/**
 * The field session machine: quarantine that cannot be lifted, failures that
 * are kept, and a reset that leaks nothing into the next participant.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { POSES } from '../capture/types.ts';
import type { FieldConsentRecord } from './consent.ts';
import {
  FIELD_DISPOSITION,
  buildFieldReceipt,
  fieldProgress,
  initialFieldSession,
  isParticipantComplete,
  isParticipantQualified,
  latestAttempt,
  reduceFieldSession,
  recordedPoses,
  qualifiedPoses,
  resetForNextParticipant,
  type FieldPoseAttempt,
  type FieldSessionEvent,
  type FieldSessionState,
} from './session.ts';

const CONSENT: FieldConsentRecord = {
  participantRef: 'P-000001',
  researchCollection: true,
  rawFrameRetention: false,
  policyVersion: 'consent-1.0.0',
  rawPhotoRetentionDays: 7,
  grantedAtMs: 1_700_000_000_000,
};

const RECORDED: Omit<FieldPoseAttempt, 'attempt' | 'outcome'> = {
  atMs: 1_700_000_000_100,
  errorCode: null,
  gatePassed: true,
  gateFailures: [],
  serverAccepted: true,
  serverFailures: [],
  metrics: { blur: 0.9, exposure: 0.9, occlusion: null, neutrality: 0.98, face_count: 1, yaw_deg: 0, pitch_deg: 0 },
  rawFrameSent: false,
  rawFrameUploaded: false,
  rawFrameErrorCode: null,
  observationId: 'obs_1',
};

function run(state: FieldSessionState, events: FieldSessionEvent[]): FieldSessionState {
  return events.reduce(reduceFieldSession, state);
}

/**
 * A participant the server has allocated and whose consent it has recorded.
 *
 * Both events, in that order, because that is the only order the machine
 * accepts: a consent record cannot advance a session whose reference the
 * server has not yet minted.
 */
function consented(consent: FieldConsentRecord = CONSENT): FieldSessionState {
  return run(initialFieldSession(), [
    { type: 'PARTICIPANT_ALLOCATED', participantRef: consent.participantRef },
    { type: 'CONSENT_RECORDED', consent },
  ]);
}

test('a session starts on setup with all five poses pending and nothing recorded', () => {
  const state = initialFieldSession();
  assert.equal(state.screen, 'setup');
  assert.equal(state.participantRef, null);
  assert.equal(state.consent, null);
  assert.deepEqual(
    state.poses.map((pose) => pose.pose),
    [...POSES],
  );
  assert.ok(state.poses.every((pose) => pose.stage === 'pending' && pose.attempts.length === 0));
  assert.equal(fieldProgress(state), 0);
});

test('the disposition is a constant no event can move', () => {
  const events: FieldSessionEvent[] = [
    { type: 'PARTICIPANT_ALLOCATED', participantRef: 'P-000001' },
    { type: 'CONSENT_RECORDED', consent: CONSENT },
    { type: 'SCAN_ATTACHED', scanId: 'scan_1' },
    ...POSES.map((pose) => ({ type: 'POSE_RECORDED' as const, pose, attempt: RECORDED })),
    { type: 'COMPLETE', atMs: 1 },
  ];
  let state = initialFieldSession();
  for (const event of events) {
    state = reduceFieldSession(state, event);
    assert.equal(state.disposition, FIELD_DISPOSITION);
  }
  assert.equal(state.disposition, 'CALIBRATION_PROVISIONAL_QUARANTINED');
});

test('consent is a gate: a refused or malformed record does not open the camera', () => {
  const allocated = reduceFieldSession(initialFieldSession(), {
    type: 'PARTICIPANT_ALLOCATED',
    participantRef: 'P-000001',
  });

  const denied = reduceFieldSession(allocated, {
    type: 'CONSENT_RECORDED',
    consent: { ...CONSENT, researchCollection: false },
  });
  assert.equal(denied.screen, 'setup');
  assert.equal(denied.consent, null);

  const named = reduceFieldSession(allocated, {
    type: 'CONSENT_RECORDED',
    consent: { ...CONSENT, participantRef: 'Ali Hassan' },
  });
  assert.equal(named.screen, 'setup');
  assert.equal(named.consent, null);
});

test('the reference is the server\u2019s, and a locally invented one is refused', () => {
  // The whole defect: a device that could mint its own reference minted
  // `P-000001` on every handset in the room. This event only accepts the
  // opaque shape, and nothing else in the machine sets the field.
  for (const invented of ['Ali Hassan', 'ali@example.com', 'p-000001', 'P-1', '']) {
    const state = reduceFieldSession(initialFieldSession(), {
      type: 'PARTICIPANT_ALLOCATED',
      participantRef: invented,
    });
    assert.equal(state.participantRef, null, invented);
  }
});

