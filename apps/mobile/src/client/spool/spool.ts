/**
 * Drives one capture from the native spool to a server verdict:
 *
 *   pending_create → POST /captures (client_capture_id = idempotency key)
 *   uploading      → per frame: native uploadFrame to the presigned PUT
 *                    (renewed when expired or about to expire) → complete {meta}
 *                    → deleteFrames once the server has re-hashed it
 *   finalizing     → POST /captures/{id}/finalize
 *   checking       → GET /captures/{id} until received | stored | needs_retake |
 *                    needs_more | complete (ADR-016: `measuring` keeps polling)
 *   (terminal)     → POST /attempts once, with the verdict as the outcome
 *
 * Every transition is saved before the next network call, so a restart resumes
 * from the last durable step. Network and 5xx failures leave the manifest
 * queued and schedule a retry with backoff; elapsed time never implies
 * acceptance. A non-retryable refusal ends in `failed` and deletes the local
 * frames — the server said no and the photos must not linger on the device.
 *
 * DISCARD IS FINAL (Codex round 2 + 3, A9). Each run belongs to a *generation*.
 * `discard()` (sign-out, account deletion, session expiry) and an account
 * switch bump the generation and abort the run's in-flight HTTP request; every
 * continuation of an older run checks the generation after each await and
 * stops before it persists, uploads, completes or polls anything more, and no
 * storage write of an older generation can start any more. A write already
 * started cannot be recalled, so the discard first writes a durable marker
 * (account id, capture id, frame ids), then waits for every write in flight to
 * land, then deletes frames, manifest and marker. A process death anywhere in
 * between leaves the marker, and the next boot (`recoverDiscarded`, also run
 * before the first operation of a runner) finishes the discard. Each manifest
 * names its account: a manifest of another account is deleted (frames and
 * record), never resumed.
 *
 * ATTEMPT TELEMETRY (Codex round 3, B2). The attempt rides in the manifest
 * until the capture is terminal; then it moves to its own durable queue
 * (`telemetryQueue.ts`) before the manifest may be cleared, and every run
 * sends what the queue owes: offline or server trouble keeps it (with its own
 * backoff — `telemetryRetryInMs` tells the pump when to run again), a
 * validation refusal drops it, an account switch or deletion drops the queue.
 */

import { CLIENT_PROTOCOL_VERSION, gateConfigHash } from '@facetype/contracts';

import { isClientApiError, uuidV4, type CallOptions, type ClientApi } from '../api/clientApi.ts';
import type { AttemptTelemetry, CaptureCreate, CaptureView, FrameUploadTarget } from '../api/types.ts';
import { nativeErrorCode, type BurstFrame, type CameraCapabilities, type ClientCameraModule } from '../native/types.ts';
import { outcomeForStage, type PendingAttempt } from '../telemetry.ts';
import {
  clearDiscardMarker,
  clearManifest,
  discardedCapture,
  isTerminal,
  loadDiscardMarker,
  loadManifest,
  MANIFEST_VERSION,
  parseManifest,
  saveManifest,
  SPOOL_KEY,
  SPOOL_MAX_AGE_MS,
  writeDiscardMarker,
  type DiscardedCapture,
  type KeyValueStorage,
  type SpoolManifest,
} from './manifest.ts';
import type { FrameMetaVault } from './metaVault.ts';
import { clearAttemptQueue, loadAttemptQueue, queueAttempt, removeQueuedAttempt, TELEMETRY_QUEUE_MAX } from './telemetryQueue.ts';

export { CLIENT_PROTOCOL_VERSION };

export const SPOOL_TIMING = {
  /** Renew an upload URL that expires within this window. */
  renewMarginMs: 60_000,
  pollFastMs: 2_000,
  pollSlowMs: 5_000,
  /** After this long in «جارٍ التحقق» the screen says the result will appear on the profile. */
  checkingNoticeMs: 30_000,
  backoffBaseMs: 2_000,
  backoffMaxMs: 60_000,
} as const;

export type SpoolOutcome = (
  | { kind: 'idle' }
  | { kind: 'terminal'; manifest: SpoolManifest }
  | { kind: 'waiting'; manifest: SpoolManifest; retryInMs: number; reason: 'offline' | 'server' | 'checking' }
  | { kind: 'blocked'; reason: 'session' }
) & {
  /** Attempt telemetry is still owed (queued, not yet delivered): run again in this many ms. Absent when none is owed. */
  telemetryRetryInMs?: number;
};

/** When the pump should run the spool again (the capture's retry or the owed telemetry's, whichever is first); null = not until something changes. */
export function nextRunInMs(outcome: SpoolOutcome): number | null {
  if (outcome.kind === 'blocked') return null;
  const delays: number[] = [];
  if (outcome.kind === 'waiting') delays.push(outcome.retryInMs);
  if (outcome.telemetryRetryInMs !== undefined) delays.push(outcome.telemetryRetryInMs);
  return delays.length > 0 ? Math.max(0, Math.min(...delays)) : null;
}

