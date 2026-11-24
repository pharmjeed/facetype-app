/**
 * The client API: serialised refresh (a rotated refresh token is never sent
 * twice), proactive refresh, idempotent capture creation, and error mapping.
 * The fetch is a fake; tokens are made-up strings.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CLIENT_API_PREFIX as P, ClientApiError, createClientApi, mapProblem, uuidV4 } from './clientApi.ts';
import { memoryTokenStore, parseTokens, serialiseTokens, type StoredTokens } from './tokens.ts';

const BASE = 'https://api.example.test';
/** Obviously synthetic provider token (the repo secret scanner's allowed marker). */
const GOOGLE_ID_TOKEN = 'synthetic-nonempty-google-id';
const HOUR = 3_600_000;
// eslint-disable-next-line no-restricted-syntax -- the local object store's upload path as the server returns it, not a route the app calls
const LOCAL_UPLOAD = '/api/v1/objects/client/a/c';

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: Call) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const call: Call = {
      method: init.method,
      path: url.slice(BASE.length),
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const empty = (status: number) => new Response(null, { status });

function tokens(access: string, refresh: string, expiresAtMs = Date.now() + HOUR): StoredTokens {
  return { accessToken: access, refreshToken: refresh, accessExpiresAtMs: expiresAtMs };
}

const ME = {
  account: { id: 'acc-1', provider: 'mock', state: 'active', created_at: '2026-11-23T00:00:00Z' },
  profile: null,
  consent: null,
  captures: { count: 0, last_at: null, latest_status: null, next_repeat_due_at: null },
  personality: { status: 'MODEL_UNAVAILABLE' },
};

test('every route lives under /api/v1/client', async () => {
  const { impl, calls } = fakeFetch(() => json(200, { nonce: 'n', expires_at: '2026-11-23T00:10:00Z' }));
  const api = createClientApi({ baseUrl: `${BASE}/`, tokens: memoryTokenStore(), fetch: impl });
  await api.nonce();
  assert.equal(calls[0]!.path, `${P}/auth/nonce`);
  assert.equal(calls[0]!.headers.Authorization, undefined);
});

test('sign-in stores the token pair; requests then carry the bearer token', async () => {
  const store = memoryTokenStore();
  const { impl, calls } = fakeFetch((call) =>
    call.path.endsWith('/auth/google')
      ? json(200, { access_token: 'A1', refresh_token: 'R1', token_type: 'Bearer', expires_in: 3600 })
      : json(200, ME),
  );
  const api = createClientApi({ baseUrl: BASE, tokens: store, fetch: impl });
  await api.signInGoogle(GOOGLE_ID_TOKEN);
  assert.deepEqual(calls[0]!.body, { id_token: GOOGLE_ID_TOKEN });
  assert.equal(store.current()?.refreshToken, 'R1');
  const me = await api.me();
  assert.equal(me.personality.status, 'MODEL_UNAVAILABLE');
  assert.equal(calls[1]!.headers.Authorization, 'Bearer A1');
});

test('concurrent 401s share ONE refresh, and both requests are retried with the new token', async () => {
  const store = memoryTokenStore(tokens('A1', 'R1'));
  let refreshes = 0;
  let releaseRefresh: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const { impl, calls } = fakeFetch(async (call) => {
    if (call.path.endsWith('/auth/refresh')) {
      refreshes += 1;
      assert.deepEqual(call.body, { refresh_token: 'R1' });
      await gate;
      return json(200, { access_token: 'A2', refresh_token: 'R2', expires_in: 3600 });
    }
    return call.headers.Authorization === 'Bearer A2' ? json(200, ME) : json(401, { error_code: 'FT-AUTH-003' });
  });
  const api = createClientApi({ baseUrl: BASE, tokens: store, fetch: impl });
  const pending = Promise.all([api.me(), api.me(), api.listCaptures().catch(() => null)]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseRefresh();
  await pending;
  assert.equal(refreshes, 1, 'a rotated refresh token must never be presented twice');
  assert.equal(store.current()?.refreshToken, 'R2');
  assert.equal(calls.filter((c) => c.headers.Authorization === 'Bearer A2').length, 3);
});

test('a 401 for a request sent with an already-replaced token retries without refreshing again', async () => {
  const store = memoryTokenStore(tokens('A1', 'R1'));
  let refreshes = 0;
  let firstMeResolve: (r: Response) => void = () => undefined;
  const { impl } = fakeFetch((call) => {
    if (call.path.endsWith('/auth/refresh')) {
      refreshes += 1;
      return json(200, { access_token: 'A2', refresh_token: 'R2', expires_in: 3600 });
    }
    if (call.path.endsWith('/captures') && call.headers.Authorization === 'Bearer A1') {
      // This one is held until after the other request refreshed.
      return new Promise<Response>((resolve) => {
        firstMeResolve = resolve;
      });
    }
    return call.headers.Authorization === 'Bearer A2' ? json(200, call.path.endsWith('/captures') ? [] : ME) : json(401, {});
  });
  const api = createClientApi({ baseUrl: BASE, tokens: store, fetch: impl });
  const slow = api.listCaptures();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await api.me(); // 401 with A1 → refresh → A2
  firstMeResolve(json(401, {}));
  assert.deepEqual(await slow, []);
  assert.equal(refreshes, 1);
});

test('an access token about to expire is refreshed before the request, not after a 401', async () => {
  const store = memoryTokenStore(tokens('A1', 'R1', Date.now() + 5_000));
  const { impl, calls } = fakeFetch((call) =>
    call.path.endsWith('/auth/refresh')
      ? json(200, { access_token: 'A2', refresh_token: 'R2', expires_in: 3600 })
      : json(200, ME),
  );
  const api = createClientApi({ baseUrl: BASE, tokens: store, fetch: impl });
  await api.me();
  assert.deepEqual(
    calls.map((c) => c.path),
    [`${P}/auth/refresh`, `${P}/me`],
  );
  assert.equal(calls[1]!.headers.Authorization, 'Bearer A2');
});

test('a refused refresh ends the session once and clears the stored tokens', async () => {
  const store = memoryTokenStore(tokens('A1', 'R1'));
  let ended = 0;
  const { impl } = fakeFetch((call) =>
    call.path.endsWith('/auth/refresh') ? json(401, { error_code: 'FT-AUTH-001' }) : json(401, {}),
  );
  const api = createClientApi({ baseUrl: BASE, tokens: store, fetch: impl, onSessionEnded: () => (ended += 1) });
  const results = await Promise.allSettled([api.me(), api.me()]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.equal((result as PromiseRejectedResult).reason.kind, 'session_expired');
  }
  assert.equal(ended, 1);
  assert.equal(store.current(), null);
  assert.equal(api.hasSession(), false);
});

test('a network failure during refresh keeps the tokens (offline is not signed out)', async () => {
  const store = memoryTokenStore(tokens('A1', 'R1', Date.now() + 1_000));
  const { impl } = fakeFetch(() => {
    throw new TypeError('Network request failed');
  });
  const api = createClientApi({ baseUrl: BASE, tokens: store, fetch: impl });
  await assert.rejects(api.me(), (error: ClientApiError) => error.kind === 'network' && error.retryable);
  assert.equal(store.current()?.refreshToken, 'R1');
});

test('capture creation is idempotent: client_capture_id is the body field and the Idempotency-Key', async () => {
  const store = memoryTokenStore(tokens('A1', 'R1'));
  const { impl, calls } = fakeFetch(() =>
    json(201, {
      capture_id: 'cap-1',
      status: 'uploading',
      frames: [
        { index: 0, completed: false, upload_url: 'https://upload.test/0', method: 'PUT', headers: {}, expires_at: '2026-11-23T01:00:00Z' },
      ],
    }),
  );
  const api = createClientApi({ baseUrl: BASE, tokens: store, fetch: impl });
  const id = uuidV4();
  const body = {
    client_capture_id: id,
    protocol_version: 'p',
    gate_config_hash: 'h',
    device: {},
    camera: {},
    frames: [{ index: 0, sha256: 'a'.repeat(64), bytes: 10, width: 1, height: 1 }],
    attempt: { attempts: 1 },
  };
  await api.createCapture(body);
  await api.createCapture(body);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.path, `${P}/captures`);
    assert.equal(call.headers['Idempotency-Key'], id);
    assert.equal((call.body as { client_capture_id: string }).client_capture_id, id);
  }
});

