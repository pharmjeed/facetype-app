/**
 * Screen 4 — capture (docs/client-app-v1.md §1 row 4, docs/capture-spec-v2.md §3–§4).
 *
 * Tips card (3 tips) → camera with an oval and ONE message at a time →
 * automatic burst (no shutter button) → «جارٍ الرفع» → «جارٍ التحقق» →
 * «تم» or a specific retake reason. Side states: camera permission denied
 * (settings link), camera interrupted, cancel, and a help card after 60 s.
 * Messages are announced to VoiceOver/TalkBack; text follows the system size.
 *
 * Native decides which frames are good; this screen only guides and shows
 * progress. There is no photo review and no image is ever displayed back.
 *
 * One burst is one capture (native contract §5.16), and since 2026-11-24 it
 * accumulates for up to 60 s (owner: «كل مرة تأخذ جزءًا حتى يكتمل»): a frame
 * that fails is skipped while the live guidance says why, a frame that passes
 * is kept, and the bar fills to ten. Only a burst that still ends short (60 s,
 * or the native candidate cap) is deleted, and the next one starts from zero. Attempt telemetry is never sent when the frames are queued: an
 * attempt that reached the spool reports its server verdict from there
 * (docs/client-app-v1.md §6); this screen reports only attempts that end
 * before any upload (cancel, time-out, camera permission refused).
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  AppState,
  BackHandler,
  Linking,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { CLIENT_GATE_CONFIG, gateConfigJson } from '@facetype/contracts';
import { colors, radius, spacing } from '@facetype/design-system';

import { Button } from '../../components/Button.tsx';
import { styles } from '../../theme.ts';
import type { AttemptTelemetry } from '../api/types.ts';
import {
  burstDisposition,
  initialCaptureFlow,
  isCameraPhase,
  nextBurstOptions,
  reduceCapture,
  type CaptureFlowState,
} from '../captureFlow.ts';
import {
  guidanceView,
  initialGuidance,
  rearmGuidance,
  stepGuidance,
  type GuidanceMessage,
  type GuidanceState,
} from '../guidance/guidance.ts';
import { ClientCameraView, type CameraBackend } from '../native/clientCamera.tsx';
import type { BurstFrame, CameraCapabilities, FrameMeasure } from '../native/types.ts';
import type { SpoolOutcome } from '../spool/spool.ts';
import { apiErrorKey, rejectReasonKey, verdictReasonKey } from '../messages.ts';
import { s, type StringKey } from '../strings.ts';
import { attemptDevice, pendingAttempt, type PendingAttempt } from '../telemetry.ts';
import { ui } from './ui.tsx';

const GATE_JSON = gateConfigJson();

/** A server refusal gets its own sentence; a local upload failure keeps its code. */
function rejectedText(code: string): string {
  const key = apiErrorKey(code);
  return key ? s(key) : s('upload.rejected', { code });
}

const GUIDE_KEY: Record<GuidanceMessage, StringKey> = {
  camera_starting: 'guide.camera_starting',
  no_face: 'guide.no_face',
  multiple_faces: 'guide.multiple_faces',
  move_closer: 'guide.move_closer',
  move_back: 'guide.move_back',
  centre: 'guide.centre',
  look_straight: 'guide.look_straight',
  light: 'guide.light',
  hold_still: 'guide.hold_still',
};

async function ensureCameraPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true; // iOS: the native view asks and reports permission_denied.
  const permission = PermissionsAndroid.PERMISSIONS.CAMERA;
  if (!permission) return false;
  const result = await PermissionsAndroid.request(permission);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

