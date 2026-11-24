/**
 * Capture one pose for the field study: measure it, keep the verdict whatever
 * it is, upload the geometry, and upload a photograph only if the participant
 * said so.
 *
 * WHY IT IS A SEPARATE SEQUENCE FROM `capture/captureSequence.ts` RATHER THAN A
 * FLAG ON IT. The production sequence exists to enforce one rule: a frame that
 * fails FT-03 never reaches `createUpload`. The field study needs the opposite
 * disposal of a failing frame — the sample that failed is the calibration
 * evidence — and a boolean that inverts a security-relevant ordering inside the
 * function that enforces it is exactly how such a rule stops being enforced.
 * Two functions means the production path has no parameter that could ever make
 * it upload a rejected frame, and `fieldMode.test.ts` asserts that directly.
 *
 * WHAT IS NOT RELAXED HERE. The gate itself. This sequence calls the same
 * `evaluateFrameQuality` from the same shared threshold artifact, with the same
 * arguments, and records the verdict verbatim: the failure codes, the resolved
 * profile, the measured signals, the server's own second opinion. Nothing is
 * rounded, defaulted or omitted, no threshold is read from a different place,
 * and an unmeasured signal is still sent as `null` rather than as a number
 * somebody chose. The difference is solely what happens *after* a failing
 * verdict: production refuses to upload, the field study uploads and marks the
 * sample as below the gate. The scan is never finalized, so no result, job or
 * inference can exist for it (see `FieldStudyApp.tsx`).
 *
 * RAW FRAMES. `deps.rawFrame` is `null` unless the participant opted in, and
 * this function additionally re-checks `mayRetainRawFrames` before touching it.
 * Two independent conditions, because "the channel was wired up wrong" and "the
 * consent was not given" are different mistakes and either one alone must stop
 * a photograph existing. Whatever happens afterwards — an upload failure, a
 * completion failure, a rejection, a thrown error — the `finally` discards
 * the native slot.
 *
 * A raw frame is uploaded in two steps for the same reason geometry is: the PUT
 * puts bytes in a bucket, and a separate server call is what makes the artifact
 * record say they arrived. `deps.completeRawUpload` is that second step — bound
 * to `POST /scans/{id}/uploads/{artifact_id}/complete`, the one route that
 * marks a RAW_FRAME stored without registering an observation — and
 * `rawFrameUploaded` stays false until it resolves.
 */

import {
  evaluateFrameQuality,
  meanConfidence,
  type FrameQualityVerdict,
} from '@facetype/contracts';

import { captureError } from '../capture/captureError.ts';
import type { PoseLabel, StandardFaceObservation } from '../capture/types.ts';
import { mayCollect, mayRetainRawFrames, type FieldConsentRecord } from './consent.ts';
import type { RawFrameChannel, RawFrameHandle } from './rawFrame.ts';

/** Client-local refusals. Deliberately not shaped like server FT codes. */
export const FIELD_CONSENT_REQUIRED = 'FIELD_CONSENT_REQUIRED';
export const FIELD_CAPTURE_CANCELLED = 'FIELD_CAPTURE_CANCELLED';

/** Stop new work; cancellation does not erase bytes already sent to a server. */
export function assertFieldCaptureActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw captureError(FIELD_CAPTURE_CANCELLED, 'field capture was cancelled');
}

/** The JPEG this lane produces. 16 MiB is the server's RAW_FRAME ceiling. */
export const RAW_FRAME_CONTENT_TYPE = 'image/jpeg';

export interface FieldUploadSlot {
  artifact_id: string;
  upload_url: string;
  method: string;
  headers: Record<string, string>;
}

export interface FieldObservationVerdict {
  accepted: boolean;
  failures: string[];
}