test('a caller signal aborts the request in flight; an already-aborted signal sends nothing', async () => {
  const store = memoryTokenStore(tokens('A1', 'R1'));
  let seen: AbortSignal | undefined;
  let sent = 0;
  const impl = ((_url: string, init: { signal?: AbortSignal }) => {
    sent += 1;
    seen = init.signal;
    // A request that only ends when it is aborted.
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
    });
  }) as unknown as typeof fetch;
  const api = createClientApi({ baseUrl: BASE, tokens: store, fetch: impl });
  const controller = new AbortController();
  const pending = api.getCapture('c/1', { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen?.aborted, false);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ClientApiError);
    assert.equal(error.kind, 'network');
    assert.equal(error.retryable, false, 'an abort is not a transient failure');
    assert.equal(error.message, 'aborted');
    return true;
  });
  assert.equal(seen?.aborted, true);
  await assert.rejects(api.finalizeCapture('c/1', { signal: controller.signal }), /aborted/);
  assert.equal(sent, 1, 'nothing is sent once the caller has aborted');
});

test('frame routes: renew, complete {meta}, finalize, status', async () => {
  const store = memoryTokenStore(tokens('A1', 'R1'));
  const { impl, calls } = fakeFetch((call) =>
    call.path.endsWith('/complete') ? empty(204) : json(200, { id: 'c/1', status: 'checking', accepted_frames: 0, reasons: [] }),
  );
  const api = createClientApi({ baseUrl: BASE, tokens: store, fetch: impl });
  await api.renewFrameUpload('c/1', 3);
  await api.completeFrame('c/1', 3, { frame_id: 'f' });
  await api.finalizeCapture('c/1');
  await api.getCapture('c/1');
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [
      `POST ${P}/captures/c%2F1/frames/3/renew`,
      `POST ${P}/captures/c%2F1/frames/3/complete`,
      `POST ${P}/captures/c%2F1/finalize`,
      `GET ${P}/captures/c%2F1`,
    ],
  );
  assert.deepEqual(calls[1]!.body, { meta: { frame_id: 'f' } });
});

