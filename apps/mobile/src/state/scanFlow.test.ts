/** Scan flow reducer tests — the navigation contract, without a renderer. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { currentPose, initialState, progress, reduce, type ScanState } from './scanFlow.ts';

const FINALIZE_KEY = '123e4567-e89b-42d3-a456-426614174000';
const RETAKE_FINALIZE_KEY = '123e4567-e89b-42d3-b456-426614174001';

test('the flow starts at welcome with all five poses pending', () => {
  assert.equal(initialState.screen, 'welcome');
  assert.equal(initialState.pending.length, 5);
  assert.equal(currentPose(initialState), 'front');
});

test('consent is a gate: refusing it does not advance', () => {
  const refused = reduce(reduce(initialState, { type: 'BEGIN' }), {
    type: 'CONSENT',
    granted: false,
    researchOptIn: false,
  });
  assert.equal(refused.screen, 'consent');
  assert.equal(refused.consentGranted, false);
});

test('granting consent advances to the scan and records the research opt-in', () => {
  const state = reduce(reduce(initialState, { type: 'BEGIN' }), {
    type: 'CONSENT',
    granted: true,
    researchOptIn: true,
  });
  assert.equal(state.screen, 'scan');
  assert.equal(state.researchOptIn, true);
});

test('capturing all five poses moves to processing', () => {
  let state = reduce(reduce(initialState, { type: 'BEGIN' }), {
    type: 'CONSENT',
    granted: true,
    researchOptIn: false,
  });
  for (const pose of ['front', 'left_25', 'right_25', 'up_15'] as const) {
    state = reduce(state, { type: 'POSE_CAPTURED', pose });
    assert.equal(state.screen, 'scan');
  }
  state = reduce(state, { type: 'POSE_CAPTURED', pose: 'down_15' });
  assert.equal(state.screen, 'processing');
  assert.equal(progress(state), 1);
});

test('a rejected pose stays pending — the user retries the step, not the scan', () => {
  let state = reduce(reduce(initialState, { type: 'BEGIN' }), {
    type: 'CONSENT',
    granted: true,
    researchOptIn: false,
  });
  state = reduce(state, { type: 'POSE_REJECTED', pose: 'front', errorCode: 'FT-SCAN-006' });
  assert.equal(state.screen, 'scan');
  assert.equal(currentPose(state), 'front');
  assert.equal(state.errorCode, 'FT-SCAN-006');
});

test('a retake re-captures only the failed pose', () => {
  const finished: ScanState = {
    ...initialState,
    screen: 'processing',
    pending: [],
    captured: ['front', 'left_25', 'right_25', 'up_15', 'down_15'],
  };
  let state = reduce(finished, { type: 'RESULT', status: 'RETAKE_REQUIRED', retakePose: 'left_25' });
  assert.equal(state.screen, 'retake');

  state = reduce(state, {
    type: 'RETAKE',
    poses: ['left_25'],
    finalizeKey: RETAKE_FINALIZE_KEY,
  });
  assert.equal(state.screen, 'scan');
  assert.deepEqual(state.pending, ['left_25']);
  assert.equal(state.captured.length, 4);
  assert.ok(!state.captured.includes('left_25'));
  assert.equal(state.jobId, null);
  assert.equal(state.finalizeKey, RETAKE_FINALIZE_KEY);
});

test('MODEL_UNAVAILABLE is a result screen, not an error screen', () => {
  const processing: ScanState = { ...initialState, screen: 'processing' };
  const state = reduce(processing, { type: 'RESULT', status: 'MODEL_UNAVAILABLE' });
  assert.equal(state.screen, 'result');
  assert.equal(state.status, 'MODEL_UNAVAILABLE');
  assert.equal(state.errorCode, null);
});

test('a processing timeout preserves the job and is explicitly retryable', () => {
  const processing: ScanState = {
    ...initialState,
    screen: 'processing',
    scanId: 'scn_1',
    jobId: 'job_1',
    finalizeKey: FINALIZE_KEY,
  };
  const pending = reduce(processing, {
    type: 'PROCESSING_PENDING',
    errorCode: 'PROCESSING_TIMEOUT',
  });
  assert.equal(pending.screen, 'processing');
  assert.equal(pending.scanId, 'scn_1');
  assert.equal(pending.jobId, 'job_1');
  assert.equal(pending.errorCode, 'PROCESSING_TIMEOUT');

  const retrying = reduce(pending, { type: 'PROCESSING_RETRY' });
  assert.equal(retrying.errorCode, null);
  assert.equal(retrying.jobId, 'job_1');
  assert.equal(retrying.finalizeKey, FINALIZE_KEY);
});

test('validated persisted state can restore the flow', () => {
  const restored: ScanState = {
    ...initialState,
    screen: 'scan',
    consentGranted: true,
    scanId: 'scn_1',
    finalizeKey: FINALIZE_KEY,
    pending: ['left_25'],
    captured: ['front', 'right_25', 'up_15', 'down_15'],
  };
  assert.deepEqual(reduce(initialState, { type: 'RESTORED', state: restored }), restored);
});

test('scan creation allocates one finalize key that survives retries', () => {
  const created = reduce(initialState, {
    type: 'SCAN_CREATED',
    scanId: 'scn_1',
    finalizeKey: FINALIZE_KEY,
  });
  const retrying = reduce(
    reduce(created, { type: 'PROCESSING_PENDING', errorCode: 'FT-SYS-003' }),
    { type: 'PROCESSING_RETRY' },
  );
  assert.equal(retrying.finalizeKey, FINALIZE_KEY);
});

test('the create-scan idempotency key survives a retry of the same attempt', () => {
  // Emulates App.tsx's createScan(): generate a key on the first attempt...
  let state = reduce(initialState, { type: 'SCAN_CREATE_KEY', key: 'idem-1' });
  assert.equal(state.scanCreateKey, 'idem-1');
  // ...a lost response forces a retry, which must reuse that same key rather
  // than minting a new one (M1-F4): a second createScan with a fresh key
  // would risk a duplicate scan if the server actually committed the first.
  state = reduce(state, { type: 'SCAN_CREATE_KEY', key: 'idem-2' });
  assert.equal(state.scanCreateKey, 'idem-1');
});

test('SCAN_CREATED clears the create-scan key; it is irrelevant once a scan exists', () => {
  const withKey = reduce(initialState, { type: 'SCAN_CREATE_KEY', key: 'idem-1' });
  const created = reduce(withKey, {
    type: 'SCAN_CREATED',
    scanId: 'scn_1',
    finalizeKey: FINALIZE_KEY,
  });
  assert.equal(created.scanCreateKey, null);
  assert.equal(created.scanId, 'scn_1');
});

test('reset returns to a clean welcome state', () => {
  const dirty: ScanState = { ...initialState, screen: 'result', scanId: 'scn_1' };
  assert.deepEqual(reduce(dirty, { type: 'RESET' }), initialState);
});
