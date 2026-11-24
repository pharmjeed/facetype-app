/**
 * Attempt telemetry still owed to POST /attempts (Codex round 3, B2 and the
 * defect it found: acknowledging a verdict cleared the manifest that still
 * held an undelivered attempt). Owed attempts live in their own small durable
 * queue, apart from the capture manifest, so clearing a manifest can never
 * lose one.
 *
 * WHAT IS WRITTEN TO ASYNCSTORAGE: the owning account id and, per attempt, its
 * dedup key (the client capture id; an attempt that never reached the spool
 * gets a random key), the telemetry body (outcome, duration, attempt count,
 * snake_case reason counts, device model — no image, landmark or identifier)
 * and when it was queued; for an aggregate also how many records it stands
 * for and when the latest of them was queued.
 *
 *  - Account-bound: a queue of another account is removed when read, never sent.
 *  - Deduplicated by key: queueing the same capture again (a process death
 *    between «queued» and «manifest updated») never sends it twice.
 *  - Bounded without loss (Codex round 4: the earlier cap of 20 silently
 *    dropped the oldest attempts). Past `TELEMETRY_QUEUE_MAX` entries, the
 *    oldest records are folded into per-outcome aggregates: one entry with
 *    the outcome, the summed attempt count, duration and reason counts, and
 *    the earliest and latest queue times, delivered like any other entry. The
 *    individual records merge; no count is lost. The server's attempt schema
 *    has no aggregate form, so an aggregate is sent as one attempt carrying
 *    the sums, and it only ever holds sums the server accepts
 *    (`ATTEMPT_LIMITS`; a group that would exceed one starts another
 *    aggregate). A record the server would refuse anyway is never folded, so
 *    it cannot take valid counts down with it; nor is the head entry (a send
 *    may have it in flight) or the newest (its dedup key is still needed).
 */

import type { AttemptOutcome, AttemptTelemetry } from '../api/types.ts';
import { isPendingAttempt, WIRE_REASONS } from '../telemetry.ts';
import type { KeyValueStorage } from './manifest.ts';

export const TELEMETRY_QUEUE_KEY = '@facetype/client-attempt-queue/v1';
export const TELEMETRY_QUEUE_VERSION = 1;
/** Past this many entries the oldest records are folded into aggregates (never dropped). */
export const TELEMETRY_QUEUE_MAX = 200;

/**
 * The bounds `ClientAttemptInput` (services/api/.../schemas/client.py) puts
 * on one POST /attempts body; an aggregate never exceeds them. Kept equal to
 * the server by tests/contract/test_client_attempt_aggregate_bounds.py.
 */
export const ATTEMPT_LIMITS = {
  durationMs: 3_600_000,
  attempts: 10_000,
  reasonCount: 1_000_000,
} as const;

/** The reason keys the server accepts (`ATTEMPT_REASON_KEYS`); the wire names of the native reasons. */
const SERVER_REASON_KEYS: ReadonlySet<string> = new Set(Object.values(WIRE_REASONS));

/** Present on an entry that stands for several queued records folded together. */
export interface AttemptAggregate {
  /** How many records it stands for (at least 2). */
  records: number;
  /** When the latest of them was queued (`queuedAtMs` is the earliest). */
  lastQueuedAtMs: number;
}

export interface QueuedAttempt {
  /** The client capture id of a spooled capture, or a random key for an attempt that never reached the spool. */
  key: string;
  telemetry: AttemptTelemetry;
  /** When it was queued; for an aggregate, when its earliest record was. */
  queuedAtMs: number;
  aggregate?: AttemptAggregate;
}

interface StoredQueue {
  version: 1;
  accountId: string;
  entries: QueuedAttempt[];
}

const OUTCOMES: readonly AttemptOutcome[] = [
  'stored',
  'received',
  'needs_retake',
  'abandoned',
  'cancelled',
  'timed_out',
  'out_of_scope',
  'permission_denied',
];

function isAggregate(value: unknown, queuedAtMs: number): value is AttemptAggregate {
  const a = value as AttemptAggregate;
  return (
    typeof a === 'object' &&
    a !== null &&
    Number.isInteger(a.records) &&
    a.records >= 2 &&
    typeof a.lastQueuedAtMs === 'number' &&
    a.lastQueuedAtMs >= queuedAtMs
  );
}

function isQueuedAttempt(value: unknown): value is QueuedAttempt {
  const v = value as QueuedAttempt;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.key === 'string' &&
    v.key.length > 0 &&
    v.key.length <= 100 &&
    typeof v.queuedAtMs === 'number' &&
    typeof v.telemetry === 'object' &&
    v.telemetry !== null &&
    OUTCOMES.includes(v.telemetry.outcome) &&
    isPendingAttempt(v.telemetry) &&
    (v.aggregate === undefined || isAggregate(v.aggregate, v.queuedAtMs))
  );
}

function isStoredQueue(value: unknown): value is StoredQueue {
  const q = value as StoredQueue;
  return (
    typeof q === 'object' &&
    q !== null &&
    q.version === TELEMETRY_QUEUE_VERSION &&
    typeof q.accountId === 'string' &&
    q.accountId.length > 0 &&
    Array.isArray(q.entries) &&
    q.entries.every(isQueuedAttempt)
  );
}

