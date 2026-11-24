import type { PoseLabel, StandardFaceObservation } from '../capture/types.ts';
import { POSES } from '../capture/types.ts';
import { captureError } from '../capture/captureError.ts';
import { assertFieldCaptureActive, evaluateFieldObservation } from './fieldCapture.ts';
import { waitBetweenMeasurements, type AutomaticCaptureFeedback } from './automaticCapture.ts';
import type { FieldPoseRecord, FieldSessionState } from './session.ts';

export const COLLECTION_SAMPLES_PER_POSE = 3;
export const COLLECTION_POSE_TIMEOUT = 'FIELD_COLLECTION_POSE_TIMEOUT';

// Collection is not analysis approval. Keep the original blur/expression
// verdict with each sample instead of making uncalibrated scores block a study.
// Face count, exposure, pose, confidence and unknown signals still fail closed.
const REVIEW_WARNINGS = new Set(['FT-SCAN-006', 'FT-SCAN-010']);
// The SM-T875's ARCore face pose can report a visually slight chin-lower
// movement around 40–46°.  Keep the frozen analysis band (8–20°) unchanged,
// but retain that field evidence for later review instead of losing the photo.
// A direction and finite magnitude are still required; this is not a pose
// bypass and the stored gate/server failure remains visible on the attempt.
const COLLECTION_VERTICAL_MAX_DEG = 50;
const RETRYABLE = new Set([
  'FT-SCAN-004', 'FT-SCAN-005', 'FT-SCAN-006', 'FT-SCAN-007',
  'FT-SCAN-008', 'FT-SCAN-009', 'FT-SCAN-010', 'FT-SCAN-011', 'FT-SCAN-014',
]);

export function collectedSamples(record: FieldPoseRecord, requirePhoto: boolean): number {
  return new Set(record.attempts.filter((attempt) =>
    attempt.outcome === 'recorded' && attempt.observationId !== null &&
    attempt.gatePassed !== null && attempt.serverAccepted !== null &&
    attempt.gateFailures.every((code) => collectionWarning(record.pose, code)) &&
    attempt.serverFailures.every((code) => collectionWarning(record.pose, code)) &&
    (!requirePhoto || (attempt.rawFrameUploaded && !attempt.rawFrameErrorCode)),
  ).map((attempt) => attempt.observationId)).size;
}

function collectionWarning(pose: PoseLabel, code: string): boolean {
  return REVIEW_WARNINGS.has(code) || (isVerticalPose(pose) && code === 'FT-SCAN-011');
}

function isVerticalPose(pose: PoseLabel): boolean {
  return pose === 'up_15' || pose === 'down_15';
}

function verticalCollectionPoseAccepted(pose: PoseLabel, candidate: StandardFaceObservation): boolean {
  if (!isVerticalPose(pose)) return false;
  const pitch = candidate.quality.pitchDeg;
  if (!Number.isFinite(pitch)) return false;
  const magnitude = Math.abs(pitch);
  return magnitude >= 8 && magnitude <= COLLECTION_VERTICAL_MAX_DEG &&
    (pose === 'up_15' ? pitch > 0 : pitch < 0) &&
    Math.abs(candidate.quality.yawDeg) <= 16;
}

export function collectedPoseCount(state: FieldSessionState): number {
  const requirePhoto = state.consent?.rawFrameRetention === true;
  return state.poses.filter((pose) => collectedSamples(pose, requirePhoto) >= COLLECTION_SAMPLES_PER_POSE).length;
}

export function collectionComplete(state: FieldSessionState): boolean {
  return state.attached && state.consent !== null && collectedPoseCount(state) === POSES.length;
}

export function nextCollectionPose(state: FieldSessionState): PoseLabel {
  const requirePhoto = state.consent?.rawFrameRetention === true;
  return state.poses.find((pose) => collectedSamples(pose, requirePhoto) < COLLECTION_SAMPLES_PER_POSE)?.pose ?? state.activePose;
}

/** Bounded serial acquisition, not an infinite retry and not a production gate. */
export async function waitForCollectionObservation(
  pose: PoseLabel,
  capture: (pose: PoseLabel) => Promise<StandardFaceObservation>,
  signal: AbortSignal,
  onFeedback: (feedback: AutomaticCaptureFeedback) => void,
  wait: (signal: AbortSignal) => Promise<void> = waitBetweenMeasurements,
): Promise<StandardFaceObservation> {
  let previousId: string | null = null;
  let stable = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assertFieldCaptureActive(signal);
    try {
      const candidate = await capture(pose);
      assertFieldCaptureActive(signal);
      const verdict = evaluateFieldObservation(candidate);
      const strictFailure = verdict.failures.find((code) => !REVIEW_WARNINGS.has(code)) ?? null;
      const failure = candidate.poseLabel !== pose ? 'FT-SCAN-011'
        : strictFailure === 'FT-SCAN-011' && verticalCollectionPoseAccepted(pose, candidate)
          ? null
          : strictFailure;
      stable = failure === null && previousId !== candidate.observationId ? stable + 1 : 0;
      previousId = candidate.observationId;
      onFeedback({ failureCode: failure, consecutive: stable });
      if (stable >= 2) return candidate;
    } catch (error) {
      assertFieldCaptureActive(signal);
      const code = (error as { code?: string } | null)?.code;
      if (!code || !RETRYABLE.has(code)) throw error;
      stable = 0;
      previousId = null;
      onFeedback({ failureCode: code, consecutive: 0 });
    }
    if (attempt < 19) await wait(signal);
  }
  throw captureError(COLLECTION_POSE_TIMEOUT, 'Capture paused: no stable face in the requested pose.');
}