export interface DiscardOptions {
  /**
   * `'drop'` (the default: account deletion, account switch) also deletes the
   * attempt telemetry still owed. `'keep'` (sign-out, expired session) leaves
   * it queued for the same account's next session; it is bound to that
   * account and dropped as soon as another one signs in.
   */
  telemetry?: 'drop' | 'keep';
}

function backoffMs(failures: number): number {
  const ms = SPOOL_TIMING.backoffBaseMs * 2 ** Math.min(failures, 10);
  return Math.min(ms, SPOOL_TIMING.backoffMaxMs);
}

export interface SpoolDeps {
  api: Pick<ClientApi, 'createCapture' | 'renewFrameUpload' | 'completeFrame' | 'finalizeCapture' | 'getCapture' | 'postAttempt'>;
  camera: Pick<ClientCameraModule, 'uploadFrame' | 'deleteFrames' | 'listSpool'>;
  storage: KeyValueStorage;
  vault: FrameMetaVault;
  now?: () => number;
}

export interface EnqueueInput {
  /** The signed-in account the capture belongs to. */
  accountId: string;
  frames: BurstFrame[];
  attempt: number;
  capabilities: CameraCapabilities | null;
  /** POST /attempts owed once the verdict is known (never sent at enqueue time). */
  telemetry?: PendingAttempt | null;
  clientCaptureId?: string;
}

export function captureDevice(caps: CameraCapabilities | null): {
  device: Record<string, unknown>;
  camera: Record<string, unknown>;
} {
  if (!caps) return { device: { missing_reason: 'capabilities_unavailable' }, camera: {} };
  return {
    device: {
      platform: caps.platform,
      model: caps.deviceModel,
      manufacturer: caps.manufacturer,
      os_version: caps.osVersion,
    },
    camera: {
      id: caps.frontCamera.id,
      sizes: caps.frontCamera.sizes,
      focal_lengths_mm: caps.frontCamera.focalLengthsMm,
      sensor_size_mm: caps.frontCamera.sensorSizeMm,
      has_intrinsic_calibration: caps.frontCamera.hasIntrinsicCalibration,
      distortion_correction: caps.frontCamera.distortionCorrection,
      mediapipe_model_sha256: caps.mediapipeModelSha256,
    },
  };
}

async function deleteFrameIds(deps: SpoolDeps, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await deps.camera.deleteFrames(ids);
  } catch {
    // Orphan cleanup at the next boot catches what this misses.
  }
  await deps.vault.delete(ids);
}

async function dropManifestFrames(deps: SpoolDeps, m: SpoolManifest): Promise<void> {
  await deleteFrameIds(
    deps,
    m.frames.map((f) => f.nativeId),
  );
}

/**
 * Persist a finished burst as a new manifest owned by `accountId` (the
 * frames' meta goes to the vault). A previous terminal manifest is replaced;
 * another account's manifest is deleted with its frames; an in-flight one of
 * the same account is refused — one capture at a time. Prefer
 * `SpoolRunner.enqueue`, which also stops a capture enqueued while the person
 * was signing out.
 */
export async function enqueueCapture(deps: SpoolDeps, input: EnqueueInput): Promise<SpoolManifest> {
  if (!input.accountId) throw new Error('a capture needs its account');
  if (input.frames.length === 0) throw new Error('no frames to enqueue');
  const existing = await loadManifest(deps.storage);
  if (existing && existing.accountId !== input.accountId) await dropManifestFrames(deps, existing);
  else if (existing && !isTerminal(existing.stage)) throw new Error('a capture is already being uploaded');
  const now = (deps.now ?? Date.now)();
  for (const frame of input.frames) await deps.vault.put(frame.id, frame.meta);
  const { device, camera } = captureDevice(input.capabilities);
  const manifest: SpoolManifest = {
    version: MANIFEST_VERSION,
    accountId: input.accountId,
    clientCaptureId: input.clientCaptureId ?? uuidV4(),
    createdAtMs: now,
    updatedAtMs: now,
    stage: 'pending_create',
    captureId: null,
    attempt: input.attempt,
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    gateConfigHash: gateConfigHash(),
    device,
    camera,
    frames: input.frames.map((frame, index) => ({
      index,
      nativeId: frame.id,
      sha256: frame.sha256,
      bytes: frame.bytes,
      width: frame.width,
      height: frame.height,
      uploaded: false,
      completed: false,
    })),
    verdict: null,
    checkingSinceMs: null,
    error: null,
    attemptTelemetry: input.telemetry ?? null,
  };
  await saveManifest(deps.storage, manifest);
  return manifest;
}

function createBody(m: SpoolManifest): CaptureCreate {
  return {
    client_capture_id: m.clientCaptureId,
    protocol_version: m.protocolVersion,
    gate_config_hash: m.gateConfigHash,
    device: m.device,
    camera: m.camera,
    frames: m.frames.map(({ index, sha256, bytes, width, height }) => ({ index, sha256, bytes, width, height })),
    // The server stores the attempt descriptor as an object (ClientCaptureCreate.attempt).
    attempt: { attempts: m.attempt },
  };
}

