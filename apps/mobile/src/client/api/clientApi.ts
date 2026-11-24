/**
 * Typed fetch client for the client lane (docs/client-app-v1.md §3).
 *
 * THREE BEHAVIOURS THE REST OF THE APP RELIES ON.
 *
 * 1. Refresh is serialised. Refresh tokens rotate inside a family and the
 *    server revokes the whole family when a rotated token is presented again
 *    (ADR-015 §8). Two screens that both got a 401 and both refreshed would
 *    sign the person out. So there is at most one refresh in flight, every
 *    caller awaits the same promise, and a 401 for a request that was sent
 *    with an access token that has *since* been replaced is simply retried
 *    with the new one instead of refreshing again.
 * 2. Capture creation is idempotent: the caller's `client_capture_id` is both
 *    the body field and the `Idempotency-Key` header, so a retry after a lost
 *    response returns the same capture rather than a second one.
 * 3. Errors are mapped to a small closed set of kinds the UI can act on
 *    (`ClientApiError.kind`); the FT error code is kept for display and logs.
 *
 * The capture calls take an optional `AbortSignal` (`CallOptions`): the upload
 * spool aborts its in-flight request when the person signs out, deletes the
 * account or the queued capture is discarded (Codex round 2, A9).
 */

import type {
  AppleSignInBody,
  AttemptTelemetry,
  CaptureCreate,
  CaptureCreated,
  CaptureView,
  ClientMe,
  ConsentInput,
  ConsentView,
  DeletionAccepted,
  FrameCompleteBody,
  FrameUploadTarget,
  GoogleSignInBody,
  MockSignInBody,
  NonceResponse,
  ProblemBody,
  ProfileInput,
  ProfileView,
  RefreshBody,
  TokenPair,
} from './types.ts';
import { tokensFromPair, type StoredTokens, type TokenStore } from './tokens.ts';

// eslint-disable-next-line no-restricted-syntax -- the client routes are hand-called (docs/client-app-v1.md §3); tests/contract/test_client_mobile_api_contract.py checks every path and shape here against services/api/openapi.json.
export const CLIENT_API_PREFIX = '/api/v1/client';

/** Refresh this long before the access token's stated expiry. */
export const REFRESH_SKEW_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 30_000;

export type ClientErrorKind =
  | 'network'
  | 'session_expired'
  | 'unauthorized'
  | 'provider_unconfigured'
  | 'nonce_invalid'
  | 'identifier_taken'
  | 'validation'
  | 'consent_required'
  | 'profile_required'
  | 'account_withdrawing'
  | 'not_found'
  | 'capture_conflict'
  | 'capture_state'
  | 'frame_immutable'
  | 'upload_missing'
  | 'upload_mismatch'
  | 'rate_limited'
  | 'server'
  | 'unknown';

/** Every FT code a client route can return (contract-tested against the server registry). */
export const CODE_KINDS: Record<string, ClientErrorKind> = {
  'FT-CLIENT-AUTH-UNCONFIGURED': 'provider_unconfigured',
  'FT-CLIENT-NONCE-INVALID': 'nonce_invalid',
  'FT-CLIENT-ACCOUNT-WITHDRAWING': 'account_withdrawing',
  'FT-CLIENT-PROFILE-INVALID': 'validation',
  'FT-CLIENT-ID-TAKEN': 'identifier_taken',
  'FT-CLIENT-PROFILE-REQUIRED': 'profile_required',
  'FT-CLIENT-CAPTURE-NOT-FOUND': 'not_found',
  'FT-CLIENT-CAPTURE-CONFLICT': 'capture_conflict',
  'FT-CLIENT-CAPTURE-STATE': 'capture_state',
  'FT-CLIENT-FRAME-IMMUTABLE': 'frame_immutable',
  'FT-CLIENT-UPLOAD-MISSING': 'upload_missing',
  'FT-CLIENT-UPLOAD-MISMATCH': 'upload_mismatch',
  'FT-PRIV-003': 'consent_required',
  'FT-AUTH-001': 'unauthorized',
  // Only the mock route answers 403 on this lane: mock sign-in disabled on the server.
  'FT-AUTH-002': 'provider_unconfigured',
  'FT-AUTH-003': 'unauthorized',
  'FT-SYS-001': 'rate_limited',
  'FT-SYS-002': 'server',
};

export class ClientApiError extends Error {
  readonly kind: ClientErrorKind;
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly fieldErrors: Record<string, string>;