test('a consent for somebody else cannot advance this participant', () => {
  // Two operators, one handset, a response that arrived late. Advancing here
  // would attach the next five poses to the wrong reference.
  const allocated = reduceFieldSession(initialFieldSession(), {
    type: 'PARTICIPANT_ALLOCATED',
    participantRef: 'P-000002',
  });
  const crossed = reduceFieldSession(allocated, {
    type: 'CONSENT_RECORDED',
    consent: { ...CONSENT, participantRef: 'P-000001' },
  });
  assert.equal(crossed.screen, 'setup');
  assert.equal(crossed.consent, null);
  assert.equal(crossed.participantRef, 'P-000002');
});

test('a consent with no allocated reference at all is refused', () => {
  const orphan = reduceFieldSession(initialFieldSession(), {
    type: 'CONSENT_RECORDED',
    consent: CONSENT,
  });
  assert.equal(orphan.screen, 'setup');
  assert.equal(orphan.consent, null);
});

test('nothing may be uploaded until the scan is attributed to the participant', () => {
  const state = consented();
  assert.equal(state.scanId, null);
  assert.equal(state.attached, false);

  const attached = reduceFieldSession(state, { type: 'SCAN_ATTACHED', scanId: 'scan_1' });
  assert.equal(attached.scanId, 'scan_1');
  assert.equal(attached.attached, true);
});

test('a sample that failed the production gate is recorded, with its reasons kept', () => {
  const state = reduceFieldSession(consented(), {
    type: 'POSE_RECORDED',
    pose: 'front',
    attempt: {
      ...RECORDED,
      gatePassed: false,
      gateFailures: ['FT-SCAN-006', 'FT-SCAN-011'],
      serverAccepted: false,
      serverFailures: ['FT-SCAN-006'],
      metrics: { ...RECORDED.metrics!, blur: 0.31 },
    },
  });

  const front = state.poses.find((pose) => pose.pose === 'front')!;
  assert.equal(front.stage, 'recorded');
  const attempt = latestAttempt(front)!;
  assert.equal(attempt.gatePassed, false);
  assert.deepEqual(attempt.gateFailures, ['FT-SCAN-006', 'FT-SCAN-011']);
  assert.deepEqual(attempt.serverFailures, ['FT-SCAN-006']);
  assert.equal(attempt.metrics!.blur, 0.31);
  // Still provisional. A failing sample is evidence, never a downgrade of the
  // session's disposition and never an upgrade of the sample's.
  assert.equal(state.disposition, FIELD_DISPOSITION);
});

test('a repeat appends a second attempt rather than overwriting the first', () => {
  const state = run(consented(), [
    { type: 'POSE_RECORDED', pose: 'front', attempt: { ...RECORDED, gatePassed: false, gateFailures: ['FT-SCAN-006'] } },
    { type: 'POSE_SELECTED', pose: 'front' },
    { type: 'POSE_RECORDED', pose: 'front', attempt: { ...RECORDED, observationId: 'obs_2' } },
  ]);

  const front = state.poses.find((pose) => pose.pose === 'front')!;
  assert.equal(front.attempts.length, 2);
  assert.equal(front.attempts[0]!.attempt, 1);
  assert.equal(front.attempts[0]!.gatePassed, false);
  assert.equal(front.attempts[1]!.attempt, 2);
  assert.equal(front.attempts[1]!.observationId, 'obs_2');
});

test('a failed attempt keeps its reason and leaves the pose capturable', () => {
  const state = reduceFieldSession(consented(), {
    type: 'POSE_FAILED',
    pose: 'left_25',
    atMs: 5,
    errorCode: 'FT-SCAN-005',
  });
  const left = state.poses.find((pose) => pose.pose === 'left_25')!;
  assert.equal(left.stage, 'failed');
  assert.equal(latestAttempt(left)!.errorCode, 'FT-SCAN-005');
  assert.equal(latestAttempt(left)!.outcome, 'failed');
  assert.equal(isParticipantComplete(state), false);
});