function expiresAtMs(target: FrameUploadTarget): number {
  const value = target.expires_at === null ? NaN : Date.parse(target.expires_at);
  return Number.isFinite(value) ? value : 0;
}

/** The server already holds a verified copy of this frame: nothing to PUT. */
function alreadyStored(target: FrameUploadTarget): boolean {
  return target.completed === true || !target.upload_url;
}

/** Statuses an object store returns for an expired or no-longer-valid presigned URL. */
function targetRejected(status: number): boolean {
  return status === 400 || status === 401 || status === 403 || status === 410;
}

/** Server verdicts that end the spool's work on a capture. */
function isVerdict(
  status: string,
): status is 'received' | 'stored' | 'needs_retake' | 'needs_more' | 'complete' {
  return (
    status === 'received' ||
    status === 'stored' ||
    status === 'needs_retake' ||
    status === 'needs_more' ||
    status === 'complete'
  );
}

class Retryable extends Error {
  readonly reason: 'offline' | 'server';
  constructor(reason: 'offline' | 'server', message: string) {
    super(message);
    this.reason = reason;
  }
}

class Fatal extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** Raised inside a run whose generation was superseded: it stops without persisting anything. */
class Superseded extends Error {
  constructor() {
    super('superseded');
  }
}

export class SpoolRunner {
  private readonly deps: SpoolDeps;
  private readonly now: () => number;
  /** Fresh upload targets, memory only (never persisted). */
  private readonly targets = new Map<number, FrameUploadTarget>();
  private targetsFor: string | null = null;
  private failures = 0;
  private running: { generation: number; promise: Promise<SpoolOutcome> } | null = null;
  /** Bumped by discard, sign-out, deletion and account switch; older runs stop at their next await. */
  private generation = 0;
  private controller: AbortController | null = null;
  private account: string | null;
  private discarding: Promise<void> | null = null;
  private acknowledging: Promise<void> | null = null;
  /** The previous process's unfinished discard, finished once before anything else (null = not yet / retry). */
  private recovery: Promise<void> | null = null;
  /**
   * Storage writes in flight (any key), keyed by a promise that settles when
   * the write does. A discard marks and then waits for them: an AsyncStorage
   * write cannot be recalled once started.
   */
  private readonly writes = new Map<Promise<void>, { key: string; value: string }>();
  /** Serialises read-modify-write of the telemetry queue. */
  private queueLock: Promise<void> = Promise.resolve();
  private telemetryFailures = 0;
  private telemetryNextAtMs = 0;