export interface FieldCaptureDeps {
  capture(pose: PoseLabel): Promise<StandardFaceObservation>;
  serialise(observation: StandardFaceObservation): Uint8Array;
  digest(payload: Uint8Array): Promise<string>;
  createUpload(request: {
    pose_label: PoseLabel;
    artifact_kind: 'LANDMARKS_FTOB' | 'RAW_FRAME';
    content_type: string;
    content_length: number;
    sha256: string;
  }): Promise<FieldUploadSlot>;
  upload(slot: FieldUploadSlot, payload: Uint8Array): Promise<void>;
  registerObservation(request: {
    client_observation_id: string;
    pose_label: PoseLabel;
    provider: 'arkit' | 'arcore' | 'mediapipe' | 'simulator';
    timestamp_ms: number;
    artifact_id: string;
    artifact_kind: 'LANDMARKS_FTOB';
    quality: Record<string, number | null>;
    declared_quality_profile: string;
    declared_profile_version: string;
    sha256: string;
  }): Promise<FieldObservationVerdict>;
  /**
   * Tell the server the raw bytes are in the store.
   *
   * WHY THIS EXISTS AS ITS OWN DEPENDENCY. `createUpload` only mints a signed
   * slot; the artifact row it creates says `uploaded = false` until some server
   * operation verifies the object and flips it. For geometry that operation is
   * `registerObservation`, which stats the object, checks its length and digest
   * against what was declared, and only then marks the artifact uploaded. A
   * RAW_FRAME has no such call on the observation path — and must not: a
   * photograph registered as an observation is a photograph filed in the
   * geometry ledger as a measured pose, counted towards pose completeness and
   * handed to everything downstream that reads observations.
   * `POST /scans/{id}/uploads/{artifact_id}/complete` is the route that
   * verifies a photograph and registers nothing, and this is bound to it.
   *
   * WHAT THE REQUEST MAY CARRY. The digest, and optional restatements of the
   * declared size and content type. Nothing else: `RawUploadCompletionRequest`
   * forbids extra fields, and it deliberately has no `pose_label`, no
   * participant reference and no consent flag — a photograph is retained
   * because of a fact already recorded against a participant, never because a
   * client asserted one at upload time.
   *
   * The implementation must reject a response that does not actually confirm
   * the photograph (see `assertRawUploadConfirmed`), because a resolved promise
   * here is what sets `rawFrameUploaded`.
   */
  completeRawUpload(request: {
    artifact_id: string;
    sha256: string;
    content_length: number;
    content_type: string;
  }): Promise<void>;
  /** Present only when the participant opted in to raw retention. */
  rawFrame: RawFrameChannel | null;
  now(): number;
}

/** Everything one field attempt produced. Nothing is summarised away. */
export interface FieldCaptureOutcome {
  atMs: number;
  gatePassed: boolean;
  gateFailures: string[];
  serverAccepted: boolean | null;
  serverFailures: string[];
  metrics: Record<string, number | null>;
  /**
   * A photograph left the device: the presigned PUT returned successfully.
   *
   * This, not [rawFrameUploaded], is what the participant's receipt speaks to.
   * The participant is owed the truth about where their face went, and once the
   * PUT succeeds their face is in the object store whether or not the server
   * has finished accounting for it.
   */
  rawFrameSent: boolean;
  /**
   * The bytes reached the store *and* the server confirmed them.
   *
   * Not "the PUT returned 200". A successful PUT with no completion call leaves
   * the artifact row saying the object was never uploaded, so reporting that as
   * stored would put a claim on the operator's console that the backend would
   * contradict. The two booleans are deliberately separate because they can
   * genuinely disagree, and collapsing them would mean lying to somebody: to
   * the operator if it followed the PUT, to the participant if it followed the
   * confirmation.
   */
  rawFrameUploaded: boolean;
  rawFrameErrorCode: string | null;
  observationId: string;
  errorCode: null;
  /** The full client verdict, for the operator's per-pose detail line. */
  verdict: FrameQualityVerdict;
}

/**
 * The wire-shaped quality record for a calibration sample.
 *
 * `capture/captureSequence.ts` throws `FT-SCAN-014` when a signal the resolved
 * profile requires is missing, because in production such a frame must not be
 * uploaded at all. Here the missing signal is itself the finding — a device
 * that cannot measure occlusion in a particular room is exactly what a
 * calibration session is trying to characterise — so it travels as `null` and
 * the server's own gate records the resulting failure against the observation.
 *
 * `null` is never substituted for a number and a number is never substituted
 * for `null`: a non-finite value (NaN from a division by an empty ROI, an
 * Infinity from a degenerate exposure histogram) becomes `null`, because "this
 * came back unusable" is what happened, and reporting NaN as a score would put
 * a fabricated measurement into the calibration set.
 */
export function fieldQualityRecord(
  observation: StandardFaceObservation,
): Record<string, number | null> {
  const quality = observation.quality;
  const finite = (value: number | null): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    blur: finite(quality.blur),
    exposure: finite(quality.exposure),
    occlusion: finite(quality.occlusion),
    neutrality: finite(quality.neutrality),
    face_count: finite(quality.faceCount),
    yaw_deg: finite(quality.yawDeg),
    pitch_deg: finite(quality.pitchDeg),
  };
}

/** The production gate, run unchanged, on a field sample. */
export function evaluateFieldObservation(
  observation: StandardFaceObservation,
): FrameQualityVerdict {
  return evaluateFrameQuality(
    observation.quality,
    observation.poseLabel,
    meanConfidence(observation.landmarkConfidence),
    observation.declaredQualityProfile,
    observation.source,
    observation.declaredProfileVersion,
  );
}

