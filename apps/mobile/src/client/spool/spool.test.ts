/**
 * The durable spool: idempotent create, upload with renew, complete, finalize,
 * verdict polling — what survives a restart, what a discard stops, whose
 * capture it is, and when attempt telemetry is sent. Frames come from the
 * simulator (synthetic bytes, never an image).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { gateConfigHash } from '@facetype/contracts';

import { ClientApiError, type CallOptions } from '../api/clientApi.ts';
import type { AttemptTelemetry, CaptureCreate, CaptureView, FrameUploadTarget } from '../api/types.ts';
import { SimulatorClientCamera } from '../native/simulator.ts';
import type { BurstFrame, UploadTarget } from '../native/types.ts';
import { pendingAttempt, type PendingAttempt } from '../telemetry.ts';
import {
  DISCARD_MARKER_KEY,
  loadDiscardMarker,
  loadManifest,
  SPOOL_KEY,
  SPOOL_MAX_AGE_MS,
  type KeyValueStorage,
} from './manifest.ts';
import { memoryMetaVault, nativeBackedMetaVault, type FrameMetaVault } from './metaVault.ts';
import { enqueueCapture, nextRunInMs, SPOOL_TIMING, SpoolRunner, type EnqueueInput, type SpoolDeps } from './spool.ts';
import { loadAttemptQueue, queueAttempt, TELEMETRY_QUEUE_KEY, TELEMETRY_QUEUE_MAX } from './telemetryQueue.ts';

const ACCOUNT = 'acc-synthetic-a';
const OTHER_ACCOUNT = 'acc-synthetic-b';

// ---------------------------------------------------------------------------
// Gates: hold any awaited dependency call until the test releases it
// ---------------------------------------------------------------------------
class Gates {
  private readonly armed = new Set<string>();
  private readonly held = new Map<string, () => void>();
  private readonly waiters = new Map<string, () => void>();

  arm(name: string): void {
    this.armed.add(name);
  }

  /** Called by a fake before it does `name`; blocks while that step is armed. */
  async pass(name: string): Promise<void> {
    if (!this.armed.has(name)) return;
    this.armed.delete(name);
    await new Promise<void>((resolve) => {
      this.held.set(name, resolve);
      this.waiters.get(name)?.();
    });
  }

  /** Resolves once a fake is blocked at `name`. */
  reached(name: string): Promise<void> {
    if (this.held.has(name)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.set(name, resolve));
  }

  release(name: string): void {
    const resolve = this.held.get(name);
    this.held.delete(name);
    resolve?.();
  }
}

function memoryStorage(gates?: Gates): KeyValueStorage & {
  raw(key?: string): string | null;
  writes: number;
  /** Every write and removal as it lands, in order: `set:<key>` / `remove:<key>`. */
  ops: string[];
} {
  const map = new Map<string, string>();
  return {
    writes: 0,
    ops: [],
    async getItem(key) {
      return map.get(key) ?? null;
    },
    async setItem(key, value) {
      await gates?.pass('setItem');
      this.writes += 1;
      this.ops.push(`set:${key}`);
      map.set(key, value);
    },
    async removeItem(key) {
      this.ops.push(`remove:${key}`);
      map.delete(key);
    },
    raw(key = SPOOL_KEY) {
      return map.get(key) ?? null;
    },
  };
}

/** Let pending promise chains (a discard reaching its drain, say) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const offline = () => new ClientApiError({ kind: 'network', status: 0, retryable: true });

const FUTURE = '2999-01-01T00:00:00Z';

function target(index: number, expiresAt = FUTURE): FrameUploadTarget {
  return {
    index,
    completed: false,
    upload_url: `https://upload.test/${index}?sig=secret`,
    method: 'PUT',
    headers: { 'Content-Length': '2048' },
    expires_at: expiresAt,
  };
}

function storedTarget(index: number): FrameUploadTarget {
  return { index, completed: true, upload_url: null, method: 'PUT', headers: {}, expires_at: null };
}

class FakeApi {
  /** Every call in order, as `name` or `name:index`. */
  log: string[] = [];
  signals: AbortSignal[] = [];
  creates: CaptureCreate[] = [];
  renewals: number[] = [];
  completes: number[] = [];
  attempts: AttemptTelemetry[] = [];
  finalizes = 0;
  polls = 0;
  createError: Error | null = null;
  attemptErrors: Error[] = [];
  /** Frames the server reports as already stored when a create is replayed. */
  storedOnCreate = new Set<number>();
  renewErrors = new Map<number, Error>();
  completeErrors = new Map<number, Error[]>();
  verdicts: CaptureView['status'][] = ['checking', 'stored'];
  targetExpiry = FUTURE;
  gates: Gates | null = null;

  private async enter(name: string, call?: CallOptions): Promise<void> {
    this.log.push(name);
    if (call?.signal) this.signals.push(call.signal);
    await this.gates?.pass(name.split(':')[0]!);
  }

  async createCapture(body: CaptureCreate, call?: CallOptions) {
    await this.enter('createCapture', call);
    this.creates.push(body);
    if (this.createError) throw this.createError;
    return {
      capture_id: 'cap-1',
      status: 'uploading',
      frames: body.frames.map((f) =>
        this.storedOnCreate.has(f.index) ? storedTarget(f.index) : target(f.index, this.targetExpiry),
      ),
    };
  }
  async renewFrameUpload(_id: string, index: number, call?: CallOptions) {
    await this.enter(`renewFrameUpload:${index}`, call);
    this.renewals.push(index);
    const error = this.renewErrors.get(index);
    if (error) throw error;
    return target(index);
  }
  async completeFrame(_id: string, index: number, meta: Record<string, unknown>, call?: CallOptions) {
    await this.enter(`completeFrame:${index}`, call);
    assert.equal(typeof meta.frame_id, 'string', 'complete carries the frame meta');
    const queue = this.completeErrors.get(index);
    const error = queue?.shift();
    if (error) throw error;
    this.completes.push(index);
  }
  async finalizeCapture(id: string, call?: CallOptions): Promise<CaptureView> {
    await this.enter('finalizeCapture', call);
    this.finalizes += 1;
    return { id, status: this.verdicts.shift() ?? 'checking', accepted_frames: 10, reasons: [] };
  }
  async getCapture(id: string, call?: CallOptions): Promise<CaptureView> {
    await this.enter('getCapture', call);
    this.polls += 1;
    const status = this.verdicts.shift() ?? 'checking';
    return { id, status, accepted_frames: 10, reasons: status === 'needs_retake' ? ['glasses'] : [] };
  }
  async postAttempt(telemetry: AttemptTelemetry, call?: CallOptions) {
    await this.enter('postAttempt', call);
    const error = this.attemptErrors.shift();
    if (error) throw error;
    this.attempts.push(telemetry);
  }
}

