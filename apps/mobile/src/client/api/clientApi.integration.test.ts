/**
 * End-to-end: the REAL `clientApi.ts` (and the real upload spool) against a
 * running API (docs/client-app-v1.md §3). Skipped unless
 * `FACETYPE_CLIENT_E2E_URL` points at a server started with the offline
 * environment of `tools/task.py` plus `CLIENT_AUTH_MOCK_ENABLED=true`, e.g.
 *
 *   FACETYPE_CLIENT_E2E_URL=http://127.0.0.1:8765 \
 *     node --test --experimental-strip-types src/client/api/clientApi.integration.test.ts
 *
 * SYNTHETIC DATA ONLY. The frames are uniform-grey 320x240 JPEGs written here
 * byte by byte (no face, no photo of anyone). The identity number is the
 * obviously fake `1000000008` (Saudi national-ID format, Luhn-valid), the
 * phone `0500000000`, the name «اختبار تجريبي». The account is deleted at the
 * end. Every HTTP exchange is reported as a diagnostic line.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { CLIENT_PROTOCOL_VERSION, gateConfigHash } from '@facetype/contracts';

import type { BurstFrame, ClientCameraModule, SpoolEntry, UploadTarget } from '../native/types.ts';
import { memoryMetaVault } from '../spool/metaVault.ts';
import type { KeyValueStorage } from '../spool/manifest.ts';
import { enqueueCapture, SpoolRunner } from '../spool/spool.ts';
import { CONSENT_VERSION } from '../strings.ts';
import { validateProfile } from '../validation.ts';
import { CLIENT_API_PREFIX, ClientApiError, createClientApi, uuidV4, type ClientApi } from './clientApi.ts';
import { memoryTokenStore } from './tokens.ts';
import type { CaptureCreate, CaptureView, ProfileInput } from './types.ts';

const BASE = process.env.FACETYPE_CLIENT_E2E_URL?.replace(/\/+$/, '') ?? '';
const SYNTHETIC_ID = '1000000008';
const SYNTHETIC_PHONE_LOCAL = '0500000000';
const FRAMES = 10;
const WIDTH = 320;
const HEIGHT = 240;
/**
 * With CELERY_TASK_ALWAYS_EAGER the server runs the post-finalize check and the
 * erasure inside the request, so on a slow development machine finalize and
 * DELETE /me can outlast the app's 30 s request timeout. Production dispatches
 * to a worker and answers at once; only this test waits longer.
 */
const TIMEOUT_MS = Number(process.env.FACETYPE_CLIENT_E2E_TIMEOUT_MS ?? 180_000);

// --- a uniform-grey baseline JPEG, no encoder library ------------------------
// One grey component, quantiser 1, one-symbol Huffman tables: every 8x8 block
// is DC difference 0 + end-of-block, i.e. every pixel decodes to 128.
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const segment = (marker: number, payload: number[]) => [0xff, marker, ...u16(payload.length + 2), ...payload];
const oneSymbolTable = (tableClass: number) => [tableClass, 1, ...new Array<number>(15).fill(0), 0x00];

function greyJpeg(width: number, height: number, label: string): Uint8Array {
  const comment = [...label].map((c) => c.charCodeAt(0) & 0x7f);
  const bits = Math.ceil(width / 8) * Math.ceil(height / 8) * 2;
  const scan = new Array<number>(Math.ceil(bits / 8)).fill(0);
  const pad = scan.length * 8 - bits;
  if (pad > 0) scan[scan.length - 1] = (1 << pad) - 1;
  return Uint8Array.from([
    0xff, 0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    ...segment(0xfe, comment),
    ...segment(0xdb, [0x00, ...new Array<number>(64).fill(1)]),
    ...segment(0xc0, [0x08, ...u16(height), ...u16(width), 0x01, 0x01, 0x11, 0x00]),
    ...segment(0xc4, oneSymbolTable(0x00)),
    ...segment(0xc4, oneSymbolTable(0x10)),
    ...segment(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    ...scan,
    0xff, 0xd9,
  ]);
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface SyntheticFrame {
  id: string;
  bytes: Uint8Array;
  meta: Record<string, unknown>;
}

function syntheticBurst(tag: string): SyntheticFrame[] {
  return Array.from({ length: FRAMES }, (_, index) => ({
    id: `${tag}-${index}`,
    bytes: greyJpeg(WIDTH, HEIGHT, `synthetic uniform grey frame ${tag}-${index} (no face)`),
    // Synthetic FrameMeta with every key the server requires (client-native-interface §4);
    // the values describe a neutral, frontal pose and are not measurements of anyone.
    meta: {
      frame_id: `${tag}-${index}`,
      synthetic: true,
      burst_index: index,
      stream_w: WIDTH,
      stream_h: HEIGHT,
      protocol_version: CLIENT_PROTOCOL_VERSION,
      gate_config_hash: gateConfigHash(),
      blendshapes: { mouthSmileLeft: 0, mouthSmileRight: 0, jawOpen: 0, eyeBlinkLeft: 0, eyeBlinkRight: 0 },
      yaw: 0,
      pitch: 0,
      roll: 0,
    },
  }));
}

// --- HTTP log ------------------------------------------------------------------
const log: string[] = [];
let step = '';

const loggingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const started = Date.now();
  const response = await fetch(input, init);
  const where = url.pathname.replace(/(\/objects\/client\/)[^?]*\/(\d+\.jpg)$/, '$1…/$2');
  log.push(`${step} | ${init?.method ?? 'GET'} ${where} -> ${response.status} (${Date.now() - started} ms)`);
  return response;
}) as typeof fetch;

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => void map.set(key, value),
    removeItem: async (key) => void map.delete(key),
  };
}