test('error mapping covers the FT-CLIENT codes and falls back on status', () => {
  assert.equal(mapProblem(409, { error_code: 'FT-CLIENT-ID-TAKEN' }).kind, 'identifier_taken');
  assert.equal(mapProblem(409, null, 'profile').kind, 'identifier_taken');
  assert.equal(mapProblem(503, { error_code: 'FT-CLIENT-AUTH-UNCONFIGURED' }).kind, 'provider_unconfigured');
  assert.equal(mapProblem(503, null, 'auth').kind, 'provider_unconfigured');
  assert.equal(mapProblem(409, { error_code: 'FT-CLIENT-FRAME-IMMUTABLE' }).kind, 'frame_immutable');
  assert.equal(mapProblem(409, { error_code: 'FT-CLIENT-ACCOUNT-WITHDRAWING' }).kind, 'account_withdrawing');
  assert.equal(mapProblem(403, { error_code: 'FT-PRIV-003' }).kind, 'consent_required');
  assert.equal(mapProblem(401, { error_code: 'FT-CLIENT-NONCE-INVALID' }).kind, 'nonce_invalid');
  const upload = mapProblem(422, { error_code: 'FT-CLIENT-UPLOAD-MISMATCH' });
  assert.equal(upload.kind, 'upload_mismatch');
  assert.equal(upload.retryable, true);
  for (const reason of ['jpeg_invalid', 'dimensions_mismatch']) {
    const final = mapProblem(422, { error_code: 'FT-CLIENT-UPLOAD-MISMATCH', retryable: true, action: { reason } });
    assert.equal(final.kind, 'upload_mismatch');
    assert.equal(final.retryable, false, reason);
  }
  assert.equal(mapProblem(422, { error_code: 'FT-SYS-003', retryable: true }).retryable, false);
  const validation = mapProblem(422, {
    error_code: 'FT-CLIENT-PROFILE-INVALID',
    errors: [{ field: 'body.phone', message: 'bad phone' }],
  });
  assert.equal(validation.kind, 'validation');
  assert.deepEqual(validation.fieldErrors, { phone: 'bad phone' });
  const server = mapProblem(502, null);
  assert.equal(server.kind, 'server');
  assert.equal(server.retryable, true);
  assert.equal(mapProblem(418, null).kind, 'unknown');
});

test('server field reasons (action.fields) become field errors; a refused contract is never retried', () => {
  const profile = mapProblem(422, {
    error_code: 'FT-CLIENT-PROFILE-INVALID',
    retryable: false,
    action: { type: 'CORRECT_INPUT', fields: { phone: 'e164', birth_date: 'under_18' } },
  });
  assert.equal(profile.kind, 'validation');
  assert.deepEqual(profile.fieldErrors, { phone: 'e164', birth_date: 'under_18' });
  // The server's generic FT-SYS-003 says retryable: true even for a 422.
  const contract = mapProblem(422, {
    error_code: 'FT-SYS-003',
    retryable: true,
    errors: [{ field: 'body.attempt', message: 'Input should be a valid dictionary' }],
  });
  assert.equal(contract.kind, 'validation');
  assert.equal(contract.retryable, false);
  assert.equal(mapProblem(403, { error_code: 'FT-AUTH-002' }, 'auth').kind, 'provider_unconfigured');
});

