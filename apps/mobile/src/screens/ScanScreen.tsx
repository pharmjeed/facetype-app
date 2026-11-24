/**
 * Guided scan — FT-17 §3.
 *
 * One pose at a time, with live quality chips. The instruction text changes per
 * pose so the user is told exactly what to do rather than being shown a generic
 * "align your face" overlay.
 *
 * The face frame is the real native camera preview (`NativeFaceTypePreview`
 * — an ARCore `GLSurfaceView` on Android, an ARKit `ARSCNView` on iOS) when
 * one is available for this platform/provider, with this screen's own pose
 * text/hint drawn on top as an RN overlay — never a decorative placeholder
 * standing in for a camera that never opened (audit F1/F2; design review
 * D2/D3, message 2026-08-25T21-54-44Z_53356c299477). On Android the native
 * view's `zOrderMediaOverlay(true)` is what lets these RN siblings still draw
 * above its SurfaceView-backed content; iOS's `ARSCNView` has no such
 * SurfaceView z-order restriction, so RN siblings composite above it by
 * default.
 */

import { StyleSheet, Text, View } from 'react-native';

import { t } from '@facetype/design-system';

import { NativeFaceTypePreview } from '../capture/NativeFaceTypePreview.tsx';
import type { PoseLabel } from '../capture/types.ts';
import { POSES } from '../capture/types.ts';
import { Button } from '../components/Button.tsx';
import { styles, theme } from '../theme.ts';

const POSE_INSTRUCTION: Record<PoseLabel, 'scan.front' | 'scan.left' | 'scan.right' | 'scan.up' | 'scan.down'> = {
  front: 'scan.front',
  left_25: 'scan.left',
  right_25: 'scan.right',
  up_15: 'scan.up',
  down_15: 'scan.down',
};

/**
 * FT-09 scan errors mapped to the exact instruction that fixes them.
 *
 * EVERY CODE THE QUALITY GATE CAN PRODUCE HAS TO BE IN HERE, and two were not.
 * An unmapped code fell through to the `scan.neutral` muted line below, which
 * is the *pose* instruction ("relax your face") — the thing the screen says
 * when nothing has gone wrong. So a capture that failed outright looked
 * identical to a step that had not been attempted yet: the scan returned to
 * step 1 with calm copy and no explanation, which is exactly what a Galaxy Tab
 * S7 showed for every ARCore capture.
 *
 *  - `FT-SCAN-014` (nothing could be measured) is reachable from a bridge
 *    rejection, from low landmark confidence, and from a broken signal under a
 *    profile that waives it.
 *  - `FT-SCAN-011` (the head was measured and is not at the requested angle) is
 *    the single most likely failure once a capture gets far enough to be
 *    judged, and it is entirely actionable.
 *
 * `RETRY_HINT` closes the class rather than these two instances: a coded
 * failure with no specific instruction still says a capture failed. Silence is
 * never the safe default here, because the fallback is not silence — it is a
 * line that reads as "all is well".
 */
const ERROR_HINT: Record<
  string,
  | 'scan.blur'
  | 'scan.light'
  | 'scan.occlusion'
  | 'scan.neutral'
  | 'scan.one_face'
  | 'scan.unmeasurable'
  | 'scan.pose_off'
> = {
  'FT-SCAN-004': 'scan.one_face',
  'FT-SCAN-005': 'scan.one_face',
  'FT-SCAN-006': 'scan.blur',
  'FT-SCAN-007': 'scan.light',
  'FT-SCAN-008': 'scan.light',
  'FT-SCAN-009': 'scan.occlusion',
  'FT-SCAN-010': 'scan.neutral',
  'FT-SCAN-011': 'scan.pose_off',
  'FT-SCAN-014': 'scan.unmeasurable',
};

/** Shown for a coded failure this table does not have a specific line for. */
const RETRY_HINT = 'scan.retry_pose' as const;

export function ScanScreen({
  locale,
  pose,
  captured,
  errorCode,
  shellError,
  busy,
  showNativePreview,
  previewReady,
  onCapture,
  onPreviewReady,
  onPreviewError,
  onRetry,
}: {
  locale: string;
  pose: PoseLabel;
  captured: PoseLabel[];
  errorCode: string | null;
  /** Set when the start-camera/create-scan sequence itself failed (M1-F2); distinct from a per-pose `errorCode`. */
  shellError: string | null;
  busy: boolean;
  /** True for a native geometry provider (ARCore or ARKit): mount the real native preview. */
  showNativePreview: boolean;
  /** True once the capture sequence (start + scan creation) has completed. */
  previewReady: boolean;
  onCapture: () => void;
  onPreviewReady: () => void;
  onPreviewError: (message: string) => void;
  /** Re-runs the start-camera/create-scan sequence after a `shellError`. */
  onRetry: () => void;
}) {
  const step = captured.length + 1;
  const hint = errorCode ? (ERROR_HINT[errorCode] ?? RETRY_HINT) : null;

  return (
    <View style={styles.screen}>
      <View style={styles.row}>
        <Text style={styles.caption}>
          {t(locale, 'scan.step', { current: step, total: POSES.length })}
        </Text>
        <View style={[styles.stepper, { flex: 1, justifyContent: 'flex-end' }]}>
          {POSES.map((item) => (
            <View
              key={item}
              style={[
                styles.stepDot,
                captured.includes(item) && styles.stepDotDone,
                item === pose && styles.stepDotActive,
              ]}
            />
          ))}
        </View>
      </View>

      <View
        style={[
          styles.faceFrame,
          hint ? styles.faceFrameWarn : styles.faceFrameActive,
          previewStyles.clip,
        ]}
        accessibilityLabel={t(locale, POSE_INSTRUCTION[pose])}
      >
        {showNativePreview ? (
          <NativeFaceTypePreview
            style={StyleSheet.absoluteFill}
            onPreviewReady={onPreviewReady}
            onPreviewError={(event) => onPreviewError(event.nativeEvent.message)}
          />
        ) : null}
        {!showNativePreview || !previewReady ? (
          <Text style={styles.muted}>{t(locale, `pose.${pose}` as 'pose.front')}</Text>
        ) : null}
      </View>

      <Text style={styles.h2}>{t(locale, POSE_INSTRUCTION[pose])}</Text>
      {hint ? (
        <Text style={[styles.body, { color: theme.colors.warning }]}>{t(locale, hint)}</Text>
      ) : (
        <Text style={styles.muted}>{t(locale, 'scan.neutral')}</Text>
      )}

      {shellError ? (
        <>
          <Text style={[styles.body, { color: theme.colors.warning }]}>{shellError}</Text>
          <Button label={t(locale, 'common.retry')} onPress={onRetry} loading={busy} />
        </>
      ) : (
        <Button
          label={t(locale, 'scan.start')}
          onPress={onCapture}
          loading={busy}
          disabled={!previewReady}
        />
      )}
    </View>
  );
}

const previewStyles = StyleSheet.create({
  // The native GLSurfaceView is a real camera surface; it must respect the
  // frame's rounded corners instead of drawing a square over them.
  clip: { overflow: 'hidden' },
});
