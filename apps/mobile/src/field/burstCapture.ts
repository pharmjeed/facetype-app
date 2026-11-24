/** Select the strongest of a short, sequential on-device burst.
 *
 * Only the selected geometry leaves the device.  A burst reduces blink and
 * motion-blur failures without weakening a threshold or manufacturing a pass.
 */
import { meanConfidence } from '@facetype/contracts';

import { POSE_TARGETS, type PoseLabel, type StandardFaceObservation } from '../capture/types.ts';
import { evaluateFieldObservation } from './fieldCapture.ts';

export const FIELD_BURST_SIZE = 3;

function finite(value: number | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function fieldObservationRank(observation: StandardFaceObservation): number {
  const verdict = evaluateFieldObservation(observation);
  const target = POSE_TARGETS[observation.poseLabel];
  const poseError =
    Math.abs(observation.quality.yawDeg - target.yaw) +
    Math.abs(observation.quality.pitchDeg - target.pitch);
  return (
    (verdict.pass ? 100 : 0) -
    verdict.failures.length * 10 +
    finite(observation.quality.blur) +
    finite(observation.quality.exposure) +
    finite(observation.quality.neutrality) +
    meanConfidence(observation.landmarkConfidence) -
    poseError / 100
  );
}

export async function captureBestFieldObservation(
  pose: PoseLabel,
  capture: (pose: PoseLabel) => Promise<StandardFaceObservation>,
  count = FIELD_BURST_SIZE,
): Promise<StandardFaceObservation> {
  if (!Number.isInteger(count) || count < 1) throw new RangeError('burst size must be positive');
  let best: StandardFaceObservation | null = null;
  let bestRank = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < count; index += 1) {
    const candidate = await capture(pose);
    const rank = fieldObservationRank(candidate);
    if (best === null || rank > bestRank) {
      best = candidate;
      bestRank = rank;
    }
  }
  return best!;
}
