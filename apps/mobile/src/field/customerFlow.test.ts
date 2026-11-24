import assert from 'node:assert/strict';
import test from 'node:test';

import { attachBeforeCamera, recordDeclineBeforeRelease } from './customerFlow.ts';

test('the camera never starts when scan attachment fails', async () => {
  let starts = 0;
  await assert.rejects(
    () =>
      attachBeforeCamera({
        attach: async () => {
          throw new Error('attach failed');
        },
        startCamera: async () => {
          starts += 1;
        },
      }),
    /attach failed/,
  );
  assert.equal(starts, 0);
});

test('attachment completes before the camera starts', async () => {
  const events: string[] = [];
  const scanId = await attachBeforeCamera({
    attach: async () => {
      events.push('attached');
      return 'scan-1';
    },
    startCamera: async () => {
      events.push('camera-started');
    },
  });
  assert.equal(scanId, 'scan-1');
  assert.deepEqual(events, ['attached', 'camera-started']);
});

test('a failed refusal remains available for retry and does not release the participant', async () => {
  let releases = 0;
  await assert.rejects(
    () =>
      recordDeclineBeforeRelease({
        recordDecline: async () => {
          throw new Error('record failed');
        },
        release: async () => {
          releases += 1;
        },
      }),
    /record failed/,
  );
  assert.equal(releases, 0);
});

test('a recorded refusal releases the participant exactly once', async () => {
  const events: string[] = [];
  await recordDeclineBeforeRelease({
    recordDecline: async () => {
      events.push('recorded');
    },
    release: async () => {
      events.push('released');
    },
  });
  assert.deepEqual(events, ['recorded', 'released']);
});