test('recording a pose advances to the next one still needing a sample', () => {
  let state = consented();
  assert.equal(state.activePose, 'front');
  state = reduceFieldSession(state, { type: 'POSE_RECORDED', pose: 'front', attempt: RECORDED });
  assert.equal(state.activePose, 'left_25');
  state = reduceFieldSession(state, { type: 'POSE_RECORDED', pose: 'right_25', attempt: RECORDED });
  // Forward from the pose just recorded, skipping the ones already done.
  assert.equal(state.activePose, 'up_15');
  state = reduceFieldSession(state, { type: 'POSE_RECORDED', pose: 'up_15', attempt: RECORDED });
  assert.equal(state.activePose, 'down_15');
  // And once the end is reached it wraps back to the gap that was skipped,
  // so an out-of-order session still ends up asking for every pose.
  state = reduceFieldSession(state, { type: 'POSE_RECORDED', pose: 'down_15', attempt: RECORDED });
  assert.equal(state.activePose, 'left_25');
});

test('all five recorded is complete, and completing produces a receipt with no result in it', () => {
  let state = consented();
  for (const pose of POSES) {
    state = reduceFieldSession(state, { type: 'POSE_RECORDED', pose, attempt: RECORDED });
  }
  assert.equal(isParticipantComplete(state), true);
  assert.equal(fieldProgress(state), 1);
  assert.deepEqual(recordedPoses(state), [...POSES]);

  state = reduceFieldSession(state, { type: 'COMPLETE', atMs: 999 });
  assert.equal(state.screen, 'receipt');

  const receipt = buildFieldReceipt(state)!;
  assert.equal(receipt.participantRef, 'P-000001');
  assert.equal(receipt.disposition, FIELD_DISPOSITION);
  assert.equal(receipt.posesRecorded, 5);
  assert.equal(receipt.rawFramesConsented, false);
  assert.equal(receipt.rawFramesUploaded, 0);
  // The receipt is the whole summary this lane produces. Nothing in its shape
  // can carry a type, a score or a confidence.
  assert.deepEqual(
    Object.keys(receipt).filter((key) => /type|score|confidence|personality/i.test(key)),
    [],
  );
});

test('a server retake request blocks completion until every requested pose is fresh', () => {
  let state = consented();
  for (const pose of POSES) {
    state = reduceFieldSession(state, { type: 'POSE_RECORDED', pose, attempt: RECORDED });
  }
  assert.equal(isParticipantQualified(state), true);
  state = reduceFieldSession(state, {
    type: 'PROCESSING_RETAKE_REQUIRED',
    poses: ['front', 'right_25'],
    errorCode: 'FT-SCAN-015',
  });
  assert.equal(isParticipantQualified(state), false);
  assert.deepEqual(qualifiedPoses(state), ['left_25', 'up_15', 'down_15']);
  assert.equal(state.activePose, 'front');

  state = reduceFieldSession(state, { type: 'POSE_RECORDED', pose: 'front', attempt: RECORDED });
  assert.equal(state.activePose, 'right_25');
  assert.equal(isParticipantQualified(state), false);
  state = reduceFieldSession(state, { type: 'POSE_RECORDED', pose: 'right_25', attempt: RECORDED });
  assert.equal(isParticipantQualified(state), true);
});

test('a receipt counts the samples kept below the production gate', () => {
  let state = consented();
  state = reduceFieldSession(state, {
    type: 'POSE_RECORDED',
    pose: 'front',
    attempt: { ...RECORDED, gatePassed: false, gateFailures: ['FT-SCAN-006'] },
  });
  state = reduceFieldSession(state, { type: 'POSE_RECORDED', pose: 'left_25', attempt: RECORDED });
  state = reduceFieldSession(state, { type: 'POSE_FAILED', pose: 'up_15', atMs: 1, errorCode: 'FT-SCAN-005' });
  state = reduceFieldSession(state, { type: 'COMPLETE', atMs: 2 });

  const receipt = buildFieldReceipt(state)!;
  assert.equal(receipt.samplesBelowProductionGate, 1);
  assert.equal(receipt.posesRecorded, 2);
  assert.equal(receipt.totalAttempts, 3);
});

test('there is no receipt without a consent that authorised the collection', () => {
  assert.equal(buildFieldReceipt(initialFieldSession()), null);
});