/** JSON with object keys sorted, so equal device descriptors compare equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const within = (value: number, max: number): boolean => Number.isInteger(value) && value >= 0 && value <= max;

/** Whether the server would accept this body as it is: only such records are ever folded. */
function serverAccepts(t: AttemptTelemetry): boolean {
  const reasons = Object.entries(t.reason_counts);
  return (
    within(t.duration_ms, ATTEMPT_LIMITS.durationMs) &&
    within(t.attempts, ATTEMPT_LIMITS.attempts) &&
    reasons.length <= SERVER_REASON_KEYS.size &&
    reasons.every(([key, count]) => SERVER_REASON_KEYS.has(key) && within(count, ATTEMPT_LIMITS.reasonCount))
  );
}

/** The sums of two bodies of one outcome and device, or null when the server would refuse them. */
function summed(a: AttemptTelemetry, b: AttemptTelemetry): AttemptTelemetry | null {
  if (a.outcome !== b.outcome || stableJson(a.device) !== stableJson(b.device)) return null;
  if (!serverAccepts(a) || !serverAccepts(b)) return null;
  const reason_counts: Record<string, number> = { ...a.reason_counts };
  for (const [key, count] of Object.entries(b.reason_counts)) reason_counts[key] = (reason_counts[key] ?? 0) + count;
  const sum: AttemptTelemetry = {
    outcome: a.outcome,
    duration_ms: a.duration_ms + b.duration_ms,
    attempts: a.attempts + b.attempts,
    reason_counts,
    device: a.device,
  };
  return serverAccepts(sum) ? sum : null;
}

/** `earlier` with `later` folded into it; null when they cannot share one body. */
function fold(earlier: QueuedAttempt, later: QueuedAttempt): QueuedAttempt | null {
  const telemetry = summed(earlier.telemetry, later.telemetry);
  if (!telemetry) return null;
  const last = (e: QueuedAttempt) => e.aggregate?.lastQueuedAtMs ?? e.queuedAtMs;
  return {
    // A new aggregate gets a key of its own: the record's key is that
    // record's, and a later retry of it must not be mistaken for the sum.
    key: earlier.aggregate ? earlier.key : `aggregate:${earlier.key}`.slice(0, 100),
    telemetry,
    queuedAtMs: Math.min(earlier.queuedAtMs, later.queuedAtMs),
    aggregate: {
      records: (earlier.aggregate?.records ?? 1) + (later.aggregate?.records ?? 1),
      lastQueuedAtMs: Math.max(last(earlier), last(later)),
    },
  };
}

/**
 * Bring the queue back to `TELEMETRY_QUEUE_MAX` entries without losing a
 * count: oldest first, each record is folded into the earliest entry it can
 * share a body with. Two entries are left alone. The head: a send may have
 * it in flight, and folding into it would send the folded records again
 * after the send removes it by key. The newest: it was queued just now and
 * its manifest may not record that yet, so it keeps its key for the dedup
 * check of a re-queue. When nothing more can fold — every record left is
 * the server's to refuse, or every group is at a bound — the queue stays
 * longer than the cap rather than drop anything.
 */
function compact(entries: QueuedAttempt[]): QueuedAttempt[] {
  if (entries.length <= TELEMETRY_QUEUE_MAX) return entries;
  const out = [...entries];
  for (let i = 2; i < out.length - 1 && out.length > TELEMETRY_QUEUE_MAX; ) {
    const later = out[i]!;
    let folded = false;
    for (let j = 1; j < i; j += 1) {
      const merged = fold(out[j]!, later);
      if (merged) {
        out[j] = merged;
        out.splice(i, 1);
        folded = true;
        break;
      }
    }
    if (!folded) i += 1;
  }
  return out;
}

/** The account's owed attempts, oldest first. Another account's queue, or a corrupt one, is removed. */
export async function loadAttemptQueue(storage: KeyValueStorage, accountId: string): Promise<QueuedAttempt[]> {
  const raw = await storage.getItem(TELEMETRY_QUEUE_KEY);
  if (!raw) return [];
  let value: unknown = null;
  try {
    value = JSON.parse(raw);
  } catch {
    // removed below
  }
  if (isStoredQueue(value) && value.accountId === accountId) return value.entries;
  await storage.removeItem(TELEMETRY_QUEUE_KEY);
  return [];
}

async function storeQueue(storage: KeyValueStorage, accountId: string, entries: QueuedAttempt[]): Promise<void> {
  if (entries.length === 0) {
    await storage.removeItem(TELEMETRY_QUEUE_KEY);
    return;
  }
  const queue: StoredQueue = { version: TELEMETRY_QUEUE_VERSION, accountId, entries };
  await storage.setItem(TELEMETRY_QUEUE_KEY, JSON.stringify(queue));
}

/** Owe one more attempt (once per key; past the cap the oldest records fold into aggregates). */
export async function queueAttempt(storage: KeyValueStorage, accountId: string, entry: QueuedAttempt): Promise<void> {
  const entries = await loadAttemptQueue(storage, accountId);
  if (entries.some((queued) => queued.key === entry.key)) return;
  await storeQueue(storage, accountId, compact([...entries, entry]));
}

/** Forget one attempt (delivered, or refused by the server). */
export async function removeQueuedAttempt(storage: KeyValueStorage, accountId: string, key: string): Promise<void> {
  const entries = await loadAttemptQueue(storage, accountId);
  const left = entries.filter((queued) => queued.key !== key);
  if (left.length !== entries.length) await storeQueue(storage, accountId, left);
}

/** Drop every owed attempt (account deletion, account switch). */
export async function clearAttemptQueue(storage: KeyValueStorage): Promise<void> {
  await storage.removeItem(TELEMETRY_QUEUE_KEY);
}
