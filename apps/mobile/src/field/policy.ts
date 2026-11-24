/**
 * The field-study policy, as the server states it — and the only source of the
 * retention promise a participant is read.
 *
 * WHAT CHANGED AND WHY. This lane used to state a retention period compiled
 * into the bundle, optionally corrected by `GET /privacy/retention-status`. Two
 * things were wrong with that. The build-time number is a number somebody wrote
 * down months ago on a machine that is not this deployment, and a consent that
 * states it is a promise the deployment has not made. And the correction was
 * best-effort: a refusal or a transport failure left the stale figure in place
 * and the session carried on. So the app told participants a period, and the
 * server enforced a different one, and nothing in either place noticed.
 *
 * `GET /api/v1/field-study/policy` is the deployment's own answer to exactly
 * the question the consent screen asks, and it is now a precondition rather
 * than an improvement: no policy, no field session, no camera. There is no
 * fallback, because the only available fallback was the thing that was wrong.
 *
 * WHAT IS DELIBERATELY NOT PROMISED. The policy document defines a raw-photo
 * retention period and nothing else. It carries no geometry or quality-metric
 * retention period, so this module produces none and the consent copy states
 * none — an invented figure is exactly the defect above, wearing a different
 * number. What the participant is told about geometry is what is actually true:
 * it is kept for the study under a named consent version, and deletion is
 * requested through the operator against their reference.
 *
 * FAIL-CLOSED, INCLUDING AGAINST AN INTERNALLY CONTRADICTORY ANSWER. A policy
 * whose `raw_photo_retention_enabled` disagrees with its
 * `raw_photo_retention_days`, or whose days exceed the deployment's own stated
 * ceiling, is not a document to pick the safer half of: it means the field the
 * consent screen is about to quote cannot be trusted, so the lane refuses to
 * open at all. A policy that is merely *disabled* is not contradictory — it is
 * the production default — and it fails closed in the narrower way it should:
 * the photograph question is not asked, and no raw frame can be created.
 *
 * Framework-free and unit-tested directly.
 */

import type { FieldSessionResponse, FieldStudyPolicyResponse } from '@facetype/contracts';

import { POSES, type PoseLabel } from '../capture/types.ts';

/** Client-local refusals. Deliberately not shaped like server FT codes. */
export const FIELD_POLICY_UNAVAILABLE = 'FIELD_POLICY_UNAVAILABLE';
export const FIELD_POLICY_MALFORMED = 'FIELD_POLICY_MALFORMED';
export const FIELD_POLICY_RETENTION_INCONSISTENT = 'FIELD_POLICY_RETENTION_INCONSISTENT';
export const FIELD_POLICY_PROTOCOL_UNSUPPORTED = 'FIELD_POLICY_PROTOCOL_UNSUPPORTED';
export const FIELD_SESSION_NOT_OPEN = 'FIELD_SESSION_NOT_OPEN';

export type FieldPolicyRejection =
  | typeof FIELD_POLICY_UNAVAILABLE
  | typeof FIELD_POLICY_MALFORMED
  | typeof FIELD_POLICY_RETENTION_INCONSISTENT
  | typeof FIELD_POLICY_PROTOCOL_UNSUPPORTED
  | typeof FIELD_SESSION_NOT_OPEN;

/**
 * The terms this device will collect under, every field of which came from the
 * server. There is no constructor that can produce one from build config.
 */
export interface FieldStudyPolicy {
  /** The protocol the scan is created under. Not a client constant. */
  captureProtocol: string;
  /** The exact consent wording version the server will record. */
  consentPolicyVersion: string;
  /** Days a consented photograph is kept. `0` means none is kept at all. */
  rawPhotoRetentionDays: number;
  /** Whether any photograph may outlive processing on this deployment. */
  rawPhotoRetentionEnabled: boolean;
  /** The deployment's own ceiling, used to bound everything above. */
  maxRawPhotoRetentionDays: number;
  /** The frozen five, as the server names them. */
  requiredPoses: PoseLabel[];
}

export type FieldPolicyResult =
  | { ok: true; policy: FieldStudyPolicy }
  | { ok: false; reason: FieldPolicyRejection };

/** `capture_protocol` and `consent_policy_version` are `max_length=32` server-side. */
const MAX_VERSION_LENGTH = 32;

function boundedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_VERSION_LENGTH) return null;
  return trimmed;
}

