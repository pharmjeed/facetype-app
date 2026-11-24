import assert from 'node:assert/strict';
import test from 'node:test';

import type { CaptureStateResponse } from '@facetype/contracts';

import { FIELD_PROCESSING_TIMEOUT, waitForFieldProcessing } from './processing.ts';

function state(processing_state: string): CaptureStateResponse {
  return {
    scan_id: 'scan_1',
    status: 'CAPTURING',
    collection_status: 'COMPLETED',
    processing_state,
    retake_poses: [],
    attempt: 1,
    device_platform: 'android',
    captured_poses: [],
    missing_poses: [],
    pose_completion: 1,
    uploaded_artifacts: 5,
    pending_artifacts: 0,
    cluster: { state: 'NOT_YET_CLUSTERED' },
    geometry: { state: 'UNAVAILABLE' },
    created_at: '2026-08-28T09:07:01Z',
  };
}

test('waits through queued and running until geometry is ready', async () => {
  const states = [state('QUEUED'), state('RUNNING'), state('READY')];
  let reads = 0;
  const result = await waitForFieldProcessing(async () => states[reads++]!, {
    attempts: 3,
    intervalMs: 0,
    wait: async () => undefined,
  });
  assert.equal(result.processing_state, 'READY');
  assert.equal(reads, 3);
});

test('returns retake instructions as a terminal outcome', async () => {
  const result = await waitForFieldProcessing(
    async () => ({ ...state('RETAKE_REQUIRED'), retake_poses: ['front'] }),
    { attempts: 1 },
  );
  assert.deepEqual(result.retake_poses, ['front']);
});

test('a bounded wait fails visibly', async () => {
  await assert.rejects(
    () => waitForFieldProcessing(async () => state('QUEUED'), { attempts: 2, wait: async () => undefined }),
    (error: { code?: string }) => error.code === FIELD_PROCESSING_TIMEOUT,
  );
});
