/**
 * Attempt telemetry (capture-spec-v2 §5, docs/client-app-v1.md §6): one
 * POST /attempts per capture attempt, sent only once its outcome is known —
 * the server's verdict on the uploaded burst (stored / received /
 * needs_retake), or the attempt ending without one (cancel, time-out, camera
 * permission refused, an enqueued capture abandoned). Never at enqueue time:
 * «stored» before the upload would be a claim nobody has checked.
 *
 * No images, landmarks or identifiers: durations, counts and the device model.
 * Reject reasons go on the wire in snake_case (native contract §5.17).
 */

import type { AttemptOutcome, AttemptTelemetry } from './api/types.ts';
import type { CameraCapabilities, RejectReason } from './native/types.ts';
import type { SpoolStage } from './spool/manifest.ts';

/** Native check name → the server's snake_case reason key (contract §5.17). */
export const WIRE_REASONS: Readonly<Record<RejectReason, string>> = {
  oneFace: 'one_face',
  distanceOrSize: 'distance_or_size',
  centred: 'centred',
  facing: 'facing',
  light: 'light',
  expression: 'expression',
  eyes: 'eyes',
  sharp: 'sharp',
  effects_active: 'effects_active',
  internal: 'internal',
};

/** The server's reason-key rule (`ClientAttemptInput.reason_counts`). */
const WIRE_KEY = /^[a-z0-9_]{1,40}$/;
/** The server accepts at most this many distinct reasons per attempt. */
export const MAX_REASON_KEYS = 64;

/** snake_case wire key for a native reason; null when it cannot be one. */
export function wireReason(reason: string): string | null {
  const known = (WIRE_REASONS as Record<string, string>)[reason];
  if (known) return known;
  // A reason added natively later: camelCase → snake_case, else dropped.
  const snake = reason.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return WIRE_KEY.test(snake) ? snake : null;
}

/** Native-keyed counts → wire-keyed counts (merged, invalid keys dropped, capped). */
export function wireReasonCounts(counts: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [reason, count] of Object.entries(counts)) {
    const key = wireReason(reason);
    if (!key || !Number.isInteger(count) || count < 0) continue;
    if (!(key in out) && Object.keys(out).length >= MAX_REASON_KEYS) continue;
    out[key] = (out[key] ?? 0) + count;
  }
  return out;
}

/** The device descriptor attempts carry (no identifiers). */
export function attemptDevice(caps: CameraCapabilities | null, platform: string): Record<string, unknown> {
  return caps
    ? { platform: caps.platform, model: caps.deviceModel, manufacturer: caps.manufacturer, os_version: caps.osVersion }
    : { platform };
}

/** Everything about an enqueued attempt except its outcome, kept in the spool manifest until the verdict. */
export type PendingAttempt = Omit<AttemptTelemetry, 'outcome'>;

export function pendingAttempt(input: {
  startedAtMs: number;
  nowMs: number;
  attempts: number;
  reasonCounts: Readonly<Record<string, number>>;
  device: Record<string, unknown>;
}): PendingAttempt {
  return {
    duration_ms: Math.max(0, Math.min(3_600_000, Math.round(input.nowMs - input.startedAtMs))),
    attempts: Math.max(0, input.attempts),
    reason_counts: wireReasonCounts(input.reasonCounts),
    device: input.device,
  };
}

/** The outcome an enqueued attempt reports once its spool stage is terminal; null while it is not. */
export function outcomeForStage(stage: SpoolStage): AttemptOutcome | null {
  switch (stage) {
    case 'stored':
    case 'received':
    case 'needs_retake':
      return stage;
    case 'failed':
    case 'abandoned':
      return 'abandoned';
    default:
      return null;
  }
}

export function isPendingAttempt(value: unknown): value is PendingAttempt {
  const v = value as PendingAttempt;
  return (
    typeof v === 'object' &&
    v !== null &&
    Number.isInteger(v.duration_ms) &&
    Number.isInteger(v.attempts) &&
    typeof v.reason_counts === 'object' &&
    v.reason_counts !== null &&
    Object.entries(v.reason_counts).every(([key, count]) => WIRE_KEY.test(key) && Number.isInteger(count)) &&
    typeof v.device === 'object' &&
    v.device !== null
  );
}
