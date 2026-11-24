/**
 * FaceType AI API contracts.
 *
 * The generated client under `generated/` is the only supported way for the
 * mobile and web apps to call the API (FT-04 §11) — no hand-written endpoint
 * strings anywhere. Everything in this file is hand-written *around* that
 * client: helpers that encode contract rules the generator cannot infer.
 */

export * from '../generated/index.ts';

// The FT-03 quality gate and its shared threshold artifact. It lives in the
// contracts package for the same reason the API client does: it is a rule both
// the app and the server have to agree on, and a second hand-written copy is
// exactly how they stop agreeing.
export * from './quality.ts';

// The client-app capture gate: one config object that guidance, the native
// camera and the server's per-frame metadata all name by the same hash.
export * from './clientGate.ts';

import { FaceTypeApiError, FaceTypeClient, type ClientOptions } from '../generated/client.ts';
import type { ResultResponse } from '../generated/types.ts';

/** Terminal result states (FT-02 §2). */
export const RESULT_STATUSES = [
  'COMPLETED',
  'ABSTAINED',
  'RETAKE_REQUIRED',
  'MODEL_UNAVAILABLE',
  'FAILED',
  'DELETED',
] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

/** The five guided poses of `cap-1.0.0` (FT-03 §3). */
export const REQUIRED_POSES = ['front', 'left_25', 'right_25', 'up_15', 'down_15'] as const;
export type PoseLabel = (typeof REQUIRED_POSES)[number];

/**
 * Client actions an error envelope may ask for (FT-09).
 *
 * `UNKNOWN` exists because FT-04 §12 requires clients to tolerate enum
 * additions: an unrecognised action must degrade, never crash.
 */
export type ErrorAction =
  | 'NONE'
  | 'LOGIN_OR_NEW_SESSION'
  | 'REFRESH'
  | 'MFA'
  | 'UPDATE_APP'
  | 'RETAKE'
  | 'RETAKE_POSE'
  | 'RELAX_FACE'
  | 'REUPLOAD'
  | 'RESTART_SCAN'
  | 'RETRY'
  | 'ABSTAIN'
  | 'MODEL_UNAVAILABLE'
  | 'CONSENT'
  | 'WAIT'
  | 'UPGRADE_OR_WAIT'
  | 'CONTACT_ADMIN'
  | 'REFERENCE_ID'
  | 'UNKNOWN';

/** Narrow an unknown action string, per the FT-04 §12 unknown-enum rule. */
export function toErrorAction(value: unknown): ErrorAction {
  const known: ErrorAction[] = [
    'NONE', 'LOGIN_OR_NEW_SESSION', 'REFRESH', 'MFA', 'UPDATE_APP', 'RETAKE',
    'RETAKE_POSE', 'RELAX_FACE', 'REUPLOAD', 'RESTART_SCAN', 'RETRY', 'ABSTAIN',
    'MODEL_UNAVAILABLE', 'CONSENT', 'WAIT', 'UPGRADE_OR_WAIT', 'CONTACT_ADMIN',
    'REFERENCE_ID',
  ];
  return known.includes(value as ErrorAction) ? (value as ErrorAction) : 'UNKNOWN';
}

/** The pose a `RETAKE_POSE` error is asking the user to redo, if any. */
export function retakePose(error: unknown): PoseLabel | null {
  if (!(error instanceof FaceTypeApiError)) return null;
  const action = error.action;
  if (toErrorAction(action.type) !== 'RETAKE_POSE') return null;
  const pose = action.pose;
  return REQUIRED_POSES.includes(pose as PoseLabel) ? (pose as PoseLabel) : null;
}

/**
 * Whether a result may display a personality type.
 *
 * This is a *contract* check, not a UI preference: FT-02 §2 permits a headline
 * type only on a COMPLETED result that actually carries one. Any other state —
 * abstained, model unavailable, retake — must render its own explanation and no
 * type at all, not a greyed-out guess.
 */
export function canDisplayType(result: ResultResponse): boolean {
  return result.status === 'COMPLETED' && Boolean(result.personality?.top_type);
}

/**
 * Confidence bucket for display (FT-07 §5 ConfidenceBadge).
 *
 * A numeric confidence is only ever shown alongside a promoted model's output,
 * and never as 100% — calibration governs the actual range (FT-02 §7).
 */
export function confidenceBucket(confidence: number | null | undefined): 'low' | 'medium' | 'high' | 'unknown' {
  if (confidence === null || confidence === undefined) return 'unknown';
  if (confidence < 0.45) return 'low';
  if (confidence < 0.7) return 'medium';
  return 'high';
}

/** Build a configured client. */
export function createClient(options: ClientOptions): FaceTypeClient {
  return new FaceTypeClient(options);
}

export { FaceTypeApiError, FaceTypeClient };
export type { ClientOptions };
