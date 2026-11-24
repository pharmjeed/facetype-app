import assert from 'node:assert/strict';
import test from 'node:test';

import { captureBestFieldObservation } from './burstCapture.ts';
import { observationFixture } from './__fixtures__/observation.ts';

test('captures three sequential frames and chooses the passing frame', async () => {
  const frames = [
    observationFixture('front', {
      observationId: 'blurred',
      quality: { ...observationFixture().quality, blur: 0.1 },
    }),
    observationFixture('front', { observationId: 'best' }),
    observationFixture('front', {
      observationId: 'moving',
      quality: { ...observationFixture().quality, neutrality: 0.1 },
    }),
  ];
  let calls = 0;
  const selected = await captureBestFieldObservation('front', async () => frames[calls++]!, 3);
  assert.equal(calls, 3);
  assert.equal(selected.observationId, 'best');
});

test('when all frames fail it keeps the least-bad evidence', async () => {
  const frames = [
    observationFixture('front', {
      observationId: 'two-failures',
      quality: { ...observationFixture().quality, blur: 0.1, neutrality: 0.1 },
    }),
    observationFixture('front', {
      observationId: 'one-failure',
      quality: { ...observationFixture().quality, blur: 0.69 },
    }),
  ];
  let calls = 0;
  const selected = await captureBestFieldObservation('front', async () => frames[calls++]!, 2);
  assert.equal(selected.observationId, 'one-failure');
});
