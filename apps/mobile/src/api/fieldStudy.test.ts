/**
 * The wrapper is thin, and this suite is what keeps it thin.
 *
 * Every method must reach exactly one generated client method, with exactly the
 * arguments it was given and nothing added. The two that matter most are the
 * idempotency keys — `addParticipant` and `createScan` — because a key silently
 * dropped here does not fail: it mints a second `P-000002` for the person still
 * sitting in the chair, or a second scan for the same participant, and only a
 * study lead reading a dashboard weeks later notices.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { FaceTypeClient } from '@facetype/contracts';

import { fieldStudyApi, type FieldStudyApi } from './fieldStudy.ts';

interface Call {
  method: string;
  args: unknown[];
}

/**
 * A client that records instead of fetching.
 *
 * A `Proxy` rather than a hand-written stub: a hand-written one would have to
 * list the methods, and a method added to the port but forgotten there would
 * throw at run time in a way that reads like an unrelated failure. This
 * answers to anything and records what it was asked.
 */
function recordingClient(
  responses: Record<string, unknown> = {},
): { client: FaceTypeClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = new Proxy(
    {},
    {
      get(_target, property: string) {
        return (...args: unknown[]) => {
          calls.push({ method: property, args });
          return Promise.resolve(responses[property] ?? {});
        };
      },
    },
  ) as FaceTypeClient;
  return { client, calls };
}

function api(): { api: FieldStudyApi; calls: Call[] } {
  const { client, calls } = recordingClient();
  return { api: fieldStudyApi(client), calls };
}

test('the policy read takes no arguments and adds none', async () => {
  const { api: bound, calls } = api();
  await bound.fieldStudyPolicy();
  assert.deepEqual(calls, [{ method: 'fieldStudyPolicy', args: [] }]);
});

test('the join code is wrapped in the generated request body and nothing else', async () => {
  const { api: bound, calls } = api();
  await bound.joinFieldSession('SESSION-CODE-1');
  assert.deepEqual(calls, [
    { method: 'joinFieldSession', args: [{ join_code: 'SESSION-CODE-1' }] },
  ]);
});

test('allocating a participant sends the idempotency key and no body at all', async () => {
  // The endpoint deliberately takes no request body: a body would be somewhere
  // to type a name. The key is the only thing that travels.
  const { api: bound, calls } = api();
  await bound.addParticipant('fs_abc', 'key-participant-1');
  assert.deepEqual(calls, [
    { method: 'addParticipant', args: ['fs_abc', { idempotencyKey: 'key-participant-1' }] },
  ]);
});

test('a consent fact reaches the client with its type, its answer and its locale', async () => {
  const { api: bound, calls } = api();
  await bound.recordConsent('fs_abc', 'P-000001', {
    consent_type: 'field_study_raw_photo_retention',
    granted: false,
    locale: 'ar-SA',
  });
  assert.deepEqual(calls, [
    {
      method: 'recordConsent',
      args: [
        'fs_abc',
        'P-000001',
        { consent_type: 'field_study_raw_photo_retention', granted: false, locale: 'ar-SA' },
      ],
    },
  ]);
});

test('createScan carries its idempotency key, so a retry cannot mint a second scan', async () => {
  const { api: bound, calls } = api();
  const body = {
    capture_protocol: 'cap-1.0.0',
    device: { platform: 'android', model: 'unknown', app_version: '1.0.0' },
  } as never;
  await bound.createScan(body, 'key-scan-1');
  assert.deepEqual(calls, [
    { method: 'createScan', args: [body, { idempotencyKey: 'key-scan-1' }] },
  ]);
});

test('attaching a capture sends only the reference and the scan id', async () => {
  const { api: bound, calls } = api();
  await bound.attachCapture('fs_abc', { participant_ref: 'P-000001', scan_id: 'scan_1' });
  assert.deepEqual(calls, [
    {
      method: 'attachCapture',
      args: ['fs_abc', { participant_ref: 'P-000001', scan_id: 'scan_1' }],
    },
  ]);
});

test('the collector polls only its own attached capture', async () => {
  const { api: bound, calls } = api();
  await bound.getOwnCapture('fs_abc', 'scan_1');
  assert.deepEqual(calls, [{ method: 'getOwnCapture', args: ['fs_abc', 'scan_1'] }]);
});

test('the raw completion goes to the completion route, never to observations', async () => {
  const { api: bound, calls } = api();
  await bound.completeRawUpload('scan_1', 'artifact_1', {
    sha256: 'd'.repeat(64),
    content_length: 2048,
    content_type: 'image/jpeg',
  });
  assert.deepEqual(calls, [
    {
      method: 'completeRawUpload',
      args: [
        'scan_1',
        'artifact_1',
        { sha256: 'd'.repeat(64), content_length: 2048, content_type: 'image/jpeg' },
      ],
    },
  ]);
});

test('the port exposes the collecting device’s methods and no others', async () => {
  // The quarantine and the erasure boundary are both here: a method that does
  // not exist cannot be called by mistake, by a refactor, or by a component
  // that was written before the rule.
  const { api: bound } = api();
  assert.deepEqual(Object.keys(bound).sort(), [
    'addParticipant',
    'attachCapture',
    'completeRawUpload',
    'createScan',
    'createUpload',
    'fieldStudyPolicy',
    'getOwnCapture',
    'joinFieldSession',
    'recordConsent',
    'registerObservation',
  ]);
  for (const forbidden of ['finalizeScan', 'getJob', 'getResult', 'retakePose', 'deleteScan']) {
    assert.equal(forbidden in bound, false, forbidden);
  }
});
