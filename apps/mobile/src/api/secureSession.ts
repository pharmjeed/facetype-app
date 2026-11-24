/** Native secure storage adapter: iOS Keychain and Android Keystore. */

import { NativeModules } from 'react-native';

import {
  clearSessionToken as clearWithStore,
  persistSessionToken as persistWithStore,
  recoverSessionToken as recoverWithStore,
  type SecureValueStore,
} from './sessionPersistence.ts';

interface NativeSecureSessionModule {
  loadSession(): Promise<string | null>;
  saveSession(value: string): Promise<void>;
  clearSession(): Promise<void>;
}

function nativeModule(): NativeSecureSessionModule {
  const module = (NativeModules as Record<string, NativeSecureSessionModule | undefined>)
    .FaceTypeSecureSession;
  if (!module) throw new Error('Secure session storage is unavailable');
  return module;
}

const secureStore: SecureValueStore = {
  async get() {
    return nativeModule().loadSession();
  },
  async set(value) {
    await nativeModule().saveSession(value);
  },
  async remove() {
    await nativeModule().clearSession();
  },
};

export function persistSecureSessionToken(
  accessToken: string,
  expiresInSeconds: number,
): Promise<void> {
  return persistWithStore(accessToken, expiresInSeconds, secureStore);
}

export function recoverSecureSessionToken(): Promise<string | null> {
  return recoverWithStore(secureStore);
}

export function clearSecureSessionToken(): Promise<void> {
  return clearWithStore(secureStore);
}
