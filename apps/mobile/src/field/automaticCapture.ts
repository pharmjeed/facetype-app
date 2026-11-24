import type { PoseLabel, StandardFaceObservation } from '../capture/types.ts';
import { captureError } from '../capture/captureError.ts';
import { assertFieldCaptureActive, evaluateFieldObservation } from './fieldCapture.ts';

export const AUTOMATIC_QUALITY_TIMEOUT = 'FIELD_AUTOMATIC_QUALITY_TIMEOUT';

export interface AutomaticCaptureFeedback {
  failureCode: string | null;
  consecutive: number;
}

const RETRYABLE_QUALITY_CODES = new Set([
  'FT-SCAN-004', 'FT-SCAN-005', 'FT-SCAN-006', 'FT-SCAN-007',
  'FT-SCAN-008', 'FT-SCAN-009', 'FT-SCAN-010', 'FT-SCAN-011', 'FT-SCAN-014',
]);

/** A bounded, serial measurement loop. Rejected candidates stay on device;
 * no upload, photo retention or consent decision happens in this function. */
export async function waitForQualifiedObservation(
  pose: PoseLabel,
  capture: (pose: PoseLabel) => Promise<StandardFaceObservation>,
  signal: AbortSignal,
  wait: (signal: AbortSignal) => Promise<void> = waitBetweenMeasurements,
  onFeedback: (feedback: AutomaticCaptureFeedback) => void = () => {},
): Promise<StandardFaceObservation> {
  let previousId: string | null = null;
  let stable = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assertFieldCaptureActive(signal);
    let candidate: StandardFaceObservation;
    try {
      candidate = await capture(pose);
    } catch (error) {
      assertFieldCaptureActive(signal);
      const code = (error as { code?: string } | null)?.code;
      if (!code || !RETRYABLE_QUALITY_CODES.has(code)) throw error;
      onFeedback({ failureCode: code, consecutive: 0 });
      stable = 0;
      previousId = null;
      if (attempt < 19) await wait(signal);
      continue;
    }
    assertFieldCaptureActive(signal);
    const verdict = evaluateFieldObservation(candidate);
    const passing = candidate.poseLabel === pose && verdict.pass;
    // The same cached observation is not a second independent measurement.
    stable = passing && candidate.observationId !== previousId ? stable + 1 : 0;
    previousId = candidate.observationId;
    onFeedback({
      failureCode: candidate.poseLabel !== pose ? 'FT-SCAN-011' : verdict.failures[0] ?? null,
      consecutive: stable,
    });
    if (stable >= 2) return candidate;
    if (attempt < 19) await wait(signal);
  }
  throw captureError(AUTOMATIC_QUALITY_TIMEOUT, 'No stable qualifying pose; adjust position and retry.');
}

export function waitBetweenMeasurements(signal: AbortSignal): Promise<void> {
  assertFieldCaptureActive(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      try { assertFieldCaptureActive(signal); } catch (error) { reject(error); }
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, 700);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
