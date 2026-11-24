/**
 * The durable upload manifest (docs/capture-spec-v2.md §4: «جارٍ الرفع»
 * survives an app restart; «جارٍ التحقق» persists across restarts; offline
 * keeps the capture queued).
 *
 * WHAT IS — AND IS NOT — WRITTEN TO ASYNCSTORAGE.
 * Written: bookkeeping only — the owning account id, the client capture id
 * (the idempotency key), the server capture id, per-frame index / native spool
 * id / sha256 / byte count / size, which frames are uploaded and completed, the
 * stage, the verdict, and the attempt telemetry still to be sent after the
 * verdict (durations and reason counts — no image, no landmark; once the
 * capture is terminal it moves to `telemetryQueue.ts`). While a discard runs,
 * a small marker names what it is deleting (account id, client capture id,
 * native spool frame ids) so a process death mid-discard is finished at the
 * next boot.
 * Not written: the JPEGs (they live in the native AES-GCM spool), presigned
 * upload URLs (bearer-like; renewed after a restart), and the per-frame
 * `FrameMeta` (478 landmarks + 52 blendshapes are biometric-like data and
 * AsyncStorage is not encrypted). FrameMeta goes through `FrameMetaVault`;
 * see `metaVault.ts` for what that means after a restart.
 */

import type { CaptureView } from '../api/types.ts';
import { isPendingAttempt, type PendingAttempt } from '../telemetry.ts';

/**
 * v2 (Codex round 2, A9): every manifest names the account that made it; a
 * v1 record has no owner, fails validation and is removed (its native frames
 * are then orphans, deleted at the next boot).
 */
export const SPOOL_KEY = '@facetype/client-spool/v1';
export const MANIFEST_VERSION = 2;
/** ADR-015 §6 / native contract §3: spool frames and unfinalized captures expire after 48 h. */
export const SPOOL_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export type SpoolStage =
  | 'pending_create'
  | 'uploading'
  | 'finalizing'
  | 'checking'
  | 'received'
  | 'stored'
  | 'needs_retake'
  | 'failed'
  | 'abandoned';

/**
 * Stages after which the spool does nothing more. `received` is one: the
 * frames are verified on the server and the quality checks finish there
 * later (docs/client-app-v1.md §6); the profile follows GET /me from then on.
 */
export const TERMINAL_STAGES: readonly SpoolStage[] = ['received', 'stored', 'needs_retake', 'failed', 'abandoned'];

export interface ManifestFrame {
  index: number;
  nativeId: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  uploaded: boolean;
  completed: boolean;
}

export interface SpoolManifest {
  version: 2;
  /** The account that made this capture; never uploaded, resumed or shown under another. */
  accountId: string;
  clientCaptureId: string;
  createdAtMs: number;
  updatedAtMs: number;
  stage: SpoolStage;
  captureId: string | null;
  attempt: number;
  protocolVersion: string;
  gateConfigHash: string;
  device: Record<string, unknown>;
  camera: Record<string, unknown>;
  frames: ManifestFrame[];
  verdict: CaptureView | null;
  checkingSinceMs: number | null;
  /** Error kind/code for failed or abandoned, or the last retryable failure. */
  error: string | null;
  /** POST /attempts still owed for this capture (moved to the telemetry queue once the stage is terminal, then null). */
  attemptTelemetry: PendingAttempt | null;
}

// ---------------------------------------------------------------------------
// Discard marker (Codex round 3, A9)
// ---------------------------------------------------------------------------

/**
 * Written by a discard (sign-out, deletion, account switch) before it removes
 * anything, cleared when it has finished. A marker found at boot means the
 * process died mid-discard: the marked manifests and their spool frames are
 * deleted then, never resumed.
 */
export const DISCARD_MARKER_KEY = '@facetype/client-spool-discarded/v1';

export interface DiscardedCapture {
  accountId: string;
  clientCaptureId: string;
  /** Native spool ids of the capture's frames (deleted even if the manifest is already gone). */
  frameIds: string[];
}

export interface DiscardMarker {
  version: 1;
  captures: DiscardedCapture[];
  /** The discard also drops the owed attempt telemetry (account deletion / switch). */
  dropTelemetry: boolean;
}

export function discardedCapture(m: Pick<SpoolManifest, 'accountId' | 'clientCaptureId' | 'frames'>): DiscardedCapture {
  return { accountId: m.accountId, clientCaptureId: m.clientCaptureId, frameIds: m.frames.map((f) => f.nativeId) };
}

