/**
 * The owed-attempt queue (Codex round 3, B2): account-bound, deduplicated by
 * capture id, and a corrupt record is removed rather than sent. Bounded
 * without loss (Codex round 4): past the cap the oldest records fold into
 * per-outcome aggregates that keep every count.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AttemptOutcome, AttemptTelemetry } from '../api/types.ts';
import type { KeyValueStorage } from './manifest.ts';
import {
  ATTEMPT_LIMITS,
  clearAttemptQueue,
  loadAttemptQueue,
  queueAttempt,
  removeQueuedAttempt,
  TELEMETRY_QUEUE_KEY,
  TELEMETRY_QUEUE_MAX,
  type QueuedAttempt,
} from './telemetryQueue.ts';

function memoryStorage(): KeyValueStorage & { raw(): string | null } {
  const map = new Map<string, string>();
  return {
    async getItem(key) {
      return map.get(key) ?? null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async removeItem(key) {
      map.delete(key);
    },
    raw() {
      return map.get(TELEMETRY_QUEUE_KEY) ?? null;
    },
  };
}

const TELEMETRY: AttemptTelemetry = {
  outcome: 'stored',
  duration_ms: 4200,
  attempts: 2,
  reason_counts: { one_face: 1 },
  device: { platform: 'android' },
};

const entry = (key: string, queuedAtMs = 0) => ({ key, telemetry: TELEMETRY, queuedAtMs });

test('one entry per capture id; removal forgets only that one; the last removal deletes the record', async () => {
  const storage = memoryStorage();
  await queueAttempt(storage, 'acc-a', entry('cap-1'));
  await queueAttempt(storage, 'acc-a', entry('cap-1', 99));
  await queueAttempt(storage, 'acc-a', entry('cap-2'));
  assert.deepEqual(
    (await loadAttemptQueue(storage, 'acc-a')).map((e) => [e.key, e.queuedAtMs]),
    [
      ['cap-1', 0],
      ['cap-2', 0],
    ],
  );
  await removeQueuedAttempt(storage, 'acc-a', 'cap-1');
  assert.deepEqual(
    (await loadAttemptQueue(storage, 'acc-a')).map((e) => e.key),
    ['cap-2'],
  );
  await removeQueuedAttempt(storage, 'acc-a', 'cap-2');
  assert.equal(storage.raw(), null);
});

/** Per outcome: records, attempts, duration and reason counts the entries stand for. */
function totals(entries: readonly QueuedAttempt[]) {
  const out: Record<string, { records: number; attempts: number; duration: number; reasons: Record<string, number> }> = {};
  for (const e of entries) {
    const t = (out[e.telemetry.outcome] ??= { records: 0, attempts: 0, duration: 0, reasons: {} });
    t.records += e.aggregate?.records ?? 1;
    t.attempts += e.telemetry.attempts;
    t.duration += e.telemetry.duration_ms;
    for (const [key, count] of Object.entries(e.telemetry.reason_counts)) t.reasons[key] = (t.reasons[key] ?? 0) + count;
  }
  return out;
}

const owed = (outcome: AttemptOutcome, i: number, extra: Partial<AttemptTelemetry> = {}) => ({
  key: `${outcome}-${i}`,
  telemetry: { ...TELEMETRY, outcome, attempts: 1 + (i % 4), duration_ms: 1000 + i, reason_counts: { light: i % 3, eyes: 1 }, ...extra },
  queuedAtMs: 1000 + i,
});

