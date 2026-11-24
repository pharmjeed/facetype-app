/**
 * App shell — wires the scan flow reducer to the screens (FT-17 §14).
 *
 * The whole capture contract lives in `state/scanFlow.ts` (a pure reducer) and
 * `capture/` (the provider abstraction), so this component is only navigation
 * and side effects. That split is what lets the flow be unit-tested without a
 * camera, a renderer or a network.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  I18nManager,
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  StatusBar,
  Text,
  View,
} from 'react-native';

import { FaceTypeApiError, type ResultResponse, retakePose } from '@facetype/contracts';
import { direction, t } from '@facetype/design-system';

import { createApi, getToken, idempotencyKey, sha256, setToken } from './api/client.ts';
import { ConsentGatedAnalytics, type ProductEventName } from './api/tracking.ts';
import {
  ApiConfigurationError,
  buildPolicy,
  resolveApiBaseUrl,
} from './api/endpoint.ts';
import {
  ProcessingTimeoutError,
  pollUntilTerminal,
  resolveUploadUrl,
  retryWithBackoff,
  uploadHttpError,
} from './api/runtime.ts';
import {
  clearSecureSessionToken,
  persistSecureSessionToken,
  recoverSecureSessionToken,
} from './api/secureSession.ts';
import { normalizeCaptureError } from './capture/captureError.ts';
import { runCaptureSequence } from './capture/captureSequence.ts';
import {
  nativeCaptureErrorCode,
  resolveCaptureErrorCode,
  UNKNOWN_ERROR_CODE,
} from './capture/errorCodes.ts';
import { defaultProviders } from './capture/providers.ts';
import { ClientApp } from './client/ClientApp.tsx';
import { FieldStudyApp } from './field/FieldStudyApp.tsx';
import { fieldStudyConfig } from './field/mode.ts';
import { needsResumeChoice, prepareFieldEntry } from './field/entry.ts';
import { Button } from './components/Button.tsx';
import { ft } from './field/strings.ts';
import {
  isNativePreviewProvider,
  shouldAutoStartPreviewSequence,
  type ProviderSelectionStatus,
} from './capture/previewGate.ts';
import { runPreviewReadySequence } from './capture/previewReadySequence.ts';
import { type CaptureProvider, selectProvider, serialiseObservation } from './capture/types.ts';
import { ConsentScreen } from './screens/ConsentScreen.tsx';
import { PrivacyScreen } from './screens/PrivacyScreen.tsx';
import { ProcessingScreen } from './screens/ProcessingScreen.tsx';
import { ResultScreen } from './screens/ResultScreen.tsx';
import { RetakeScreen } from './screens/RetakeScreen.tsx';
import { ScanScreen } from './screens/ScanScreen.tsx';
import { WelcomeScreen } from './screens/WelcomeScreen.tsx';
import { persistScanState, recoverScanState } from './state/asyncStorage.ts';
import { currentPose, initialState, progress, reduce, type TerminalStatus } from './state/scanFlow.ts';
import { styles } from './theme.ts';

/**
 * Both reads are rewritten to string literals at bundle time by
 * `babel/inlineBuildEnv.js`; React Native's `process` shim would otherwise
 * return undefined for each. The failure is captured rather than thrown so a
 * misconfigured build shows its API_URL_* code on the welcome screen; throwing
 * during module evaluation is an unrecoverable white screen in React Native.
 */
const API_ENDPOINT = ((): { url: string } | { error: string } => {
  try {
    return {
      url: resolveApiBaseUrl(
        process.env.FACETYPE_API_URL,
        buildPolicy(process.env.FACETYPE_ALLOW_CLEARTEXT),
      ),
    };
  } catch (error) {
    return { error: error instanceof ApiConfigurationError ? error.code : 'API_URL_INVALID' };
  }
})();
const API_URL = 'url' in API_ENDPOINT ? API_ENDPOINT.url : '';
const LOCALE = 'ar-SA';