async function rejectsWith(promise: Promise<unknown>, kind: ClientApiError['kind'], code?: string): Promise<ClientApiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ClientApiError, String(error));
    assert.equal(error.kind, kind, `${error.code ?? ''} ${error.message}`);
    if (code) assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${kind}`);
}

async function rawRefresh(refreshToken: string): Promise<{ status: number; code: string | null }> {
  const response = await loggingFetch(`${BASE}${CLIENT_API_PREFIX}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const body = (await response.json().catch(() => null)) as { error_code?: string } | null;
  return { status: response.status, code: body?.error_code ?? null };
}

/** PUT like the native uploader: the exact bytes, the server-given headers. */
async function put(url: string, headers: Record<string, string>, bytes: Uint8Array): Promise<number> {
  const response = await loggingFetch(url, { method: 'PUT', headers, body: bytes });
  await response.arrayBuffer();
  return response.status;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('client app v1 end to end against a live API (synthetic data)', { skip: BASE === '' }, async (t) => {
  const subject = `e2e-${uuidV4()}`;
  const storeA = memoryTokenStore();
  const a: ClientApi = createClientApi({ baseUrl: BASE, tokens: storeA, fetch: loggingFetch, timeoutMs: TIMEOUT_MS });
  let deleted = false;
  try {
    step = '01 nonce';
    const nonce = await a.nonce();
    assert.ok(nonce.nonce.length >= 16);

    step = '02 google (unconfigured)';
    await rejectsWith(a.signInGoogle('synthetic-nonempty-google-id'), 'provider_unconfigured', 'FT-CLIENT-AUTH-UNCONFIGURED');
    step = '03 apple (unconfigured)';
    await rejectsWith(
      a.signInApple({ identity_token: 'synthetic-nonempty-apple-id', nonce: nonce.nonce }),
      'provider_unconfigured',
      'FT-CLIENT-AUTH-UNCONFIGURED',
    );

    step = '04 mock sign-in';
    await a.signInMock(subject);
    assert.ok(storeA.current()?.refreshToken);

    step = '05 GET /me (new)';
    let me = await a.me();
    assert.equal(me.profile, null);
    assert.equal(me.consent, null);
    assert.equal(me.account.provider, 'mock');
    assert.equal(me.account.state, 'active');
    assert.equal(me.personality.status, 'MODEL_UNAVAILABLE');

    const burst1 = syntheticBurst('c1');
    const manifest: CaptureCreate = {
      client_capture_id: uuidV4(),
      protocol_version: CLIENT_PROTOCOL_VERSION,
      gate_config_hash: gateConfigHash(),
      device: { platform: 'e2e', model: 'synthetic' },
      camera: { id: 'synthetic' },
      frames: burst1.map((f, index) => ({ index, sha256: sha256(f.bytes), bytes: f.bytes.length, width: WIDTH, height: HEIGHT })),
      attempt: { attempts: 1 },
    };

    step = '06 capture before profile';
    await rejectsWith(a.createCapture(manifest), 'profile_required', 'FT-CLIENT-PROFILE-REQUIRED');

    const form = {
      full_name: 'اختبار تجريبي',
      id_issuing_country: 'SA',
      id_document_type: 'national_id' as const,
      id_number: SYNTHETIC_ID,
      phone: SYNTHETIC_PHONE_LOCAL,
      sex: 'male' as const,
      birth_date: '1990-01-01',
      nationality: 'SA',
    };
    step = '07 profile, local phone (server refuses)';
    const refused = await rejectsWith(a.putProfile({ ...form } satisfies ProfileInput), 'validation', 'FT-CLIENT-PROFILE-INVALID');
    assert.deepEqual(refused.fieldErrors, { phone: 'e164' });

    step = '08 PUT /me/profile (validated, E.164)';
    const checked = validateProfile(form);
    assert.ok(checked.ok);
    assert.equal(checked.value.phone, '+966500000000', 'the app sends full E.164');
    const view = await a.putProfile(checked.value);
    // Unmasked for the account's own owner (owner decision 2026-11-24).
    assert.equal(view.id_number, SYNTHETIC_ID);
    assert.equal(view.phone, '+966500000000');
    assert.equal(view.birth_date, '1990-01-01');
    assert.ok(Number.isInteger(view.age_years) && view.age_years >= 18);
    assert.equal(view.identity_verification, 'self_declared');

    step = '09 capture before consent';
    await rejectsWith(a.createCapture(manifest), 'consent_required', 'FT-PRIV-003');

    step = '10 POST /me/consent (research on)';
    const consent = await a.postConsent({ version: CONSENT_VERSION, store_accepted: true, research_use: true });
    assert.equal(consent.version, 'client-notice-v1');

    step = '11 GET /me (profile + consent)';
    me = await a.me();
    assert.ok(me.profile && me.consent?.store_accepted);
    assert.equal(me.profile.id_number, SYNTHETIC_ID);

    step = '12 POST /captures';
    const created = await a.createCapture(manifest);
    assert.equal(created.status, 'uploading');
    assert.equal(created.frames.length, FRAMES);
    for (const target of created.frames) assert.match(target.upload_url ?? '', /^https?:\/\//, 'absolute upload URL');

    step = '13 POST /captures (idempotent replay)';
    const replay = await a.createCapture(manifest);
    assert.equal(replay.capture_id, created.capture_id);

    step = '14 renew frame 1';
    const renewed = await a.renewFrameUpload(created.capture_id, 1);
    assert.equal(renewed.completed, false);

    step = '15 complete before upload';
    await rejectsWith(a.completeFrame(created.capture_id, 0, burst1[0]!.meta), 'upload_missing', 'FT-CLIENT-UPLOAD-MISSING');

    step = '16 PUT frames';
    for (const target of created.frames) {
      const frame = burst1[target.index]!;
      assert.equal(await put(target.upload_url!, target.headers, frame.bytes), 200);
    }

    step = '17 complete frames';
    for (const [index, frame] of burst1.entries()) await a.completeFrame(created.capture_id, index, frame.meta);

    step = '18 complete again (same meta, idempotent)';
    await a.completeFrame(created.capture_id, 0, burst1[0]!.meta);
    step = '19 complete again (other meta)';
    await rejectsWith(a.completeFrame(created.capture_id, 0, { ...burst1[0]!.meta, frame_id: 'other' }), 'frame_immutable', 'FT-CLIENT-FRAME-IMMUTABLE');
    step = '20 renew a stored frame';
    await rejectsWith(a.renewFrameUpload(created.capture_id, 0), 'frame_immutable', 'FT-CLIENT-FRAME-IMMUTABLE');

    step = '21 finalize';
    let capture: CaptureView = await a.finalizeCapture(created.capture_id);
    assert.ok(['checking', 'received', 'stored'].includes(String(capture.status)), String(capture.status));

    step = '22 poll until received or stored';
    for (let i = 0; i < 30 && capture.status === 'checking'; i += 1) {
      await sleep(1000);
      capture = await a.getCapture(created.capture_id);
    }
    capture = await a.getCapture(created.capture_id);
    // `received` = integrity verified, quality checks not run (docs/client-app-v1.md §6); never a quality claim.
    assert.ok(['received', 'stored'].includes(String(capture.status)), JSON.stringify(capture));
    const verdict1 = String(capture.status);
    assert.equal(capture.accepted_frames, FRAMES);
    assert.deepEqual(capture.reasons, []);

    step = '23 GET /captures';
    const listed = await a.listCaptures();
    assert.deepEqual(
      listed.map((c) => [c.id, c.status]),
      [[created.capture_id, verdict1]],
    );

    step = '24 POST /attempts';
    await a.postAttempt({ outcome: 'cancelled', duration_ms: 4200, attempts: 1, reason_counts: { light: 2, one_face: 1 }, device: { platform: 'e2e' } });

    step = '25 spool capture (real SpoolRunner)';
    const burst2 = syntheticBurst('c2');
    const spoolFrames = new Map(burst2.map((f) => [f.id, f]));
    const camera: Pick<ClientCameraModule, 'uploadFrame' | 'deleteFrames' | 'listSpool'> = {
      async uploadFrame(id: string, target: UploadTarget) {
        const frame = spoolFrames.get(id);
        if (!frame) throw Object.assign(new Error('not_found'), { code: 'not_found' });
        return { status: await put(target.url, target.headers, frame.bytes) };
      },
      async deleteFrames(ids: string[]) {
        for (const id of ids) spoolFrames.delete(id);
      },
      async listSpool(): Promise<SpoolEntry[]> {
        return [...spoolFrames.values()].map((f) => ({ id: f.id, bytes: f.bytes.length, createdAtMs: Date.now() }));
      },
    };
    const deps = { api: a, camera, storage: memoryStorage(), vault: memoryMetaVault() };
    const frames: BurstFrame[] = burst2.map((f) => ({
      id: f.id,
      width: WIDTH,
      height: HEIGHT,
      sha256: sha256(f.bytes),
      bytes: f.bytes.length,
      meta: f.meta,
    }));
    await enqueueCapture(deps, { accountId: me.account.id, frames, attempt: 2, capabilities: null });
    const runner = new SpoolRunner(deps, { accountId: me.account.id });
    let outcome = await runner.runOnce();
    for (let i = 0; i < 30 && outcome.kind === 'waiting'; i += 1) {
      await sleep(Math.min(outcome.retryInMs, 1000));
      outcome = await runner.runOnce();
    }
    assert.equal(outcome.kind, 'terminal', JSON.stringify(outcome.kind === 'waiting' ? outcome.manifest.error : outcome));
    assert.ok(
      outcome.kind === 'terminal' && ['received', 'stored'].includes(outcome.manifest.stage),
      outcome.kind === 'terminal' ? `${outcome.manifest.stage} ${String(outcome.manifest.error)}` : '',
    );
    assert.equal(spoolFrames.size, 0, 'the spool deleted every uploaded frame');

    step = '26 GET /me (2 captures)';
    me = await a.me();
    assert.equal(me.captures.count, 2);
    assert.ok(['received', 'stored'].includes(String(me.captures.latest_status)), String(me.captures.latest_status));
    assert.ok(me.captures.last_at);

    step = '27 refresh rotation (session B)';
    const storeB = memoryTokenStore();
    let clockSkewMs = 0;
    const b = createClientApi({
      baseUrl: BASE,
      tokens: storeB,
      fetch: loggingFetch,
      timeoutMs: TIMEOUT_MS,
      now: () => Date.now() + clockSkewMs,
    });
    await b.signInMock(subject);
    const firstRefresh = storeB.current()!.refreshToken;
    clockSkewMs = 2 * 3_600_000; // the access token now looks expired: the next call refreshes first
    await b.me();
    const rotated = storeB.current()!.refreshToken;
    assert.notEqual(rotated, firstRefresh, 'refresh rotated');

    step = '28 reuse of the rotated refresh token';
    const reuse = await rawRefresh(firstRefresh);
    assert.equal(reuse.status, 401);
    assert.equal(reuse.code, 'FT-AUTH-001');
    step = '29 session B after reuse (family revoked)';
    await rejectsWith(b.me(), 'session_expired');
    assert.equal(storeB.current(), null);
    step = '30 session A unaffected';
    await a.me();

    step = '31 logout (session C)';
    const storeC = memoryTokenStore();
    const c = createClientApi({ baseUrl: BASE, tokens: storeC, fetch: loggingFetch, timeoutMs: TIMEOUT_MS });
    await c.signInMock(subject);
    const cRefresh = storeC.current()!.refreshToken;
    await c.logout();
    assert.equal(storeC.current(), null);
    step = '32 refresh after logout';
    assert.equal((await rawRefresh(cRefresh)).status, 401);

    step = '33 POST /me/consent (research off)';
    const off = await a.postConsent({ version: CONSENT_VERSION, store_accepted: true, research_use: false });
    assert.equal(off.research_use, false);
    step = '34 GET /me (research off)';
    me = await a.me();
    assert.equal(me.consent?.research_use, false);

    step = '35 DELETE /me';
    const aRefresh = storeA.current()!.refreshToken;
    const accepted = await a.deleteAccount();
    deleted = true;
    assert.ok(['withdrawing', 'deleted'].includes(accepted.status));
    assert.ok(Date.parse(accepted.deletion_due_by) > Date.now());
    assert.equal(storeA.current(), null);
    step = '36 refresh after deletion';
    const after = await rawRefresh(aRefresh);
    assert.ok(after.status === 401 || after.status === 409, String(after.status));
    t.diagnostic(`deletion status: ${accepted.status}`);
  } finally {
    if (!deleted && storeA.current()) {
      step = 'cleanup DELETE /me';
      await a.deleteAccount().catch(() => undefined);
    }
    for (const line of log) t.diagnostic(line);
  }
});