test('round 4: past the cap the oldest records fold into per-outcome aggregates; no count is lost', async () => {
  assert.equal(TELEMETRY_QUEUE_MAX, 200);
  const storage = memoryStorage();
  const queued: QueuedAttempt[] = [];
  for (let i = 0; i < TELEMETRY_QUEUE_MAX + 25; i += 1) {
    const e = owed(i % 3 === 0 ? 'permission_denied' : 'cancelled', i);
    queued.push(e);
    await queueAttempt(storage, 'acc-a', e);
  }
  const entries = await loadAttemptQueue(storage, 'acc-a');
  assert.equal(entries.length, TELEMETRY_QUEUE_MAX);
  // Every record is still there: as itself or inside an aggregate, per outcome.
  assert.deepEqual(totals(entries), totals(queued));
  // The head (a send may have it in flight) and the newest records are untouched.
  assert.deepEqual(entries[0], queued[0]);
  assert.deepEqual(entries.slice(-150), queued.slice(-150));
  // One aggregate per outcome holding the oldest records after the head, in
  // order: 25 folds absorb records 2 and 4..27 into the first record of each
  // outcome (1 and 3), with the earliest and latest queue times.
  const aggregates = entries.filter((e) => e.aggregate);
  assert.deepEqual(
    aggregates.map((e) => [e.key, e.telemetry.outcome, e.aggregate?.records, e.queuedAtMs, e.aggregate?.lastQueuedAtMs]),
    [
      ['aggregate:cancelled-1', 'cancelled', 18, 1001, 1026],
      ['aggregate:permission_denied-3', 'permission_denied', 9, 1003, 1027],
    ],
  );
  assert.deepEqual(entries.slice(3, 6), queued.slice(28, 31));
  assert.deepEqual(aggregates[0]!.telemetry.device, TELEMETRY.device);
});

test("Codex round 4's reproduction: 201 owed attempts keep the oldest permission denial", async () => {
  const storage = memoryStorage();
  await queueAttempt(storage, 'acc-a', owed('permission_denied', 0));
  for (let i = 1; i <= TELEMETRY_QUEUE_MAX; i += 1) await queueAttempt(storage, 'acc-a', owed('cancelled', i));
  const entries = await loadAttemptQueue(storage, 'acc-a');
  assert.equal(entries.length, TELEMETRY_QUEUE_MAX);
  assert.equal(entries[0]!.telemetry.outcome, 'permission_denied');
  assert.equal(totals(entries).cancelled!.records, TELEMETRY_QUEUE_MAX);
});

test('an aggregate never exceeds what the server accepts: a group at a bound starts another', async () => {
  const storage = memoryStorage();
  const queued: QueuedAttempt[] = [];
  for (let i = 0; i < TELEMETRY_QUEUE_MAX + 4; i += 1) {
    const e = owed('timed_out', i, { attempts: 4_000, duration_ms: 1_000_000 });
    queued.push(e);
    await queueAttempt(storage, 'acc-a', e);
  }
  const entries = await loadAttemptQueue(storage, 'acc-a');
  assert.equal(entries.length, TELEMETRY_QUEUE_MAX);
  assert.deepEqual(totals(entries), totals(queued));
  const aggregates = entries.filter((e) => e.aggregate);
  assert.equal(aggregates.length, 4, 'two records per aggregate: a third would pass 10,000 attempts');
  for (const e of aggregates) {
    assert.ok(e.telemetry.attempts <= ATTEMPT_LIMITS.attempts);
    assert.ok(e.telemetry.duration_ms <= ATTEMPT_LIMITS.durationMs);
  }

  // Records that cannot share a body at all are kept as they are: the queue
  // stays longer than the cap rather than drop one.
  const full = memoryStorage();
  for (let i = 0; i < TELEMETRY_QUEUE_MAX + 3; i += 1) {
    await queueAttempt(full, 'acc-a', owed('timed_out', i, { duration_ms: 2_000_000 }));
  }
  const kept = await loadAttemptQueue(full, 'acc-a');
  assert.equal(kept.length, TELEMETRY_QUEUE_MAX + 3);
  assert.ok(kept.every((e) => !e.aggregate));
});

