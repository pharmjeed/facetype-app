/** Testable session-envelope logic; the native adapter owns Keychain/Keystore IO. */

export interface SecureValueStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  remove(): Promise<void>;
}

interface PersistedSession {
  version: 1;
  accessToken: string;
  expiresAtMs: number;
}

/** Save only the bearer token and its expiry, never scan geometry or user data. */
export async function persistSessionToken(
  accessToken: string,
  expiresInSeconds: number,
  store: SecureValueStore,
  nowMs: number = Date.now(),
): Promise<void> {
  if (!accessToken || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new Error('Cannot persist an invalid session');
  }
  const session: PersistedSession = {
    version: 1,
    accessToken,
    expiresAtMs: nowMs + expiresInSeconds * 1_000,
  };
  await store.set(JSON.stringify(session));
}

/** Restore a valid token or erase an expired/corrupt credential fail-closed. */
export async function recoverSessionToken(
  store: SecureValueStore,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const raw = await store.get();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      typeof parsed.accessToken === 'string' &&
      parsed.accessToken.length > 0 &&
      typeof parsed.expiresAtMs === 'number' &&
      Number.isFinite(parsed.expiresAtMs) &&
      parsed.expiresAtMs > nowMs
    ) {
      return parsed.accessToken;
    }
  } catch {
    // Removal below prevents retrying a malformed credential every launch.
  }
  await store.remove();
  return null;
}

export async function clearSessionToken(store: SecureValueStore): Promise<void> {
  await store.remove();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
