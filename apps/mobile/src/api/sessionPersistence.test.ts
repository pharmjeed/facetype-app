import assert from 'node:assert/strict';
import test from 'node:test';

import { createApi, getToken, setToken } from './client.ts';
import {
  persistSessionToken,
  recoverSessionToken,
  type SecureValueStore,
} from './sessionPersistence.ts';

function secureMemoryStore(): SecureValueStore & { value: string | null } {
  return {
    value: null,
    async get() {
      return this.value;
    },
    async set(value) {
      this.value = value;
    },
    async remove() {
      this.value = null;
    },
  };
}

test('cold restart restores the bearer token before API work resumes', async () => {
  const secureStore = secureMemoryStore();
  const token = 'synthetic-nonempty';
  await persistSessionToken(token, 3_600, secureStore, 1_000);

  // Simulate a terminated JS process: its module-level token is gone, while
  // the platform credential remains available to the new process.
  setToken(null);
  const recovered = await recoverSessionToken(secureStore, 2_000);
  setToken(recovered);

  assert.equal(recovered, token);
  assert.equal(getToken(), token);
  setToken(null);
});

test('an expired session is erased instead of being sent after restart', async () => {
  const secureStore = secureMemoryStore();
  await persistSessionToken('synthetic-nonempty', 1, secureStore, 1_000);
  assert.equal(await recoverSessionToken(secureStore, 2_001), null);
  assert.equal(secureStore.value, null);
});

test('a corrupt secure credential fails closed and is erased', async () => {
  const secureStore = secureMemoryStore();
  secureStore.value = '{bad json';
  assert.equal(await recoverSessionToken(secureStore), null);
  assert.equal(secureStore.value, null);
});

test('a 401 clears both the in-memory token and the persisted-token callback', async () => {
  const originalFetch = globalThis.fetch;
  let clearedPersistedToken = false;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        error_code: 'FT-AUTH-001',
        detail: 'Expired session',
        message_key: 'error.auth',
        retryable: false,
        action: { type: 'LOGIN_OR_NEW_SESSION' },
      }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );

  try {
    setToken('synthetic-nonempty');
    const api = createApi('https://api.example', () => {
      clearedPersistedToken = true;
    });
    await assert.rejects(api.authMe());
    assert.equal(getToken(), null);
    assert.equal(clearedPersistedToken, true);
  } finally {
    setToken(null);
    globalThis.fetch = originalFetch;
  }
});
