/**
 * Field-study session state — a pure reducer, one participant at a time.
 *
 * WHAT MAKES THIS DIFFERENT FROM `state/scanFlow.ts`, AND WHY IT IS A SECOND
 * MACHINE RATHER THAN A FLAG ON THE FIRST ONE.
 *
 *  1. It has no result state. There is no `status`, no `retakePose`, no place
 *     to put a `ResultResponse` and no screen that could render one. A field
 *     capture must never present a personality inference, and the strongest
 *     way to guarantee that is a machine in which no such value is
 *     representable — not a screen that chooses not to draw one.
 *  2. Its disposition is a constant. Everything this machine produces is
 *     `CALIBRATION_PROVISIONAL_QUARANTINED`, there is no event that changes it,
 *     and the banner and the receipt both read it from here.
 *  3. A pose that FAILS the production quality gate is still *recorded*. That
 *     is the point of a calibration session: the sample that failed is the
 *     evidence about why the threshold is where it is. The failure is not
 *     discarded, softened or converted into a pass — every attempt keeps its
 *     own verdict, its own failure codes and its own measured signals, and the
 *     session stays provisional regardless.
 *  4. `resetForNextParticipant` returns the initial state, not an edited one.
 *     The whole reason a field session is fast is that an operator moves
 *     straight to the next person, and the whole risk of that is one
 *     participant's reference, consent or geometry surviving into the next
 *     one's record. Rebuilding from `initialFieldSession` means a field added
 *     later is cleared by construction rather than by somebody remembering to
 *     add it to a reset list.
 *
 * Framework-free and unit-tested directly, like the production flow reducer.
 */

import { POSES, type PoseLabel } from '../capture/types.ts';
import { mayCollect, type FieldConsentRecord } from './consent.ts';
import { isParticipantRef } from './participantRef.ts';

/**
 * What a field capture is, and the only thing it is ever allowed to be.
 *
 * Not a status the server returns and not a value any event can set: this
 * lane exists to gather calibration evidence, and nothing it produces is a
 * validated measurement of anything about a person.
 */
export const FIELD_DISPOSITION = 'CALIBRATION_PROVISIONAL_QUARANTINED' as const;
export type FieldDisposition = typeof FIELD_DISPOSITION;

export type FieldScreen = 'setup' | 'capture' | 'receipt';

/** Where one pose is in the capture -> upload -> registered progression. */
export type PoseStage = 'pending' | 'capturing' | 'uploading' | 'recorded' | 'failed';

/** One attempt at one pose, kept whether it succeeded or not. */
export interface FieldPoseAttempt {
  /** 1-based within this pose. */
  attempt: number;
  atMs: number;
  outcome: 'recorded' | 'failed';
  /** The FT code for an attempt that produced no observation at all. */
  errorCode: string | null;
  /** The production client gate's verdict. `false` is kept, never repaired. */
  gatePassed: boolean | null;
  gateFailures: string[];
  /** The server's own verdict for the registered observation. */
  serverAccepted: boolean | null;
  serverFailures: string[];
  /** The signals exactly as sent; `null` means unmeasured, never zero. */
  metrics: Record<string, number | null> | null;
  /** A photograph left the device. What the participant's receipt counts. */
  rawFrameSent: boolean;
  /** The server confirmed the stored bytes. What the operator's console shows. */
  rawFrameUploaded: boolean;
  /** Why the consented photograph did not happen, when one was expected. */
  rawFrameErrorCode: string | null;
  observationId: string | null;
}

export interface FieldPoseRecord {
  pose: PoseLabel;
  stage: PoseStage;
  /** Every attempt, oldest first. Nothing is dropped on a repeat. */
  attempts: FieldPoseAttempt[];
}