/**
 * The field-study lane, or `null` for every build that does not run one.
 *
 * Both reads are inlined at bundle time like the API address, so this is a
 * property of the artifact rather than of anything the running app can change.
 * `null` here means the entry point is not rendered at all and
 * `field/FieldStudyApp.tsx` is never mounted: a consumer build has no research
 * collection mode, not a hidden one.
 */
const FIELD_STUDY = fieldStudyConfig(
  process.env.FACETYPE_FIELD_STUDY,
  process.env.FACETYPE_FIELD_STUDY_CONFIG,
);

/**
 * Which app this bundle runs.
 *
 * A field-study build (FACETYPE_FIELD_STUDY + a complete study config, both
 * inlined at bundle time) keeps the existing shell exactly as it was: the
 * field lane and the anonymous scan lane beside it. Every other build mounts
 * the client app (docs/client-app-v1.md, ADR-015); the anonymous scan lane is
 * then not mounted at all — its code stays in the repository, unreachable from
 * this bundle's UI.
 */
export default function App() {
  return FIELD_STUDY ? <LegacyApp /> : <ClientApp />;
}

/** The pre-client shell: anonymous scan lane + field-study lane (unchanged). */
function LegacyApp() {
  const [state, dispatch] = useReducer(reduce, initialState);
  // Which lane is mounted. The two are alternatives, never nested: the field
  // container has no result screen and the production flow has no participant
  // reference, and neither can reach the other's state.
  const [lane, setLane] = useState<'production' | 'field'>('production');
  const [resumeChoicePending, setResumeChoicePending] = useState(FIELD_STUDY !== null);
  const fieldEntryInFlight = useRef(false);
  const [provider, setProvider] = useState<CaptureProvider | null>(null);
  // Tracks *why* `provider` is null, not just whether it is (audit R2): a
  // plain nullable provider cannot distinguish "still resolving" from
  // "resolved: no supported provider on this device" from "the selection
  // promise rejected" — all three read as null, and the auto-start gate
  // below used to treat all of them like "definitely not ready yet",
  // waiting forever on an unsupported device with no native preview ever
  // coming to fire the event that would unblock it.
  const [providerSelection, setProviderSelection] = useState<ProviderSelectionStatus>('pending');
  const [selectionAttempt, setSelectionAttempt] = useState(0);
  const [result, setResult] = useState<ResultResponse | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [shellError, setShellError] = useState<string | null>(
    'error' in API_ENDPOINT ? API_ENDPOINT.error : null,
  );
  const [processingAttempt, setProcessingAttempt] = useState(0);
  // True once provider.start() + (first-time) scan creation have completed
  // for the currently-mounted preview. Gates the capture button so a tap can
  // never race a camera session that has not started yet (design review D3).
  const [previewReady, setPreviewReady] = useState(false);

  const api = useMemo(
    () =>
      createApi(API_URL, () => {
        void clearSecureSessionToken().catch(() => {
          // The in-memory token is already cleared synchronously by createApi.
        });
      }),
    [],
  );
  const analytics = useMemo(() => new ConsentGatedAnalytics(api), [api]);
  const track = useCallback(
    (eventName: ProductEventName, properties: Record<string, string | number | boolean> = {}) => {
      void analytics.trackEvent(eventName, properties).catch(() => {
        // Product analytics is optional and must never break the scan flow.
      });
    },
    [analytics],
  );

  // A real native preview exists for both native geometry providers today:
  // Android's ARCore `FaceTypePreviewView` (a GLSurfaceView that owns the
  // Session) and iOS's ARKit `FaceTypePreviewView` (an ARSCNView that
  // displays whatever session `FaceTypeCapture` is running). Both register
  // under the same RN component name (`NativeFaceTypePreview` wraps
  // `FaceTypePreviewView`) and fire the same `onPreviewReady`/`onPreviewError`
  // events, so this gate does not need a platform check — only the
  // simulator/web paths have no native surface to wait an event from.
  const usingNativePreview = isNativePreviewProvider(provider?.kind);

  // Read fresh inside startPreviewSequence without making it depend on
  // state.scanId (which the sequence itself sets, via SCAN_CREATED).
  const scanIdRef = useRef(state.scanId);
  useEffect(() => {
    scanIdRef.current = state.scanId;
  }, [state.scanId]);

  // Mirrors state.scanCreateKey for the same reason as scanIdRef: read fresh
  // inside createScan without depending on a value this same call sets.
  const scanCreateKeyRef = useRef(state.scanCreateKey);
  useEffect(() => {
    scanCreateKeyRef.current = state.scanCreateKey;
  }, [state.scanCreateKey]);

  const startPreviewSequence = useCallback(async () => {
    if (!provider || lane !== 'production' || resumeChoicePending) return;
    setBusy(true);
    setShellError(null);
    try {
      const created = await runPreviewReadySequence({
        startProvider: () => provider.start(),
        hasExistingScan: () => scanIdRef.current !== null,
        // One idempotency key per logical createScan attempt, reused on every
        // retry (M1-F4): a fresh key per attempt would let a retry after a
        // lost response mint a duplicate/orphan scan if the server had
        // actually committed the first request.
        resolveCreateKey: () =>
          scanCreateKeyRef.current
            ? { key: scanCreateKeyRef.current, isNew: false }
            : { key: idempotencyKey(), isNew: true },
        onKeyMinted: (key) => {
          scanCreateKeyRef.current = key;
          dispatch({ type: 'SCAN_CREATE_KEY', key });
        },
        // Write-ahead barrier (audit R1A): this must durably record the
        // pending-create key *before* createScan below is ever called. A
        // rejection here propagates out of runPreviewReadySequence and
        // createScan is never reached — a full/denied device store must
        // block the request, not silently let it through unrecoverable.
        persistPendingCreate: (key) =>
          persistScanState({
            ...initialState,
            consentGranted: true,
            analyticsConsent: state.analyticsConsent,
            researchOptIn: state.researchOptIn,
            screen: 'scan',
            scanCreateKey: key,
          }),
        createScan: async (scanCreateKey) => {
          // Re-narrowed here (not just in consent()): control-flow narrowing
          // does not cross a closure/callback boundary, and consent() only
          // ever advances to `scan` — where this runs — after this exact
          // check already passed once.
          if (Platform.OS !== 'ios' && Platform.OS !== 'android' && Platform.OS !== 'web') {
            throw new Error(`Unsupported runtime platform: ${Platform.OS}`);
          }
          const capabilities = [provider.capabilities().kind];
          const scan = await api.createScan(
            {
              capture_protocol: 'cap-1.0.0',
              capture_mode: 'geometry_preferred',
              device: {
                platform: Platform.OS,
                model: 'unknown',
                app_version: '1.0.0',
                provider_capabilities: capabilities,
              },
              privacy: { retain_raw_frames: false, research_opt_in: state.researchOptIn },
              // What the user said before the camera opened, carried as a
              // statement rather than a signal (ADR-011). Absent from `quality`
              // on purpose: nothing downstream may read it as an occlusion
              // score or let it satisfy a gate.
              obstruction_self_attested: state.obstructionSelfAttested,
              locale: LOCALE,
              consent_granted: true,
            },
            { idempotencyKey: scanCreateKey },
          );
          return { scanId: scan.scan_id, finalizeKey: idempotencyKey() };
        },
      });
      if (created) {
        dispatch({ type: 'SCAN_CREATED', scanId: created.scanId, finalizeKey: created.finalizeKey });
        track('scan_started', { platform: Platform.OS, capture_mode: 'geometry_preferred' });
      }
      setPreviewReady(true);
    } catch (error) {
      setShellError(shellErrorCode(error));
      // A create-scan failure after the provider already started must not
      // leave the camera running with no way back in: reset the guard so a
      // retry can re-run this whole sequence, and stop whatever the provider
      // started so the next attempt begins from a clean camera session
      // (M1-F2). Stopping a provider that never started (e.g. startProvider
      // itself threw) is a documented no-op on every CaptureProvider.
      previewSequenceStartedRef.current = false;
      try {
        await provider.stop();
      } catch {
        // Best-effort cleanup; the retry path re-runs provider.start() next.
      }
    } finally {
      setBusy(false);
    }
  }, [api, lane, provider, resumeChoicePending, state.researchOptIn, track]);

  // Guards against running the sequence twice for one mounted preview (e.g.
  // a native `onPreviewReady` firing again after a transient GL surface
  // recreation), without gating on previewReady itself (which this sequence
  // is what sets).
  const previewSequenceStartedRef = useRef(false);

  useEffect(() => {
    if (state.screen !== 'scan' || lane !== 'production' || resumeChoicePending) {
      previewSequenceStartedRef.current = false;
      setPreviewReady(false);
      return;
    }
    if (
      !shouldAutoStartPreviewSequence({
        screen: state.screen,
        providerSelection,
        usingNativePreview,
        alreadyStarted: previewSequenceStartedRef.current,
      })
    ) {
      return;
    }
    previewSequenceStartedRef.current = true;
    void startPreviewSequence();
  }, [lane, resumeChoicePending, state.screen, providerSelection, usingNativePreview, startPreviewSequence]);

  const onNativePreviewReady = useCallback(() => {
    if (previewSequenceStartedRef.current) return;
    previewSequenceStartedRef.current = true;
    void startPreviewSequence();
  }, [startPreviewSequence]);

  const onNativePreviewError = useCallback((_message: string) => {
    setShellError('FT-REC-005');
    // Mirrors the createScan failure path: a native preview error means no
    // ready event is coming for this mount, so the guard must reset too or
    // a retry (native or the explicit button) would silently no-op forever.
    previewSequenceStartedRef.current = false;
  }, []);

  // Explicit retry for a failed startPreviewSequence (M1-F2): the native
  // onPreviewReady event that would otherwise re-trigger it only fires once
  // per GL surface creation, so a user-facing action is required once that
  // event has already been consumed (or never applies, e.g. non-native).
  //
  // Also the single retry action for a provider selection that resolved
  // `unavailable`/`failed` (R2): there is no `provider` yet in that case, so
  // re-running `startPreviewSequence` would be a no-op — re-run selection
  // itself instead, in case the earlier probe failure was transient.
  const retryPreviewSequence = useCallback(() => {
    if (providerSelection !== 'ready') {
      setShellError(null);
      setSelectionAttempt((attempt) => attempt + 1);
      return;
    }
    if (previewSequenceStartedRef.current) return;
    previewSequenceStartedRef.current = true;
    void startPreviewSequence();
  }, [providerSelection, startPreviewSequence]);

  useEffect(() => {
    I18nManager.forceRTL(direction(LOCALE) === 'rtl');
    let cancelled = false;
    setProviderSelection('pending');
    void selectProvider(defaultProviders())
      .then((selected) => {
        if (cancelled) return;
        // Defence in depth: release builds never accept synthetic morphology,
        // even if a future caller accidentally opts the simulator into its list.
        if (selected?.kind === 'simulator' && !__DEV__) {
          setShellError('UNSUPPORTED_DEVICE');
          setProvider(null);
          setProviderSelection('unavailable');
          return;
        }
        if (!selected) {
          // A legitimate `selectProvider` result: no provider on this device
          // is available (e.g. no supported ARCore front-face geometry).
          // This is a terminal, actionable state — not "still resolving" —
          // so it must be reported, not silently left to hang the gate above.
          setShellError('UNSUPPORTED_DEVICE');
          setProvider(null);
          setProviderSelection('unavailable');
          return;
        }
        setProvider(selected);
        setProviderSelection('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setShellError('CAPTURE_UNAVAILABLE');
        setProvider(null);
        setProviderSelection('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [selectionAttempt]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Restore credentials first. Dispatching the processing state can
        // start polling on the next render, so setToken must happen before it.
        const restoredToken = await recoverSecureSessionToken();
        const restoredState = await recoverScanState();
        if (cancelled) return;
        if (restoredToken && restoredState) {
          setToken(restoredToken);
          setResumeChoicePending(needsResumeChoice(FIELD_STUDY !== null, restoredState.screen));
          dispatch({ type: 'RESTORED', state: restoredState });
        } else {
          setResumeChoicePending(false);
          setToken(null);
          // A lone half of the recovery pair cannot resume safely.
          await Promise.all([
            restoredToken ? clearSecureSessionToken() : Promise.resolve(),
            restoredState ? persistScanState(initialState) : Promise.resolve(),
          ]);
        }
      } catch {
        // Secure/storage failure must not prevent a clean new scan.
        setResumeChoicePending(false);
        setToken(null);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    void persistScanState(state).catch(() => {
      // The current in-memory flow remains usable if device storage is full.
    });
  }, [hydrated, state]);

  useEffect(() => {
    if (state.screen !== 'processing') return;
    // All guided poses are already in FTOB buffers; release the camera before
    // network finalization/polling so it never remains open in the background.
    void provider?.stop().catch(() => {
      // The OS also tears the camera down with the activity; processing remains safe.
    });
  }, [provider, state.screen]);

  const begin = useCallback(async () => {
    if ('error' in API_ENDPOINT) {
      // Fail closed rather than issue requests against an empty base URL,
      // which would surface as a generic transport error and hide the cause.
      setShellError(API_ENDPOINT.error);
      return;
    }
    setBusy(true);
    setShellError(null);
    try {
      const session = await api.createAnonymousSession();
      await persistSecureSessionToken(session.access_token, session.expires_in);
      setToken(session.access_token);
      dispatch({ type: 'BEGIN' });
    } catch (error) {
      setShellError(shellErrorCode(error));
    } finally {
      setBusy(false);
    }
  }, [api]);

  /**
   * Open the calibration lane.
   *
   * It needs the same anonymous session the production flow does — a scan
   * cannot be created without one — so the session is established here, before
   * the lane is mounted, and the field container never has to think about
   * credentials. Nothing else is carried across: the production reducer is
   * left exactly as it was and is not advanced.
   */
  const enterFieldStudy = useCallback(async () => {
    if (busy || fieldEntryInFlight.current || !FIELD_STUDY) return;
    if ('error' in API_ENDPOINT) {
      setShellError(API_ENDPOINT.error);
      return;
    }
    setBusy(true);
    fieldEntryInFlight.current = true;
    setShellError(null);
    try {
      await prepareFieldEntry({
        stopCamera: async () => { await provider?.stop(); },
        hasToken: () => getToken() !== null,
        createSession: async () => {
          const session = await api.createAnonymousSession();
          await persistSecureSessionToken(session.access_token, session.expires_in);
          setToken(session.access_token);
        },
      });
      previewSequenceStartedRef.current = false;
      setPreviewReady(false);
      setLane('field');
    } catch (error) {
      setShellError(shellErrorCode(error));
    } finally {
      fieldEntryInFlight.current = false;
      setBusy(false);
    }
  }, [api, busy, provider]);

  const consent = useCallback(
    async (
      granted: boolean,
      researchOptIn: boolean,
      analyticsConsent: boolean,
      obstructionSelfAttested: boolean,
    ) => {
      if (!granted) return;
      setBusy(true);
      setShellError(null);
      try {
        if (!provider) throw new Error('CAPTURE_UNAVAILABLE');
        if (Platform.OS !== 'ios' && Platform.OS !== 'android' && Platform.OS !== 'web') {
          throw new Error(`Unsupported runtime platform: ${Platform.OS}`);
        }
        if (Platform.OS === 'android') {
          const cameraPermission = PermissionsAndroid.PERMISSIONS.CAMERA;
          if (!cameraPermission) throw new Error('CAMERA_PERMISSION_UNAVAILABLE');
          const permission = await PermissionsAndroid.request(
            cameraPermission,
            {
              title: 'إذن الكاميرا',
              message: 'تُستخدم الكاميرا لقياس هندسة الوجه على الجهاز دون رفع الصور.',
              buttonPositive: 'متابعة',
              buttonNegative: 'إلغاء',
            },
          );
          if (permission !== PermissionsAndroid.RESULTS.GRANTED) {
            throw new Error('CAMERA_PERMISSION_DENIED');
          }
        }
        let analyticsEnabled = false;
        try {
          await analytics.setConsent(analyticsConsent);
          analyticsEnabled = analyticsConsent;
        } catch {
          analytics.disable();
        }
        // Consent only authorises camera access and advances to `scan`, which
        // mounts the preview. Starting the provider and creating the scan
        // happen only once that preview signals it is actually ready (see
        // `startPreviewSequence`) — never here, before anything exists for a
        // native session to attach a camera texture to (design review D3).
        dispatch({
          type: 'CONSENT',
          granted,
          researchOptIn,
          analyticsConsent: analyticsEnabled,
          obstructionSelfAttested,
        });
      } catch (error) {
        setShellError(shellErrorCode(error));
      } finally {
        setBusy(false);
      }
    },
    [analytics, provider],
  );

  const capture = useCallback(async () => {
    const pose = currentPose(state);
    if (!pose || !state.scanId || !provider) return;

    setBusy(true);
    track('pose_requested', { pose });
    const scanId = state.scanId;
    try {
      // The gate-then-upload ordering lives in `captureSequence.ts` so it can
      // be asserted directly: a frame that fails FT-03 must never reach
      // `createUpload`, and a registration must never follow a failed upload.
      await runCaptureSequence(pose, {
        capture: (requested) => provider.capture(requested),
        serialise: serialiseObservation,
        digest: sha256,
        createUpload: (request) => api.createUpload(scanId, request),
        upload: async (slot, payload) => {
          const uploadUrl = resolveUploadUrl(slot.upload_url, API_URL);
          const uploadResponse = await retryWithBackoff(async () => {
            const response = await fetch(uploadUrl, {
              method: slot.method,
              headers: slot.headers,
              body: payload,
            });
            if (!response.ok) throw uploadHttpError(response);
            return response;
          });
          if (!uploadResponse.ok) throw uploadHttpError(uploadResponse);
        },
        registerObservation: async (request) => {
          await api.registerObservation(scanId, request);
        },
      });

      dispatch({ type: 'POSE_CAPTURED', pose });
      track('pose_accepted', { pose, quality_bucket: 'client_accepted' });
    } catch (error) {
      // A native bridge rejection carries a real FT-* code (FT-SCAN-004 for a
      // second face, FT-SCAN-005 for no face, FT-SCAN-014 for unmeasurable
      // quality). Collapsing everything that is not a FaceTypeApiError to
      // FT-SYS-003 threw all of it away, which left ScanScreen's ERROR_HINT
      // table unreachable and every pose_rejected event reading the same
      // reason. See capture/errorCodes.ts.
      const normalizedCode = normalizeCaptureError(error).code;
      const code = resolveCaptureErrorCode(
        error,
        error instanceof FaceTypeApiError
          ? error.errorCode
          : normalizedCode === UNKNOWN_ERROR_CODE
            ? null
            : normalizedCode,
      );
      dispatch({ type: 'POSE_REJECTED', pose, errorCode: code });
      track('pose_rejected', { pose, reason_code: code });
    } finally {
      setBusy(false);
    }
  }, [api, provider, state, track]);

  // Finalize once every pose is captured. Retries reuse one idempotency key.
  useEffect(() => {
    if (state.screen !== 'processing' || !state.scanId || !state.finalizeKey || state.jobId) return;

    let cancelled = false;
    void (async () => {
      try {
        await provider?.stop();
        track('processing_stage_started', { stage: 'finalize' });
        const job = await retryWithBackoff(() =>
          api.finalizeScan(state.scanId!, { idempotencyKey: state.finalizeKey! }),
        );
        if (!cancelled) {
          dispatch({ type: 'FINALIZED', jobId: job.job_id });
          track('scan_finalized');
        }
      } catch (error) {
        if (!cancelled) {
          dispatch({ type: 'PROCESSING_PENDING', errorCode: runtimeErrorCode(error) });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    api,
    processingAttempt,
    provider,
    state.finalizeKey,
    state.jobId,
    state.scanId,
    state.screen,
    track,
  ]);

  // Poll an existing job, including one recovered after background/restart.
  useEffect(() => {
    if (state.screen !== 'processing' || !state.scanId || !state.jobId) return;

    let cancelled = false;
    void (async () => {
      try {
        await pollUntilTerminal(() => api.getJob(state.jobId!), {
          maxAttempts: 60,
          baseDelayMs: 500,
          maxDelayMs: 8_000,
          pollIntervalMs: 1_000,
          onStatus: (status) => {
            if (!cancelled) {
              setStage(status.stage ?? null);
              if (status.stage) track('processing_stage_started', { stage: status.stage });
            }
          },
        });
        if (cancelled) return;

        const document = await retryWithBackoff(() => api.getResult(state.scanId!));
        if (cancelled) return;
        setResult(document);
        track('processing_stage_completed', { stage: 'terminal' });
        track('scan_terminal', { outcome: document.status });
        track('result_viewed', { outcome: document.status });
        dispatch({
          type: 'RESULT',
          status: document.status as TerminalStatus,
          retakePose: retakePoseFrom(document),
          errorCode: document.error_codes?.[0] ?? null,
        });
      } catch (error) {
        if (!cancelled) {
          dispatch({ type: 'PROCESSING_PENDING', errorCode: runtimeErrorCode(error) });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, processingAttempt, state.jobId, state.scanId, state.screen, track]);

  const retryProcessing = useCallback(() => {
    dispatch({ type: 'PROCESSING_RETRY' });
    setProcessingAttempt((attempt) => attempt + 1);
  }, []);

  const resetFlow = useCallback(async () => {
    analytics.disable();
    try {
      await provider?.stop();
    } catch {
      // Reset still clears all resumable state; native teardown is best-effort.
    }
    setToken(null);
    try {
      await clearSecureSessionToken();
    } catch {
      // The UI must still leave a completed/deferred scan. A later 401 also
      // invokes the same secure-store cleanup callback on the API client.
    }
    dispatch({ type: 'RESET' });
    setResult(null);
    setStage(null);
    setShellError(null);
  }, [analytics, provider]);

  const remove = useCallback(async () => {
    if (!state.scanId) return;
    setBusy(true);
    try {
      track('privacy_delete_requested');
      await api.deleteScan(state.scanId);
      await resetFlow();
    } finally {
      setBusy(false);
    }
  }, [api, resetFlow, state.scanId, track]);

  const pose = currentPose(state);

  if (!hydrated) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <View style={[styles.screen, styles.centered]}>
          <Text style={styles.muted}>{t(LOCALE, 'processing.title')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (lane === 'field' && FIELD_STUDY) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <StatusBar barStyle="dark-content" />
        <FieldStudyApp
          locale={LOCALE}
          api={api}
          apiUrl={API_URL}
          provider={provider}
          providerSelection={providerSelection}
          config={FIELD_STUDY}
          onExit={() => {
            setLane('production');
            if (needsResumeChoice(FIELD_STUDY !== null, state.screen)) {
              setResumeChoicePending(true);
            } else {
              void resetFlow();
            }
          }}
        />
      </SafeAreaView>
    );
  }

  if (resumeChoicePending && FIELD_STUDY) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <View style={[styles.screen, styles.centered]}>
          <Text style={styles.h2}>لديك جلسة تصوير سابقة</Text>
          <Text style={styles.body}>يمكنك متابعتها أو فتح الدراسة الميدانية. لن تُحذف بيانات الجلسة السابقة.</Text>
          {shellError ? <Text style={styles.body}>{shellError}</Text> : null}
          <Button label={ft(LOCALE, 'field.mode.enter')} onPress={() => void enterFieldStudy()} loading={busy} />
          <Button label="متابعة التصوير السابق" onPress={() => setResumeChoicePending(false)} disabled={busy} variant="secondary" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <StatusBar barStyle="dark-content" />
      {state.screen === 'welcome' ? (
        <WelcomeScreen
          locale={LOCALE}
          busy={busy}
          errorCode={shellError}
          onStart={() => void begin()}
          fieldStudy={
            FIELD_STUDY
              ? { label: ft(LOCALE, 'field.mode.enter'), onEnter: () => void enterFieldStudy() }
              : null
          }
        />
      ) : state.screen === 'consent' ? (
        <ConsentScreen
          locale={LOCALE}
          busy={busy}
          errorCode={shellError}
          unmeasuredSignals={provider?.capabilities().unmeasuredSignals ?? []}
          onContinue={(g, r, a, o) => void consent(g, r, a, o)}
        />
      ) : state.screen === 'scan' && pose ? (
        <ScanScreen
          locale={LOCALE}
          pose={pose}
          captured={state.captured}
          errorCode={state.errorCode}
          shellError={shellError}
          busy={busy}
          showNativePreview={usingNativePreview}
          previewReady={previewReady}
          onCapture={() => void capture()}
          onPreviewReady={onNativePreviewReady}
          onPreviewError={onNativePreviewError}
          onRetry={retryPreviewSequence}
        />
      ) : state.screen === 'processing' ? (
        <ProcessingScreen
          locale={LOCALE}
          stage={stage}
          progress={progress(state)}
          errorCode={state.errorCode}
          onRetry={retryProcessing}
        />
      ) : state.screen === 'retake' ? (
        <RetakeScreen
          locale={LOCALE}
          pose={state.retakePose}
          onRetake={() => {
            track('rescan_started', { outcome: 'targeted_retake' });
            dispatch({
              type: 'RETAKE',
              poses: state.retakePose ? [state.retakePose] : [],
              finalizeKey: idempotencyKey(),
            });
          }}
          onLater={() => void resetFlow()}
        />
      ) : state.screen === 'privacy' ? (
        <PrivacyScreen
          locale={LOCALE}
          deleting={busy}
          onDelete={() => void remove()}
          onCancel={() => dispatch({ type: 'RESULT', status: (result?.status as TerminalStatus) ?? 'FAILED' })}
        />
      ) : result ? (
        <ResultScreen
          locale={LOCALE}
          result={result}
          onRescan={() => {
            track('rescan_started', { outcome: 'new_scan' });
            void resetFlow();
          }}
          onDelete={() => dispatch({ type: 'OPEN_PRIVACY' })}
        />
      ) : (
        <View style={[styles.screen, styles.centered]}>
          <Text style={styles.muted}>{t(LOCALE, 'processing.title')}</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

/** The pose a retake result is asking for, if the server named one. */
function retakePoseFrom(document: ResultResponse) {
  const action = document.action as { type?: string; pose?: string } | undefined;
  if (!action || action.type !== 'RETAKE_POSE') return null;
  return retakePose(
    new FaceTypeApiError({
      type: '',
      title: '',
      status: 422,
      error_code: 'FT-SCAN-011',
      detail: '',
      message_key: '',
      retryable: true,
      action: { type: 'RETAKE_POSE', pose: action.pose },
    }),
  );
}

/**
 * Narrow on purpose: `PROCESSING_PENDING` only ever describes the
 * finalize/poll network step, whose failures are transport failures, and the
 * reducer's action type says so.
 */
function runtimeErrorCode(error: unknown): 'PROCESSING_TIMEOUT' | typeof UNKNOWN_ERROR_CODE {
  if (error instanceof ProcessingTimeoutError) return 'PROCESSING_TIMEOUT';
  return UNKNOWN_ERROR_CODE;
}

/**
 * The code shown on the shell for a failed session/consent/start-camera step.
 *
 * Unlike the processing path above, these steps *can* fail for a reason the
 * user is able to act on — a denied camera (CAMERA_PERMISSION_DENIED, thrown
 * by `consent()` on Android and rejected by `FaceTypeCapture.start()` on iOS)
 * or a device that cannot produce geometry (FT-REC-005). Reporting those as
 * FT-SYS-003 told someone who only had to open Settings that the app had hit
 * an internal error. A transport failure still carries no code and still
 * falls through to `runtimeErrorCode`.
 */
function shellErrorCode(error: unknown): string {
  return nativeCaptureErrorCode(error) ?? runtimeErrorCode(error);
}