class UploadingCamera extends SimulatorClientCamera {
  statuses: number[] = [];
  rejections: Array<{ code: string } | null> = [];
  uploads: Array<{ id: string; url: string }> = [];
  deleted: string[] = [];
  gates: Gates | null = null;
  log: string[] | null = null;
  override async uploadFrame(id: string, t: UploadTarget) {
    this.log?.push('uploadFrame');
    await this.gates?.pass('uploadFrame');
    this.uploads.push({ id, url: t.url });
    const rejection = this.rejections.shift();
    if (rejection) throw Object.assign(new Error(rejection.code), rejection);
    await super.uploadFrame(id, t);
    return { status: this.statuses.shift() ?? 200 };
  }
  override async deleteFrames(ids: string[]) {
    await this.gates?.pass('deleteFrames');
    this.deleted.push(...ids);
    await super.deleteFrames(ids);
  }
  override async listSpool() {
    await this.gates?.pass('listSpool');
    return super.listSpool();
  }
}

function gatedVault(gates: Gates): FrameMetaVault {
  const inner = memoryMetaVault();
  return {
    put: inner.put,
    delete: inner.delete,
    async get(id) {
      await gates.pass('vault.get');
      return inner.get(id);
    },
  };
}

async function burst(camera: SimulatorClientCamera): Promise<BurstFrame[]> {
  const result = await camera.startBurst({ targetFrames: 10, maxDurationMs: 8000, minSpacingMs: 66, minCoverageMs: 1000 });
  return result.frames;
}

function setup(vault?: FrameMetaVault, gates?: Gates) {
  const api = new FakeApi();
  api.gates = gates ?? null;
  const camera = new UploadingCamera({ fetch: undefined as unknown as typeof fetch });
  camera.gates = gates ?? null;
  // No network for the simulator's own PUT in tests.
  (camera as unknown as { fetchImpl: null }).fetchImpl = null;
  const storage = memoryStorage(gates);
  const deps: SpoolDeps = { api, camera, storage, vault: vault ?? (gates ? gatedVault(gates) : memoryMetaVault()) };
  return { api, camera, storage, vault: deps.vault, deps };
}

function input(frames: BurstFrame[], extra: Partial<EnqueueInput> = {}): EnqueueInput {
  return { accountId: ACCOUNT, frames, attempt: 1, capabilities: null, ...extra };
}

const runner = (deps: SpoolDeps, accountId: string | null = ACCOUNT) => new SpoolRunner(deps, { accountId });

const TELEMETRY: PendingAttempt = pendingAttempt({
  startedAtMs: 0,
  nowMs: 4200,
  attempts: 2,
  reasonCounts: { oneFace: 1, distanceOrSize: 2, light: 1 },
  device: { platform: 'android', model: 'simulator' },
});

