/**
 * Client session tokens at rest.
 *
 * The access token (ES256 JWT, 3600 s) and the rotating refresh token
 * (30 days, reuse revokes the family — ADR-015 §8) are kept together in one
 * envelope in platform secure storage (Keychain / Keystore, via the existing
 * `FaceTypeSecureSession` module). Nothing token-shaped is ever written to
 * AsyncStorage. The envelope is versioned `client-1` so a value written by the
 * anonymous scan lane is never misread as a client session.
 */

import type { SecureValueStore } from '../../api/sessionPersistence.ts';
import type { TokenPair } from './types.ts';

export interface StoredTokens {
  accessToken: string;
  accessExpiresAtMs: number;
  refreshToken: string;
}

export interface TokenStore {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

export function tokensFromPair(pair: TokenPair, nowMs: number): StoredTokens {
  if (
    typeof pair?.access_token !== 'string' ||
    pair.access_token.length === 0 ||
    typeof pair.refresh_token !== 'string' ||
    pair.refresh_token.length === 0 ||
    typeof pair.expires_in !== 'number' ||
    !Number.isFinite(pair.expires_in) ||
    pair.expires_in <= 0
  ) {
    throw new Error('malformed token pair');
  }
  return {
    accessToken: pair.access_token,
    accessExpiresAtMs: nowMs + pair.expires_in * 1000,
    refreshToken: pair.refresh_token,
  };
}

interface Envelope extends StoredTokens {
  version: 'client-1';
}

export function serialiseTokens(tokens: StoredTokens): string {
  const envelope: Envelope = { version: 'client-1', ...tokens };
  return JSON.stringify(envelope);
}

export function parseTokens(raw: string | null): StoredTokens | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Envelope>;
    if (
      value?.version === 'client-1' &&
      typeof value.accessToken === 'string' &&
      value.accessToken.length > 0 &&
      typeof value.refreshToken === 'string' &&
      value.refreshToken.length > 0 &&
      typeof value.accessExpiresAtMs === 'number' &&
      Number.isFinite(value.accessExpiresAtMs)
    ) {
      return {
        accessToken: value.accessToken,
        accessExpiresAtMs: value.accessExpiresAtMs,
        refreshToken: value.refreshToken,
      };
    }
  } catch {
    // Fall through: an unreadable credential is treated as no session.
  }
  return null;
}

/**
 * Secure-store-backed token store. A value that is not a client envelope is
 * erased on load (fail closed), so a corrupt record cannot wedge every launch.
 */
export function secureTokenStore(store: SecureValueStore): TokenStore {
  return {
    async load() {
      const raw = await store.get();
      const tokens = parseTokens(raw);
      if (raw && !tokens) await store.remove();
      return tokens;
    },
    async save(tokens) {
      await store.set(serialiseTokens(tokens));
    },
    async clear() {
      await store.remove();
    },
  };
}

/** For tests and for builds without the secure-storage module (dev only). */
export function memoryTokenStore(initial: StoredTokens | null = null): TokenStore & {
  current(): StoredTokens | null;
} {
  let value = initial;
  return {
    async load() {
      return value;
    },
    async save(tokens) {
      value = tokens;
    },
    async clear() {
      value = null;
    },
    current() {
      return value;
    },
  };
}
