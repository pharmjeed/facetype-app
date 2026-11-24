/**
 * Capture one pose: gate it, then -- only then -- upload and register it.
 *
 * WHY THIS IS A MODULE AND NOT A CLOSURE IN `App.tsx`. The ordering *is* the
 * requirement. "The client must not upload a frame that fails FT-03" is not
 * observable from the reducer, from the provider, or from any screen; it is a
 * property of the sequence of calls this function makes. Left inline in a
 * React component it could only be checked by reading it, which is how it came
 * to be missing in the first place. Dependency-injected and framework-free, it
 * is four assertions.
 *
 * Every rejection carries an FT code (see `captureError.ts`), so the caller
 * never has to guess what to tell the user.
 */

import {
  evaluateFrameQuality,
  resolveQualityProfile,
  meanConfidence,
  type FrameQualityVerdict,
  type ProviderKind as WireProviderKind,
} from '@facetype/contracts';

import { captureError } from './captureError.ts';
import type { PoseLabel, StandardFaceObservation } from './types.ts';

/** The subset of an upload slot this sequence needs. */
export interface UploadSlot {
  artifact_id: string;
  upload_url: string;
  method: string;
  headers: Record<string, string>;
}

export interface CaptureSequenceDeps {
  capture(pose: PoseLabel): Promise<StandardFaceObservation>;
  serialise(observation: StandardFaceObservation): Uint8Array;
  digest(payload: Uint8Array): Promise<string>;
  createUpload(request: {
    pose_label: PoseLabel;
    artifact_kind: 'LANDMARKS_FTOB';
    content_type: string;
    content_length: number;
    sha256: string;
  }): Promise<UploadSlot>;
  upload(slot: UploadSlot, payload: Uint8Array): Promise<void>;
  registerObservation(request: {
    client_observation_id: string;
    pose_label: PoseLabel;
    provider: WireProviderKind;
    timestamp_ms: number;
    artifact_id: string;
    artifact_kind: 'LANDMARKS_FTOB';
    // `null` is a value here, not an absence: a device that looked and cannot
    // say is exactly what the reduced profile declares (ADR-011).
    quality: Record<string, number | null>;
    declared_quality_profile: string;
    declared_profile_version: string;
    sha256: string;
  }): Promise<void>;
}

export interface CaptureSequenceResult {
  observation: StandardFaceObservation;
  verdict: FrameQualityVerdict;
}

export async function runCaptureSequence(
  pose: PoseLabel,
  deps: CaptureSequenceDeps,
): Promise<CaptureSequenceResult> {
  const observation = await deps.capture(pose);

  // FT-03 §3 before a single byte leaves the device. The server re-runs the
  // same gate from the same shared threshold artifact -- this is not a
  // substitute for that -- but a frame the client can already see is bad must
  // not cost the user an upload, and rejecting it here is what lets the app
  // name the exact reason instead of a round trip ending in a generic failure.
  const verdict = evaluateFrameQuality(
    observation.quality,
    observation.poseLabel,
    meanConfidence(observation.landmarkConfidence),
    observation.declaredQualityProfile,
    observation.source,
    observation.declaredProfileVersion,
  );
  if (!verdict.pass) {
    throw captureError(
      verdict.primaryErrorCode ?? 'FT-SCAN-014',
      `client quality gate rejected ${pose} (${verdict.failures.join(',')})`,
    );
  }

  const quality = measuredQuality(observation);
  const payload = deps.serialise(observation);
  const sha256 = await deps.digest(payload);

  const slot = await deps.createUpload({
    pose_label: pose,
    artifact_kind: 'LANDMARKS_FTOB',
    content_type: 'application/vnd.facetype.ftob',
    content_length: payload.byteLength,
    sha256,
  });

  await deps.upload(slot, payload);

  // Registration must never run after storage rejected the bytes: an
  // observation row pointing at an artifact that was never stored is a scan
  // that fails much later, somewhere much less obvious.
  await deps.registerObservation({
    client_observation_id: observation.observationId,
    pose_label: pose,
    provider: observation.source === 'simulator' ? 'simulator' : observation.source,
    timestamp_ms: observation.timestampMs,
    artifact_id: slot.artifact_id,
    artifact_kind: 'LANDMARKS_FTOB',
    quality,
    // Declared again here, and identically, because the server compares this
    // against the copy inside the hashed FTOB header. A payload that claims one
    // profile and a request that claims another is a mismatch, not a detail.
    declared_quality_profile: observation.declaredQualityProfile,
    declared_profile_version: observation.declaredProfileVersion,
    sha256,
  });

  return { observation, verdict };
}

/**
 * The wire-shaped quality record, with unmeasured signals sent as `null`.
 *
 * WHY `null` RATHER THAN OMITTED. An absent key and a null are the same thing
 * to a permissive parser and very different things to a reader: `null` is this
 * device stating that it looked and cannot say, which is exactly the claim the
 * reduced profile is built on. Dropping the key would leave the server to infer
 * the absence, and inference is what this whole mechanism replaces.
 *
 * The gate has already run, so a signal is null here only if the resolved
 * profile permits it. The guard below is the belt to that braces: it fails with
 * the same `FT-SCAN-014` the gate would, from the same profile resolution, so
 * the two cannot disagree about what an unmeasured frame is.
 */
function measuredQuality(observation: StandardFaceObservation): Record<string, number | null> {
  const q = observation.quality;
  const profile = resolveQualityProfile(
    observation.declaredQualityProfile,
    observation.source,
    observation.declaredProfileVersion,
  );
  const required = { blur: q.blur, exposure: q.exposure, occlusion: q.occlusion, neutrality: q.neutrality };
  const missing = Object.entries(required)
    .filter(([name]) => !profile.unmeasuredAllowed.includes(name))
    .filter(([, value]) => value === null || !Number.isFinite(value))
    .map(([name]) => name);
  if (missing.length > 0) {
    throw captureError('FT-SCAN-014', `unmeasured quality signals: ${missing.join(',')}`);
  }
  const waived = (name: string, value: number | null): number | null =>
    profile.unmeasuredAllowed.includes(name) && (value === null || !Number.isFinite(value))
      ? null
      : (value as number);
  return {
    blur: waived('blur', required.blur),
    exposure: waived('exposure', required.exposure),
    occlusion: waived('occlusion', required.occlusion),
    neutrality: waived('neutrality', required.neutrality),
    face_count: q.faceCount,
    yaw_deg: q.yawDeg,
    pitch_deg: q.pitchDeg,
  };
}