/** A retention period is a whole number of days, and never negative. */
function wholeDays(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/**
 * The five poses, whatever order the server lists them in.
 *
 * Compared as a set rather than as a sequence: the order a protocol lists its
 * poses in is presentation, and the operator's screen chooses its own. A
 * *different* set is a different protocol, and this build's capture screen,
 * reducer and receipt are all written around exactly these five.
 */
function sameFivePoses(value: unknown): PoseLabel[] | null {
  if (!Array.isArray(value)) return null;
  const named = new Set(value.filter((entry): entry is string => typeof entry === 'string'));
  if (named.size !== POSES.length) return null;
  for (const pose of POSES) {
    if (!named.has(pose)) return null;
  }
  return [...POSES];
}

/**
 * Turn `GET /field-study/policy` into the terms this device may collect under,
 * or say why it may not collect at all.
 *
 * Every refusal is a distinct code because they call for different actions: a
 * malformed document is a deployment or client-version problem for the study
 * lead, an inconsistent retention pair is a server misconfiguration, and an
 * unsupported protocol means this handset's build is the wrong one for this
 * study. "Field mode is unavailable" would have told the operator none of that.
 */
export function resolveFieldStudyPolicy(
  response: FieldStudyPolicyResponse | null | undefined,
): FieldPolicyResult {
  if (typeof response !== 'object' || response === null) {
    return { ok: false, reason: FIELD_POLICY_MALFORMED };
  }

  const captureProtocol = boundedString(response.capture_protocol);
  const consentPolicyVersion = boundedString(response.consent_policy_version);
  if (captureProtocol === null || consentPolicyVersion === null) {
    return { ok: false, reason: FIELD_POLICY_MALFORMED };
  }

  const requiredPoses = sameFivePoses(response.required_poses);
  if (requiredPoses === null) {
    return { ok: false, reason: FIELD_POLICY_PROTOCOL_UNSUPPORTED };
  }

  const maxRawPhotoRetentionDays = wholeDays(response.max_raw_photo_retention_days);
  const rawPhotoRetentionDays = wholeDays(response.raw_photo_retention_days);
  if (maxRawPhotoRetentionDays === null || rawPhotoRetentionDays === null) {
    return { ok: false, reason: FIELD_POLICY_MALFORMED };
  }
  if (typeof response.raw_photo_retention_enabled !== 'boolean') {
    return { ok: false, reason: FIELD_POLICY_MALFORMED };
  }

  const consistent =
    response.raw_photo_retention_enabled === (rawPhotoRetentionDays > 0) &&
    rawPhotoRetentionDays <= maxRawPhotoRetentionDays;
  if (!consistent) {
    return { ok: false, reason: FIELD_POLICY_RETENTION_INCONSISTENT };
  }

  return {
    ok: true,
    policy: {
      captureProtocol,
      consentPolicyVersion,
      rawPhotoRetentionDays,
      rawPhotoRetentionEnabled: response.raw_photo_retention_enabled,
      maxRawPhotoRetentionDays,
      requiredPoses,
    },
  };
}

/**
 * Narrow the deployment policy to the session that was actually joined.
 *
 * The session carries its own consent wording version and its own retention
 * period, and the server already takes the *lower* of the session's figure and
 * the deployment's before enforcing anything. Those are the numbers that will
 * be written against this participant's consent fact and against this
 * participant's photograph, so those are the numbers the consent screen states
 * — not the deployment-wide ones, which may be more generous than what this
 * particular session will really do.
 *
 * A session claiming a longer retention than the deployment permits is refused
 * rather than clamped. Clamping would quietly show a period the operator did
 * not configure; the disagreement means one of the two is wrong, and neither is
 * a safe thing to read to somebody about a photograph of their face.
 */
export function narrowPolicyToSession(
  policy: FieldStudyPolicy,
  session: FieldSessionResponse | null | undefined,
): FieldPolicyResult {
  if (typeof session !== 'object' || session === null) {
    return { ok: false, reason: FIELD_POLICY_MALFORMED };
  }
  if (typeof session.session_id !== 'string' || session.session_id.trim().length === 0) {
    return { ok: false, reason: FIELD_POLICY_MALFORMED };
  }
  if (session.status !== 'OPEN') {
    return { ok: false, reason: FIELD_SESSION_NOT_OPEN };
  }

  const consentPolicyVersion = boundedString(session.consent_policy_version);
  if (consentPolicyVersion === null) {
    return { ok: false, reason: FIELD_POLICY_MALFORMED };
  }

  const rawPhotoRetentionDays = wholeDays(session.raw_photo_retention_days);
  if (rawPhotoRetentionDays === null) {
    return { ok: false, reason: FIELD_POLICY_MALFORMED };
  }
  if (typeof session.raw_photo_retention_enabled !== 'boolean') {
    return { ok: false, reason: FIELD_POLICY_MALFORMED };
  }

  const consistent =
    session.raw_photo_retention_enabled === (rawPhotoRetentionDays > 0) &&
    rawPhotoRetentionDays <= policy.maxRawPhotoRetentionDays &&
    rawPhotoRetentionDays <= policy.rawPhotoRetentionDays;
  if (!consistent) {
    return { ok: false, reason: FIELD_POLICY_RETENTION_INCONSISTENT };
  }

  return {
    ok: true,
    policy: {
      ...policy,
      consentPolicyVersion,
      rawPhotoRetentionDays,
      rawPhotoRetentionEnabled: session.raw_photo_retention_enabled,
    },
  };
}

/**
 * Whether the photograph question may be put to a participant at all.
 *
 * A deployment that retains nothing must not ask it. Asking would obtain a
 * grant for something that cannot happen, and the receipt would then have to
 * explain why the photographs the participant agreed to do not exist.
 */
export function mayOfferPhotoConsent(policy: FieldStudyPolicy | null | undefined): boolean {
  return (
    typeof policy === 'object' &&
    policy !== null &&
    policy.rawPhotoRetentionEnabled === true &&
    policy.rawPhotoRetentionDays > 0
  );
}