test('a record the server would refuse, or from another device, never shares an aggregate', async () => {
  const storage = memoryStorage();
  const queued: QueuedAttempt[] = [
    owed('stored', 0),
    owed('stored', 1, { reason_counts: { future_reason: 1 } }),
    owed('stored', 2, { attempts: 10_001 }),
    owed('stored', 3, { device: { platform: 'ios' } }),
  ];
  for (let i = 4; i < TELEMETRY_QUEUE_MAX + 6; i += 1) queued.push(owed('stored', i));
  for (const e of queued) await queueAttempt(storage, 'acc-a', e);
  const entries = await loadAttemptQueue(storage, 'acc-a');
  assert.equal(entries.length, TELEMETRY_QUEUE_MAX);
  assert.deepEqual(totals(entries), totals(queued));
  for (const odd of queued.slice(1, 4)) assert.deepEqual(entries.find((e) => e.key === odd.key), odd, odd.key);
  const aggregates = entries.filter((e) => e.aggregate);
  assert.equal(aggregates.length, 1);
  assert.deepEqual(aggregates[0]!.telemetry.device, TELEMETRY.device);
  assert.ok(Object.keys(aggregates[0]!.telemetry.reason_counts).every((key) => key !== 'future_reason'));
});

test('an aggregate is stored, reloaded and removed by its key like any entry; a malformed one is discarded', async () => {
  const storage = memoryStorage();
  for (let i = 0; i < TELEMETRY_QUEUE_MAX + 2; i += 1) await queueAttempt(storage, 'acc-a', owed('cancelled', i));
  const aggregate = (await loadAttemptQueue(storage, 'acc-a')).find((e) => e.aggregate)!;
  assert.equal(aggregate.aggregate?.records, 3);
  assert.deepEqual(aggregate.telemetry, {
    ...TELEMETRY,
    outcome: 'cancelled',
    attempts: 2 + 3 + 4,
    duration_ms: 1001 + 1002 + 1003,
    reason_counts: { light: 1 + 2 + 0, eyes: 3 },
  });
  await removeQueuedAttempt(storage, 'acc-a', aggregate.key);
  const left = await loadAttemptQueue(storage, 'acc-a');
  assert.equal(left.length, TELEMETRY_QUEUE_MAX - 1);
  assert.ok(left.every((e) => !e.aggregate));

  const stored = JSON.parse(storage.raw() ?? 'null');
  stored.entries[1] = { ...stored.entries[1], aggregate: { records: 1, lastQueuedAtMs: 0 } };
  await storage.setItem(TELEMETRY_QUEUE_KEY, JSON.stringify(stored));
  assert.deepEqual(await loadAttemptQueue(storage, 'acc-a'), []);
  assert.equal(storage.raw(), null);
});

test("another account's queue is removed when read, never returned", async () => {
  const storage = memoryStorage();
  await queueAttempt(storage, 'acc-a', entry('cap-1'));
  assert.deepEqual(await loadAttemptQueue(storage, 'acc-b'), []);
  assert.equal(storage.raw(), null);
  assert.deepEqual(await loadAttemptQueue(storage, 'acc-a'), []);
});

test('a corrupt or invalid record is removed rather than sent; clear drops everything', async () => {
  const storage = memoryStorage();
  await storage.setItem(TELEMETRY_QUEUE_KEY, '{not json');
  assert.deepEqual(await loadAttemptQueue(storage, 'acc-a'), []);
  assert.equal(storage.raw(), null);
  await storage.setItem(
    TELEMETRY_QUEUE_KEY,
    JSON.stringify({ version: 1, accountId: 'acc-a', entries: [{ ...entry('cap-1'), telemetry: { ...TELEMETRY, outcome: 'bogus' } }] }),
  );
  assert.deepEqual(await loadAttemptQueue(storage, 'acc-a'), []);
  assert.equal(storage.raw(), null);
  await queueAttempt(storage, 'acc-a', entry('cap-1'));
  await clearAttemptQueue(storage);
  assert.equal(storage.raw(), null);
});

test('what is written: account id, key, telemetry body, time — no image, landmark or upload URL', async () => {
  const storage = memoryStorage();
  await queueAttempt(storage, 'acc-a', entry('cap-1', 5));
  assert.deepEqual(JSON.parse(storage.raw() ?? 'null'), {
    version: 1,
    accountId: 'acc-a',
    entries: [{ key: 'cap-1', telemetry: TELEMETRY, queuedAtMs: 5 }],
  });
});
