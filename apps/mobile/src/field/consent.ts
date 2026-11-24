/**
 * Field-study consent, as a value that fails closed.
 *
 * TWO SEPARATE PERMISSIONS, NOT ONE WITH A SUB-OPTION.
 *
 *  - `researchCollection` authorises the collection at all: the geometry, the
 *    quality metrics and the fact that this participant was scanned.
 *  - `rawFrameRetention` authorises a photograph of the participant's face to
 *    leave the device and be stored.
 *
 * They are asked separately and answered separately because they are different
 * disclosures with different consequences, and because a participant who is
 * willing to contribute geometry but not a photograph must be able to say
 * exactly that. Declining the second one is a supported, complete state — the
 * session still collects everything the calibration actually needs.
 *
 * WHY EVERY CHECK IS `=== true`. This module is the only thing standing between
 * "the operator has not answered yet" and "a photograph of a stranger's face
 * has been uploaded". A truthy test accepts `"false"`, `"0"`, `1` and `{}` —
 * every one of which is what a restored JSON blob, a native bridge or a
 * mistyped prop hands you (the same class of defect as commit ee076f8, where a
 * build declaration arrived as the string `"false"` and read as true). The
 * grant is a typed boolean or it is not a grant.
 *
 * WHERE THE NUMBERS COME FROM. `policyVersion` and `rawPhotoRetentionDays` are
 * the server's, read from `GET /field-study/policy` and narrowed to the joined
 * session. They are not build configuration and they are not defaults: a
 * consent that states a period the deployment does not implement is not an
 * informed consent, and there is no value here the app could have chosen.
 */

import { isParticipantRef } from './participantRef.ts';

export interface FieldConsentRecord {
  /** The pseudonymous reference this consent belongs to. */
  participantRef: string;
  /** Required. Without it nothing at all may be collected. */
  researchCollection: boolean;
  /** Separate opt-in. Without it no raw frame may be created or uploaded. */
  rawFrameRetention: boolean;
  /** The exact wording the participant agreed to. Server-supplied. */
  policyVersion: string;
  /**
   * The photograph retention period that wording stated, in days.
   *
   * Server-supplied, and `0` on a deployment that retains no photograph — in
   * which case `mayRetainRawFrames` is false whatever the grant says, because
   * a photograph kept for zero days is not a photograph anybody can consent to
   * keeping. There is deliberately no *geometry* retention period here: the
   * platform contract defines none, and a field the app filled in itself would
   * be the app promising a period on the deployment's behalf.
   */
  rawPhotoRetentionDays: number;
  /** Device clock, for the receipt. Never a location, never an operator id. */
  grantedAtMs: number;
}

/** A grant is a literal `true`. Everything else — including truthy — is not. */
function granted(value: unknown): boolean {
  return value === true;
}

function positiveNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** A retention period: a whole number of days, possibly zero, never negative. */
function wholeDays(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The floor both permissions stand on: a real, well-formed consent record for
 * a real, opaque participant reference, agreed under a named policy version.
 */
function isWellFormed(record: unknown): record is FieldConsentRecord {
  if (typeof record !== 'object' || record === null) return false;
  const candidate = record as Partial<FieldConsentRecord>;
  return (
    isParticipantRef(candidate.participantRef) &&
    typeof candidate.policyVersion === 'string' &&
    candidate.policyVersion.trim().length > 0 &&
    wholeDays(candidate.rawPhotoRetentionDays) &&
    positiveNumber(candidate.grantedAtMs)
  );
}

/**
 * May this session collect geometry, quality metrics and observations at all?
 *
 * `false` for a missing record, a malformed one, or one whose research grant is
 * anything other than `true`.
 */
export function mayCollect(record: FieldConsentRecord | null | undefined): boolean {
  return isWellFormed(record) && granted(record.researchCollection);
}

/**
 * May this session create, upload or retain a raw face photograph?
 *
 * Strictly narrower than `mayCollect`: the research grant is a precondition, so
 * a raw-frame opt-in on its own can never authorise anything. The stated
 * raw-frame retention period must also be a real number, because a photograph
 * kept for an unstated period is not one anybody consented to.
 */
export function mayRetainRawFrames(record: FieldConsentRecord | null | undefined): boolean {
  return (
    mayCollect(record) &&
    granted((record as FieldConsentRecord).rawFrameRetention) &&
    positiveNumber((record as FieldConsentRecord).rawPhotoRetentionDays)
  );
}

/**
 * Build a consent record, or return `null` if what was answered does not
 * amount to one.
 *
 * Construction is the second gate rather than the only one: `mayCollect` and
 * `mayRetainRawFrames` re-check everything, because a record can also arrive
 * from restored storage or a prop, never having passed through here.
 */
export function buildFieldConsentRecord(input: {
  participantRef: string;
  researchCollection: boolean;
  rawFrameRetention: boolean;
  policyVersion: string;
  rawPhotoRetentionDays: number;
  grantedAtMs: number;
}): FieldConsentRecord | null {
  const record: FieldConsentRecord = {
    participantRef: input.participantRef,
    researchCollection: granted(input.researchCollection),
    // A raw-frame opt-in is discarded outright when the research grant is
    // absent, so the record cannot even represent the contradictory state.
    rawFrameRetention: granted(input.researchCollection) && granted(input.rawFrameRetention),
    policyVersion: input.policyVersion,
    rawPhotoRetentionDays: input.rawPhotoRetentionDays,
    grantedAtMs: input.grantedAtMs,
  };
  return mayCollect(record) ? record : null;
}