  constructor(init: {
    kind: ClientErrorKind;
    status: number;
    code?: string | null;
    retryable?: boolean;
    retryAfterSeconds?: number | null;
    fieldErrors?: Record<string, string>;
    message?: string;
  }) {
    super(init.message ?? `${init.code ?? init.kind} (${init.status})`);
    this.name = 'ClientApiError';
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code ?? null;
    this.retryable = init.retryable ?? false;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.fieldErrors = init.fieldErrors ?? {};
  }
}

export function isClientApiError(error: unknown, kind?: ClientErrorKind): error is ClientApiError {
  return error instanceof ClientApiError && (kind === undefined || error.kind === kind);
}

/** Map an HTTP failure to a kind. `context` disambiguates a bare 409/503. */
export function mapProblem(
  status: number,
  body: ProblemBody | null,
  context: 'auth' | 'profile' | 'capture' | 'other' = 'other',
): ClientApiError {
  const code = typeof body?.error_code === 'string' ? body.error_code : null;
  let kind: ClientErrorKind | undefined = code ? CODE_KINDS[code] : undefined;
  if (!kind) {
    if (status === 401) kind = 'unauthorized';
    else if (status === 409 && context === 'profile') kind = 'identifier_taken';
    else if (status === 503 && context === 'auth') kind = 'provider_unconfigured';
    else if (status === 400 || status === 422) kind = 'validation';
    else if (status === 404) kind = 'not_found';
    else if (status === 429) kind = 'rate_limited';
    else if (status >= 500) kind = 'server';
    else kind = 'unknown';
  }
  // Field -> reason. Request-contract failures (422 FT-SYS-003) list `errors[]`
  // with a `body.` prefix; FT-CLIENT-PROFILE-INVALID puts `{field: reason}`
  // in `action.fields`. Either way the UI shows its own Arabic sentence per field.
  const fieldErrors: Record<string, string> = {};
  for (const item of body?.errors ?? []) {
    if (item && typeof item.field === 'string') fieldErrors[item.field.replace(/^body\./, '')] = item.message;
  }
  const actionFields = body?.action?.fields;
  if (actionFields && typeof actionFields === 'object') {
    for (const [field, reason] of Object.entries(actionFields)) {
      if (typeof reason === 'string') fieldErrors[field] = reason;
    }
  }
  // The server marks its generic FT-SYS-003 retryable, but a request the
  // contract refused (422) is refused again: never retry a validation error.
  // Bytes that are not a valid JPEG, or whose size differs from the manifest,
  // fail the same way on every re-upload: the server's `retryable` does not apply.
  const finalUploadReason =
    kind === 'upload_mismatch' &&
    (body?.action?.reason === 'jpeg_invalid' || body?.action?.reason === 'dimensions_mismatch');
  const retryable =
    kind === 'validation' || finalUploadReason
      ? false
      : typeof body?.retryable === 'boolean'
        ? body.retryable
        : status >= 500 || status === 429 || kind === 'upload_missing' || kind === 'upload_mismatch';
  return new ClientApiError({
    kind,
    status,
    code,
    retryable,
    retryAfterSeconds: typeof body?.retry_after_seconds === 'number' ? body.retry_after_seconds : null,
    fieldErrors,
    message: body?.detail ?? undefined,
  });
}

export interface ClientApiOptions {
  baseUrl: string;
  tokens: TokenStore;
  fetch?: typeof fetch;
  now?: () => number;
  /** Called once when the server refuses the refresh token (signed out). */
  onSessionEnded?: () => void;
  timeoutMs?: number;
}

/** Per-call options of the capture routes. */
export interface CallOptions {
  /** Aborts the HTTP request (the shared token refresh is never aborted). */
  signal?: AbortSignal;
}

export interface ClientApi {
  /** Load tokens from secure storage; true if a session exists. */
  restore(): Promise<boolean>;
  hasSession(): boolean;
  nonce(): Promise<NonceResponse>;
  signInGoogle(idToken: string): Promise<void>;
  signInApple(body: AppleSignInBody): Promise<void>;
  signInMock(subject: string): Promise<void>;
  logout(): Promise<void>;
  me(): Promise<ClientMe>;
  putProfile(input: ProfileInput): Promise<ProfileView>;
  postConsent(input: ConsentInput): Promise<ConsentView>;
  deleteAccount(): Promise<DeletionAccepted>;
  createCapture(body: CaptureCreate, options?: CallOptions): Promise<CaptureCreated>;
  renewFrameUpload(captureId: string, index: number, options?: CallOptions): Promise<FrameUploadTarget>;
  completeFrame(captureId: string, index: number, meta: Record<string, unknown>, options?: CallOptions): Promise<void>;
  finalizeCapture(captureId: string, options?: CallOptions): Promise<CaptureView>;
  getCapture(captureId: string, options?: CallOptions): Promise<CaptureView>;
  listCaptures(): Promise<CaptureView[]>;
  postAttempt(telemetry: AttemptTelemetry, options?: CallOptions): Promise<void>;
}

