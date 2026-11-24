/**
 * The field-study container: policy, join, participant, camera — in that order.
 *
 * WHAT THIS COMPONENT NOW DOES THAT IT DID NOT. It calls the field-study API.
 * Until this branch it created an ordinary scan, uploaded geometry and
 * registered observations, and that was all: no policy read, no session joined,
 * no participant allocated, no capture attached. Every sample it collected was
 * an anonymous production-shaped scan that the study console could not see, and
 * the `P-000001` on the receipt was minted on the handset — so two devices in
 * one room handed out the same reference and the server had heard of neither.
 * The sequence is now the real one, and it lives in `orchestrator.ts` rather
 * than in this component, so it can be driven end to end by a test.
 *
 * FIVE DELIBERATE ABSENCES, EACH OF WHICH IS THE POINT.
 *
 *  - It never calls `finalizeScan`. That is the single call that turns a scan
 *    into a processing job and, eventually, a result. Not making it means no
 *    job, no result document and no inference can exist for anything this lane
 *    collects. It is not a call site left out: `FieldStudyApi` has no such
 *    method, so it cannot be expressed here.
 *  - It never calls `getResult`, `getJob` or `retake`, for the same reason.
 *  - It never calls `deleteScan`. Deleting a scan is not deleting a
 *    participant, and a receipt that claimed otherwise would be the worst kind
 *    of privacy control — one that stops somebody asking again. Erasure is
 *    `field_study:admin` on the operator console; the receipt routes there.
 *  - It never writes to AsyncStorage. The production flow persists a resumable
 *    scan; a field session must not leave one participant's reference, consent
 *    or progress on disk for the next launch to restore. A cold restart
 *    therefore has no session and no participant, and the operator is asked for
 *    the join code again — which is the fail-closed answer, and is why no
 *    `P-000001` can ever be locally re-issued.
 *  - It never asks for a raw frame unless the server holds a photograph consent
 *    for this participant *and* the deployment retains photographs at all.
 *
 * The production flow in `App.tsx` is untouched by all of this: this component
 * is mounted instead of it, not inside it.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AppState, Platform, Text, View } from 'react-native';

import type { FaceTypeClient } from '@facetype/contracts';

import { idempotencyKey, sha256 } from '../api/client.ts';
import { fieldStudyApi } from '../api/fieldStudy.ts';
import { resolveUploadUrl, retryWithBackoff, uploadHttpError } from '../api/runtime.ts';
import { normalizeCaptureError } from '../capture/captureError.ts';
import { resolveCaptureErrorCode, UNKNOWN_ERROR_CODE } from '../capture/errorCodes.ts';
import {
  isNativePreviewProvider,
  shouldAutoStartPreviewSequence,
  type ProviderSelectionStatus,
} from '../capture/previewGate.ts';
import { serialiseObservation, type CaptureProvider, type PoseLabel } from '../capture/types.ts';
import { styles, theme } from '../theme.ts';
import type { FieldStudyConfig } from './config.ts';
import { mayRetainRawFrames } from './consent.ts';
import { attachBeforeCamera, recordDeclineBeforeRelease } from './customerFlow.ts';
import { assertFieldCaptureActive, FIELD_CAPTURE_CANCELLED, runFieldCaptureSequence } from './fieldCapture.ts';
import { captureBestFieldObservation } from './burstCapture.ts';
import { COLLECTION_POSE_TIMEOUT, collectionComplete, collectedPoseCount, nextCollectionPose, waitForCollectionObservation } from './photoCollection.ts';
import { nativeRawFrameChannel } from './nativeRawFrame.ts';
import {
  FieldStudyOrchestrator,
  type JoinedFieldSession,
} from './orchestrator.ts';
import type { FieldStudyPolicy } from './policy.ts';
import type { RawFrameChannel } from './rawFrame.ts';
import { FieldCaptureScreen } from './screens/FieldCaptureScreen.tsx';
import { FieldJoinScreen } from './screens/FieldJoinScreen.tsx';
import { FieldReceiptScreen } from './screens/FieldReceiptScreen.tsx';
import { FieldSetupScreen } from './screens/FieldSetupScreen.tsx';
import {
  buildFieldReceipt,
  initialFieldSession,
  qualifiedPoses,
  recordedPoses,
  reduceFieldSession,
} from './session.ts';
import { ft } from './strings.ts';

export function FieldStudyApp({
  locale,
  api,
  apiUrl,
  provider,
  providerSelection,
  config,
  onExit,
}: {
  locale: string;
  api: FaceTypeClient;
  apiUrl: string;
  provider: CaptureProvider | null;
  providerSelection: ProviderSelectionStatus;
  config: FieldStudyConfig;
  onExit: () => void;
}) {
  const [state, dispatch] = useReducer(reduceFieldSession, undefined, () => initialFieldSession());
  const [busy, setBusy] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [captureFeedback, setCaptureFeedback] = useState<string | null>(null);
  const finishInFlight = useRef(false);
  const [autoCapture, setAutoCaptureState] = useState(false);
  const autoCaptureEnabled = useRef(false);
  const setAutoCapture = useCallback((enabled: boolean) => {
    // A timer already queued by React must observe Stop immediately, even
    // before the state update renders and the effect cleanup runs.
    autoCaptureEnabled.current = enabled;
    setAutoCaptureState(enabled);
  }, []);
  const appActive = useRef(AppState.currentState === 'active');
  // Synchronous lease: React's busy state alone cannot exclude two rapid taps.
  const captureInFlight = useRef<AbortController | null>(null);
  const captureStopping = useRef<object | null>(null);
  const captureUiEpoch = useRef(0);
  /**
   * Bumped whenever a participant is released, and used as the setup screen's
   * `key`.
   *
   * The two consent answers live in that screen's own state, and a decline
   * leaves the screen mounted — so without this the next person would walk up
   * to a consent form that still had the previous person's ticks in it. A key
   * change remounts the screen, which clears them by construction rather than
   * by a reset handler somebody has to remember to extend.
   */
  const [participantEpoch, setParticipantEpoch] = useState(0);

  /**
   * The device's side of the session, held outside the reducer on purpose.
   *
   * `NEXT_PARTICIPANT` rebuilds the reducer state from `initialFieldSession`,
   * which is exactly what participant isolation requires and exactly what the
   * *session* must survive: the operator joins once and then collects all
   * afternoon. Keeping the join here rather than in the reducer means the reset
   * cannot take it with it, by construction rather than by an exception list.
   */
  const orchestrator = useMemo(
    () => new FieldStudyOrchestrator(fieldStudyApi(api), idempotencyKey),
    [api],
  );

  // Mirrors of orchestrator state, for rendering only. The orchestrator remains
  // the authority; nothing is decided from these.
  const [policy, setPolicy] = useState<FieldStudyPolicy | null>(null);
  const [joined, setJoined] = useState<JoinedFieldSession | null>(null);
  const [shellError, setShellError] = useState<string | null>(null);

  const usingNativePreview = isNativePreviewProvider(provider?.kind);

  /**
   * The raw-frame channel for the participant currently consented, or `null`.
   *
   * Recomputed from the consent record itself rather than carried in state, so
   * a stale channel cannot survive a participant reset: `state.consent` is
   * cleared by the reset, and this becomes `null` in the same render. The
   * consent record's retention period is the server's, so a deployment that
   * retains no photograph produces `null` here for everybody.
   */
  const rawFrameChannel: RawFrameChannel | null = useMemo(
    () => (mayRetainRawFrames(state.consent) ? nativeRawFrameChannel() : null),
    [state.consent],
  );

  /**
   * Step 1, before anything else can happen: what will this deployment do?
   *
   * A failure leaves `policy` null, which the join screen renders as a blocked
   * state with the reason — and the join button stays disabled, so no session
   * is entered and no camera opens. There is deliberately no configured value
   * to fall back to.
   */
  const loadPolicy = useCallback(async () => {
    setBusy(true);
    setShellError(null);
    try {
      setPolicy(await orchestrator.loadPolicy());
    } catch (error) {
      setPolicy(null);
      setShellError(errorCodeOf(error));
    } finally {
      setBusy(false);
    }
  }, [orchestrator]);

  useEffect(() => {
    void loadPolicy();
  }, [loadPolicy]);

  /**
   * Step 2. The join code is a parameter and dies with this call.
   *
   * It is not stored in state, not persisted, not put in an error message and
   * not carried into any later request: what survives is the session id and the
   * policy narrowed to that session.
   */
  const join = useCallback(
    async (joinCode: string) => {
      setBusy(true);
      setShellError(null);
      try {
        const session = await orchestrator.join(joinCode);
        setJoined(session);
        setPolicy(session.policy);
      } catch (error) {
        setShellError(errorCodeOf(error));
      } finally {
        setBusy(false);
      }
    },
    [orchestrator],
  );

  /** Step 3. The server mints the reference; this device never does. */
  const allocateParticipant = useCallback(async () => {
    setBusy(true);
    setShellError(null);
    try {
      const participantRef = await orchestrator.allocateParticipant();
      dispatch({ type: 'PARTICIPANT_ALLOCATED', participantRef });
    } catch (error) {
      setShellError(errorCodeOf(error));
    } finally {
      setBusy(false);
    }
  }, [orchestrator]);

  /**
   * Step 4. Both consent facts, then — and only then — the capture screen.
   *
   * A failure at either call leaves the screen on `setup` with the reason, and
   * `CONSENT_RECORDED` is never dispatched, so the camera does not open and no
   * scan is created. That is the whole gate: the reducer's `capture` screen is
   * unreachable without a consent record, and the consent record is unreachable
   * without both server calls having returned.
   */
  const startParticipant = useCallback(
    async (photoGranted: boolean) => {
      setBusy(true);
      setShellError(null);
      try {
        const participant = await orchestrator.recordConsent({
          researchGranted: true,
          photoGranted,
          locale,
          nowMs: Date.now(),
        });
        dispatch({ type: 'CONSENT_RECORDED', consent: participant.consent });
        setAutoCapture(true);
      } catch (error) {
        setShellError(errorCodeOf(error));
      } finally {
        setBusy(false);
      }
    },
    [locale, orchestrator],
  );

  /** Read fresh inside the start sequence without depending on it. */
  const attachedRef = useRef(state.attached);
  useEffect(() => {
    attachedRef.current = state.attached;
  }, [state.attached]);

  /**
   * Discard anything the native side is still holding.
   *
   * Called on background, on unmount, on participant reset and on leaving the
   * mode. Deliberately not conditional on the current consent: the point is to
   * clear whatever exists, and a channel is only obtainable at all on a build
   * that has the export.
   */
  const purgeRawFrames = useCallback(() => {
    const channel = nativeRawFrameChannel();
    if (!channel) return;
    void channel.discardAll().catch(() => {
      // Native also discards on host pause and on bridge invalidation; a
      // failed explicit sweep is covered rather than final.
    });
  }, []);

  // The app going to the background is one of the cleanup points the study
  // protocol requires, and the one JavaScript would otherwise never notice.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => {
      appActive.current = status === 'active';
      if (status !== 'active') {
        setAutoCapture(false);
        captureInFlight.current?.abort();
        purgeRawFrames();
      }
    });
    return () => subscription.remove();
  }, [purgeRawFrames]);

  useEffect(() => () => {
    captureUiEpoch.current += 1;
    captureInFlight.current?.abort();
    purgeRawFrames();
  }, [purgeRawFrames]);

  /**
   * A device that cannot produce geometry is a terminal, actionable state, not
   * "still resolving" — and in this lane it must be said before the operator
   * has taken somebody's consent, not after. Without this the capture button
   * would simply stay disabled forever with nothing on screen explaining why
   * (the same defect audit R2 found in the production flow).
   */
  useEffect(() => {
    if (providerSelection === 'unavailable' || providerSelection === 'failed') {
      dispatch({ type: 'SESSION_ERROR', errorCode: 'FT-REC-005' });
    }
  }, [providerSelection]);

  const previewSequenceStartedRef = useRef(false);

  /**
   * Steps 5 and 6, alongside the camera: create the scan, attach it, and only
   * then let a pose be captured.
   *
   * The attach is not an afterthought here. A scan that is not attributed to a
   * participant is an ordinary anonymous scan, and a raw frame uploaded against
   * one is dated under the ephemeral policy rather than the consented retention
   * — so the attachment happens before the capture button is ever enabled, and
   * `orchestrator.poseDeps` refuses to build without it.
   */
  const startPreviewSequence = useCallback(async () => {
    if (!provider || !state.consent) return;
    setBusy(true);
    dispatch({ type: 'SESSION_ERROR_CLEARED' });
    try {
      const scanId = await attachBeforeCamera({
        attach: async () => {
          if (attachedRef.current) return state.scanId;
          if (Platform.OS !== 'ios' && Platform.OS !== 'android' && Platform.OS !== 'web') {
            throw new Error(`Unsupported runtime platform: ${Platform.OS}`);
          }
          return orchestrator.createAndAttachScan({
            platform: Platform.OS,
            deviceModel: 'unknown',
            appVersion: '1.0.0',
            providerCapability: provider.capabilities().kind,
            locale,
          });
        },
        startCamera: () => provider.start(),
      });
      if (!attachedRef.current && scanId) dispatch({ type: 'SCAN_ATTACHED', scanId });
      setPreviewReady(true);
    } catch (error) {
      dispatch({ type: 'SESSION_ERROR', errorCode: errorCodeOf(error) });
      previewSequenceStartedRef.current = false;
      try {
        await provider.stop();
      } catch {
        // The retry path re-runs provider.start() from a clean session.
      }
    } finally {
      setBusy(false);
    }
  }, [locale, orchestrator, provider, state.consent, state.scanId]);

  useEffect(() => {
    if (state.screen !== 'capture') {
      previewSequenceStartedRef.current = false;
      setPreviewReady(false);
      return;
    }
    // The gate's rules are about the provider, not about which screen is
    // mounted; this component owns the screen check itself.
    if (
      !shouldAutoStartPreviewSequence({
        screen: 'scan',
        providerSelection,
        usingNativePreview,
        alreadyStarted: previewSequenceStartedRef.current,
      })
    ) {
      return;
    }
    previewSequenceStartedRef.current = true;
    void startPreviewSequence();
  }, [providerSelection, startPreviewSequence, state.screen, usingNativePreview]);

  const onPreviewReady = useCallback(() => {
    if (previewSequenceStartedRef.current) return;
    previewSequenceStartedRef.current = true;
    void startPreviewSequence();
  }, [startPreviewSequence]);

  const onPreviewError = useCallback((_message: string) => {
    setAutoCapture(false);
    captureUiEpoch.current += 1;
    captureInFlight.current?.abort();
    setPreviewReady(false);
    setBusy(captureInFlight.current !== null || captureStopping.current !== null);
    dispatch({ type: 'SESSION_ERROR', errorCode: 'FT-REC-005' });
    previewSequenceStartedRef.current = false;
  }, []);

  /** Step 7. One pose: geometry always, a photograph only if consented. */
  const capture = useCallback(async (automatic = false) => {
    if (automatic && !autoCaptureEnabled.current) return;
    const pose = automatic ? nextCollectionPose(state) : state.activePose;
    const consent = state.consent;
    if (!appActive.current || !provider || !consent || !state.attached || !previewReady || busy || captureStopping.current || captureInFlight.current) return;
    const controller = new AbortController();
    captureInFlight.current = controller;
    const epoch = captureUiEpoch.current;

    setBusy(true);
    dispatch({ type: 'POSE_SELECTED', pose });
    dispatch({ type: 'POSE_CAPTURING', pose });
    try {
      const outcome = await runFieldCaptureSequence(
        pose,
        consent,
        orchestrator.poseDeps({
          capture: (requested: PoseLabel) => automatic
            ? waitForCollectionObservation(requested, (candidate) => provider.capture(candidate), controller.signal, (feedback) => {
              if (epoch === captureUiEpoch.current && !controller.signal.aborted) {
                setCaptureFeedback(feedback.failureCode);
              }
            })
            : captureBestFieldObservation(requested, async (candidate) => {
              assertFieldCaptureActive(controller.signal);
              const observation = await provider.capture(candidate);
              assertFieldCaptureActive(controller.signal);
              return observation;
            }),
          serialise: serialiseObservation,
          digest: sha256,
          onUploading: () => {
            if (epoch === captureUiEpoch.current && !controller.signal.aborted) {
              dispatch({ type: 'POSE_UPLOADING', pose });
            }
          },
          upload: async (slot, payload) => {
            const uploadUrl = resolveUploadUrl(slot.upload_url, apiUrl);
            const response = await retryWithBackoff(async () => {
              assertFieldCaptureActive(controller.signal);
              const attempt = await fetch(uploadUrl, {
                method: slot.method,
                headers: slot.headers,
                body: payload,
                signal: controller.signal,
              });
              if (!attempt.ok) throw uploadHttpError(attempt);
              return attempt;
            });
            if (!response.ok) throw uploadHttpError(response);
          },
          rawFrame: rawFrameChannel,
          now: () => Date.now(),
        }),
        controller.signal,
      );

      if (epoch !== captureUiEpoch.current || controller.signal.aborted) return;
      if (outcome.rawFrameErrorCode || (mayRetainRawFrames(consent) && !outcome.rawFrameUploaded) ||
          outcome.serverFailures.some((code) => code !== 'FT-SCAN-006' && code !== 'FT-SCAN-010')) {
        setAutoCapture(false);
      }
      dispatch({
        type: 'POSE_RECORDED',
        pose,
        attempt: {
          atMs: outcome.atMs,
          errorCode: null,
          gatePassed: outcome.gatePassed,
          gateFailures: outcome.gateFailures,
          serverAccepted: outcome.serverAccepted,
          serverFailures: outcome.serverFailures,
          metrics: outcome.metrics,
          rawFrameSent: outcome.rawFrameSent,
          rawFrameUploaded: outcome.rawFrameUploaded,
          rawFrameErrorCode: outcome.rawFrameErrorCode,
          observationId: outcome.observationId,
        },
      });
    } catch (error) {
      if (epoch === captureUiEpoch.current) {
        // A single quality window is bounded, but a participant should not
        // have to press a button after every timeout. Structural/camera errors
        // still stop; a timeout re-arms the next bounded window while the
        // foregrounded automatic lane remains enabled. The explicit Stop
        // control remains available at all times.
        if (errorCodeOf(error) !== COLLECTION_POSE_TIMEOUT) setAutoCapture(false);
        setCaptureFeedback(errorCodeOf(error));
        dispatch({
          type: 'POSE_FAILED', pose, atMs: Date.now(),
          errorCode: controller.signal.aborted ? FIELD_CAPTURE_CANCELLED : errorCodeOf(error),
        });
      }
    } finally {
      if (captureInFlight.current === controller) {
        captureInFlight.current = null;
        setBusy(false);
      }
    }
  }, [
    apiUrl,
    busy,
    orchestrator,
    provider,
    previewReady,
    rawFrameChannel,
    state.activePose,
    state.attached,
    state.consent,
    state,
  ]);

  useEffect(() => {
    if (!autoCapture || state.screen !== 'capture' || busy || !previewReady || !state.attached) return;
    if (collectionComplete(state)) {
      return;
    }
    const nextPose = nextCollectionPose(state);
    if (state.activePose !== nextPose) {
      dispatch({ type: 'POSE_SELECTED', pose: nextPose });
      return;
    }
    // Give the next pose instruction time to render. This delay is not a
    // quality signal: capture(true) still checks face, exposure and pose.
    const timer = setTimeout(() => void capture(true), 900);
    return () => clearTimeout(timer);
  }, [autoCapture, busy, capture, previewReady, state]);

  const stopAutomatic = useCallback(() => {
    setAutoCapture(false);
    captureInFlight.current?.abort();
  }, []);

  /**
   * One participant ends: camera down, native buffers cleared, participant
   * state gone — and the joined session kept.
   */
  const releaseParticipant = useCallback(async () => {
    setAutoCapture(false);
    captureUiEpoch.current += 1;
    const stopOwner = {};
    captureStopping.current = stopOwner;
    captureInFlight.current?.abort();
    // Detach the old request so its eventual finally cannot affect a new
    // participant. The synchronous stop lock prevents a new native capture
    // until provider.stop() has settled.
    captureInFlight.current = null;
    setBusy(true);
    purgeRawFrames();
    orchestrator.releaseParticipant();
    setParticipantEpoch((epoch) => epoch + 1);
    previewSequenceStartedRef.current = false;
    setPreviewReady(false);
    setShellError(null);
    try {
      await provider?.stop();
    } catch {
      // The next participant's sequence starts a fresh session regardless.
    } finally {
      if (captureStopping.current === stopOwner) {
        captureStopping.current = null;
        setBusy(false);
      }
    }
  }, [orchestrator, provider, purgeRawFrames]);

  const finish = useCallback(async () => {
    if (!collectionComplete(state) || finishInFlight.current) return;
    finishInFlight.current = true;
    const epoch = captureUiEpoch.current;
    setBusy(true);
    dispatch({ type: 'SESSION_ERROR_CLEARED' });
    try {
      // Each counted photograph has a verified upload completion already.
      // Collection completion is not an analysis verdict or a processing job.
      if (epoch !== captureUiEpoch.current) return;
      await releaseParticipant();
      dispatch({ type: 'COMPLETE', atMs: Date.now() });
    } catch (error) {
      dispatch({ type: 'SESSION_ERROR', errorCode: errorCodeOf(error) });
    } finally {
      finishInFlight.current = false;
      setBusy(false);
    }
  }, [releaseParticipant, state]);

  useEffect(() => {
    if (!autoCapture || busy || !collectionComplete(state)) return;
    setAutoCapture(false);
    void finish();
  }, [autoCapture, busy, finish, setAutoCapture, state]);

  const abort = useCallback(() => {
    void releaseParticipant();
    dispatch({ type: 'ABORT' });
  }, [releaseParticipant]);

  const nextParticipant = useCallback(() => {
    void releaseParticipant();
    dispatch({ type: 'NEXT_PARTICIPANT' });
  }, [releaseParticipant]);

  /**
   * A participant who declines, recorded as declining.
   *
   * The refusal is written to the server against the reference already
   * allocated, because an allocated row with no consent fact reads as "not
   * asked yet" and this lane asked. If that write fails, the participant stays
   * on screen so the operator can retry instead of silently losing the refusal.
   */
  const decline = useCallback(async () => {
    setBusy(true);
    try {
      await recordDeclineBeforeRelease({
        recordDecline: () => orchestrator.declineParticipant(locale),
        release: releaseParticipant,
      });
      dispatch({ type: 'ABORT' });
    } catch (error) {
      setShellError(errorCodeOf(error));
    } finally {
      setBusy(false);
    }
  }, [locale, orchestrator, releaseParticipant]);

  const exit = useCallback(async () => {
    await releaseParticipant();
    orchestrator.leaveSession();
    setJoined(null);
    onExit();
  }, [onExit, orchestrator, releaseParticipant]);

  // Not joined yet — or joined and then left. Nothing about a participant is
  // reachable from here, and the policy gate is enforced inside the screen.
  if (joined === null || policy === null) {
    return (
      <FieldJoinScreen
        locale={locale}
        policy={joined === null ? policy : joined.policy}
        busy={busy}
        errorCode={shellError}
        onJoin={(joinCode) => void join(joinCode)}
        onReloadPolicy={() => void loadPolicy()}
        onExit={exit}
      />
    );
  }

  if (state.screen === 'setup') {
    return (
      <FieldSetupScreen
        key={participantEpoch}
        locale={locale}
        config={config}
        policy={joined.policy}
        session={{ label: joined.label, siteCode: joined.siteCode }}
        participantRef={state.participantRef}
        participantsCompleted={state.participantsCompleted}
        busy={busy}
        errorCode={shellError ?? state.errorCode}
        onAllocate={() => void allocateParticipant()}
        onStart={(photoGranted) => void startParticipant(photoGranted)}
        onDecline={() => void decline()}
        onExit={exit}
      />
    );
  }

  if (state.screen === 'capture' && state.participantRef) {
    return (
      <FieldCaptureScreen
        locale={locale}
        participantRef={state.participantRef}
        poses={state.poses}
        activePose={state.activePose}
        rawFramesConsented={rawFrameChannel !== null}
        recorded={recordedPoses(state).length}
        qualified={qualifiedPoses(state).length}
        collected={collectedPoseCount(state)}
        busy={busy}
        previewReady={previewReady}
        automatic={autoCapture}
        feedbackCode={captureFeedback}
        onAutomatic={() => autoCapture ? stopAutomatic() : setAutoCapture(true)}
        showNativePreview={usingNativePreview}
        errorCode={state.errorCode}
        onSelectPose={(pose) => {
          if (busy || captureInFlight.current || captureStopping.current) return;
          setAutoCapture(false);
          dispatch({ type: 'POSE_SELECTED', pose });
        }}
        onCapture={() => { setAutoCapture(false); void capture(); }}
        onFinish={() => void finish()}
        onAbort={abort}
        onPreviewReady={onPreviewReady}
        onPreviewError={onPreviewError}
      />
    );
  }

  const receipt = buildFieldReceipt(state);
  if (state.screen === 'receipt' && receipt) {
    return (
      <FieldReceiptScreen
        locale={locale}
        receipt={receipt}
        deletionContact={config.deletionContact}
        onNextParticipant={nextParticipant}
        onExit={exit}
      />
    );
  }

  // Reached only if a participant reference or consent went missing between
  // renders, which the reducer does not permit. Fail visible, not blank.
  return (
    <View style={[styles.screen, styles.centered]}>
      <Text style={[styles.body, { color: theme.colors.warning }]}>
        {ft(locale, 'field.error.unavailable')}
      </Text>
    </View>
  );
}

/**
 * The code an error carries, without reading any message text.
 *
 * The lane's own refusals (`FIELD_CONSENT_REQUIRED`, `FIELD_NOT_JOINED`,
 * `FIELD_POLICY_*`, `FIELD_RAW_*`) are client-local strings, deliberately not
 * shaped like server FT codes so they cannot be mistaken for one.
 * `resolveCaptureErrorCode` recognises only FT codes and the three
 * camera-permission strings, so it would collapse these to `FT-SYS-003` — the
 * exact loss of the actionable reason that `capture/errorCodes.ts` was written
 * to stop. They are recognised first, and everything else falls through to the
 * shared resolver unchanged.
 */
function errorCodeOf(error: unknown): string {
  const carried = (error as { code?: unknown } | null)?.code;
  if (typeof carried === 'string' && carried.startsWith('FIELD_')) return carried;
  const normalized = normalizeCaptureError(error).code;
  return resolveCaptureErrorCode(
    error,
    normalized === UNKNOWN_ERROR_CODE ? null : normalized,
  );
}
