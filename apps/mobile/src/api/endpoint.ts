/**
 * Where the app talks to the backend, and when it is allowed to do so in the
 * clear.
 *
 * The previous shell read `process.env.FACETYPE_API_URL` directly and fell back
 * to `http://localhost:8000`. React Native's `process` shim only carries
 * `NODE_ENV`, so the variable was always `undefined` and every build — debug,
 * release, store — shipped pointing at loopback. On a physical handset that is
 * the handset itself, so the app could never reach a backend at all, and a
 * release build silently pointed at a cleartext URL rather than refusing to
 * start.
 *
 * The value now arrives as a real string literal, inlined at bundle time by
 * `babel/inlineBuildEnv.js`, and this module decides whether it is usable.
 * The LAN address of a development machine is therefore supplied by whoever
 * runs the bundler and never appears in source.
 *
 * Cleartext is a build-time opt-in, not an inference from `__DEV__`: a device
 * preview APK is bundled with `--dev false` (so `__DEV__` is false) while still
 * needing plain HTTP to a laptop. Android enforces the same policy natively —
 * `android:usesCleartextTraffic="false"` in the main manifest, relaxed only by
 * the debug-variant overlay — so this check is defence in depth over an
 * OS-level control, not a substitute for one.
 *
 * Parsing goes through `./url.ts` rather than `new URL(...)`: React Native
 * replaces the global with a stub whose `protocol` and `origin` getters throw.
 */

import { isLoopbackHost, parseHttpUrl } from './url.ts';

/** Emulator/simulator default. Reachable only from the host machine itself. */
export const LOOPBACK_API_URL = 'http://localhost:8000';

export type ApiConfigurationCode = 'API_URL_UNCONFIGURED' | 'API_URL_INSECURE' | 'API_URL_INVALID';

/** The app cannot pick a backend, and must not guess one. */
export class ApiConfigurationError extends Error {
  readonly code: ApiConfigurationCode;

  constructor(code: ApiConfigurationCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'ApiConfigurationError';
    this.code = code;
  }
}

export interface ApiEndpointPolicy {
  /**
   * Build-time opt-in for plain HTTP and for the loopback fallback. True only
   * for a Metro dev bundle or an explicitly-flagged device preview build.
   */
  allowCleartext: boolean;
}

/**
 * Resolve the API origin the client should use, or throw rather than guess.
 *
 * Fail-closed rules, in order:
 *  - nothing configured and cleartext not allowed -> `API_URL_UNCONFIGURED`;
 *  - unparseable, relative, or credential-bearing -> `API_URL_INVALID`;
 *  - `http://` without the cleartext opt-in       -> `API_URL_INSECURE`.
 */
export function resolveApiBaseUrl(
  configured: string | undefined | null,
  policy: ApiEndpointPolicy,
): string {
  const raw = (configured ?? '').trim();

  if (!raw) {
    if (!policy.allowCleartext) {
      throw new ApiConfigurationError(
        'API_URL_UNCONFIGURED',
        'no FACETYPE_API_URL was inlined into this bundle',
      );
    }
    return LOOPBACK_API_URL;
  }

  const parsed = parseHttpUrl(raw);
  if (!parsed) {
    throw new ApiConfigurationError('API_URL_INVALID', `${raw} is not an absolute http(s) URL`);
  }
  if (parsed.userinfo !== null) {
    // Credentials in a base URL leak into every log line and every retry.
    throw new ApiConfigurationError('API_URL_INVALID', 'the base URL must not carry credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new ApiConfigurationError(
      'API_URL_INVALID',
      'the base URL must not carry a query or fragment',
    );
  }
  if (parsed.protocol === 'http:' && !policy.allowCleartext) {
    throw new ApiConfigurationError(
      'API_URL_INSECURE',
      `${parsed.origin} is cleartext and this build does not permit cleartext traffic`,
    );
  }
  // A configured loopback alias (not just the exact string `localhost` this
  // module falls back to itself, but `127.1`, `::1`, `localhost.`, and every
  // other spelling `isLoopbackHost` recognises) is unreachable on a real
  // handset for the same reason the build script refuses one: it resolves
  // back to the device itself. `policy.allowCleartext` doubles as "this is a
  // dev/emulator build", which is the one context where that is intentional.
  if (!policy.allowCleartext && isLoopbackHost(parsed.hostname)) {
    throw new ApiConfigurationError(
      'API_URL_INVALID',
      `${parsed.origin} is a loopback address and unreachable from a physical device`,
    );
  }

  // `resolveUploadUrl` re-adds the separator, and a doubled slash breaks
  // signature verification on some object stores.
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

/**
 * The policy for the bundle currently running.
 *
 * `FACETYPE_ALLOW_CLEARTEXT` is inlined the same way as the URL. `__DEV__` is
 * kept as a second trigger so an ordinary Metro session keeps working with no
 * environment set up at all.
 */
export function buildPolicy(
  flag: string | undefined | null,
  dev: boolean = typeof __DEV__ === 'boolean' && __DEV__,
): ApiEndpointPolicy {
  return { allowCleartext: dev || flag === '1' || flag === 'true' };
}
