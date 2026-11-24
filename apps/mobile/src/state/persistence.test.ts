import assert from 'node:assert/strict';
import test from 'node:test';

import { initialState, type ScanState } from './scanFlow.ts';
import {
  SCAN_STATE_KEY,
  persistScanState,
  recoverScanState,
  type ScanStateStorage,
} from './persistence.ts';

const FINALIZE_KEY = '123e4567-e89b-42d3-a456-426614174000';

function memoryStorage(): ScanStateStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
    async removeItem(key) {
      values.delete(key);
    },
  };
}

test('cold restart recovers the same scan, job, and finalize idempotency key', async () => {
  const storage = memoryStorage();
  const active: ScanState = {
    ...initialState,
    screen: 'processing',
    consentGranted: true,
    scanId: 'scn_123',
    jobId: 'job_123',
    finalizeKey: FINALIZE_KEY,
    pending: [],
    captured: ['front', 'left_25', 'right_25', 'up_15', 'down_15'],
  };

  await persistScanState(active, storage);
  const recovered = await recoverScanState(storage);
  assert.deepEqual(recovered, active);
  assert.equal(recovered?.finalizeKey, FINALIZE_KEY);
});

test('reset state removes the persisted active scan', async () => {
  const storage = memoryStorage();
  storage.values.set(SCAN_STATE_KEY, 'stale');
  await persistScanState(initialState, storage);
  assert.equal(storage.values.has(SCAN_STATE_KEY), false);
});

test('corrupt persisted state is discarded safely', async () => {
  const storage = memoryStorage();
  storage.values.set(SCAN_STATE_KEY, '{not json');
  assert.equal(await recoverScanState(storage), null);
  assert.equal(storage.values.has(SCAN_STATE_KEY), false);
});

test('a pending createScan attempt survives a cold restart and keeps the same key', async () => {
  const storage = memoryStorage();
  const createKey = '11111111-1111-4111-8111-111111111111';
  const pending: ScanState = {
    ...initialState,
    screen: 'scan',
    consentGranted: true,
    researchOptIn: true,
    scanCreateKey: createKey,
  };

  await persistScanState(pending, storage);
  const recovered = await recoverScanState(storage);
  assert.deepEqual(recovered, pending);
  assert.equal(recovered?.scanCreateKey, createKey);
  assert.equal(recovered?.scanId, null);
});

test('SCAN_CREATED clears the persisted pending-create record', async () => {
  const storage = memoryStorage();
  const createKey = '11111111-1111-4111-8111-111111111111';
  await persistScanState(
    { ...initialState, screen: 'scan', consentGranted: true, scanCreateKey: createKey },
    storage,
  );
  assert.equal(storage.values.has(SCAN_STATE_KEY), true);

  // SCAN_CREATED (via the reducer) clears scanCreateKey and sets scanId;
  // the next persist call must replace the pending-create record, not just
  // leave it stale — and RESET must remove it outright.
  await persistScanState(
    {
      ...initialState,
      screen: 'scan',
      consentGranted: true,
      scanId: 'scn_123',
      finalizeKey: FINALIZE_KEY,
    },
    storage,
  );
  const recovered = await recoverScanState(storage);
  assert.equal(recovered?.scanId, 'scn_123');
  assert.equal(recovered?.scanCreateKey, null);

  await persistScanState(initialState, storage);
  assert.equal(storage.values.has(SCAN_STATE_KEY), false);
});

test('a pending-create record with no key is not persisted (nothing to resume)', async () => {
  const storage = memoryStorage();
  await persistScanState({ ...initialState, screen: 'scan', consentGranted: true }, storage);
  assert.equal(storage.values.has(SCAN_STATE_KEY), false);
});

test('a pending-create record with captured poses already recorded is rejected', async () => {
  const storage = memoryStorage();
  const createKey = '11111111-1111-4111-8111-111111111111';
  storage.values.set(
    SCAN_STATE_KEY,
    JSON.stringify({
      version: 2,
      state: {
        ...initialState,
        screen: 'scan',
        consentGranted: true,
        scanCreateKey: createKey,
        captured: ['front'],
        pending: ['left_25', 'right_25', 'up_15', 'down_15'],
      },
    }),
  );
  assert.equal(await recoverScanState(storage), null);
});

test('a scanId together with a scanCreateKey violates the SCAN_CREATED invariant and is rejected', async () => {
  const storage = memoryStorage();
  const createKey = '11111111-1111-4111-8111-111111111111';
  storage.values.set(
    SCAN_STATE_KEY,
    JSON.stringify({
      version: 2,
      state: {
        ...initialState,
        screen: 'scan',
        consentGranted: true,
        scanId: 'scn_123',
        finalizeKey: FINALIZE_KEY,
        scanCreateKey: createKey,
      },
    }),
  );
  assert.equal(await recoverScanState(storage), null);
});

test('R1B: a pre-777f82c v2 envelope missing scanCreateKey is discarded, not resumed', async () => {
  // Documented pre-release compatibility decision (no scanCreateKey field
  // existed in the `version: 2` envelope before commit 777f82c, and no
  // build carrying that shape was ever distributed outside this repo's own
  // CI/dev devices — see BUILD_STATUS.md). Rather than silently guessing a
  // legacy record's create-key state, recovery discards it and the app
  // starts a fresh scan; it must not throw or resume with a fabricated key.
  const storage = memoryStorage();
  const legacyEnvelope = {
    version: 2,
    state: {
      screen: 'processing',
      consentGranted: true,
      analyticsConsent: false,
      researchOptIn: false,
      scanId: 'scn_legacy',
      jobId: 'job_legacy',
      // scanCreateKey did not exist in this shape at all.
      finalizeKey: FINALIZE_KEY,
      pending: [],
      captured: ['front', 'left_25', 'right_25', 'up_15', 'down_15'],
      status: null,
      errorCode: null,
      retakePose: null,
    },
  };
  storage.values.set(SCAN_STATE_KEY, JSON.stringify(legacyEnvelope));
  assert.equal(await recoverScanState(storage), null);
  // The unrecoverable record is removed rather than left to fail again on
  // every future launch.
  assert.equal(storage.values.has(SCAN_STATE_KEY), false);
});

test('unknown poses cannot be injected through persisted JSON', async () => {
  const storage = memoryStorage();
  storage.values.set(
    SCAN_STATE_KEY,
    JSON.stringify({
      version: 2,
      state: {
        ...initialState,
        screen: 'scan',
        consentGranted: true,
        scanId: 'scn_123',
        finalizeKey: FINALIZE_KEY,
        pending: ['profile'],
      },
    }),
  );
  assert.equal(await recoverScanState(storage), null);
});