export interface FieldSessionState {
  screen: FieldScreen;
  /** Constant. Present in state so the UI cannot render anything else. */
  disposition: FieldDisposition;
  /**
   * The reference the *server* allocated, or `null` before it has.
   *
   * Never minted on the device. `PARTICIPANT_ALLOCATED` is the only event that
   * sets it, and it carries what `POST .../participants` returned.
   */
  participantRef: string | null;
  consent: FieldConsentRecord | null;
  scanId: string | null;
  /**
   * The scan is attributed to this participant on the server.
   *
   * Set only by `SCAN_ATTACHED`, which the container dispatches from the
   * response to `POST /sessions/{id}/captures`. Nothing may be uploaded until
   * it is true, because a scan that is not attached is an ordinary anonymous
   * scan the study cannot see and a raw frame must not be dated against.
   */
  attached: boolean;
  poses: FieldPoseRecord[];
  activePose: PoseLabel;
  /** A session-level failure (create scan, camera, transport). */
  errorCode: string | null;
  completedAtMs: number | null;
  /** Participants finished on this device since the field session opened. */
  participantsCompleted: number;
  /** Server-requested fresh poses after cross-view or P03 failure. */
  retakeRequired: PoseLabel[];
}

export type FieldSessionEvent =
  | { type: 'PARTICIPANT_ALLOCATED'; participantRef: string }
  | { type: 'CONSENT_RECORDED'; consent: FieldConsentRecord }
  | { type: 'SCAN_ATTACHED'; scanId: string }
  | { type: 'POSE_SELECTED'; pose: PoseLabel }
  | { type: 'POSE_CAPTURING'; pose: PoseLabel }
  | { type: 'POSE_UPLOADING'; pose: PoseLabel }
  | {
      type: 'POSE_RECORDED';
      pose: PoseLabel;
      attempt: Omit<FieldPoseAttempt, 'attempt' | 'outcome'>;
    }
  | { type: 'POSE_FAILED'; pose: PoseLabel; atMs: number; errorCode: string }
  | { type: 'SESSION_ERROR'; errorCode: string }
  | { type: 'SESSION_ERROR_CLEARED' }
  | { type: 'PROCESSING_RETAKE_REQUIRED'; poses: PoseLabel[]; errorCode: string | null }
  | { type: 'COMPLETE'; atMs: number }
  | { type: 'NEXT_PARTICIPANT' }
  | { type: 'ABORT' };

function freshPoses(): FieldPoseRecord[] {
  return POSES.map((pose) => ({ pose, stage: 'pending' as PoseStage, attempts: [] }));
}

/** A session with nothing in it, for the next participant. */
export function initialFieldSession(participantsCompleted = 0): FieldSessionState {
  return {
    screen: 'setup',
    disposition: FIELD_DISPOSITION,
    participantRef: null,
    consent: null,
    scanId: null,
    attached: false,
    poses: freshPoses(),
    activePose: POSES[0],
    errorCode: null,
    completedAtMs: null,
    participantsCompleted,
    retakeRequired: [],
  };
}

function withPose(
  state: FieldSessionState,
  pose: PoseLabel,
  update: (record: FieldPoseRecord) => FieldPoseRecord,
): FieldSessionState {
  let changed = false;
  const poses = state.poses.map((record) => {
    if (record.pose !== pose) return record;
    changed = true;
    return update(record);
  });
  return changed ? { ...state, poses } : state;
}

/** The next pose still needing a sample, or the one just done when all are. */
function poseIsQualified(record: FieldPoseRecord): boolean {
  return record.attempts.some(
    (attempt) =>
      attempt.outcome === 'recorded' &&
      attempt.gatePassed === true &&
      attempt.serverAccepted === true,
  );
}

function nextPendingPose(
  poses: FieldPoseRecord[],
  from: PoseLabel,
  retakeRequired: readonly PoseLabel[] = [],
): PoseLabel {
  const remaining = poses.filter(
    (record) => !poseIsQualified(record) || retakeRequired.includes(record.pose),
  );
  if (remaining.length === 0) return from;
  const after = remaining.find((record) => POSES.indexOf(record.pose) > POSES.indexOf(from));
  return (after ?? remaining[0]!).pose;
}

