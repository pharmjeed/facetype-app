/** Consent -> preview-ready -> scan-creation ordering contract, without React Native. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { runPreviewReadySequence } from './previewReadySequence.ts';

/** A deps fixture that mints one key and never has an existing scan, recording call order. */
function freshScanDeps(calls: string[], overrides: Partial<Parameters<typeof runPreviewReadySequence>[0]> = {}) {
  return {
    startProvider: async () => {
      calls.push('start');
    },
    hasExistingScan: () => false,
    resolveCreateKey: () => {
      calls.push('resolveCreateKey');
      return { key: 'key_1', isNew: true };
    },
    onKeyMinted: (key: string) => {
      calls.push(`onKeyMinted:${key}`);
    },
    persistPendingCreate: async (key: string) => {
      calls.push(`persist:${key}`);
    },
    createScan: async (key: string) => {
      calls.push(`createScan:${key}`);
      return { scanId: 'scn_1', finalizeKey: 'fkey_1' };
    },
    ...overrides,
  };
}

test('a fresh scan starts the provider, mints and persists the key, then creates the scan', async () => {
  const calls: string[] = [];
  const outcome = await runPreviewReadySequence(freshScanDeps(calls));
  assert.deepEqual(calls, [
    'start',
    'resolveCreateKey',
    'onKeyMinted:key_1',
    'persist:key_1',
    'createScan:key_1',
  ]);
  assert.deepEqual(outcome, { scanId: 'scn_1', finalizeKey: 'fkey_1' });
});

test('R1A: createScan never starts until persistPendingCreate has resolved (deferred persist)', async () => {
  const calls: string[] = [];
  let releasePersist: (() => void) | undefined;
  const persistGate = new Promise<void>((resolve) => {
    releasePersist = resolve;
  });

  const runPromise = runPreviewReadySequence(
    freshScanDeps(calls, {
      persistPendingCreate: async (key) => {
        calls.push(`persist-start:${key}`);
        await persistGate;
        calls.push(`persist-end:${key}`);
      },
    }),
  );

  // Let all microtasks up to (but not past) the persist gate flush.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(
    calls,
    ['start', 'resolveCreateKey', 'onKeyMinted:key_1', 'persist-start:key_1'],
    'createScan must not have run while persistence is still pending',
  );

  releasePersist?.();
  const outcome = await runPromise;
  assert.deepEqual(calls, [
    'start',
    'resolveCreateKey',
    'onKeyMinted:key_1',
    'persist-start:key_1',
    'persist-end:key_1',
    'createScan:key_1',
  ]);
  assert.deepEqual(outcome, { scanId: 'scn_1', finalizeKey: 'fkey_1' });
});

test('R1A: a storage failure fails closed — createScan is never called', async () => {
  const calls: string[] = [];
  await assert.rejects(
    runPreviewReadySequence(
      freshScanDeps(calls, {
        persistPendingCreate: async (key) => {
          calls.push(`persist:${key}`);
          throw new Error('STORAGE_FULL');
        },
        createScan: async (key) => {
          calls.push(`createScan:${key}`);
          return { scanId: 'scn_1', finalizeKey: 'fkey_1' };
        },
      }),
    ),
    /STORAGE_FULL/,
  );
  assert.deepEqual(calls, ['start', 'resolveCreateKey', 'onKeyMinted:key_1', 'persist:key_1']);
});

test('a reused key (retry) is not re-minted, but is still persisted before createScan', async () => {
  const calls: string[] = [];
  const outcome = await runPreviewReadySequence(
    freshScanDeps(calls, {
      resolveCreateKey: () => {
        calls.push('resolveCreateKey');
        return { key: 'key_existing', isNew: false };
      },
      onKeyMinted: () => {
        calls.push('onKeyMinted');
      },
    }),
  );
  assert.deepEqual(calls, ['start', 'resolveCreateKey', 'persist:key_existing', 'createScan:key_existing']);
  assert.deepEqual(outcome, { scanId: 'scn_1', finalizeKey: 'fkey_1' });
});

test('a retake starts the provider again but never creates a second scan', async () => {
  const calls: string[] = [];
  const outcome = await runPreviewReadySequence(
    freshScanDeps(calls, {
      hasExistingScan: () => true,
    }),
  );
  assert.deepEqual(calls, ['start']);
  assert.equal(outcome, null);
});

test('the provider never starts a scan that was never created (start fails)', async () => {
  const calls: string[] = [];
  await assert.rejects(
    runPreviewReadySequence(
      freshScanDeps(calls, {
        startProvider: async () => {
          throw new Error('FT-REC-005');
        },
      }),
    ),
    /FT-REC-005/,
  );
  assert.deepEqual(calls, []);
});