test('the next participant starts from a state identical to a fresh one', () => {
  let state = consented();
  state = reduceFieldSession(state, { type: 'SCAN_ATTACHED', scanId: 'scan_1' });
  for (const pose of POSES) {
    state = reduceFieldSession(state, { type: 'POSE_RECORDED', pose, attempt: RECORDED });
  }
  state = reduceFieldSession(state, { type: 'SESSION_ERROR', errorCode: 'FT-SYS-003' });
  state = reduceFieldSession(state, { type: 'COMPLETE', atMs: 7 });

  const next = reduceFieldSession(state, { type: 'NEXT_PARTICIPANT' });

  // Field-by-field, against a freshly constructed session. This is the
  // assertion that catches a field added later and forgotten in a reset.
  assert.deepEqual(next, initialFieldSession(1));
  assert.equal(next.participantsCompleted, 1);
  assert.equal(next.participantRef, null);
  assert.equal(next.consent, null);
  assert.equal(next.scanId, null);
  assert.equal(next.attached, false);
  assert.equal(next.errorCode, null);
  assert.equal(next.completedAtMs, null);
  assert.ok(next.poses.every((pose) => pose.attempts.length === 0));
  // And the previous participant's own state is untouched: the reducer never
  // mutates, so nothing can be read back through a stale reference either.
  assert.equal(state.participantRef, 'P-000001');
});

test('aborting mid-participant erases the same way but counts nobody', () => {
  let state = consented();
  state = reduceFieldSession(state, { type: 'SCAN_ATTACHED', scanId: 'scan_1' });
  state = reduceFieldSession(state, { type: 'POSE_RECORDED', pose: 'front', attempt: RECORDED });

  const aborted = reduceFieldSession(state, { type: 'ABORT' });
  assert.deepEqual(aborted, initialFieldSession(0));
});

test('resetting from a session that never reached the receipt does not count a participant', () => {
  const state = reduceFieldSession(consented(), { type: 'POSE_RECORDED', pose: 'front', attempt: RECORDED });
  assert.equal(resetForNextParticipant(state).participantsCompleted, 0);
});

test('a receipt states the wording version and photo period the server gave', () => {
  // Neither figure is a build constant any more. The receipt reads back
  // exactly what the joined session said, via the consent record.
  let state = consented({ ...CONSENT, rawFrameRetention: true });
  state = reduceFieldSession(state, { type: 'COMPLETE', atMs: 1 });
  const receipt = buildFieldReceipt(state)!;
  assert.equal(receipt.policyVersion, 'consent-1.0.0');
  assert.equal(receipt.rawPhotoRetentionDays, 7);
  // And there is no geometry retention period on it at all, because the
  // platform contract defines none for the app to read out.
  assert.equal('retentionDays' in receipt, false);
  assert.equal('scanId' in receipt, false);
});

test('the participant is told a photograph left the device even when the server never confirmed it', () => {
  // The PUT succeeded and the completion call did not. The artifact row still
  // says `uploaded = false`, but the participant's face is in the object store,
  // so the receipt must not read "no photograph was stored".
  let state = consented({ ...CONSENT, rawFrameRetention: true });
  state = reduceFieldSession(state, {
    type: 'POSE_RECORDED',
    pose: 'front',
    attempt: {
      ...RECORDED,
      rawFrameSent: true,
      rawFrameUploaded: false,
      rawFrameErrorCode: 'FIELD_RAW_COMPLETION_MISMATCH',
    },
  });
  state = reduceFieldSession(state, { type: 'COMPLETE', atMs: 999 });

  const receipt = buildFieldReceipt(state)!;
  assert.equal(receipt.rawFramesUploaded, 1);
  // And the operator's number is the other one. The two are kept apart
  // because they genuinely disagree here, and collapsing them would mean
  // lying to one of the two people reading the screen.
  assert.equal(receipt.rawFramesConfirmed, 0);
});

test('a confirmed photograph counts on both lines', () => {
  let state = consented({ ...CONSENT, rawFrameRetention: true });
  state = reduceFieldSession(state, {
    type: 'POSE_RECORDED',
    pose: 'front',
    attempt: { ...RECORDED, rawFrameSent: true, rawFrameUploaded: true },
  });
  state = reduceFieldSession(state, { type: 'COMPLETE', atMs: 999 });

  const receipt = buildFieldReceipt(state)!;
  assert.equal(receipt.rawFramesUploaded, 1);
  assert.equal(receipt.rawFramesConfirmed, 1);
});

test('a photograph that never left the device is not counted on the receipt', () => {
  let state = consented({ ...CONSENT, rawFrameRetention: true });
  state = reduceFieldSession(state, {
    type: 'POSE_RECORDED',
    pose: 'front',
    attempt: { ...RECORDED, rawFrameSent: false, rawFrameErrorCode: 'FT-SYS-002' },
  });
  state = reduceFieldSession(state, { type: 'COMPLETE', atMs: 999 });

  assert.equal(buildFieldReceipt(state)!.rawFramesUploaded, 0);
});