export async function runFieldCaptureSequence(
  pose: PoseLabel,
  consent: FieldConsentRecord | null,
  deps: FieldCaptureDeps,
  signal?: AbortSignal,
): Promise<FieldCaptureOutcome> {
  // First line of the function on purpose: nothing below it, including the
  // camera call, may run for a participant who has not agreed to be collected.
  if (!mayCollect(consent)) {
    throw captureError(
      FIELD_CONSENT_REQUIRED,
      'field capture requires an explicit research-collection consent record',
    );
  }

  assertFieldCaptureActive(signal);
  const observation = await deps.capture(pose);
  assertFieldCaptureActive(signal);
  const verdict = evaluateFieldObservation(observation);
  const metrics = fieldQualityRecord(observation);

  // Acquired before the network work so the photograph is of the moment the
  // geometry was measured, not of whenever the upload happened to finish.
  // Both conditions are required: consent, and a channel that actually exists.
  const rawChannel = mayRetainRawFrames(consent) ? deps.rawFrame : null;
  let handle: RawFrameHandle | null = null;
  let rawFrameErrorCode: string | null = null;
  if (rawChannel !== null) {
    try {
      handle = await rawChannel.capture();
    } catch (error) {
      // A photograph that could not be taken does not cost the participant
      // their pose: the geometry below is what the calibration needs. The
      // reason is kept and shown, never swallowed.
      rawFrameErrorCode = codeOf(error);
    }
  }

  try {
    assertFieldCaptureActive(signal);
    const payload = deps.serialise(observation);
    const sha256 = await deps.digest(payload);
    assertFieldCaptureActive(signal);
    const slot = await deps.createUpload({
      pose_label: pose,
      artifact_kind: 'LANDMARKS_FTOB',
      content_type: 'application/vnd.facetype.ftob',
      content_length: payload.byteLength,
      sha256,
    });
    assertFieldCaptureActive(signal);
    await deps.upload(slot, payload);
    assertFieldCaptureActive(signal);

    // Same ordering rule as production: an observation row must never point at
    // an artifact the store did not accept.
    const serverVerdict = await deps.registerObservation({
      client_observation_id: observation.observationId,
      pose_label: pose,
      provider: observation.source,
      timestamp_ms: observation.timestampMs,
      artifact_id: slot.artifact_id,
      artifact_kind: 'LANDMARKS_FTOB',
      quality: metrics,
      declared_quality_profile: observation.declaredQualityProfile,
      declared_profile_version: observation.declaredProfileVersion,
      sha256,
    });

    let rawFrameSent = false;
    let rawFrameUploaded = false;
    assertFieldCaptureActive(signal);
    if (rawChannel !== null && handle !== null) {
      try {
        const rawSlot = await deps.createUpload({
          pose_label: pose,
          artifact_kind: 'RAW_FRAME',
          content_type: RAW_FRAME_CONTENT_TYPE,
          content_length: handle.byteLength,
          // Computed natively over the exact bytes, so the slot is signed for
          // what will actually be sent rather than for what JS re-derives.
          sha256: handle.sha256,
        });
        assertFieldCaptureActive(signal);
        const rawBytes = await rawChannel.read(handle);
        assertFieldCaptureActive(signal);
        await deps.upload(rawSlot, rawBytes);
        // The bytes are out of the device from here, whatever happens next.
        rawFrameSent = true;
        assertFieldCaptureActive(signal);
        // Only after the PUT, and only after this resolves. The same ordering
        // rule the geometry path uses: nothing is recorded as stored before the
        // store has it, and nothing is *reported* as stored before the server
        // has said so.
        await deps.completeRawUpload({
          artifact_id: rawSlot.artifact_id,
          sha256: handle.sha256,
          // Restated so the server checks them against its own declaration
          // rather than adopting them. A mismatch is refused there.
          content_length: handle.byteLength,
          content_type: RAW_FRAME_CONTENT_TYPE,
        });
        rawFrameUploaded = true;
      } catch (error) {
        rawFrameErrorCode = codeOf(error);
      }
    }

    assertFieldCaptureActive(signal);
    return {
      atMs: deps.now(),
      gatePassed: verdict.pass,
      gateFailures: [...verdict.failures],
      serverAccepted: serverVerdict.accepted,
      serverFailures: [...serverVerdict.failures],
      metrics,
      rawFrameSent,
      rawFrameUploaded,
      rawFrameErrorCode,
      observationId: observation.observationId,
      errorCode: null,
      verdict,
    };
  } finally {
    // Success, geometry failure, raw-upload failure, a thrown transport error
    // and a cancelled promise all land here. The native slot is single-use and
    // the bytes are a stranger's face; nothing gets to keep them because a
    // later step did not run.
    if (rawChannel !== null && handle !== null) {
      try {
        await rawChannel.discard(handle);
      } catch {
        // The native side also discards on host pause, stop and invalidate, so
        // a failed explicit discard is covered rather than final. There is
        // nothing further this path can do about it, and throwing from a
        // `finally` would replace the real error with this one.
      }
    }
  }
}

/** The code an error carries, without parsing any message text. */
function codeOf(error: unknown): string {
  const carried = (error as { code?: unknown } | null)?.code;
  return typeof carried === 'string' && carried.length > 0 ? carried : 'FT-SYS-003';
}