export function reduceFieldSession(
  state: FieldSessionState,
  event: FieldSessionEvent,
): FieldSessionState {
  switch (event.type) {
    case 'PARTICIPANT_ALLOCATED':
      // Allocated, not yet consented: the reference exists so the consent copy
      // can quote it, and nothing else has happened. The screen stays `setup`.
      if (!isParticipantRef(event.participantRef)) return state;
      return { ...state, participantRef: event.participantRef, errorCode: null };

    case 'CONSENT_RECORDED':
      // The gate, not a checkbox. A record that does not authorise collection
      // leaves the session on `setup` with nothing recorded against it. The
      // consent must also belong to the reference the server allocated: a
      // record for anybody else is a participant mix-up, and the strongest
      // answer to one is not to advance.
      if (!mayCollect(event.consent)) return state;
      if (state.participantRef === null || event.consent.participantRef !== state.participantRef) {
        return state;
      }
      return { ...state, screen: 'capture', consent: event.consent, errorCode: null };

    case 'SCAN_ATTACHED':
      // One event for both facts, because they are one fact: a scan this lane
      // knows about is a scan the server has already attributed. There is no
      // event that records a scan id without its attachment.
      return { ...state, scanId: event.scanId, attached: true, errorCode: null };

    case 'POSE_SELECTED':
      // Quick repeat: an already-recorded pose can be selected again, and the
      // extra sample is appended rather than replacing the first one.
      return { ...state, activePose: event.pose, errorCode: null };

    case 'POSE_CAPTURING':
      return withPose({ ...state, errorCode: null }, event.pose, (record) => ({
        ...record,
        stage: 'capturing',
      }));

    case 'POSE_UPLOADING':
      return withPose(state, event.pose, (record) => ({ ...record, stage: 'uploading' }));

    case 'POSE_RECORDED': {
      const advanced = withPose(state, event.pose, (record) => ({
        ...record,
        stage: 'recorded',
        attempts: [
          ...record.attempts,
          { ...event.attempt, attempt: record.attempts.length + 1, outcome: 'recorded' as const },
        ],
      }));
      const accepted = event.attempt.gatePassed === true && event.attempt.serverAccepted === true;
      const retakeRequired = accepted
        ? state.retakeRequired.filter((pose) => pose !== event.pose)
        : state.retakeRequired;
      return {
        ...advanced,
        retakeRequired,
        // A below-gate sample remains useful calibration evidence, but it does
        // not move the operator on and leave P03 with no usable input.
        activePose: accepted
          ? nextPendingPose(advanced.poses, event.pose, retakeRequired)
          : event.pose,
      };
    }

    case 'POSE_FAILED':
      // The pose stays capturable and the reason is kept. A failed attempt is
      // evidence too: it is why this participant's front pose took four tries.
      return withPose(state, event.pose, (record) => ({
        ...record,
        stage: 'failed',
        attempts: [
          ...record.attempts,
          {
            attempt: record.attempts.length + 1,
            atMs: event.atMs,
            outcome: 'failed' as const,
            errorCode: event.errorCode,
            gatePassed: null,
            gateFailures: [],
            serverAccepted: null,
            serverFailures: [],
            metrics: null,
            rawFrameSent: false,
            rawFrameUploaded: false,
            rawFrameErrorCode: null,
            observationId: null,
          },
        ],
      }));

    case 'SESSION_ERROR':
      return { ...state, errorCode: event.errorCode };

    case 'SESSION_ERROR_CLEARED':
      return state.errorCode === null ? state : { ...state, errorCode: null };

    case 'PROCESSING_RETAKE_REQUIRED': {
      const poses = event.poses.filter((pose): pose is PoseLabel => POSES.includes(pose));
      return {
        ...state,
        retakeRequired: [...new Set(poses)],
        activePose: poses[0] ?? state.activePose,
        errorCode: event.errorCode,
      };
    }

    case 'COMPLETE':
      // Terminal for this participant, and terminal in the only sense this
      // lane has: a receipt. There is no result to fetch and no job to poll.
      return { ...state, screen: 'receipt', completedAtMs: event.atMs };

    case 'NEXT_PARTICIPANT':
      return resetForNextParticipant(state);

    case 'ABORT':
      // Same erasure as a completed participant, without counting one.
      return initialFieldSession(state.participantsCompleted);

    default:
      return state;
  }
}

/**
 * Everything from this participant, gone; the counter, kept.
 *
 * Deliberately built from `initialFieldSession` rather than by clearing
 * fields: a field added to `FieldSessionState` later is cleared here whether or
 * not anybody remembers this function exists.
 */
export function resetForNextParticipant(state: FieldSessionState): FieldSessionState {
  const completed =
    state.screen === 'receipt' ? state.participantsCompleted + 1 : state.participantsCompleted;
  return initialFieldSession(completed);
}

