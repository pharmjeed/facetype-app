import assert from 'node:assert/strict';
import test from 'node:test';
import { needsResumeChoice, prepareFieldEntry } from './entry.ts';

test('only a restored scan in a research-enabled build needs a choice', () => {
  assert.equal(needsResumeChoice(true, 'scan'), true);
  for (const screen of ['welcome', 'consent', 'processing', 'result', 'retake']) {
    assert.equal(needsResumeChoice(true, screen), false);
  }
  assert.equal(needsResumeChoice(false, 'scan'), false);
});

test('field entry stops the camera and preserves existing credentials', async () => {
  const events: string[] = [];
  await prepareFieldEntry({
    stopCamera: async () => { events.push('stop'); },
    hasToken: () => true,
    createSession: async () => { events.push('replace-token'); },
  });
  assert.deepEqual(events, ['stop']);
});

test('a fresh entry creates credentials only after camera teardown', async () => {
  const events: string[] = [];
  await prepareFieldEntry({
    stopCamera: async () => { events.push('stop'); },
    hasToken: () => false,
    createSession: async () => { events.push('create'); },
  });
  assert.deepEqual(events, ['stop', 'create']);
});

test('a failed camera teardown blocks lane entry and credential mutation', async () => {
  let created = false;
  await assert.rejects(prepareFieldEntry({
    stopCamera: async () => { throw new Error('stop failed'); },
    hasToken: () => false,
    createSession: async () => { created = true; },
  }), /stop failed/);
  assert.equal(created, false);
});