test('API-relative upload URLs (local object store) are made absolute; object-store URLs pass through', async () => {
  const store = memoryTokenStore(tokens('A1', 'R1'));
  const frame = (index: number, url: string | null) => ({
    index,
    completed: url === null,
    upload_url: url,
    method: 'PUT',
    headers: {},
    expires_at: url === null ? null : '2026-11-23T01:00:00Z',
  });
  const { impl } = fakeFetch((call) =>
    call.path.endsWith('/renew')
      ? json(200, frame(1, `${LOCAL_UPLOAD}/01.jpg?expires=1&signature=s`))
      : json(201, {
          capture_id: 'cap-1',
          status: 'uploading',
          frames: [frame(0, `${LOCAL_UPLOAD}/00.jpg?expires=1&signature=s`), frame(1, 'https://s3.test/x'), frame(2, null)],
        }),
  );
  const api = createClientApi({ baseUrl: `${BASE}/`, tokens: store, fetch: impl });
  const created = await api.createCapture({
    client_capture_id: uuidV4(),
    protocol_version: 'p',
    gate_config_hash: 'h',
    device: {},
    camera: {},
    frames: [{ index: 0, sha256: 'a'.repeat(64), bytes: 10, width: 1, height: 1 }],
  });
  assert.deepEqual(
    created.frames.map((f) => f.upload_url),
    [`${BASE}${LOCAL_UPLOAD}/00.jpg?expires=1&signature=s`, 'https://s3.test/x', null],
  );
  assert.equal((await api.renewFrameUpload('cap-1', 1)).upload_url, `${BASE}${LOCAL_UPLOAD}/01.jpg?expires=1&signature=s`);
});

test('an account being deleted ends the local session', async () => {
  const store = memoryTokenStore(tokens('A1', 'R1'));
  let ended = 0;
  const { impl } = fakeFetch(() => json(409, { error_code: 'FT-CLIENT-ACCOUNT-WITHDRAWING' }));
  const api = createClientApi({ baseUrl: BASE, tokens: store, fetch: impl, onSessionEnded: () => (ended += 1) });
  await assert.rejects(api.me(), (error: ClientApiError) => error.kind === 'account_withdrawing');
  assert.equal(store.current(), null);
  assert.equal(ended, 1);
});

test('account deletion returns the 202 body and clears local tokens', async () => {
  const store = memoryTokenStore(tokens('A1', 'R1'));
  const { impl, calls } = fakeFetch(() => json(202, { status: 'deleted', deletion_due_by: '2026-12-23T00:00:00Z' }));
  const api = createClientApi({ baseUrl: BASE, tokens: store, fetch: impl });
  assert.deepEqual(await api.deleteAccount(), { status: 'deleted', deletion_due_by: '2026-12-23T00:00:00Z' });
  assert.equal(calls[0]!.method, 'DELETE');
  assert.equal(calls[0]!.path, `${P}/me`);
  assert.equal(store.current(), null);
});

test('a profile 409 reaches the caller as identifier_taken', async () => {
  const store = memoryTokenStore(tokens('A1', 'R1'));
  const { impl } = fakeFetch(() => json(409, { error_code: 'FT-CLIENT-ID-TAKEN', detail: 'taken' }));
  const api = createClientApi({ baseUrl: BASE, tokens: store, fetch: impl });
  await assert.rejects(
    api.putProfile({
      full_name: 'x',
      id_issuing_country: 'SA',
      id_document_type: 'passport',
      id_number: 'A12345',
      phone: '+966500000000',
      sex: 'male',
      birth_date: '1990-01-01',
      nationality: 'SA',
    }),
    (error: ClientApiError) => error.kind === 'identifier_taken' && error.status === 409,
  );
});

test('logout clears local tokens even when the network call fails', async () => {
  const store = memoryTokenStore(tokens('A1', 'R1'));
  const { impl } = fakeFetch(() => {
    throw new TypeError('offline');
  });
  const api = createClientApi({ baseUrl: BASE, tokens: store, fetch: impl });
  await api.logout();
  assert.equal(store.current(), null);
});

test('token envelopes round-trip and reject anything that is not a client-1 envelope', () => {
  const value = tokens('A', 'R', 123);
  assert.deepEqual(parseTokens(serialiseTokens(value)), value);
  assert.equal(parseTokens('{"version":1,"accessToken":"x","expiresAtMs":1}'), null);
  assert.equal(parseTokens('not json'), null);
  assert.equal(parseTokens(null), null);
});

test('uuidV4 is RFC 4122 version 4', () => {
  assert.match(uuidV4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
