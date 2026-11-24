import assert from 'node:assert/strict';
import test from 'node:test';
import { observationFixture } from './__fixtures__/observation.ts';
import { collectedSamples, collectionComplete, nextCollectionPose, waitForCollectionObservation } from './photoCollection.ts';
import { initialFieldSession, reduceFieldSession } from './session.ts';
import { evaluateFieldObservation } from './fieldCapture.ts';

const noWait = async () => {};
const noHint = () => {};

test('collection preserves failed blur/expression verdict without waiting for analysis approval', async () => {
  let calls = 0;
  const result = await waitForCollectionObservation('front', async () => {
    const frame = observationFixture('front', { observationId: String(++calls) });
    frame.quality.blur = 0.307;
    frame.quality.neutrality = 0.589;
    return frame;
  }, new AbortController().signal, noHint, noWait);
  assert.equal(calls, 2);
  assert.equal(evaluateFieldObservation(result).pass, false);
  assert.deepEqual(evaluateFieldObservation(result).failures, ['FT-SCAN-006', 'FT-SCAN-010']);
});

test('collection retains a directional vertical sample outside the strict analysis band', async () => {
  let calls = 0;
  const result = await waitForCollectionObservation('down_15', async () => {
    const frame = observationFixture('down_15', { observationId: String(++calls) });
    frame.quality.pitchDeg = -45;
    return frame;
  }, new AbortController().signal, noHint, noWait);
  assert.equal(calls, 2);
  assert.equal(result.quality.pitchDeg, -45);
  // The strict quality engine remains intentionally unchanged; the caller
  // records this as review evidence rather than analysis approval.
  assert.equal(evaluateFieldObservation(result).pass, false);
  assert.deepEqual(evaluateFieldObservation(result).failures, ['FT-SCAN-011']);
});

for (const problem of ['no-face', 'multiple', 'wrong-angle', 'dark', 'unknown', 'duplicate']) {
  test(`collection remains bounded and rejects ${problem}`, async () => {
    let calls = 0;
    await assert.rejects(waitForCollectionObservation('front', async () => {
      const frame = observationFixture('front', { observationId: problem === 'duplicate' ? 'same' : String(++calls) });
      if (problem === 'no-face') frame.quality.faceCount = 0;
      if (problem === 'multiple') frame.quality.faceCount = 2;
      if (problem === 'wrong-angle') frame.quality.yawDeg = 30;
      if (problem === 'dark') frame.quality.exposure = 0.1;
      if (problem === 'unknown') frame.quality.blur = null;
      return frame;
    }, new AbortController().signal, noHint, noWait), { code: 'FIELD_COLLECTION_POSE_TIMEOUT' });
  });
}

test('stop prevents late native result and feedback', async () => {
  const controller = new AbortController();
  await assert.rejects(waitForCollectionObservation('front', async () => {
    controller.abort();
    return observationFixture();
  }, controller.signal, () => assert.fail('stale feedback'), noWait), { code: 'FIELD_CAPTURE_CANCELLED' });
});

test('three confirmed photos per pose complete collection while analysis remains failed', () => {
  let state = reduceFieldSession(initialFieldSession(), { type: 'PARTICIPANT_ALLOCATED', participantRef: 'P-000001' });
  state = reduceFieldSession(state, { type: 'CONSENT_RECORDED', consent: {
    participantRef: 'P-000001', researchCollection: true, rawFrameRetention: true,
    policyVersion: 'consent-1.0.0', rawPhotoRetentionDays: 30, grantedAtMs: 1,
  } });
  state = reduceFieldSession(state, { type: 'SCAN_ATTACHED', scanId: 'scan_test' });
  for (const record of state.poses) {
    for (let sample = 0; sample < 3; sample += 1) {
      assert.equal(collectionComplete(state), false);
      assert.equal(nextCollectionPose(state), record.pose);
      state = reduceFieldSession(state, { type: 'POSE_RECORDED', pose: record.pose, attempt: {
        observationId: `${record.pose}-${sample}`, atMs: sample, errorCode: null,
        gatePassed: false, gateFailures: ['FT-SCAN-006'], serverAccepted: false, serverFailures: ['FT-SCAN-006'],
        metrics: { blur: 0.307 }, rawFrameSent: true, rawFrameUploaded: true, rawFrameErrorCode: null,
      } });
    }
  }
  assert.equal(collectionComplete(state), true);
  const front = state.poses[0]!;
  assert.equal(collectedSamples(front, true), 3);
  assert.equal(collectedSamples({ ...front, attempts: [...front.attempts, ...front.attempts] }, true), 3);
  assert.equal(collectedSamples({ ...front, attempts: front.attempts.map((a) => ({ ...a, rawFrameUploaded: false })) }, true), 0);
  assert.equal(collectedSamples({ ...front, attempts: front.attempts.map((a) => ({ ...a, gateFailures: ['FT-SCAN-011'] })) }, true), 0);

  const down = state.poses.find((record) => record.pose === 'down_15')!;
  assert.equal(collectedSamples({
    ...down,
    attempts: down.attempts.map((attempt) => ({
      ...attempt,
      gateFailures: ['FT-SCAN-011'],
      serverFailures: ['FT-SCAN-011'],
    })),
  }, true), 3);
});