/** Poses with at least one recorded sample. */
export function recordedPoses(state: FieldSessionState): PoseLabel[] {
  return state.poses.filter((record) => record.stage === 'recorded').map((record) => record.pose);
}

/** True once every pose in the frozen protocol has a sample. */
export function isParticipantComplete(state: FieldSessionState): boolean {
  return state.poses.every((record) => record.stage === 'recorded');
}

/** Every required pose has at least one client-and-server accepted sample. */
export function qualifiedPoses(state: FieldSessionState): PoseLabel[] {
  return state.poses
    .filter((record) => poseIsQualified(record) && !state.retakeRequired.includes(record.pose))
    .map((record) => record.pose);
}

export function isParticipantQualified(state: FieldSessionState): boolean {
  return qualifiedPoses(state).length === POSES.length;
}

/** Progress through the five poses, in [0, 1]. */
export function fieldProgress(state: FieldSessionState): number {
  return recordedPoses(state).length / POSES.length;
}

/** The most recent attempt at a pose, or null before the first one. */
export function latestAttempt(record: FieldPoseRecord): FieldPoseAttempt | null {
  return record.attempts[record.attempts.length - 1] ?? null;
}

/**
 * The receipt an operator shows a participant, and the only summary this lane
 * produces.
 *
 * It reports what was collected and under what terms. It reports no score, no
 * type, no confidence and no interpretation, because there is none: the
 * disposition is the whole verdict.
 *
 * It also no longer carries a scan id. It used to, as "the server deletion
 * handle", because the platform had no field for a participant reference and an
 * operator had to write the pairing down by hand. The server now allocates the
 * reference and the scan is attached to it, so the reference *is* the handle —
 * and handing a participant an internal scan id was always giving them the one
 * identifier they could do nothing with.
 */
export interface FieldReceipt {
  /** The reference the server allocated. The deletion request quotes this. */
  participantRef: string;
  disposition: FieldDisposition;
  /** The consent wording version the server recorded, not a build constant. */
  policyVersion: string;
  /**
   * The photograph retention period, in days, as the joined session states it.
   *
   * There is deliberately no geometry retention figure on this receipt. The
   * platform contract defines none, so the app has none to read out, and a
   * number invented here would be the product promising a period on the
   * deployment's behalf to somebody who cannot check it.
   */
  rawPhotoRetentionDays: number;
  rawFramesConsented: boolean;
  /**
   * Photographs that left the device.
   *
   * Counted from the PUT rather than from the server's confirmation: this line
   * is read to the participant, and "no photograph was stored" must not be
   * printed for a face that is sitting in an object store because a
   * bookkeeping call did not land.
   */
  rawFramesUploaded: number;
  /**
   * Photographs the server confirmed it is holding.
   *
   * Lower than [rawFramesUploaded] exactly when a PUT succeeded and the
   * completion call did not. The two are shown as two lines rather than
   * reconciled into one, because reconciling them means lying to somebody:
   * to the participant if the higher number is hidden, to the operator if the
   * lower one is.
   */
  rawFramesConfirmed: number;
  posesRecorded: number;
  posesTotal: number;
  /** Samples that did not pass the production gate but were kept anyway. */
  samplesBelowProductionGate: number;
  totalAttempts: number;
  completedAtMs: number | null;
}

export function buildFieldReceipt(state: FieldSessionState): FieldReceipt | null {
  const consent = state.consent;
  if (!mayCollect(consent) || consent === null || state.participantRef === null) return null;
  const attempts = state.poses.flatMap((record) => record.attempts);
  return {
    participantRef: state.participantRef,
    disposition: FIELD_DISPOSITION,
    policyVersion: consent.policyVersion,
    rawPhotoRetentionDays: consent.rawPhotoRetentionDays,
    rawFramesConsented: consent.rawFrameRetention === true,
    rawFramesUploaded: attempts.filter((attempt) => attempt.rawFrameSent).length,
    rawFramesConfirmed: attempts.filter((attempt) => attempt.rawFrameUploaded).length,
    posesRecorded: recordedPoses(state).length,
    posesTotal: POSES.length,
    samplesBelowProductionGate: attempts.filter(
      (attempt) => attempt.outcome === 'recorded' && attempt.gatePassed === false,
    ).length,
    totalAttempts: attempts.length,
    completedAtMs: state.completedAtMs,
  };
}