export function CaptureScreen({
  camera,
  spool,
  onEnqueue,
  onAcknowledge,
  onClose,
  onTelemetry,
}: {
  camera: CameraBackend;
  spool: SpoolOutcome;
  /** Hands one complete burst to the spool, with the attempt telemetry it must send after the verdict. */
  onEnqueue: (
    frames: BurstFrame[],
    attempts: number,
    capabilities: CameraCapabilities | null,
    telemetry: PendingAttempt,
  ) => Promise<void>;
  onAcknowledge: () => void;
  onClose: () => void;
  onTelemetry: (telemetry: AttemptTelemetry) => void;
}): ReactNode {
  const [flow, dispatch] = useReducer(reduceCapture, Date.now(), initialCaptureFlow);
  const flowRef = useRef<CaptureFlowState>(flow);
  flowRef.current = flow;
  const guidance = useRef<GuidanceState>(initialGuidance(Date.now()));
  const [view, setView] = useState(() => guidanceView(guidance.current, CLIENT_GATE_CONFIG));
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [enqueueError, setEnqueueError] = useState<string | null>(null);
  const capabilities = useRef<CameraCapabilities | null>(null);
  const burstInFlight = useRef(false);
  const enqueued = useRef(false);
  const telemetrySent = useRef(false);
  const module = camera.kind === 'unavailable' ? null : camera.module;

  useEffect(() => {
    if (!module) return;
    module.getCapabilities().then(
      (caps) => {
        capabilities.current = caps;
      },
      () => {
        capabilities.current = null;
      },
    );
  }, [module]);

  // Upload/verdict states come from the durable spool, before and after restarts.
  useEffect(() => {
    dispatch({ type: 'SPOOL_STATUS', outcome: spool, nowMs: Date.now() });
  }, [spool]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      const active = next === 'active';
      setForeground(active);
      if (!active && burstInFlight.current) void module?.cancelBurst().catch(() => undefined);
    });
    return () => subscription.remove();
  }, [module]);

  // 60 s guidance limit.
  useEffect(() => {
    if (flow.phase.name !== 'guiding') return undefined;
    const timer = setInterval(() => dispatch({ type: 'TICK', nowMs: Date.now() }), 1000);
    return () => clearInterval(timer);
  }, [flow.phase.name]);

  // Announce each new guidance message once.
  const spoken = useRef<string | null>(null);
  const message = (() => {
    const phase = flow.phase;
    if (phase.name === 'bursting') {
      // Native-only reasons (camera effects, an internal store failure) cannot be seen in the live measures.
      const native =
        phase.topRejectReason === 'effects_active' || phase.topRejectReason === 'internal'
          ? rejectReasonKey(phase.topRejectReason, view.message)
          : null;
      if (native) return s(native);
      // While the current frame fails, say why now (not the burst's most frequent reason so far).
      if (view.message !== 'hold_still') return s(GUIDE_KEY[view.message]);
      return s('burst.progress', { accepted: phase.accepted, target: phase.target });
    }
    return s(GUIDE_KEY[view.message]);
  })();
  useEffect(() => {
    if (!isCameraPhase(flow.phase) || spoken.current === message) return;
    spoken.current = message;
    AccessibilityInfo.announceForAccessibility(message);
  }, [message, flow.phase]);

  /** The attempt so far, wire-ready (snake_case reasons, §5.17), without its outcome. */
  const attemptSoFar = useCallback(
    (): PendingAttempt =>
      pendingAttempt({
        startedAtMs: flowRef.current.sessionStartedAtMs,
        nowMs: Date.now(),
        attempts: flowRef.current.attempts,
        reasonCounts: flowRef.current.reasonCounts,
        device: attemptDevice(capabilities.current, Platform.OS),
      }),
    [],
  );

  /** Only for attempts that end before any upload; an enqueued one reports from the spool. */
  const sendTelemetry = useCallback(
    (outcome: Extract<AttemptTelemetry['outcome'], 'cancelled' | 'timed_out' | 'permission_denied'>) => {
      if (telemetrySent.current || enqueued.current) return;
      telemetrySent.current = true;
      onTelemetry({ outcome, ...attemptSoFar() });
    },
    [attemptSoFar, onTelemetry],
  );

  const startBurst = useCallback(async () => {
    if (!module || burstInFlight.current) return;
    burstInFlight.current = true;
    dispatch({ type: 'BURST_STARTED', target: CLIENT_GATE_CONFIG.burst.targetFrames });
    try {
      const result = await module.startBurst(nextBurstOptions());
      // A partial burst is never kept for the next one: its frames leave the device now.
      const { discard } = burstDisposition(result);
      if (discard.length > 0) await module.deleteFrames(discard).catch(() => undefined);
      dispatch({ type: 'BURST_RESULT', result, nowMs: Date.now() });
    } catch {
      dispatch({ type: 'BURST_FAILED', nowMs: Date.now() });
    } finally {
      burstInFlight.current = false;
      guidance.current = rearmGuidance(guidance.current);
    }
  }, [module]);

  const onFrameMeasure = useCallback(
    (measure: FrameMeasure) => {
      guidance.current = stepGuidance(guidance.current, measure, CLIENT_GATE_CONFIG);
      const next = guidanceView(guidance.current, CLIENT_GATE_CONFIG);
      setView((current) =>
        current.message === next.message &&
        current.ready === next.ready &&
        Math.abs(current.holdProgress - next.holdProgress) < 0.1
          ? current
          : next,
      );
      if (next.ready && flowRef.current.phase.name === 'guiding' && !burstInFlight.current) void startBurst();
    },
    [startBurst],
  );

  // Hand a full burst to the durable spool exactly once. Its attempt
  // telemetry travels with it and is sent after the server verdict.
  useEffect(() => {
    if (flow.phase.name !== 'uploading' || flow.kept.length === 0 || enqueued.current) return;
    enqueued.current = true;
    setEnqueueError(null);
    onEnqueue(flow.kept, flow.attempts, capabilities.current, attemptSoFar()).then(
      () => {
        dispatch({ type: 'ENQUEUED' });
      },
      (error: unknown) => {
        enqueued.current = false;
        setEnqueueError(error instanceof Error ? error.message : 'enqueue failed');
      },
    );
  }, [flow.phase.name, flow.kept, flow.attempts, onEnqueue, attemptSoFar]);

  const discardKept = useCallback(async () => {
    const ids = flowRef.current.kept.map((frame) => frame.id);
    if (module && ids.length > 0) await module.deleteFrames(ids).catch(() => undefined);
  }, [module]);

  const cancel = useCallback(async () => {
    if (burstInFlight.current) await module?.cancelBurst().catch(() => undefined);
    // Frames already handed to the spool belong to it; only an unqueued burst is deleted here.
    if (!enqueued.current) await discardKept();
    const phase = flowRef.current.phase.name;
    if (phase === 'permission_denied') sendTelemetry('permission_denied');
    else if (phase !== 'tips') sendTelemetry(flowRef.current.helpShown ? 'timed_out' : 'cancelled');
    onClose();
  }, [discardKept, module, onClose, sendTelemetry]);

  // Android back = «إلغاء»: the same cleanup, never a silent exit with frames left behind.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      void cancel();
      return true;
    });
    return () => subscription.remove();
  }, [cancel]);

  const start = useCallback(async () => {
    guidance.current = initialGuidance(Date.now());
    setView(guidanceView(guidance.current, CLIENT_GATE_CONFIG));
    const granted = await ensureCameraPermission().catch(() => false);
    dispatch({ type: 'START', nowMs: Date.now() });
    if (!granted) dispatch({ type: 'PERMISSION_DENIED' });
  }, []);

  const resume = useCallback(async () => {
    const granted = await ensureCameraPermission().catch(() => false);
    if (!granted) return;
    guidance.current = initialGuidance(Date.now());
    dispatch({ type: 'RESUME', nowMs: Date.now() });
  }, []);

  const retake = useCallback(() => {
    onAcknowledge();
    enqueued.current = false;
    telemetrySent.current = false;
    dispatch({ type: 'RETAKE' });
  }, [onAcknowledge]);

  const phase = flow.phase;
  const cameraActive = isCameraPhase(phase) && foreground;
  const passing = view.message === 'hold_still';
  const oval = useMemo(
    () => [local.oval, { borderColor: passing ? colors.success : colors.surface }],
    [passing],
  );

  if (isCameraPhase(phase)) {
    return (
      <View style={local.cameraScreen}>
        <ClientCameraView
          active={cameraActive}
          gateConfig={GATE_JSON}
          style={StyleSheet.absoluteFill}
          onFrameMeasure={onFrameMeasure}
          onBurstProgress={(progress) => dispatch({ type: 'BURST_PROGRESS', progress })}
          onError={(error) => dispatch({ type: 'CAMERA_ERROR', code: error.code })}
        />
        <View style={local.overlay} pointerEvents="box-none">
          <View style={oval} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
          <View style={local.messageCard} accessible accessibilityRole="text" accessibilityLiveRegion="polite">
            <Text style={local.message}>{message}</Text>
            {phase.name === 'bursting' || view.holdProgress > 0 ? (
              <View style={styles.bar}>
                <View
                  style={[
                    styles.barFill,
                    {
                      width: `${Math.round(
                        100 * (phase.name === 'bursting' ? phase.accepted / Math.max(1, phase.target) : view.holdProgress),
                      )}%`,
                    },
                  ]}
                />
              </View>
            ) : null}
            {phase.name === 'guiding' && phase.retrying ? (
              <Text style={local.sub}>
                {(() => {
                  // «لم يكتمل التصوير»: the discarded burst's most frequent reject reason, one short sentence.
                  const key = rejectReasonKey(phase.partialReason, view.message);
                  return key ? s('burst.incomplete', { reason: s(key) }) : s('burst.partial');
                })()}
              </Text>
            ) : null}
          </View>
          <View style={local.footer}>
            <Button label={s('common.cancel')} onPress={() => void cancel()} variant="secondary" />
          </View>
        </View>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={[styles.screen, { justifyContent: 'center', flexGrow: 1 }]}>
      {phase.name === 'tips' ? (
        <View style={ui.card}>
          <Text style={ui.title} accessibilityRole="header">
            {s('tips.title')}
          </Text>
          <Text style={ui.text}>{`1. ${s('tips.glasses')}`}</Text>
          <Text style={ui.text}>{`2. ${s('tips.no_smile')}`}</Text>
          <Text style={ui.text}>{`3. ${s('tips.light')}`}</Text>
          <Text style={ui.hint}>{s('tips.auto')}</Text>
          <Button label={s('tips.start')} onPress={() => void start()} />
          <Button label={s('common.cancel')} onPress={() => void cancel()} variant="secondary" />
        </View>
      ) : null}

      {phase.name === 'help' ? (
        <View style={ui.card}>
          <Text style={ui.title} accessibilityRole="header">
            {s('help.title')}
          </Text>
          <Text style={ui.text}>{`• ${s('help.eye_level')}`}</Text>
          <Text style={ui.text}>{`• ${s('help.light')}`}</Text>
          <Text style={ui.text}>{`• ${s('help.alone')}`}</Text>
          <Text style={ui.text}>{`• ${s('tips.glasses')} — ${s('tips.no_smile')}`}</Text>
          <Button label={s('help.again')} onPress={() => void resume()} />
          <Button label={s('common.cancel')} onPress={() => void cancel()} variant="secondary" />
        </View>
      ) : null}

      {phase.name === 'permission_denied' ? (
        <View style={ui.card}>
          <Text style={ui.text} accessibilityLiveRegion="polite">{s('camera.permission_denied')}</Text>
          <Button label={s('camera.open_settings')} onPress={() => void Linking.openSettings()} />
          <Button label={s('common.retry')} onPress={() => void resume()} variant="secondary" />
          <Button label={s('common.cancel')} onPress={() => void cancel()} variant="secondary" />
        </View>
      ) : null}

      {phase.name === 'interrupted' ? (
        <View style={ui.card}>
          <Text style={ui.text} accessibilityLiveRegion="polite">{s('camera.interrupted')}</Text>
          <Button label={s('camera.resume')} onPress={() => void resume()} />
          <Button label={s('common.cancel')} onPress={() => void cancel()} variant="secondary" />
        </View>
      ) : null}

      {phase.name === 'camera_error' ? (
        <View style={ui.card}>
          <Text style={ui.text} accessibilityLiveRegion="polite">
            {s(
              phase.code === 'camera_unavailable'
                ? 'camera.unavailable'
                : phase.code === 'model_unavailable'
                  ? 'camera.model_unavailable'
                  : phase.code === 'effects_active'
                    ? 'camera.effects_active'
                    : 'camera.internal',
            )}
          </Text>
          <Button label={s('common.retry')} onPress={() => void resume()} />
          <Button label={s('common.cancel')} onPress={() => void cancel()} variant="secondary" />
        </View>
      ) : null}

      {phase.name === 'uploading' ? (
        <View style={ui.card} accessibilityLiveRegion="polite">
          <Text style={ui.title}>{s('upload.title')}</Text>
          <Text style={ui.text}>{s('upload.progress', { done: phase.done, total: phase.total })}</Text>
          {phase.offline ? <Text style={ui.text}>{s('upload.offline')}</Text> : null}
          {enqueueError ? <Text style={ui.error}>{s('common.unexpected', { code: 'SPOOL' })}</Text> : null}
          <Button
            label={s('capture.back_profile')}
            onPress={() => {
              // Frames that never reached the spool are deleted, not left on the device.
              if (enqueueError) void discardKept();
              onClose();
            }}
            variant="secondary"
          />
        </View>
      ) : null}

      {phase.name === 'checking' ? (
        <View style={ui.card} accessibilityLiveRegion="polite">
          <Text style={ui.title}>{s('check.title')}</Text>
          {phase.slow ? <Text style={ui.text}>{s('check.slow')}</Text> : null}
          <Button label={s('capture.back_profile')} onPress={onClose} variant="secondary" />
        </View>
      ) : null}

      {phase.name === 'received' ? (
        <View style={ui.card} accessibilityLiveRegion="polite">
          {/* Integrity verified, quality checks later: never «تم» (docs/client-app-v1.md §6). */}
          <Text style={ui.title}>{s('received.body')}</Text>
          <Text style={ui.text}>{s('check.slow')}</Text>
          <Button
            label={s('capture.back_profile')}
            onPress={() => {
              onAcknowledge();
              onClose();
            }}
          />
        </View>
      ) : null}

      {phase.name === 'done' ? (
        <View style={ui.card} accessibilityLiveRegion="polite">
          <Text style={ui.title}>{s('done.title')}</Text>
          <Text style={ui.text}>{s('done.body')}</Text>
          <Button
            label={s('capture.back_profile')}
            onPress={() => {
              onAcknowledge();
              onClose();
            }}
          />
        </View>
      ) : null}

      {phase.name === 'retake' ? (
        <View style={ui.card} accessibilityLiveRegion="polite">
          <Text style={ui.title}>{s('retake.title')}</Text>
          {(phase.reasons.length > 0 ? [...new Set(phase.reasons.map(verdictReasonKey))] : ['reason.generic' as StringKey]).map(
            (key) => (
              <Text key={key} style={ui.text}>
                {s(key)}
              </Text>
            ),
          )}
          <Button label={s('retake.again')} onPress={retake} />
          <Button
            label={s('capture.back_profile')}
            onPress={() => {
              onAcknowledge();
              onClose();
            }}
            variant="secondary"
          />
        </View>
      ) : null}

      {phase.name === 'lost' || phase.name === 'failed' ? (
        <View style={ui.card} accessibilityLiveRegion="polite">
          <Text style={ui.text}>
            {phase.name === 'lost' ? s('upload.lost') : rejectedText(phase.code)}
          </Text>
          <Button label={s('retake.again')} onPress={retake} />
          <Button
            label={s('capture.back_profile')}
            onPress={() => {
              onAcknowledge();
              onClose();
            }}
            variant="secondary"
          />
        </View>
      ) : null}
    </ScrollView>
  );
}

const local = StyleSheet.create({
  cameraScreen: { flex: 1, backgroundColor: '#000000' },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between', alignItems: 'center', padding: spacing[6] },
  oval: {
    marginTop: '15%',
    width: '72%',
    aspectRatio: 0.75,
    borderRadius: 1000,
    borderWidth: 4,
  },
  messageCard: {
    alignSelf: 'stretch',
    backgroundColor: 'rgba(22, 32, 51, 0.82)',
    borderRadius: radius.md,
    padding: spacing[4],
    gap: spacing[2],
  },
  message: { color: '#ffffff', fontSize: 22, fontWeight: '700', textAlign: 'center' },
  sub: { color: '#ffffff', fontSize: 14, textAlign: 'center' },
  footer: { alignSelf: 'stretch' },
});