// ---------------------------------------------------------------------------
// Upload, resume, verdict
// ---------------------------------------------------------------------------
test('happy path: create → 10 uploads + completes → finalize → poll → stored', async () => {
  const { api, camera, storage, deps } = setup();
  const frames = await burst(camera);
  const manifest = await enqueueCapture(deps, input(frames, { attempt: 2, capabilities: await camera.getCapabilities() }));
  const r = runner(deps);

  const first = await r.runOnce();
  assert.equal(first.kind, 'waiting');
  assert.equal(first.kind === 'waiting' && first.reason, 'checking');
  assert.equal(api.creates.length, 1);
  assert.equal(api.creates[0]!.client_capture_id, manifest.clientCaptureId);
  assert.deepEqual(api.creates[0]!.attempt, { attempts: 2 });
  assert.equal(api.creates[0]!.frames.length, 10);
  assert.match(api.creates[0]!.gate_config_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(api.completes, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(api.renewals.length, 0, 'fresh targets from create are used directly');
  assert.equal(camera.deleted.length, 10, 'each frame leaves the device once the server re-hashed it');
  assert.equal((await camera.listSpool()).length, 0);

  const second = await r.runOnce();
  assert.equal(second.kind, 'terminal');
  assert.equal(second.kind === 'terminal' && second.manifest.stage, 'stored');
  assert.equal((await loadManifest(storage))?.stage, 'stored');
  await r.acknowledge();
  assert.equal(await loadManifest(storage), null);
});

test('nothing secret or biometric is written to AsyncStorage', async () => {
  const { camera, storage, deps } = setup();
  const frames = (await burst(camera)).map((f) => ({ ...f, meta: { ...f.meta, landmarks_478: [0.1, 0.2, 0.3] } }));
  await enqueueCapture(deps, input(frames, { telemetry: TELEMETRY }));
  await runner(deps).runOnce();
  const raw = storage.raw() ?? '';
  assert.doesNotMatch(raw, /landmarks_478/);
  assert.doesNotMatch(raw, /upload\.test|sig=secret/);
  assert.match(raw, new RegExp(ACCOUNT), 'the manifest names its account');
});

test('offline at create: the capture stays queued and the retry reuses the same client_capture_id', async () => {
  const { api, camera, storage, deps } = setup();
  await enqueueCapture(deps, input(await burst(camera)));
  api.createError = new ClientApiError({ kind: 'network', status: 0, retryable: true });
  const r = runner(deps);
  const waiting = await r.runOnce();
  assert.equal(waiting.kind, 'waiting');
  assert.equal(waiting.kind === 'waiting' && waiting.reason, 'offline');
  assert.equal((await loadManifest(storage))?.stage, 'pending_create');
  assert.equal((await camera.listSpool()).length, 10, 'frames stay in the encrypted spool');

  api.createError = null;
  await r.runOnce();
  assert.equal(api.creates.length, 2);
  assert.equal(api.creates[0]!.client_capture_id, api.creates[1]!.client_capture_id);
});

test('restart mid-upload: completed frames are not redone, remaining targets are renewed', async () => {
  // A vault that survives the restart (the native getFrameMeta extension).
  const persisted = new Map<string, Record<string, unknown>>();
  const vault = nativeBackedMetaVault(async (id) => persisted.get(id) ?? null);
  const { api, camera, storage, deps } = setup(vault);
  const frames = await burst(camera);
  for (const f of frames) persisted.set(f.id, f.meta);
  await enqueueCapture(deps, input(frames));
  api.completeErrors.set(4, [new ClientApiError({ kind: 'network', status: 0, retryable: true })]);

  const before = await runner(deps).runOnce();
  assert.equal(before.kind, 'waiting');
  assert.deepEqual(api.completes, [0, 1, 2, 3]);

  // "Restart": a new runner, a fresh (empty) memory layer, same storage.
  const restarted = runner({ ...deps, vault: nativeBackedMetaVault(async (id) => persisted.get(id) ?? null) });
  const after = await restarted.runOnce();
  assert.equal(after.kind, 'waiting'); // checking
  assert.deepEqual(api.completes, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(api.creates.length, 1, 'no second capture after the restart');
  // Frame 4 was uploaded before the crash: it is completed without a re-upload; 5–9 need new URLs.
  assert.deepEqual(api.renewals, [5, 6, 7, 8, 9]);
  assert.equal((await loadManifest(storage))?.stage, 'checking');
});

test('restart without a way to recover FrameMeta abandons the capture instead of storing frames without it', async () => {
  const { api, camera, storage, deps } = setup();
  await enqueueCapture(deps, input(await burst(camera)));
  api.completeErrors.set(2, [new ClientApiError({ kind: 'network', status: 0, retryable: true })]);
  await runner(deps).runOnce();

  const restarted = runner({ ...deps, vault: memoryMetaVault() });
  const outcome = await restarted.runOnce();
  assert.equal(outcome.kind, 'terminal');
  assert.equal(outcome.kind === 'terminal' && outcome.manifest.stage, 'abandoned');
  assert.equal(outcome.kind === 'terminal' && outcome.manifest.error, 'meta_lost');
  assert.equal((await camera.listSpool()).length, 0, 'local frames deleted');
  assert.deepEqual(api.completes, [0, 1]);
  assert.equal((await loadManifest(storage))?.stage, 'abandoned');
});

test('an expired presigned URL is renewed once and the upload retried', async () => {
  const { api, camera, deps } = setup();
  await enqueueCapture(deps, input(await burst(camera)));
  camera.statuses = [403];
  await runner(deps).runOnce();
  assert.deepEqual(api.renewals, [0]);
  assert.equal(api.completes.length, 10);
  assert.equal(camera.uploads.filter((u) => u.id === camera.uploads[0]!.id).length, 2);
});

test('a URL about to expire is renewed before the upload', async () => {
  const { api, camera, deps } = setup();
  api.targetExpiry = new Date(Date.now() + 10_000).toISOString();
  await enqueueCapture(deps, input(await burst(camera)));
  await runner(deps).runOnce();
  assert.equal(api.renewals.length, 10);
});

test('a replayed create: frames the server already stored are not uploaded again', async () => {
  const { api, camera, deps } = setup();
  await enqueueCapture(deps, input(await burst(camera)));
  api.storedOnCreate = new Set([0, 1, 2]);
  const outcome = await runner(deps).runOnce();
  assert.equal(outcome.kind, 'waiting');
  assert.equal(camera.uploads.length, 7);
  assert.deepEqual(api.completes, [3, 4, 5, 6, 7, 8, 9]);
  assert.equal(outcome.kind === 'waiting' && outcome.manifest.frames.every((f) => f.completed), true);
});

test('renew refused because the frame is stored: no PUT, complete is repeated (idempotent)', async () => {
  const { api, camera, deps } = setup();
  api.targetExpiry = new Date(Date.now() + 10_000).toISOString(); // forces a renew per frame
  api.renewErrors.set(4, new ClientApiError({ kind: 'frame_immutable', status: 409, code: 'FT-CLIENT-FRAME-IMMUTABLE' }));
  await enqueueCapture(deps, input(await burst(camera)));
  const outcome = await runner(deps).runOnce();
  assert.equal(outcome.kind, 'waiting');
  assert.equal(camera.uploads.length, 9);
  assert.deepEqual(api.completes, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('finalize refused for missing frames ends the capture instead of polling forever', async () => {
  const { api, camera, deps } = setup();
  await enqueueCapture(deps, input(await burst(camera)));
  api.finalizeCapture = async () => {
    throw new ClientApiError({ kind: 'capture_state', status: 409, code: 'FT-CLIENT-CAPTURE-STATE' });
  };
  api.verdicts = ['uploading'];
  const outcome = await runner(deps).runOnce();
  assert.equal(outcome.kind, 'terminal');
  assert.equal(outcome.kind === 'terminal' && outcome.manifest.stage, 'failed');
  assert.equal(outcome.kind === 'terminal' && outcome.manifest.error, 'FT-CLIENT-CAPTURE-STATE');
});

test('complete: an already-completed frame is fine; a hash mismatch re-uploads once', async () => {
  const { api, camera, deps } = setup();
  await enqueueCapture(deps, input(await burst(camera)));
  api.completeErrors.set(1, [new ClientApiError({ kind: 'frame_immutable', status: 409, code: 'FT-CLIENT-FRAME-IMMUTABLE' })]);
  api.completeErrors.set(2, [new ClientApiError({ kind: 'upload_mismatch', status: 422, retryable: true })]);
  const outcome = await runner(deps).runOnce();
  assert.equal(outcome.kind, 'waiting');
  assert.deepEqual(api.completes, [0, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(camera.uploads.length, 11, 'frame 2 uploaded twice');
});

test('a non-retryable refusal fails the capture and deletes the local frames', async () => {
  const { api, camera, deps } = setup();
  await enqueueCapture(deps, input(await burst(camera)));
  api.createError = new ClientApiError({ kind: 'profile_required', status: 409, code: 'FT-CLIENT-PROFILE-REQUIRED' });
  const outcome = await runner(deps).runOnce();
  assert.equal(outcome.kind, 'terminal');
  assert.equal(outcome.kind === 'terminal' && outcome.manifest.stage, 'failed');
  assert.equal(outcome.kind === 'terminal' && outcome.manifest.error, 'FT-CLIENT-PROFILE-REQUIRED');
  assert.equal((await camera.listSpool()).length, 0);
});

test('«جارٍ التحقق» persists across a restart and resolves to the server verdict', async () => {
  const { api, camera, storage, deps } = setup();
  api.verdicts = ['checking', 'checking', 'needs_retake'];
  await enqueueCapture(deps, input(await burst(camera)));
  await runner(deps).runOnce();
  assert.equal((await loadManifest(storage))?.stage, 'checking');
  const restarted = runner({ ...deps, vault: memoryMetaVault() });
  assert.equal((await restarted.runOnce()).kind, 'waiting');
  const outcome = await restarted.runOnce();
  assert.equal(outcome.kind === 'terminal' && outcome.manifest.stage, 'needs_retake');
  assert.deepEqual(outcome.kind === 'terminal' && outcome.manifest.verdict?.reasons, ['glasses']);
  assert.equal(api.finalizes, 1);
});

test('`received` (integrity verified, quality checks not yet run) ends the polling as its own state', async () => {
  const { api, camera, storage, deps } = setup();
  api.verdicts = ['checking', 'received'];
  await enqueueCapture(deps, input(await burst(camera)));
  const r = runner(deps);
  assert.equal((await r.runOnce()).kind, 'waiting');
  const outcome = await r.runOnce();
  assert.equal(outcome.kind, 'terminal');
  assert.equal(outcome.kind === 'terminal' && outcome.manifest.stage, 'received');
  // Terminal: no further polling, even if asked again.
  const polls = api.polls;
  assert.equal((await r.runOnce()).kind, 'terminal');
  assert.equal(api.polls, polls);
  assert.equal((await loadManifest(storage))?.stage, 'received');
});

test('an expired session blocks the spool without discarding anything', async () => {
  const { api, camera, storage, deps } = setup();
  await enqueueCapture(deps, input(await burst(camera)));
  api.createError = new ClientApiError({ kind: 'session_expired', status: 401 });
  assert.deepEqual(await runner(deps).runOnce(), { kind: 'blocked', reason: 'session' });
  assert.equal((await loadManifest(storage))?.stage, 'pending_create');
});

test('only one capture at a time; a terminal one is replaced', async () => {
  const { camera, deps } = setup();
  await enqueueCapture(deps, input(await burst(camera)));
  await assert.rejects(enqueueCapture(deps, input(await burst(camera))));
});

test('captures older than 48 h are abandoned; orphan spool frames are deleted at boot', async () => {
  let now = Date.now();
  const { camera, storage, deps } = setup();
  const timed: SpoolDeps = { ...deps, now: () => now };
  await enqueueCapture(timed, input(await burst(camera)));
  const orphan = await burst(camera); // never enqueued
  const r = runner(timed);
  assert.equal(await r.cleanupOrphans(), orphan.length);
  assert.equal((await camera.listSpool()).length, 10);

  now += SPOOL_MAX_AGE_MS + 1;
  const outcome = await r.runOnce();
  assert.equal(outcome.kind === 'terminal' && outcome.manifest.error, 'expired');
  assert.equal((await loadManifest(storage))?.stage, 'abandoned');
});

test('a corrupt manifest is removed rather than resumed', async () => {
  const storage = memoryStorage();
  await storage.setItem(SPOOL_KEY, '{"version":1,"stage":"uploading"}');
  assert.equal(await loadManifest(storage), null);
  assert.equal(storage.raw(), null);
});

test('native rejection codes: upload_failed waits, not_found / spool_unreadable lose the capture', async () => {
  {
    const { camera, storage, deps } = setup();
    await enqueueCapture(deps, input(await burst(camera)));
    camera.rejections = [{ code: 'upload_failed' }];
    const outcome = await runner(deps).runOnce();
    assert.equal(outcome.kind === 'waiting' && outcome.reason, 'offline');
    assert.equal((await loadManifest(storage))?.stage, 'uploading');
  }
  for (const code of ['not_found', 'spool_unreadable']) {
    const { camera, deps } = setup();
    await enqueueCapture(deps, input(await burst(camera)));
    camera.rejections = [{ code }];
    const outcome = await runner(deps).runOnce();
    assert.equal(outcome.kind === 'terminal' && outcome.manifest.stage, 'abandoned', code);
    assert.equal((await camera.listSpool()).length, 0, code);
  }
  {
    const { camera, deps } = setup();
    await enqueueCapture(deps, input(await burst(camera)));
    camera.rejections = [{ code: 'invalid_argument' }];
    const outcome = await runner(deps).runOnce();
    assert.equal(outcome.kind === 'terminal' && outcome.manifest.stage, 'failed');
  }
});

test('captures name protocol capture-spec-v2 and the current gate hash', async () => {
  const { api, camera, deps } = setup();
  await enqueueCapture(deps, input(await burst(camera)));
  await runner(deps).runOnce();
  assert.equal(api.creates[0]!.protocol_version, 'capture-spec-v2');
  assert.equal(api.creates[0]!.gate_config_hash, gateConfigHash());
});

// ---------------------------------------------------------------------------
// Attempt telemetry: after the verdict, never at enqueue (Codex round 2, B2);
// never lost with the manifest, retried while owed (Codex round 3, B2)
// ---------------------------------------------------------------------------
test('attempt telemetry is posted once, after the verdict, with snake_case reasons', async () => {
  for (const verdict of ['stored', 'received', 'needs_retake'] as const) {
    const { api, camera, storage, deps } = setup();
    api.verdicts = ['checking', verdict];
    await enqueueCapture(deps, input(await burst(camera), { telemetry: TELEMETRY }));
    const r = runner(deps);
    await r.runOnce(); // uploaded, checking
    assert.equal(api.attempts.length, 0, `${verdict}: nothing before the verdict`);
    assert.ok(api.log.indexOf('postAttempt') === -1);
    await r.runOnce(); // verdict
    assert.equal(api.attempts.length, 1, verdict);
    const sent = api.attempts[0]!;
    assert.equal(sent.outcome, verdict);
    assert.deepEqual(sent.reason_counts, { one_face: 1, distance_or_size: 2, light: 1 });
    assert.equal(sent.attempts, 2);
    assert.equal(sent.duration_ms, 4200);
    assert.ok(api.log.lastIndexOf('getCapture') < api.log.indexOf('postAttempt'), 'after the verdict poll');
    assert.equal((await loadManifest(storage))?.attemptTelemetry, null, 'not owed any more');
    await r.runOnce();
    await r.acknowledge();
    assert.equal(api.attempts.length, 1, `${verdict}: exactly once`);
  }
});

test('an abandoned capture reports `abandoned`; offline it stays queued and is retried after the backoff', async () => {
  let now = Date.now();
  const { api, camera, storage, deps } = setup();
  const timed: SpoolDeps = { ...deps, now: () => now };
  await enqueueCapture(timed, input(await burst(camera), { telemetry: TELEMETRY }));
  camera.rejections = [{ code: 'not_found' }];
  api.attemptErrors = [offline()];
  const r = runner(timed);
  const outcome = await r.runOnce();
  assert.equal(outcome.kind === 'terminal' && outcome.manifest.stage, 'abandoned');
  assert.equal(api.attempts.length, 0, 'offline: still owed');
  assert.equal(outcome.telemetryRetryInMs, SPOOL_TIMING.backoffBaseMs * 2, 'the pump is told when to try again');
  assert.equal((await loadManifest(storage))?.attemptTelemetry, null, 'moved out of the manifest…');
  assert.equal((await loadAttemptQueue(storage, ACCOUNT)).length, 1, '…into the telemetry queue');
  now += SPOOL_TIMING.backoffBaseMs * 2;
  const retried = await r.runOnce();
  assert.equal(api.attempts.length, 1);
  assert.equal(api.attempts[0]!.outcome, 'abandoned');
  assert.equal(retried.telemetryRetryInMs, undefined, 'nothing owed any more');
  assert.equal(storage.raw(TELEMETRY_QUEUE_KEY), null);
});

test('round 3: repeated offline failures keep the attempt — past acknowledging the verdict — until it is delivered', async () => {
  let now = Date.now();
  const { api, camera, storage, deps } = setup();
  const timed: SpoolDeps = { ...deps, now: () => now };
  api.verdicts = ['stored'];
  api.attemptErrors = [offline(), offline(), offline()];
  const manifest = await enqueueCapture(timed, input(await burst(camera), { telemetry: TELEMETRY }));
  const r = runner(timed);
  const first = await r.runOnce();
  assert.equal(first.kind === 'terminal' && first.manifest.stage, 'stored');
  assert.notEqual(nextRunInMs(first), null, 'a terminal outcome that still owes telemetry is run again');
  const delays = [first.telemetryRetryInMs];

  // The person sees the verdict and dismisses it: the manifest goes, the attempt does not.
  await r.acknowledge();
  assert.equal(await loadManifest(storage), null);
  const owed = await loadAttemptQueue(storage, ACCOUNT);
  assert.deepEqual(
    owed.map((e) => [e.key, e.telemetry.outcome]),
    [[manifest.clientCaptureId, 'stored']],
  );

  // Asked again before the backoff is over: nothing is sent.
  const early = await r.runOnce();
  assert.equal(early.kind, 'idle');
  assert.ok((early.telemetryRetryInMs ?? 0) > 0);
  assert.equal(api.log.filter((c) => c === 'postAttempt').length, 1);

  for (let i = 0; i < 2; i += 1) {
    now += SPOOL_TIMING.backoffMaxMs;
    delays.push((await r.runOnce()).telemetryRetryInMs);
    assert.equal((await loadAttemptQueue(storage, ACCOUNT)).length, 1, `failure ${i + 2}: still owed`);
  }
  assert.deepEqual(delays, [4000, 8000, 16000], 'exponential backoff');

  now += SPOOL_TIMING.backoffMaxMs;
  const delivered = await r.runOnce();
  assert.deepEqual(delivered, { kind: 'idle' });
  assert.equal(nextRunInMs(delivered), null, 'nothing owed: the pump stops');
  assert.equal(api.attempts.length, 1);
  assert.equal(api.attempts[0]!.outcome, 'stored');
  assert.equal(api.log.filter((c) => c === 'postAttempt').length, 4);
  assert.equal(storage.raw(TELEMETRY_QUEUE_KEY), null);
});

test('round 3: a body the server refuses as invalid is dropped, never retried', async () => {
  const { api, camera, storage, deps } = setup();
  api.verdicts = ['received'];
  api.attemptErrors = [new ClientApiError({ kind: 'validation', status: 422 })];
  await enqueueCapture(deps, input(await burst(camera), { telemetry: TELEMETRY }));
  const r = runner(deps);
  const outcome = await r.runOnce();
  assert.equal(outcome.kind === 'terminal' && outcome.manifest.stage, 'received');
  assert.equal(outcome.telemetryRetryInMs, undefined, 'nothing owed any more');
  assert.equal(storage.raw(TELEMETRY_QUEUE_KEY), null);
  assert.equal((await loadManifest(storage))?.attemptTelemetry, null);
  await r.runOnce();
  await r.acknowledge();
  await r.runOnce();
  assert.equal(api.log.filter((c) => c === 'postAttempt').length, 1);
});

test('round 3: owed telemetry is account-bound — switch or deletion drops it; sign-out keeps it for that account only', async () => {
  const owe = async () => {
    const env = setup();
    env.api.verdicts = ['stored'];
    env.api.attemptErrors = [offline()];
    await enqueueCapture(env.deps, input(await burst(env.camera), { telemetry: TELEMETRY }));
    const r = runner(env.deps);
    await r.runOnce();
    await r.acknowledge();
    assert.equal((await loadAttemptQueue(env.storage, ACCOUNT)).length, 1);
    return { ...env, r };
  };
  const posts = (api: FakeApi) => api.log.filter((c) => c === 'postAttempt').length;
  {
    // Another account signs in on top of this one: dropped, nothing sent as account B.
    const { api, storage, r } = await owe();
    r.bindAccount(OTHER_ACCOUNT);
    assert.deepEqual(await r.runOnce(), { kind: 'idle' });
    assert.equal(storage.raw(TELEMETRY_QUEUE_KEY), null, 'switch: dropped');
    assert.equal(posts(api), 1);
  }
  {
    // Account deletion (the default discard).
    const { api, storage, r } = await owe();
    await r.discard();
    assert.equal(storage.raw(TELEMETRY_QUEUE_KEY), null, 'deletion: dropped');
    r.bindAccount(null);
    r.bindAccount(ACCOUNT);
    await r.runOnce();
    assert.equal(posts(api), 1);
  }
  {
    // Sign-out keeps it; the same account signing in again delivers it.
    const { api, storage, r } = await owe();
    await r.discard({ telemetry: 'keep' });
    r.bindAccount(null);
    assert.equal((await loadAttemptQueue(storage, ACCOUNT)).length, 1, 'sign-out: kept');
    r.bindAccount(ACCOUNT);
    await r.runOnce();
    assert.deepEqual(
      api.attempts.map((a) => a.outcome),
      ['stored'],
    );
    assert.equal(storage.raw(TELEMETRY_QUEUE_KEY), null);
  }
  {
    // …but another account signing in after that sign-out drops it unsent.
    const { api, storage, r } = await owe();
    await r.discard({ telemetry: 'keep' });
    r.bindAccount(null);
    r.bindAccount(OTHER_ACCOUNT);
    await r.runOnce();
    assert.equal(storage.raw(TELEMETRY_QUEUE_KEY), null);
    assert.equal(posts(api), 1);
  }
});

test('round 3: an attempt queued twice (death between queueing and the manifest update) is sent once', async () => {
  const { api, camera, storage, deps } = setup();
  api.verdicts = ['stored'];
  const manifest = await enqueueCapture(deps, input(await burst(camera), { telemetry: TELEMETRY }));
  await queueAttempt(storage, ACCOUNT, {
    key: manifest.clientCaptureId,
    telemetry: { outcome: 'stored', ...TELEMETRY },
    queuedAtMs: 0,
  });
  await runner(deps).runOnce();
  assert.equal(api.attempts.length, 1);
  assert.equal(storage.raw(TELEMETRY_QUEUE_KEY), null);
});

test('attempts that end before the spool (cancel, time-out) are owed through the same queue', async () => {
  let now = Date.now();
  const { api, storage, deps } = setup();
  const timed: SpoolDeps = { ...deps, now: () => now };
  const r = runner(timed);
  api.attemptErrors = [offline()];
  assert.equal(await r.recordAttempt({ outcome: 'cancelled', ...TELEMETRY }), true);
  const first = await r.runOnce();
  assert.equal(first.kind, 'idle');
  assert.ok((first.telemetryRetryInMs ?? 0) > 0, 'offline: still owed');
  now += SPOOL_TIMING.backoffMaxMs;
  await r.runOnce();
  assert.deepEqual(
    api.attempts.map((a) => a.outcome),
    ['cancelled'],
  );
  assert.equal(storage.raw(TELEMETRY_QUEUE_KEY), null);
  // Nobody signed in: nothing is kept.
  assert.equal(await runner(timed, null).recordAttempt({ outcome: 'cancelled', ...TELEMETRY }), false);
  assert.equal(storage.raw(TELEMETRY_QUEUE_KEY), null);
});

test('round 4: more owed attempts than the queue holds are delivered folded, never dropped', async () => {
  // Codex round 4 reproduced the loss through recordAttempt: 21 offline
  // attempts against a cap of 20 delivered 20, and the oldest (a permission
  // denial) was gone. Past the cap records now fold into aggregates.
  const { api, storage, deps } = setup();
  const r = runner(deps);
  const denied = { outcome: 'permission_denied' as const, duration_ms: 10, attempts: 0, reason_counts: {}, device: TELEMETRY.device };
  assert.equal(await r.recordAttempt(denied), true);
  for (let i = 0; i < TELEMETRY_QUEUE_MAX; i += 1) {
    assert.equal(await r.recordAttempt({ outcome: 'cancelled', ...TELEMETRY }), true);
  }
  assert.equal((await loadAttemptQueue(storage, ACCOUNT)).length, TELEMETRY_QUEUE_MAX);

  await r.runOnce();
  assert.equal(storage.raw(TELEMETRY_QUEUE_KEY), null, 'everything delivered');
  assert.deepEqual(api.attempts[0], denied, 'the oldest is delivered first, as it was');
  const cancelled = api.attempts.filter((a) => a.outcome === 'cancelled');
  assert.ok(cancelled.length < TELEMETRY_QUEUE_MAX, 'some records were sent folded');
  const sum = (pick: (a: AttemptTelemetry) => number) => cancelled.reduce((total, a) => total + pick(a), 0);
  assert.equal(sum((a) => a.attempts), TELEMETRY_QUEUE_MAX * TELEMETRY.attempts);
  assert.equal(sum((a) => a.duration_ms), TELEMETRY_QUEUE_MAX * TELEMETRY.duration_ms);
  for (const [key, count] of Object.entries(TELEMETRY.reason_counts)) {
    assert.equal(sum((a) => a.reason_counts[key] ?? 0), TELEMETRY_QUEUE_MAX * count, key);
  }
  assert.ok(cancelled.every((a) => a.attempts <= 10_000 && a.duration_ms <= 3_600_000));
});

test('nextRunInMs: the earlier of the capture retry and the telemetry retry; nothing when idle or blocked', () => {
  const m = {} as never; // the manifest is not inspected
  assert.equal(nextRunInMs({ kind: 'idle' }), null);
  assert.equal(nextRunInMs({ kind: 'idle', telemetryRetryInMs: 4000 }), 4000);
  assert.equal(nextRunInMs({ kind: 'blocked', reason: 'session', telemetryRetryInMs: 4000 }), null);
  assert.equal(nextRunInMs({ kind: 'terminal', manifest: m }), null);
  assert.equal(nextRunInMs({ kind: 'terminal', manifest: m, telemetryRetryInMs: 8000 }), 8000);
  assert.equal(
    nextRunInMs({ kind: 'waiting', manifest: m, retryInMs: 2000, reason: 'checking', telemetryRetryInMs: 8000 }),
    2000,
  );
  assert.equal(
    nextRunInMs({ kind: 'waiting', manifest: m, retryInMs: 60_000, reason: 'offline', telemetryRetryInMs: 8000 }),
    8000,
  );
});

// ---------------------------------------------------------------------------
// Discard is final (Codex round 2, A9) and drains its writes (round 3, A9)
// ---------------------------------------------------------------------------
const AWAITED_STEPS: Array<{ step: string; prepare?: (api: FakeApi) => void }> = [
  { step: 'createCapture' },
  { step: 'setItem' },
  { step: 'listSpool' },
  { step: 'vault.get' },
  { step: 'renewFrameUpload', prepare: (api) => (api.targetExpiry = new Date(Date.now() + 10_000).toISOString()) },
  { step: 'uploadFrame' },
  { step: 'completeFrame' },
  { step: 'deleteFrames' },
  { step: 'finalizeCapture' },
  { step: 'getCapture', prepare: (api) => (api.verdicts = ['checking']) },
  { step: 'postAttempt', prepare: (api) => (api.verdicts = ['stored']) },
];

for (const { step, prepare } of AWAITED_STEPS) {
  test(`a discard while the run awaits ${step} stops it: nothing more is uploaded, completed or saved`, async () => {
    const gates = new Gates();
    const { api, camera, storage, deps } = setup(undefined, gates);
    prepare?.(api);
    await enqueueCapture(deps, input(await burst(camera), { telemetry: TELEMETRY }));
    const r = runner(deps);
    if (step === 'getCapture') {
      // Reach the polling stage first; the poll is the second run.
      await r.runOnce();
      api.verdicts = ['stored'];
    }
    camera.log = api.log;
    gates.arm(step);
    const run = r.runOnce();
    await gates.reached(step);

    const callsAtDiscard = api.log.length;
    const writesBefore = storage.writes;
    if (step === 'setItem') {
      // A save already in flight: the discard waits for it to land (round 3), so it is released meanwhile.
      const discarding = r.discard();
      await settle();
      gates.release(step);
      await discarding;
    } else {
      await r.discard();
      gates.release(step);
    }
    const writesAtDiscard = storage.writes;
    const outcome = await run;

    assert.deepEqual(outcome, { kind: 'idle' }, step);
    assert.equal(await loadManifest(storage), null, `${step}: no manifest survives`);
    assert.equal(storage.raw(DISCARD_MARKER_KEY), null, `${step}: the discard finished and unmarked`);
    assert.equal(storage.raw(TELEMETRY_QUEUE_KEY), null, `${step}: no attempt telemetry left owed`);
    assert.equal((await camera.listSpool()).length, 0, `${step}: every local frame deleted`);
    assert.equal(api.log.length, callsAtDiscard, `${step}: no API call or upload after the discard`);
    // Every write in flight landed before the discard returned; none is started after it.
    assert.equal(storage.writes, writesAtDiscard, `${step}: nothing saved after the discard`);
    assert.ok(writesAtDiscard > writesBefore, `${step}: the discard wrote its marker`);
    if (api.signals.length > 0) assert.equal(api.signals[api.signals.length - 1]!.aborted, true, `${step}: the request was aborted`);

    // The next run finds nothing to do.
    assert.deepEqual(await r.runOnce(), { kind: 'idle' });
    assert.equal(api.log.length, callsAtDiscard);
  });
}

test('round 3 (A9): a save already in flight when the discard begins lands before the removal, and is removed', async () => {
  const gates = new Gates();
  const { camera, storage, deps } = setup(undefined, gates);
  const manifest = await enqueueCapture(deps, input(await burst(camera), { telemetry: TELEMETRY }));
  const r = runner(deps);
  gates.arm('setItem');
  const run = r.runOnce();
  await gates.reached('setItem'); // created; the save of `uploading` is in flight
  storage.ops.length = 0;

  const discarding = r.discard();
  await settle();
  // The discard has marked the capture and is waiting for the write: nothing removed yet.
  assert.deepEqual(storage.ops, [`set:${DISCARD_MARKER_KEY}`]);
  const marker = await loadDiscardMarker(storage);
  assert.ok(marker && marker !== 'corrupt');
  assert.deepEqual(
    marker.captures.map((c) => [c.accountId, c.clientCaptureId, c.frameIds.length]),
    [[ACCOUNT, manifest.clientCaptureId, 10]],
  );

  gates.release('setItem');
  await discarding;
  assert.deepEqual(await run, { kind: 'idle' });
  const landed = storage.ops.indexOf(`set:${SPOOL_KEY}`);
  const removed = storage.ops.indexOf(`remove:${SPOOL_KEY}`);
  assert.ok(landed >= 0, 'the in-flight save landed');
  assert.ok(removed > landed, 'and the removal came after it');
  assert.equal(storage.raw(), null);
  assert.equal(storage.raw(DISCARD_MARKER_KEY), null, 'unmarked once done');
  assert.equal((await camera.listSpool()).length, 0);
});

test('round 3 (A9): process death after the discard marker is written → the next boot deletes capture and frames', async () => {
  const gates = new Gates();
  const { api, camera, storage, deps } = setup(undefined, gates);
  const manifest = await enqueueCapture(deps, input(await burst(camera), { telemetry: TELEMETRY }));
  const r = runner(deps);
  gates.arm('setItem');
  void r.runOnce();
  await gates.reached('setItem');
  gates.arm('deleteFrames');
  void r.discard();
  await settle(); // marked; waiting for the save in flight
  gates.release('setItem'); // the save lands…
  await gates.reached('deleteFrames'); // …and the process dies before anything is deleted
  assert.equal(JSON.parse(storage.raw() ?? 'null')?.clientCaptureId, manifest.clientCaptureId, 'still on disk');
  assert.ok(await loadDiscardMarker(storage));
  assert.equal((await camera.listSpool()).length, 10);

  // Next boot: a new process (runner + memory) over the same storage and native spool,
  // the same account signed in again.
  const calls = api.log.length;
  const booted = runner({ ...deps, vault: memoryMetaVault() }, ACCOUNT);
  await booted.recoverDiscarded();
  assert.equal(storage.raw(), null, 'the discarded manifest is deleted…');
  assert.equal((await camera.listSpool()).length, 0, '…with its spooled frames (native deleteFrames)');
  assert.equal(storage.raw(DISCARD_MARKER_KEY), null, '…then the marker is cleared');
  assert.deepEqual(await booted.runOnce(), { kind: 'idle' });
  assert.equal(api.log.length, calls, 'nothing of the discarded capture is resumed or sent');
});

test('round 3 (A9): the first operation after boot finishes a pending discard even without recoverDiscarded()', async () => {
  const { api, camera, storage, deps } = setup();
  const manifest = await enqueueCapture(deps, input(await burst(camera)));
  await storage.setItem(
    DISCARD_MARKER_KEY,
    JSON.stringify({
      version: 1,
      dropTelemetry: true,
      captures: [{ accountId: ACCOUNT, clientCaptureId: manifest.clientCaptureId, frameIds: [] }],
    }),
  );
  assert.deepEqual(await runner(deps).runOnce(), { kind: 'idle' });
  assert.equal(storage.raw(), null);
  assert.equal((await camera.listSpool()).length, 0);
  assert.equal(api.log.length, 0);
});

test('round 3 (A9): a discard whose recovery fails still discards, and keeps the earlier marker’s captures', async () => {
  const { api, camera, storage, deps } = setup();
  const stale = await burst(camera); // frames of an earlier, half-finished discard (its manifest already gone)
  await enqueueCapture(deps, input(await burst(camera)));
  await storage.setItem(
    DISCARD_MARKER_KEY,
    JSON.stringify({
      version: 1,
      dropTelemetry: false,
      captures: [{ accountId: ACCOUNT, clientCaptureId: 'cap-earlier-0001', frameIds: stale.map((f) => f.id) }],
    }),
  );
  let failOnce = true;
  const flaky: KeyValueStorage = {
    getItem: async (key) => {
      if (failOnce && key === DISCARD_MARKER_KEY) {
        failOnce = false;
        throw new Error('storage busy');
      }
      return storage.getItem(key);
    },
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
  };
  await runner({ ...deps, storage: flaky }).discard();
  assert.equal(failOnce, false, 'the recovery did fail');
  assert.equal(storage.raw(), null, 'the current capture is discarded anyway');
  assert.equal((await camera.listSpool()).length, 0, 'and the earlier marker’s frames with it');
  assert.equal(storage.raw(DISCARD_MARKER_KEY), null);
  assert.equal(api.log.length, 0);
});

test('round 3 (A9): an unreadable discard marker discards everything at boot', async () => {
  const { api, camera, storage, deps } = setup();
  await enqueueCapture(deps, input(await burst(camera), { telemetry: TELEMETRY }));
  await storage.setItem(DISCARD_MARKER_KEY, '{not json');
  assert.deepEqual(await runner(deps).runOnce(), { kind: 'idle' });
  assert.equal(storage.raw(), null);
  assert.equal(storage.raw(DISCARD_MARKER_KEY), null);
  assert.equal((await camera.listSpool()).length, 0);
  assert.equal(api.log.length, 0);
});

test('a run started while a discard is in progress waits for it and finds nothing', async () => {
  const gates = new Gates();
  const { api, camera, storage, deps } = setup(undefined, gates);
  await enqueueCapture(deps, input(await burst(camera)));
  const r = runner(deps);
  gates.arm('deleteFrames');
  const discarding = r.discard();
  await gates.reached('deleteFrames');
  const run = r.runOnce();
  gates.release('deleteFrames');
  await discarding;
  assert.deepEqual(await run, { kind: 'idle' });
  assert.equal(api.log.length, 0);
  assert.equal(await loadManifest(storage), null);
});

test('a capture queued while the person signs out does not survive the sign-out', async () => {
  const gates = new Gates();
  const { api, camera, storage, deps } = setup(undefined, gates);
  const r = runner(deps);
  gates.arm('setItem');
  const frames = await burst(camera);
  const queued = r.enqueue({ frames, attempt: 1, capabilities: null, telemetry: TELEMETRY });
  await gates.reached('setItem');
  const signOut = r.discard();
  gates.release('setItem');
  await assert.rejects(queued, /signed out/);
  await signOut;
  assert.equal(await loadManifest(storage), null);
  assert.equal((await camera.listSpool()).length, 0);
  assert.deepEqual(await r.runOnce(), { kind: 'idle' });
  assert.equal(api.log.length, 0);
});

test('the abort signal reaches the in-flight request', async () => {
  const gates = new Gates();
  const { api, camera, deps } = setup(undefined, gates);
  await enqueueCapture(deps, input(await burst(camera)));
  const r = runner(deps);
  gates.arm('createCapture');
  const run = r.runOnce();
  await gates.reached('createCapture');
  const signal = api.signals[0]!;
  assert.equal(signal.aborted, false);
  await r.discard();
  assert.equal(signal.aborted, true);
  gates.release('createCapture');
  await run;
});

// ---------------------------------------------------------------------------
// A capture belongs to its account (Codex round 2, A9)
// ---------------------------------------------------------------------------
test("another account's manifest is deleted at boot, never resumed or uploaded", async () => {
  const { api, camera, storage, deps } = setup();
  await enqueueCapture(deps, input(await burst(camera), { accountId: OTHER_ACCOUNT }));
  const r = runner(deps, ACCOUNT);
  assert.equal(await r.cleanupOrphans(), 0, 'its frames were deleted with the manifest');
  assert.equal(await loadManifest(storage), null);
  assert.equal((await camera.listSpool()).length, 0);
  assert.deepEqual(await r.runOnce(), { kind: 'idle' });
  assert.equal(api.log.length, 0, 'nothing sent under the wrong account');
});

test('switching account supersedes the running upload and drops the old capture', async () => {
  const gates = new Gates();
  const { api, camera, storage, deps } = setup(undefined, gates);
  await enqueueCapture(deps, input(await burst(camera)));
  const r = runner(deps, ACCOUNT);
  gates.arm('completeFrame');
  const run = r.runOnce();
  await gates.reached('completeFrame');
  const calls = api.log.length;
  r.bindAccount(OTHER_ACCOUNT);
  gates.release('completeFrame');
  assert.deepEqual(await run, { kind: 'idle' });
  assert.equal(api.log.length, calls, 'the old run stopped');
  assert.deepEqual(await r.runOnce(), { kind: 'idle' });
  assert.equal(await loadManifest(storage), null, "account A's manifest is gone");
  assert.equal((await camera.listSpool()).length, 0);
  assert.equal(api.log.length, calls, 'and nothing of it was sent as account B');
});

test('the same account resumes its own capture; no account bound touches nothing', async () => {
  const { api, camera, storage, deps } = setup();
  await enqueueCapture(deps, input(await burst(camera)));
  const nobody = runner(deps, null);
  assert.deepEqual(await nobody.runOnce(), { kind: 'idle' });
  assert.equal(await nobody.cleanupOrphans(), 0);
  assert.equal((await loadManifest(storage))?.accountId, ACCOUNT, 'kept for its owner');
  nobody.bindAccount(ACCOUNT);
  assert.equal((await nobody.runOnce()).kind, 'waiting');
  assert.equal(api.creates.length, 1);
});

test('a manifest without an owning account (v1) is removed rather than resumed', async () => {
  const { camera, storage, deps } = setup();
  const manifest = await enqueueCapture(deps, input(await burst(camera)));
  const legacy: Record<string, unknown> = { ...manifest, version: 1 };
  delete legacy.accountId;
  await storage.setItem(SPOOL_KEY, JSON.stringify(legacy));
  assert.equal(await loadManifest(storage), null);
  assert.equal(storage.raw(), null);
  // Its frames are orphans now and go at the next boot.
  assert.equal(await runner(deps).cleanupOrphans(), 10);
});

test('enqueue replaces another account’s queued capture instead of refusing', async () => {
  const { camera, storage, deps } = setup();
  const theirs = await burst(camera);
  await enqueueCapture(deps, input(theirs, { accountId: OTHER_ACCOUNT }));
  const ours = await burst(camera);
  const r = runner(deps, ACCOUNT);
  await r.enqueue({ frames: ours, attempt: 1, capabilities: null });
  assert.equal((await loadManifest(storage))?.accountId, ACCOUNT);
  const left = new Set((await camera.listSpool()).map((e) => e.id));
  assert.ok(theirs.every((f) => !left.has(f.id)), "the other account's frames are deleted");
  assert.ok(ours.every((f) => left.has(f.id)));
});