interface RequestInit2 {
  body?: unknown;
  auth?: boolean;
  idempotencyKey?: string;
  context?: 'auth' | 'profile' | 'capture' | 'other';
  signal?: AbortSignal;
}

/** The error an aborted call rejects with: a network-kind failure, retried by nobody. */
function abortedError(): ClientApiError {
  return new ClientApiError({ kind: 'network', status: 0, retryable: false, message: 'aborted' });
}

export function createClientApi(options: ClientApiOptions): ClientApi {
  const base = options.baseUrl.replace(/\/+$/, '') + CLIENT_API_PREFIX;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  // undefined = not yet loaded from the store; null = signed out.
  let cached: StoredTokens | null | undefined;
  let refreshing: Promise<StoredTokens> | null = null;
  let ended = false;

  async function currentTokens(): Promise<StoredTokens | null> {
    if (cached === undefined) cached = await options.tokens.load();
    return cached;
  }

  async function adopt(pair: TokenPair): Promise<void> {
    const tokens = tokensFromPair(pair, now());
    // Persist before anyone can use it: a rotated refresh token that only
    // lived in memory is lost on the next process death.
    await options.tokens.save(tokens);
    cached = tokens;
    ended = false;
  }

  async function endSession(): Promise<void> {
    cached = null;
    refreshing = null;
    try {
      await options.tokens.clear();
    } finally {
      if (!ended) {
        ended = true;
        options.onSessionEnded?.();
      }
    }
  }

  async function send(
    method: string,
    path: string,
    init: RequestInit2,
    accessToken: string | null,
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
    if (init.signal?.aborted) throw abortedError();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    // The caller's signal aborts this request too (timeout and caller share one controller).
    const onAbort = () => controller?.abort();
    init.signal?.addEventListener('abort', onAbort);
    try {
      return await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller?.signal,
      });
    } catch (error) {
      if (init.signal?.aborted) throw abortedError();
      throw new ClientApiError({
        kind: 'network',
        status: 0,
        retryable: true,
        message: error instanceof Error ? error.message : 'network error',
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
      init.signal?.removeEventListener('abort', onAbort);
    }
  }

  async function failure(response: Response, context: RequestInit2['context']): Promise<ClientApiError> {
    let body: ProblemBody | null = null;
    try {
      const text = await response.text();
      body = text ? (JSON.parse(text) as ProblemBody) : null;
    } catch {
      body = null;
    }
    return mapProblem(response.status, body, context ?? 'other');
  }

  async function parse<T>(response: Response): Promise<T> {
    if (response.status === 204 || response.status === 202) {
      const text = await response.text().catch(() => '');
      return (text ? JSON.parse(text) : undefined) as T;
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  function refresh(): Promise<StoredTokens> {
    if (!refreshing) {
      refreshing = (async () => {
        const current = await currentTokens();
        if (!current) throw new ClientApiError({ kind: 'session_expired', status: 401 });
        const body: RefreshBody = { refresh_token: current.refreshToken };
        const response = await send('POST', '/auth/refresh', { body }, null);
        if (!response.ok) {
          const error = await failure(response, 'auth');
          if (
            response.status === 400 ||
            response.status === 401 ||
            response.status === 403 ||
            error.kind === 'account_withdrawing'
          ) {
            await endSession();
            throw new ClientApiError({ kind: 'session_expired', status: response.status, code: error.code });
          }
          throw error;
        }
        await adopt(await parse<TokenPair>(response));
        return cached as StoredTokens;
      })().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  async function freshAccessToken(): Promise<string> {
    if (refreshing) return (await refreshing).accessToken;
    const current = await currentTokens();
    if (!current) throw new ClientApiError({ kind: 'session_expired', status: 401 });
    if (current.accessExpiresAtMs - now() <= REFRESH_SKEW_MS) return (await refresh()).accessToken;
    return current.accessToken;
  }

  async function request<T>(method: string, path: string, init: RequestInit2 = {}): Promise<T> {
    const auth = init.auth ?? true;
    let used = auth ? await freshAccessToken() : null;
    if (init.signal?.aborted) throw abortedError();
    let response = await send(method, path, init, used);
    if (auth && response.status === 401) {
      const current = await currentTokens();
      if (current && current.accessToken !== used) {
        used = current.accessToken; // someone else already refreshed
      } else {
        used = (await refresh()).accessToken;
      }
      response = await send(method, path, init, used);
      if (response.status === 401) {
        await endSession();
        throw new ClientApiError({ kind: 'session_expired', status: 401 });
      }
    }
    if (!response.ok) {
      const error = await failure(response, init.context);
      // Deleted from another device: this session can never be used again.
      if (auth && error.kind === 'account_withdrawing') await endSession();
      throw error;
    }
    return parse<T>(response);
  }

  /**
   * The local development object store answers with an API-relative upload
   * URL (`/api/v1/objects/...`); the native uploader needs an absolute one.
   * Object-store (S3) URLs are absolute and pass through unchanged.
   */
  const apiRoot = options.baseUrl.replace(/\/+$/, '');
  function absoluteTarget(target: FrameUploadTarget): FrameUploadTarget {
    const url = target.upload_url;
    return typeof url === 'string' && url.startsWith('/') ? { ...target, upload_url: `${apiRoot}${url}` } : target;
  }

  async function exchange(path: string, body: unknown): Promise<void> {
    const pair = await request<TokenPair>('POST', path, { body, auth: false, context: 'auth' });
    await adopt(pair);
  }

  const id = (value: string) => encodeURIComponent(value);

  return {
    async restore() {
      return (await currentTokens()) !== null;
    },
    hasSession() {
      return cached !== undefined && cached !== null;
    },
    nonce: () => request<NonceResponse>('POST', '/auth/nonce', { auth: false, context: 'auth' }),
    signInGoogle: (idToken) => exchange('/auth/google', { id_token: idToken } satisfies GoogleSignInBody),
    signInApple: (body) => exchange('/auth/apple', body),
    signInMock: (subject) => exchange('/auth/mock', { subject } satisfies MockSignInBody),
    async logout() {
      try {
        if (await currentTokens()) await request<void>('POST', '/auth/logout');
      } catch {
        // Signing out locally must never depend on the network.
      } finally {
        cached = null;
        refreshing = null;
        await options.tokens.clear();
      }
    },
    me: () => request<ClientMe>('GET', '/me'),
    putProfile: (input) => request<ProfileView>('PUT', '/me/profile', { body: input, context: 'profile' }),
    postConsent: (input) => request<ConsentView>('POST', '/me/consent', { body: input }),
    async deleteAccount() {
      const accepted = await request<DeletionAccepted>('DELETE', '/me');
      cached = null;
      refreshing = null;
      await options.tokens.clear();
      return accepted;
    },
    async createCapture(body, call) {
      const created = await request<CaptureCreated>('POST', '/captures', {
        body,
        idempotencyKey: body.client_capture_id,
        context: 'capture',
        signal: call?.signal,
      });
      return { ...created, frames: (created.frames ?? []).map(absoluteTarget) };
    },
    renewFrameUpload: async (captureId, index, call) =>
      absoluteTarget(
        await request<FrameUploadTarget>('POST', `/captures/${id(captureId)}/frames/${index}/renew`, {
          context: 'capture',
          signal: call?.signal,
        }),
      ),
    completeFrame: (captureId, index, meta, call) =>
      request<void>('POST', `/captures/${id(captureId)}/frames/${index}/complete`, {
        body: { meta } satisfies FrameCompleteBody,
        context: 'capture',
        signal: call?.signal,
      }),
    finalizeCapture: (captureId, call) =>
      request<CaptureView>('POST', `/captures/${id(captureId)}/finalize`, { context: 'capture', signal: call?.signal }),
    getCapture: (captureId, call) =>
      request<CaptureView>('GET', `/captures/${id(captureId)}`, { context: 'capture', signal: call?.signal }),
    listCaptures: () => request<CaptureView[]>('GET', '/captures', { context: 'capture' }),
    postAttempt: (telemetry, call) => request<void>('POST', '/attempts', { body: telemetry, signal: call?.signal }),
  };
}

/** RFC 4122 v4 identifier (idempotency keys, client capture ids — not secrets). */
export function uuidV4(random: (bytes: Uint8Array) => void = fillRandom): string {
  const bytes = new Uint8Array(16);
  random(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fillRandom(bytes: Uint8Array): void {
  const crypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
    return;
  }
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
}
