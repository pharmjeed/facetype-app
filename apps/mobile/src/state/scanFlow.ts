/**
 * Scan flow state machine — FT-17 §14.
 *
 * Welcome -> Consent -> Scan -> Processing -> Result
 *                  \-> Retake -> Scan
 *
 * Kept as a pure reducer so the whole navigation contract is unit-testable
 * without a renderer, a camera or a network.
 *
 * The rule this machine exists to enforce: a retake re-captures **only** the
 * poses that failed (FT-05 §2). Asking a user to redo a scan that was mostly
 * fine is the single most common way a capture flow loses people.
 */

import { POSES, type PoseLabel } from '../capture/types.ts';

export type Screen =
  | 'welcome'
  | 'consent'
  | 'scan'
  | 'processing'
  | 'result'
  | 'retake'
  | 'privacy';

export type TerminalStatus =
  | 'COMPLETED'
  | 'ABSTAINED'
  | 'RETAKE_REQUIRED'
  | 'MODEL_UNAVAILABLE'
  | 'FAILED';

export interface ScanState {
  screen: Screen;
  consentGranted: boolean;
  analyticsConsent: boolean;
  researchOptIn: boolean;
  /**
   * The user confirmed their face is uncovered, before the camera opened.
   *
   * A statement by a person, not a measurement (ADR-011). It is asked for only
   * on a device that cannot assess occlusion, it is sent to the server as
   * self-attestation, and nothing anywhere may read it as an occlusion score.
   */
  obstructionSelfAttested: boolean;
  scanId: string | null;
  jobId: string | null;
  /**
   * Idempotency key for the *pending* createScan request, reused across every
   * retry of that one logical attempt (and across a cold restore before
   * `scanId` ever arrives) so a lost response can never create a duplicate
   * scan. Cleared once `SCAN_CREATED` lands; irrelevant after that, since a
   * scan with an id is never re-created.
   */
  scanCreateKey: string | null;
  /** Stable across finalize retries and cold restarts. */
  finalizeKey: string | null;
  /** Poses still to capture, in order. */
  pending: PoseLabel[];
  captured: PoseLabel[];
  status: TerminalStatus | null;
  errorCode: string | null;
  retakePose: PoseLabel | null;
}

export type ScanEvent =
  | { type: 'RESTORED'; state: ScanState }
  | { type: 'BEGIN' }
  | {
      type: 'CONSENT';
      granted: boolean;
      researchOptIn: boolean;
      analyticsConsent?: boolean;
      obstructionSelfAttested?: boolean;
    }
  | { type: 'SCAN_CREATE_KEY'; key: string }
  | { type: 'SCAN_CREATED'; scanId: string; finalizeKey: string }
  | { type: 'POSE_CAPTURED'; pose: PoseLabel }
  | { type: 'POSE_REJECTED'; pose: PoseLabel; errorCode: string }
  | { type: 'FINALIZED'; jobId: string }
  | { type: 'PROCESSING_PENDING'; errorCode: 'PROCESSING_TIMEOUT' | 'FT-SYS-003' }
  | { type: 'PROCESSING_RETRY' }
  | { type: 'RESULT'; status: TerminalStatus; retakePose?: PoseLabel | null; errorCode?: string | null }
  | { type: 'RETAKE'; poses: PoseLabel[]; finalizeKey: string }
  | { type: 'OPEN_PRIVACY' }
  | { type: 'RESET' };

export const initialState: ScanState = {
  screen: 'welcome',
  consentGranted: false,
  analyticsConsent: false,
  researchOptIn: false,
  obstructionSelfAttested: false,
  scanId: null,
  jobId: null,
  scanCreateKey: null,
  finalizeKey: null,
  pending: [...POSES],
  captured: [],
  status: null,
  errorCode: null,
  retakePose: null,
};

export function reduce(state: ScanState, event: ScanEvent): ScanState {
  switch (event.type) {
    case 'RESTORED':
      return event.state;

    case 'BEGIN':
      return { ...initialState, screen: 'consent' };

    case 'CONSENT':
      // Consent is a gate, not a checkbox: without it the flow does not advance.
      if (!event.granted) return { ...state, consentGranted: false };
      return {
        ...state,
        consentGranted: true,
        analyticsConsent: event.analyticsConsent ?? false,
        researchOptIn: event.researchOptIn,
        obstructionSelfAttested: event.obstructionSelfAttested ?? false,
        screen: 'scan',
      };

    case 'SCAN_CREATE_KEY':
      // A key already set for this pending attempt is never overwritten:
      // the whole point is that every retry of one logical createScan call
      // reuses the same key.
      return state.scanCreateKey ? state : { ...state, scanCreateKey: event.key };

    case 'SCAN_CREATED':
      return { ...state, scanId: event.scanId, scanCreateKey: null, finalizeKey: event.finalizeKey };

    case 'POSE_CAPTURED': {
      const pending = state.pending.filter((pose) => pose !== event.pose);
      const captured = state.captured.includes(event.pose)
        ? state.captured
        : [...state.captured, event.pose];
      return {
        ...state,
        pending,
        captured,
        errorCode: null,
        screen: pending.length === 0 ? 'processing' : 'scan',
      };
    }

    case 'POSE_REJECTED':
      // The pose stays pending; the user retries the same step, not the scan.
      return { ...state, errorCode: event.errorCode };

    case 'FINALIZED':
      return { ...state, jobId: event.jobId, errorCode: null, screen: 'processing' };

    case 'PROCESSING_PENDING':
      // The server job may still finish. Keep its IDs so a tap or app restore
      // resumes polling instead of creating another scan.
      return { ...state, screen: 'processing', errorCode: event.errorCode };

    case 'PROCESSING_RETRY':
      return { ...state, screen: 'processing', errorCode: null };

    case 'RESULT':
      return {
        ...state,
        status: event.status,
        errorCode: event.errorCode ?? null,
        retakePose: event.retakePose ?? null,
        screen: event.status === 'RETAKE_REQUIRED' ? 'retake' : 'result',
      };

    case 'RETAKE':
      return {
        ...state,
        // Only the failed poses are re-captured (FT-05 §2).
        pending: event.poses.length > 0 ? event.poses : [...POSES],
        captured: state.captured.filter((pose) => !event.poses.includes(pose)),
        // A retake is a new processing attempt. It must not reuse the old job,
        // but all retries of this new attempt must share one fresh key.
        jobId: null,
        finalizeKey: event.finalizeKey,
        status: null,
        errorCode: null,
        screen: 'scan',
      };

    case 'OPEN_PRIVACY':
      return { ...state, screen: 'privacy' };

    case 'RESET':
      return { ...initialState };

    default:
      return state;
  }
}

/** The pose the UI should currently ask for, if any. */
export function currentPose(state: ScanState): PoseLabel | null {
  return state.pending[0] ?? null;
}

/** Progress through the guided protocol, in [0, 1]. */
export function progress(state: ScanState): number {
  return state.captured.length / POSES.length;
}