function isDiscardedCapture(value: unknown): value is DiscardedCapture {
  const c = value as DiscardedCapture;
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof c.accountId === 'string' &&
    typeof c.clientCaptureId === 'string' &&
    Array.isArray(c.frameIds) &&
    c.frameIds.every((id) => typeof id === 'string')
  );
}

export async function writeDiscardMarker(storage: KeyValueStorage, marker: Omit<DiscardMarker, 'version'>): Promise<void> {
  const value: DiscardMarker = { version: 1, ...marker };
  await storage.setItem(DISCARD_MARKER_KEY, JSON.stringify(value));
}

/**
 * The pending discard, if a process died during one. `'corrupt'` (unreadable
 * marker) means «discard everything»: what it named cannot be known, so
 * nothing it might have named may survive.
 */
export async function loadDiscardMarker(storage: KeyValueStorage): Promise<DiscardMarker | 'corrupt' | null> {
  const raw = await storage.getItem(DISCARD_MARKER_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as DiscardMarker;
    if (
      typeof value === 'object' &&
      value !== null &&
      value.version === 1 &&
      typeof value.dropTelemetry === 'boolean' &&
      Array.isArray(value.captures) &&
      value.captures.every(isDiscardedCapture)
    ) {
      return value;
    }
  } catch {
    // fall through
  }
  return 'corrupt';
}

export async function clearDiscardMarker(storage: KeyValueStorage): Promise<void> {
  await storage.removeItem(DISCARD_MARKER_KEY);
}

/** The manifest a pending write carries, if it is one (used to mark in-flight saves). */
export function parseManifest(raw: string): SpoolManifest | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return isManifest(value) ? value : null;
  } catch {
    return null;
  }
}

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function isTerminal(stage: SpoolStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

export async function saveManifest(storage: KeyValueStorage, manifest: SpoolManifest): Promise<void> {
  await storage.setItem(SPOOL_KEY, JSON.stringify(manifest));
}

export async function clearManifest(storage: KeyValueStorage): Promise<void> {
  await storage.removeItem(SPOOL_KEY);
}

/** Load and validate; a corrupt record is removed rather than resumed. */
export async function loadManifest(storage: KeyValueStorage): Promise<SpoolManifest | null> {
  const raw = await storage.getItem(SPOOL_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (isManifest(value)) return value;
  } catch {
    // fall through
  }
  await storage.removeItem(SPOOL_KEY);
  return null;
}

const STAGES: readonly SpoolStage[] = [
  'pending_create',
  'uploading',
  'finalizing',
  'checking',
  'received',
  'stored',
  'needs_retake',
  'failed',
  'abandoned',
];

function isFrame(value: unknown): value is ManifestFrame {
  const f = value as ManifestFrame;
  return (
    typeof f === 'object' &&
    f !== null &&
    Number.isInteger(f.index) &&
    typeof f.nativeId === 'string' &&
    /^[0-9a-f]{64}$/.test(f.sha256) &&
    Number.isInteger(f.bytes) &&
    f.bytes > 0 &&
    Number.isInteger(f.width) &&
    Number.isInteger(f.height) &&
    typeof f.uploaded === 'boolean' &&
    typeof f.completed === 'boolean' &&
    (!f.completed || f.uploaded)
  );
}

export function isManifest(value: unknown): value is SpoolManifest {
  const m = value as SpoolManifest;
  if (typeof m !== 'object' || m === null || m.version !== MANIFEST_VERSION) return false;
  if (typeof m.accountId !== 'string' || m.accountId.length === 0) return false;
  if (typeof m.clientCaptureId !== 'string' || m.clientCaptureId.length < 8) return false;
  if (m.attemptTelemetry !== null && !isPendingAttempt(m.attemptTelemetry)) return false;
  if (!STAGES.includes(m.stage)) return false;
  if (m.captureId !== null && typeof m.captureId !== 'string') return false;
  // Every stage after creation needs the server's capture id.
  if (m.stage !== 'pending_create' && m.stage !== 'abandoned' && m.stage !== 'failed' && !m.captureId) return false;
  if (!Array.isArray(m.frames) || m.frames.length === 0 || !m.frames.every(isFrame)) return false;
  const indices = m.frames.map((f) => f.index);
  if (new Set(indices).size !== indices.length) return false;
  return (
    typeof m.createdAtMs === 'number' &&
    typeof m.updatedAtMs === 'number' &&
    typeof m.attempt === 'number' &&
    typeof m.protocolVersion === 'string' &&
    typeof m.gateConfigHash === 'string' &&
    typeof m.device === 'object' &&
    typeof m.camera === 'object'
  );
}
