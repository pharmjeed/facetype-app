/** Validated persistence for resumable scan state. */

import { POSES, type PoseLabel } from '../capture/types.ts';
import { initialState, type ScanState, type Screen, type TerminalStatus } from './scanFlow.ts';

export const SCAN_STATE_KEY = '@facetype/active-scan/v2';
const LEGACY_SCAN_STATE_KEY = '@facetype/active-scan/v1';

export interface ScanStateStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const RESUMABLE_SCREENS: Screen[] = ['scan', 'processing', 'retake'];
const TERMINAL_STATUSES: TerminalStatus[] = [
  'COMPLETED',
  'ABSTAINED',
  'RETAKE_REQUIRED',
  'MODEL_UNAVAILABLE',
  'FAILED',
];

interface PersistedEnvelope {
  version: 2;
  state: ScanState;
}

/**
 * True for the one pre-`scanId` state that still needs to survive a cold
 * restart: consent granted, `scan` mounted, and a `scanCreateKey` minted for
 * the (possibly still in-flight, possibly response-lost) createScan attempt.
 * Without persisting this, a process death between "request sent" and
 * "SCAN_CREATED dispatched" drops the only record of that logical attempt's
 * idempotency key; the next launch mints a fresh one and a server that did
 * commit the first request now has an orphaned duplicate scan (audit R1 /
 * M1-F4 follow-up). `captured`/`pending` are asserted empty/full below
 * because `capture()` requires `state.scanId`, so nothing can have been
 * captured yet in this state.
 */
function isPendingCreate(state: ScanState): boolean {
  return (
    state.scanId === null &&
    state.screen === 'scan' &&
    state.consentGranted &&
    state.scanCreateKey !== null
  );
}

/**
 * Persist a server-backed active scan, or a pending createScan attempt whose
 * idempotency key must outlive process death (see `isPendingCreate`). Any
 * other state — including RESET — removes the recovery record.
 */
export async function persistScanState(
  state: ScanState,
  storage: ScanStateStorage,
): Promise<void> {
  const resumable =
    state.scanId !== null && RESUMABLE_SCREENS.includes(state.screen);
  if (!resumable && !isPendingCreate(state)) {
    await Promise.all([
      storage.removeItem(SCAN_STATE_KEY),
      storage.removeItem(LEGACY_SCAN_STATE_KEY),
    ]);
    return;
  }
  const envelope: PersistedEnvelope = { version: 2, state };
  await storage.removeItem(LEGACY_SCAN_STATE_KEY);
  await storage.setItem(SCAN_STATE_KEY, JSON.stringify(envelope));
}

/** Ignore and remove corrupt/obsolete state rather than booting into a broken flow. */
export async function recoverScanState(storage: ScanStateStorage): Promise<ScanState | null> {
  const raw = await storage.getItem(SCAN_STATE_KEY);
  if (!raw) {
    // Version 1 lacked a stable finalize key and cannot be resumed safely.
    await storage.removeItem(LEGACY_SCAN_STATE_KEY);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const state = validatedState(parsed);
    if (state) return state;
  } catch {
    // Removal below makes the failure recoverable on the next launch too.
  }
  await storage.removeItem(SCAN_STATE_KEY);
  return null;
}

function validatedState(value: unknown): ScanState | null {
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.state)) return null;
  const state = value.state;
  if (!RESUMABLE_SCREENS.includes(state.screen as Screen)) return null;
  if (typeof state.consentGranted !== 'boolean' || typeof state.researchOptIn !== 'boolean') {
    return null;
  }
  if (!state.consentGranted) return null;

  // scanId is either a non-empty string (a created scan) or null (a
  // pending createScan attempt recorded only for its idempotency key —
  // see `isPendingCreate` in persistScanState).
  const hasScanId = typeof state.scanId === 'string' && state.scanId.length > 0;
  if (state.scanId !== null && !hasScanId) return null;
  // R1B (review 2026-08-25T23-04-18Z_941258845708): `scanCreateKey` was added
  // to this `version: 2` envelope shape in commit 777f82c without bumping the
  // version number. A record written by a pre-777f82c build has this field
  // `undefined`, which is neither `null` nor a valid key string and so falls
  // through to rejection below — the whole record is discarded and the app
  // starts a fresh scan rather than resuming with a fabricated or missing
  // key. This is an explicit pre-release decision, not an oversight: no
  // build predating 777f82c was ever distributed outside this repository's
  // own CI/dev devices (see BUILD_STATUS.md), so there is no real device
  // with a persisted record in that old shape. Were that ever not true, this
  // would need a version bump and a migration instead of a discard. See the
  // "pre-777f82c v2 envelope" test in persistence.test.ts.
  if (state.scanCreateKey !== null) {
    if (typeof state.scanCreateKey !== 'string' || !isUuidV4(state.scanCreateKey)) return null;
  }
  // Invariant mirrored from the reducer: SCAN_CREATED clears scanCreateKey
  // as it sets scanId, and nothing else sets either field independently.
  if (hasScanId === (state.scanCreateKey !== null)) return null;
  if (!hasScanId && state.screen !== 'scan') return null;

  if (state.jobId !== null && typeof state.jobId !== 'string') return null;
  if (!hasScanId && state.jobId !== null) return null;
  if (hasScanId) {
    if (typeof state.finalizeKey !== 'string' || !isUuidV4(state.finalizeKey)) return null;
  } else if (state.finalizeKey !== null) {
    return null;
  }

  const pending = poseArray(state.pending);
  const captured = poseArray(state.captured);
  if (!pending || !captured || pending.some((pose) => captured.includes(pose))) return null;
  if (new Set([...pending, ...captured]).size !== POSES.length) return null;
  // A pending create precedes every capture (`capture()` requires scanId).
  if (!hasScanId && (captured.length > 0 || pending.length !== POSES.length)) return null;

  const status = state.status;
  if (status !== null && !TERMINAL_STATUSES.includes(status as TerminalStatus)) return null;
  if (!hasScanId && status !== null) return null;
  const retakePose = state.retakePose;
  if (retakePose !== null && !POSES.includes(retakePose as PoseLabel)) return null;
  if (!hasScanId && retakePose !== null) return null;
  if (state.errorCode !== null && typeof state.errorCode !== 'string') return null;
  if (!hasScanId && state.errorCode !== null) return null;

  return {
    ...initialState,
    screen: state.screen as Screen,
    consentGranted: state.consentGranted,
    researchOptIn: state.researchOptIn,
    scanId: hasScanId ? (state.scanId as string) : null,
    scanCreateKey: state.scanCreateKey as string | null,
    jobId: state.jobId as string | null,
    finalizeKey: state.finalizeKey as string | null,
    pending,
    captured,
    status: status as TerminalStatus | null,
    errorCode: state.errorCode as string | null,
    retakePose: retakePose as PoseLabel | null,
  };
}

function poseArray(value: unknown): PoseLabel[] | null {
  if (!Array.isArray(value) || value.some((item) => !POSES.includes(item as PoseLabel))) return null;
  const poses = value as PoseLabel[];
  return new Set(poses).size === poses.length ? poses : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
