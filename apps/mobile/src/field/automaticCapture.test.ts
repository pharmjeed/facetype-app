import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForQualifiedObservation, waitBetweenMeasurements } from './automaticCapture.ts';
import { observationFixture } from './__fixtures__/observation.ts';

const noWait = async () => {};
test('native quality rejections produce live hints and retry without another tap', async () => {
  const hints: (string | null)[] = [];
  let calls = 0;
  const result = await waitForQualifiedObservation('front', async () => {
    calls += 1;
    if (calls === 1) throw { code: 'FT-SCAN-011' };
    if (calls === 2) throw { code: 'FT-SCAN-006' };
    return observationFixture('front', { observationId: String(calls) });
  }, new AbortController().signal, noWait, (feedback) => hints.push(feedback.failureCode));
  assert.equal(result.observationId, '4');
  assert.deepEqual(hints, ['FT-SCAN-011', 'FT-SCAN-006', null, null]);
});

test('late native results after Stop cannot emit guidance', async () => {
  const controller = new AbortController();
  await assert.rejects(waitForQualifiedObservation('front', async () => {
    controller.abort();
    return observationFixture();
  }, controller.signal, noWait, () => assert.fail('stale hint')), { code: 'FIELD_CAPTURE_CANCELLED' });
});
test('temporary missing face is retried but camera failures stop immediately', async () => {
  let calls = 0;
  const output = await waitForQualifiedObservation('front', async () => {
    if (++calls === 1) throw { code: 'FT-SCAN-005' };
    return observationFixture('front', { observationId: String(calls) });
  }, new AbortController().signal, noWait);
  assert.equal(output.observationId, '3');
  calls = 0;
  await assert.rejects(waitForQualifiedObservation('front', async () => {
    calls += 1;
    throw { code: 'FT-REC-005' };
  }, new AbortController().signal, noWait), { code: 'FT-REC-005' });
  assert.equal(calls, 1);
});
test('automatic capture requires two distinct consecutive passing measurements', async () => {
  const controller = new AbortController();
  let calls = 0;
  const output = await waitForQualifiedObservation('front', async () => {
    calls += 1;
    const frame = observationFixture('front', { observationId: String(calls) });
    if (calls === 2) frame.quality.blur = 0.1;
    return frame;
  }, controller.signal, noWait);
  assert.equal(calls, 4);
  assert.equal(output.observationId, '4');
});

for (const reason of ['quality', 'pose', 'repeated-id']) {
  test(`automatic capture cannot pass ${reason} and stops after bounded attempts`, async () => {
    let calls = 0;
    await assert.rejects(waitForQualifiedObservation('front', async () => {
      calls += 1;
      const frame = observationFixture(reason === 'pose' ? 'left_25' : 'front', {
        observationId: reason === 'repeated-id' ? 'same' : String(calls),
      });
      if (reason === 'quality') frame.quality.blur = 0.1;
      return frame;
    }, new AbortController().signal, noWait), { code: 'FIELD_AUTOMATIC_QUALITY_TIMEOUT' });
    assert.equal(calls, 20);
  });
}

test('cancellation before capture performs no acquisition', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(waitForQualifiedObservation('front', async () => {
    assert.fail('camera must remain idle');
  }, controller.signal, noWait), { code: 'FIELD_CAPTURE_CANCELLED' });
});

test('cancellation after native capture cannot return the candidate', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(waitForQualifiedObservation('front', async () => {
    calls += 1;
    controller.abort();
    return observationFixture();
  }, controller.signal, noWait), { code: 'FIELD_CAPTURE_CANCELLED' });
  assert.equal(calls, 1);
});

test('abort interrupts the interval rather than issuing another capture', async () => {
  const controller = new AbortController();
  const waiting = waitBetweenMeasurements(controller.signal);
  controller.abort();
  await assert.rejects(waiting, { code: 'FIELD_CAPTURE_CANCELLED' });
});