  constructor(deps: SpoolDeps, options: { accountId?: string | null } = {}) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.account = options.accountId ?? null;
  }

  /** The account whose capture this runner may advance (null = nobody signed in: it touches nothing). */
  get accountId(): string | null {
    return this.account;
  }

  /**
   * Bind the runner to the signed-in account. Switching accounts supersedes
   * any run in flight; switching from one signed-in account straight to
   * another discards the previous one's capture, frames and owed telemetry
   * (`discard`). A manifest of another account found later is deleted on the
   * next run, `cleanupOrphans` or `enqueue`, never resumed.
   */
  bindAccount(accountId: string | null): void {
    if (accountId === this.account) return;
    const previous = this.account;
    this.account = accountId;
    this.invalidate();
    if (previous !== null && accountId !== null) void this.discard({ telemetry: 'drop' }).catch(() => undefined);
  }

  /** Advance as far as possible, then send owed attempt telemetry; concurrent calls of one generation share one run. */
  runOnce(): Promise<SpoolOutcome> {
    const pending = this.discarding ?? this.acknowledging;
    if (pending) return pending.catch(() => undefined).then(() => this.runOnce());
    if (this.running && this.running.generation === this.generation) return this.running.promise;
    const generation = this.generation;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    this.controller = controller;
    const promise: Promise<SpoolOutcome> = this.cycle(generation, controller ? { signal: controller.signal } : {})
      .catch((error: unknown): SpoolOutcome => {
        if (error instanceof Superseded) return { kind: 'idle' };
        throw error;
      })
      .finally(() => {
        if (this.running?.promise === promise) this.running = null;
        if (this.controller === controller) this.controller = null;
      });
    this.running = { generation, promise };
    return promise;
  }

  /**
   * Finish a discard the previous process did not live to complete: delete
   * every manifest and spool frame its marker names (and the owed telemetry
   * if it was a deletion or switch), then clear the marker. Run at boot; every
   * operation of the runner also runs it first, once.
   */
  recoverDiscarded(): Promise<void> {
    if (!this.recovery) {
      const recovery: Promise<void> = this.recover().catch((error: unknown) => {
        if (this.recovery === recovery) this.recovery = null;
        throw error;
      });
      this.recovery = recovery;
    }
    return this.recovery;
  }

  /**
   * Delete everything local about the current capture (sign-out, account
   * deletion, session expiry, account switch). The running request is
   * aborted; nothing the old run does afterwards is persisted. Order: mark
   * (durable) → wait for every write already in flight → delete frames and
   * manifest (and the owed telemetry unless `telemetry: 'keep'`) → unmark.
   */
  discard(options: DiscardOptions = {}): Promise<void> {
    const dropTelemetry = options.telemetry !== 'keep';
    if (this.discarding) {
      const pending = this.discarding;
      // A deletion arriving during a sign-out's discard still drops the telemetry.
      return dropTelemetry ? pending.catch(() => undefined).then(() => this.discard(options)) : pending;
    }
    this.invalidate();
    // No write of an older generation can start from here on; the ones
    // already started are these.
    const inflight = [...this.writes.entries()];
    const storage = this.deps.storage;
    const work = (async () => {
      try {
        // An earlier unfinished discard first; if that fails, its marker is
        // merged into this one rather than overwritten.
        await this.recoverDiscarded().catch(() => undefined);
        const marked = new Map<string, DiscardedCapture>();
        const mark = (m: Pick<SpoolManifest, 'accountId' | 'clientCaptureId' | 'frames'> | null): void => {
          if (m && !marked.has(m.clientCaptureId)) marked.set(m.clientCaptureId, discardedCapture(m));
        };
        const previous = await loadDiscardMarker(storage);
        if (previous && previous !== 'corrupt') for (const c of previous.captures) marked.set(c.clientCaptureId, c);
        const drop = dropTelemetry || previous === 'corrupt' || previous?.dropTelemetry === true;
        for (const [, write] of inflight) if (write.key === SPOOL_KEY) mark(parseManifest(write.value));
        mark(await loadManifest(storage));
        // 1. Durable marker before anything is removed: a process death from
        //    here on is finished by the next boot. (Nothing to mark and nothing
        //    to drop — a boot without a session — writes nothing.)
        if (marked.size > 0 || drop) {
          await writeDiscardMarker(storage, { captures: [...marked.values()], dropTelemetry: drop });
        }
        // 2. Drain: a save that already started lands (or fails) before the removal.
        await Promise.all(inflight.map(([settled]) => settled));
        // 3. Delete.
        const m = await loadManifest(storage);
        mark(m);
        await deleteFrameIds(this.deps, [...new Set([...marked.values()].flatMap((c) => c.frameIds))]);
        if (m) await clearManifest(storage);
        if (drop) await clearAttemptQueue(storage);
        // 4. Done.
        await clearDiscardMarker(storage);
      } catch (error) {
        // The marker stays; the next operation (or boot) finishes the discard.
        this.recovery = null;
        throw error;
      } finally {
        // Anything started while this ran belongs to the discarded state too.
        this.invalidate();
        this.discarding = null;
      }
    })();
    this.discarding = work;
    return work;
  }

  /**
   * Persist a finished burst for the bound account. If the person signs out
   * (or switches account) while this runs, the capture is deleted again and
   * the call rejects: it never survives the session that made it.
   */
  async enqueue(input: Omit<EnqueueInput, 'accountId'>): Promise<SpoolManifest> {
    await this.settled();
    const account = this.account;
    if (!account) throw new Error('no signed-in account');
    const generation = this.generation;
    let manifest: SpoolManifest;
    try {
      await this.step(generation, this.recoverDiscarded());
      manifest = await enqueueCapture({ ...this.deps, storage: this.guarded(generation) }, { ...input, accountId: account });
    } catch (error) {
      if (!(error instanceof Superseded)) throw error;
      // Signed out before the manifest could be written: the burst goes with the session.
      await deleteFrameIds(
        this.deps,
        input.frames.map((f) => f.id),
      );
      throw new Error('signed out while the capture was being queued');
    }
    if (generation !== this.generation) {
      // Written, then superseded. A discard has marked this write and removes
      // it once it has landed; without one (unbinding only) it goes here.
      await dropManifestFrames(this.deps, manifest);
      const current = await loadManifest(this.deps.storage);
      if (current?.clientCaptureId === manifest.clientCaptureId) await clearManifest(this.deps.storage);
      throw new Error('signed out while the capture was being queued');
    }
    return manifest;
  }

  /**
   * Forget a terminal manifest once the person has seen its verdict. An
   * attempt it still owes moves to the telemetry queue first: a manifest is
   * never cleared while it owes its attempt.
   */
  acknowledge(): Promise<void> {
    if (this.acknowledging) return this.acknowledging;
    const work = (async () => {
      try {
        if (this.discarding) await this.discarding.catch(() => undefined);
        if (this.running) await this.running.promise.catch(() => undefined);
        const generation = this.generation;
        try {
          await this.step(generation, this.recoverDiscarded());
          const m = await this.loadOwn(generation);
          if (!m || !isTerminal(m.stage)) return;
          await this.queueOwedAttempt(generation, m);
          const current = await this.step(generation, loadManifest(this.deps.storage));
          if (current?.clientCaptureId === m.clientCaptureId) await clearManifest(this.deps.storage);
        } catch (error) {
          if (!(error instanceof Superseded)) throw error;
        }
      } finally {
        this.acknowledging = null;
      }
    })();
    this.acknowledging = work;
    return work;
  }

  /**
   * Owe the telemetry of an attempt that ended before reaching the spool
   * (cancelled, timed out, camera permission refused) under the bound
   * account; the next run sends it. False when nobody is signed in or the
   * session ended meanwhile (nothing is kept).
   */
  async recordAttempt(telemetry: AttemptTelemetry): Promise<boolean> {
    await this.settled();
    const account = this.account;
    if (!account) return false;
    const generation = this.generation;
    try {
      await this.step(generation, this.recoverDiscarded());
      const storage = this.guarded(generation);
      const entry = { key: `attempt-${uuidV4()}`, telemetry, queuedAtMs: this.now() };
      await this.step(generation, this.withQueue(() => queueAttempt(storage, account, entry)));
      return true;
    } catch (error) {
      if (error instanceof Superseded) return false;
      throw error;
    }
  }

  /**
   * Delete native spool frames no live manifest of the bound account refers
   * to (crashed bursts, cancelled attempts, another account's capture,
   * anything older than 48 h). Run at boot, after `bindAccount`.
   */
  async cleanupOrphans(): Promise<number> {
    await this.settled();
    if (this.account === null) return 0;
    const generation = this.generation;
    let m: SpoolManifest | null;
    try {
      await this.step(generation, this.recoverDiscarded());
      m = await this.loadOwn(generation);
    } catch {
      return 0;
    }
    const live = new Set(
      m && !isTerminal(m.stage) ? m.frames.filter((f) => !f.completed).map((f) => f.nativeId) : [],
    );
    let entries: Awaited<ReturnType<ClientCameraModule['listSpool']>> = [];
    try {
      entries = await this.deps.camera.listSpool();
    } catch {
      return 0;
    }
    if (generation !== this.generation) return 0;
    const now = this.now();
    const orphans = entries
      .filter((entry) => !live.has(entry.id) || now - entry.createdAtMs > SPOOL_MAX_AGE_MS)
      .map((entry) => entry.id);
    if (orphans.length > 0) {
      await this.deps.camera.deleteFrames(orphans);
      await this.deps.vault.delete(orphans);
    }
    return orphans.length;
  }

  // -------------------------------------------------------------------------

  private invalidate(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.running = null;
    this.targets.clear();
    this.targetsFor = null;
    this.failures = 0;
    this.telemetryFailures = 0;
    this.telemetryNextAtMs = 0;
  }

  /** Throws `Superseded` once a newer generation exists. */
  private live(generation: number): void {
    if (generation !== this.generation) throw new Superseded();
  }

  /** Wait until no discard or acknowledgement is running. */
  private async settled(): Promise<void> {
    for (let pending = this.discarding ?? this.acknowledging; pending; pending = this.discarding ?? this.acknowledging) {
      await pending.catch(() => undefined);
    }
  }

  /** Await `work`, then stop if the run was superseded meanwhile (whether `work` succeeded or not). */
  private async step<T>(generation: number, work: Promise<T>): Promise<T> {
    let value: T;
    try {
      value = await work;
    } catch (error) {
      this.live(generation);
      throw error;
    }
    this.live(generation);
    return value;
  }

  /**
   * The storage as `generation` may use it: a write is refused (Superseded)
   * once the generation is over and tracked while in flight, so a discard
   * can wait for it. Reads and removals pass through.
   */
  private guarded(generation: number): KeyValueStorage {
    const storage = this.deps.storage;
    return {
      getItem: (key) => storage.getItem(key),
      removeItem: (key) => storage.removeItem(key),
      setItem: (key, value) => {
        if (generation !== this.generation) return Promise.reject(new Superseded());
        const write = storage.setItem(key, value);
        const settled = write.then(
          () => undefined,
          () => undefined,
        );
        this.writes.set(settled, { key, value });
        void settled.then(() => this.writes.delete(settled));
        return write;
      },
    };
  }

  private withQueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queueLock.then(work, work);
    this.queueLock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async recover(): Promise<void> {
    const storage = this.deps.storage;
    const marker = await loadDiscardMarker(storage);
    if (marker === null) return;
    const m = await loadManifest(storage);
    const everything = marker === 'corrupt';
    const ids = new Set(everything ? [] : marker.captures.flatMap((c) => c.frameIds));
    const marked = m !== null && (everything || marker.captures.some((c) => c.clientCaptureId === m.clientCaptureId));
    if (marked) for (const f of m.frames) ids.add(f.nativeId);
    await deleteFrameIds(this.deps, [...ids]);
    if (marked) await clearManifest(storage);
    if (everything || marker.dropTelemetry) await clearAttemptQueue(storage);
    await clearDiscardMarker(storage);
  }

  private async cycle(generation: number, call: CallOptions): Promise<SpoolOutcome> {
    await this.step(generation, this.recoverDiscarded());
    const outcome = await this.advance(generation, call);
    if (outcome.kind === 'blocked') return outcome;
    const telemetryRetryInMs = await this.sendOwedAttempts(generation, call);
    return telemetryRetryInMs === null ? outcome : { ...outcome, telemetryRetryInMs };
  }

  /** The bound account's manifest; another account's is deleted (frames and record) and never returned. */
  private async loadOwn(generation: number): Promise<SpoolManifest | null> {
    const m = await this.step(generation, loadManifest(this.deps.storage));
    if (!m || this.account === null) return null;
    if (m.accountId === this.account) return m;
    await dropManifestFrames(this.deps, m);
    const again = await loadManifest(this.deps.storage);
    if (again?.clientCaptureId === m.clientCaptureId) await clearManifest(this.deps.storage);
    this.live(generation);
    return null;
  }

  private async save(generation: number, m: SpoolManifest, patch: Partial<SpoolManifest>): Promise<SpoolManifest> {
    const next = { ...m, ...patch, updatedAtMs: this.now() };
    // Refused before it starts once discarded; if the discard came while this
    // write was in flight, the discard waits for it and then removes it.
    await saveManifest(this.guarded(generation), next);
    this.live(generation);
    return next;
  }

  private async dropFrames(generation: number, m: SpoolManifest): Promise<void> {
    // Deleting is safe in any generation; only what follows is gated.
    await dropManifestFrames(this.deps, m);
    this.live(generation);
  }

  private async end(generation: number, m: SpoolManifest, stage: 'failed' | 'abandoned', code: string): Promise<SpoolOutcome> {
    await this.dropFrames(generation, m);
    const next = await this.save(generation, m, { stage, error: code });
    this.targets.clear();
    return this.terminal(generation, next);
  }

  /** A terminal manifest: move the attempt it still owes to the telemetry queue, then report it. */
  private async terminal(generation: number, m: SpoolManifest): Promise<SpoolOutcome> {
    let next = m;
    if (await this.queueOwedAttempt(generation, m)) next = await this.save(generation, m, { attemptTelemetry: null });
    this.failures = 0;
    this.targets.clear();
    return { kind: 'terminal', manifest: next };
  }

  /**
   * Queue POST /attempts for a terminal manifest that still owes it, with the
   * verdict (or `abandoned`) as the outcome (docs/client-app-v1.md §6). Keyed
   * by the client capture id, so queueing it twice sends it once. True if it
   * owed one.
   */
  private async queueOwedAttempt(generation: number, m: SpoolManifest): Promise<boolean> {
    const pending = m.attemptTelemetry;
    const outcome = outcomeForStage(m.stage);
    if (!pending || !outcome) return false;
    const storage = this.guarded(generation);
    const entry = { key: m.clientCaptureId, telemetry: { outcome, ...pending }, queuedAtMs: this.now() };
    await this.step(generation, this.withQueue(() => queueAttempt(storage, m.accountId, entry)));
    return true;
  }

  /**
   * Send what the telemetry queue owes, oldest first. Offline, server trouble,
   * rate limits or an expired session keep it owed and back off; a body the
   * server refuses (validation) is dropped, never retried. Returns the delay
   * until the next try while anything is still owed, else null.
   */
  private async sendOwedAttempts(generation: number, call: CallOptions): Promise<number | null> {
    const account = this.account;
    if (account === null) return null;
    const storage = this.guarded(generation);
    const later = (retryAfterMs: number): number => {
      this.telemetryFailures += 1;
      const delay = Math.max(backoffMs(this.telemetryFailures), retryAfterMs);
      this.telemetryNextAtMs = this.now() + delay;
      return delay;
    };
    try {
      for (let sent = 0; sent <= TELEMETRY_QUEUE_MAX; sent += 1) {
        const owed = await this.step(generation, this.withQueue(() => loadAttemptQueue(storage, account)));
        const entry = owed[0];
        if (!entry) {
          this.telemetryFailures = 0;
          this.telemetryNextAtMs = 0;
          return null;
        }
        const wait = this.telemetryNextAtMs - this.now();
        if (wait > 0) return wait;
        try {
          await this.step(generation, this.deps.api.postAttempt(entry.telemetry, call));
        } catch (error) {
          if (error instanceof Superseded) throw error;
          if (!isClientApiError(error, 'validation')) {
            return later(isClientApiError(error) && error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : 0);
          }
          // Refused as invalid: it would be refused again. Dropped.
        }
        this.telemetryFailures = 0;
        await this.step(generation, this.withQueue(() => removeQueuedAttempt(storage, account, entry.key)));
      }
      return later(0);
    } catch (error) {
      if (error instanceof Superseded) throw error;
      // Storage trouble: everything stays owed.
      return later(0);
    }
  }

  private async advance(generation: number, call: CallOptions): Promise<SpoolOutcome> {
    let m = await this.loadOwn(generation);
    if (!m) return { kind: 'idle' };
    if (isTerminal(m.stage)) return this.terminal(generation, m);
    if (this.targetsFor !== m.clientCaptureId) {
      this.targets.clear();
      this.targetsFor = m.clientCaptureId;
    }

    if ((m.stage === 'pending_create' || m.stage === 'uploading') && this.now() - m.createdAtMs > SPOOL_MAX_AGE_MS) {
      return this.end(generation, m, 'abandoned', 'expired');
    }

    try {
      if (m.stage === 'pending_create') {
        const created = await this.step(generation, this.deps.api.createCapture(createBody(m), call));
        for (const target of created.frames ?? []) this.targets.set(target.index, target);
        // A replay of a create whose response was lost: frames the server
        // already verified are done here too.
        const done = new Set((created.frames ?? []).filter((t) => t.completed).map((t) => t.index));
        m = await this.save(generation, m, {
          stage: 'uploading',
          captureId: created.capture_id,
          error: null,
          frames: m.frames.map((f) => (done.has(f.index) ? { ...f, uploaded: true, completed: true } : f)),
        });
        if (done.size > 0) {
          const ids = m.frames.filter((f) => done.has(f.index)).map((f) => f.nativeId);
          await this.step(generation, this.deps.camera.deleteFrames(ids).catch(() => undefined));
          await this.step(generation, this.deps.vault.delete(ids));
        }
      }

      if (m.stage === 'uploading') {
        const lost = await this.preflight(generation, m);
        if (lost) return this.end(generation, m, 'abandoned', lost);
        for (const frame of [...m.frames].sort((a, b) => a.index - b.index)) {
          if (frame.completed) continue;
          m = await this.uploadAndComplete(generation, m, frame.index, call);
        }
        m = await this.save(generation, m, { stage: 'finalizing' });
      }

      let justFinalized = false;
      if (m.stage === 'finalizing') {
        justFinalized = true;
        let view: CaptureView;
        try {
          view = await this.step(generation, this.deps.api.finalizeCapture(m.captureId!, call));
        } catch (error) {
          // The server answers a repeated finalize with the capture itself, so a
          // state refusal means frames it still lacks: polling would never end.
          if (!isClientApiError(error, 'capture_state')) throw error;
          view = await this.step(generation, this.deps.api.getCapture(m.captureId!, call));
          if (view.status === 'uploading') throw error;
        }
        m = await this.applyVerdict(generation, m, view);
      }

      if (m.stage === 'checking') {
        // Right after finalize the server has only just started its checks:
        // wait one poll interval instead of asking again immediately.
        if (!justFinalized) {
          m = await this.applyVerdict(generation, m, await this.step(generation, this.deps.api.getCapture(m.captureId!, call)));
        }
        if (m.stage === 'checking') {
          this.failures = 0;
          const since = m.checkingSinceMs ?? this.now();
          const slow = this.now() - since >= SPOOL_TIMING.checkingNoticeMs;
          return {
            kind: 'waiting',
            manifest: m,
            retryInMs: slow ? SPOOL_TIMING.pollSlowMs : SPOOL_TIMING.pollFastMs,
            reason: 'checking',
          };
        }
      }
    } catch (error) {
      if (error instanceof Superseded) throw error;
      return this.failed(generation, m, error);
    }
    return this.terminal(generation, m);
  }

  private async failed(generation: number, stale: SpoolManifest, error: unknown): Promise<SpoolOutcome> {
    this.live(generation);
    // Steps inside the failed run may already have saved progress (a frame
    // marked uploaded); patch the latest durable manifest, never the copy the
    // run started from.
    const m = (await this.loadOwn(generation)) ?? stale;
    if (error instanceof Fatal) {
      // Frames gone or unreadable on the device: the capture is lost, not refused.
      const lost = error.code === 'frames_lost' || error.code === 'spool_unreadable' || error.code === 'meta_lost';
      return this.end(generation, m, lost ? 'abandoned' : 'failed', error.code);
    }
    if (isClientApiError(error, 'session_expired')) return { kind: 'blocked', reason: 'session' };
    const retryable =
      error instanceof Retryable ||
      (isClientApiError(error) &&
        (error.retryable || error.kind === 'network' || error.kind === 'server' || error.kind === 'rate_limited'));
    if (!retryable) {
      const code = isClientApiError(error) ? (error.code ?? error.kind) : 'unexpected';
      return this.end(generation, m, 'failed', code);
    }
    this.failures += 1;
    const reason =
      error instanceof Retryable ? error.reason : isClientApiError(error, 'network') ? 'offline' : 'server';
    const kind = isClientApiError(error) ? (error.code ?? error.kind) : reason;
    const next = await this.save(generation, m, { error: kind });
    const retryAfter = isClientApiError(error) && error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : 0;
    return { kind: 'waiting', manifest: next, retryInMs: Math.max(backoffMs(this.failures), retryAfter), reason };
  }

  /** null if every unfinished frame can still be uploaded and completed; else why not. */
  private async preflight(generation: number, m: SpoolManifest): Promise<string | null> {
    const pending = m.frames.filter((f) => !f.completed);
    if (pending.length === 0) return null;
    let spool: Set<string>;
    try {
      spool = new Set((await this.step(generation, this.deps.camera.listSpool())).map((entry) => entry.id));
    } catch (error) {
      if (error instanceof Superseded) throw error;
      throw new Retryable('server', 'native spool unavailable');
    }
    for (const frame of pending) {
      if (!frame.uploaded && !spool.has(frame.nativeId)) return 'frames_lost';
      if (!(await this.step(generation, this.deps.vault.get(frame.nativeId)))) return 'meta_lost';
    }
    return null;
  }

  private async target(
    generation: number,
    m: SpoolManifest,
    index: number,
    forceRenew: boolean,
    call: CallOptions,
  ): Promise<FrameUploadTarget> {
    const cached = this.targets.get(index);
    if (cached && alreadyStored(cached)) return cached;
    if (!forceRenew && cached && expiresAtMs(cached) - this.now() > SPOOL_TIMING.renewMarginMs) return cached;
    let renewed: FrameUploadTarget;
    try {
      renewed = await this.step(generation, this.deps.api.renewFrameUpload(m.captureId!, index, call));
    } catch (error) {
      // Renew refuses a frame that is already stored: the bytes are there.
      if (!isClientApiError(error, 'frame_immutable')) throw error;
      renewed = { index, completed: true, upload_url: null, method: 'PUT', headers: {}, expires_at: null };
    }
    this.targets.set(index, renewed);
    return renewed;
  }

  private async putBytes(
    generation: number,
    m: SpoolManifest,
    index: number,
    nativeId: string,
    call: CallOptions,
  ): Promise<void> {
    let target = await this.target(generation, m, index, false, call);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Stored already (complete with the same meta is idempotent on the server).
      const url = target.upload_url;
      if (target.completed || !url) return;
      let status: number;
      try {
        // The native PUT cannot be aborted; its result is ignored once superseded.
        ({ status } = await this.step(
          generation,
          this.deps.camera.uploadFrame(nativeId, { url, method: 'PUT', headers: target.headers ?? {} }),
        ));
      } catch (error) {
        if (error instanceof Superseded) throw error;
        // Native rejection codes (client-native-interface.md §5.9).
        const code = nativeErrorCode(error);
        if (code === 'not_found') throw new Fatal('frames_lost');
        if (code === 'spool_unreadable') throw new Fatal('spool_unreadable');
        if (code === 'invalid_argument') throw new Fatal('upload_invalid_argument');
        // upload_failed (transport), spool_error (I/O) and anything unknown: try again later.
        throw new Retryable(code === 'spool_error' ? 'server' : 'offline', error instanceof Error ? error.message : 'upload failed');
      }
      if (status >= 200 && status < 300) return;
      if (status === 0 || status >= 500 || status === 408 || status === 429) {
        throw new Retryable(status === 0 ? 'offline' : 'server', `upload status ${status}`);
      }
      if (targetRejected(status) && attempt === 0) {
        target = await this.target(generation, m, index, true, call);
        continue;
      }
      throw new Fatal(`upload_rejected_${status}`);
    }
  }

  private async uploadAndComplete(
    generation: number,
    m: SpoolManifest,
    index: number,
    call: CallOptions,
  ): Promise<SpoolManifest> {
    let frame = m.frames.find((f) => f.index === index)!;
    const meta = await this.step(generation, this.deps.vault.get(frame.nativeId));
    if (!meta) throw new Fatal('meta_lost');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!frame.uploaded) {
        await this.putBytes(generation, m, index, frame.nativeId, call);
        m = await this.markFrame(generation, m, index, { uploaded: true });
        frame = m.frames.find((f) => f.index === index)!;
      }
      try {
        await this.step(generation, this.deps.api.completeFrame(m.captureId!, index, meta, call));
      } catch (error) {
        if (error instanceof Superseded) throw error;
        if (isClientApiError(error, 'frame_immutable')) {
          // Completed by an earlier attempt whose 204 was lost.
        } else if (
          attempt === 0 &&
          (isClientApiError(error, 'upload_missing') || isClientApiError(error, 'upload_mismatch'))
        ) {
          m = await this.markFrame(generation, m, index, { uploaded: false });
          frame = m.frames.find((f) => f.index === index)!;
          continue;
        } else {
          throw error;
        }
      }
      m = await this.markFrame(generation, m, index, { uploaded: true, completed: true });
      try {
        await this.step(generation, this.deps.camera.deleteFrames([frame.nativeId]));
      } catch (error) {
        if (error instanceof Superseded) throw error;
        // The server holds a verified copy; orphan cleanup removes this later.
      }
      await this.step(generation, this.deps.vault.delete([frame.nativeId]));
      return m;
    }
    throw new Fatal('upload_mismatch');
  }

  private async markFrame(
    generation: number,
    m: SpoolManifest,
    index: number,
    patch: { uploaded?: boolean; completed?: boolean },
  ): Promise<SpoolManifest> {
    return this.save(generation, m, {
      frames: m.frames.map((f) => (f.index === index ? { ...f, ...patch } : f)),
    });
  }

  private async applyVerdict(generation: number, m: SpoolManifest, view: CaptureView): Promise<SpoolManifest> {
    if (isVerdict(view.status)) {
      return this.save(generation, m, { stage: view.status, verdict: view, error: null });
    }
    // `checking` (or `uploading` echoed back, or a state added later): keep polling.
    return this.save(generation, m, {
      stage: 'checking',
      verdict: view,
      checkingSinceMs: m.checkingSinceMs ?? this.now(),
      error: null,
    });
  }
}
