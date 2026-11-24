/** Attempt telemetry: snake_case reasons on the wire (§5.17) and the outcome per spool stage. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { REJECT_REASONS } from './messages.ts';
import {
  attemptDevice,
  isPendingAttempt,
  MAX_REASON_KEYS,
  outcomeForStage,
  pendingAttempt,
  WIRE_REASONS,
  wireReason,
  wireReasonCounts,
} from './telemetry.ts';

const SERVER_KEY = /^[a-z0-9_]{1,40}$/;

test('every native reject reason has the §5.17 wire name, and every wire name passes the server rule', () => {
  assert.deepEqual(WIRE_REASONS, {
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
  });
  for (const reason of REJECT_REASONS) {
    const wire = wireReason(reason);
    assert.ok(wire && SERVER_KEY.test(wire), reason);
  }
});

test('counts are re-keyed, merged and cleaned before they are sent', () => {
  assert.deepEqual(wireReasonCounts({ oneFace: 2, distanceOrSize: 1, light: 3 }), {
    one_face: 2,
    distance_or_size: 1,
    light: 3,
  });
  // A reason added natively later is snake_cased; anything unusable is dropped.
  assert.deepEqual(wireReasonCounts({ newCheckName: 1, 'bad key!': 4, light: -1, eyes: 1.5 }), { new_check_name: 1 });
  // Already-wire keys merge with their native spelling.
  assert.deepEqual(wireReasonCounts({ oneFace: 1, one_face: 2 }), { one_face: 3 });
  const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`reason${i}`, 1]));
  assert.equal(Object.keys(wireReasonCounts(many)).length, MAX_REASON_KEYS);
  assert.equal(wireReason('x'.repeat(41)), null);
});

test('the pending attempt is wire-ready and bounded', () => {
  const pending = pendingAttempt({
    startedAtMs: 1000,
    nowMs: 5200.4,
    attempts: 3,
    reasonCounts: { facing: 2 },
    device: attemptDevice(null, 'ios'),
  });
  assert.deepEqual(pending, { duration_ms: 4200, attempts: 3, reason_counts: { facing: 2 }, device: { platform: 'ios' } });
  assert.ok(isPendingAttempt(pending));
  assert.equal(pendingAttempt({ startedAtMs: 0, nowMs: 10 * 3_600_000, attempts: 1, reasonCounts: {}, device: {} }).duration_ms, 3_600_000);
  assert.equal(isPendingAttempt({ ...pending, reason_counts: { oneFace: 1 } }), false, 'camelCase never reaches the wire');
  assert.equal(isPendingAttempt(null), false);
});

test('an enqueued attempt reports the verdict, or abandoned; nothing while the upload is still running', () => {
  assert.equal(outcomeForStage('stored'), 'stored');
  assert.equal(outcomeForStage('received'), 'received');
  assert.equal(outcomeForStage('needs_retake'), 'needs_retake');
  assert.equal(outcomeForStage('abandoned'), 'abandoned');
  assert.equal(outcomeForStage('failed'), 'abandoned');
  for (const stage of ['pending_create', 'uploading', 'finalizing', 'checking'] as const) {
    assert.equal(outcomeForStage(stage), null, stage);
  }
});
