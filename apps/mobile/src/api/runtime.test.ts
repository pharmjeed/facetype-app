import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProcessingTimeoutError,
  UploadHttpError,
  pollUntilTerminal,
  resolveUploadUrl,
  retryWithBackoff,
} from './runtime.ts';

test('an absolute signed upload URL is never prefixed with the API origin', () => {
  const signed = 'https://objects.example/upload/key?signature=abc';
  assert.equal(resolveUploadUrl(signed, 'https://api.example/api'), signed);
});

test('a relative development upload URL is resolved against the API origin', () => {
  assert.equal(
    resolveUploadUrl('/uploads/key', 'http://localhost:8000/api'),
    'http://localhost:8000/uploads/key',
  );
});

test('retry uses bounded exponential backoff and eventually succeeds', async () => {
  const waits: number[] = [];
  let calls = 0;
  const result = await retryWithBackoff(
    async () => {
      calls += 1;
      if (calls < 3) throw new TypeError('offline');
      return 'ok';
    },
    { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
    async (delay) => {
      waits.push(delay);
    },
  );

  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 20]);
});

test('retry stops at its configured attempt bound', async () => {
  let calls = 0;
  await assert.rejects(
    retryWithBackoff(
      async () => {
        calls += 1;
        throw new TypeError('offline');
      },
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      async () => {},
    ),
    TypeError,
  );
  assert.equal(calls, 2);
});

test('a non-retryable upload response fails immediately', async () => {
  let calls = 0;
  await assert.rejects(
    retryWithBackoff(
      async () => {
        calls += 1;
        throw new UploadHttpError(403);
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      async () => {},
    ),
    UploadHttpError,
  );
  assert.equal(calls, 1);
});

test('polling recovers from a network failure inside one total attempt budget', async () => {
  let calls = 0;
  const waits: number[] = [];
  const result = await pollUntilTerminal(
    async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('offline');
      return { status: calls === 3 ? 'SUCCEEDED' : 'RUNNING', stage: `P0${calls}` };
    },
    {
      maxAttempts: 3,
      baseDelayMs: 5,
      maxDelayMs: 20,
      pollIntervalMs: 7,
      wait: async (delay) => {
        waits.push(delay);
      },
    },
  );
  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(waits, [5, 7]);
});

test('poll timeout is explicit and recoverable', async () => {
  await assert.rejects(
    pollUntilTerminal(async () => ({ status: 'RUNNING' }), {
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 1,
      pollIntervalMs: 1,
      wait: async () => {},
    }),
    (error: unknown) =>
      error instanceof ProcessingTimeoutError &&
      error.code === 'PROCESSING_TIMEOUT' &&
      error.recoverable,
  );
});
