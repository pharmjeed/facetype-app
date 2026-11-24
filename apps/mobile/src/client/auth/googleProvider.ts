/**
 * Google sign-in via `@react-native-google-signin/google-signin` (13.x,
 * old-architecture compatible). Only the OIDC ID token leaves this module; the
 * server verifies it against Google's JWKS and `CLIENT_GOOGLE_CLIENT_IDS`.
 *
 * Scopes stay at the library default (openid profile email are implied by the
 * ID token); no offline access, no server auth code, no Drive or contacts.
 */

import { Platform } from 'react-native';
import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';

import type { AuthConfig } from './config.ts';
import type { AuthProvider, ProviderAvailability, SignInOutcome } from './types.ts';

export function googleProvider(config: AuthConfig['google']): AuthProvider {
  let configured = false;

  function ensureConfigured(): void {
    if (configured) return;
    GoogleSignin.configure({
      webClientId: config.webClientId ?? undefined,
      iosClientId: Platform.OS === 'ios' ? (config.iosClientId ?? undefined) : undefined,
      offlineAccess: false,
    });
    configured = true;
  }

  return {
    id: 'google',
    availability(): ProviderAvailability {
      return config.configured ? 'ready' : 'unconfigured';
    },
    async signIn(): Promise<SignInOutcome> {
      if (!config.configured) return { kind: 'error', reason: 'unconfigured' };
      try {
        ensureConfigured();
        if (Platform.OS === 'android') {
          await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
        }
        const response = await GoogleSignin.signIn();
        if (!isSuccessResponse(response)) return { kind: 'cancelled' };
        const idToken = response.data.idToken;
        if (!idToken) return { kind: 'error', reason: 'failed', detail: 'no_id_token' };
        return { kind: 'credential', credential: { provider: 'google', idToken } };
      } catch (error) {
        if (isErrorWithCode(error)) {
          if (error.code === statusCodes.SIGN_IN_CANCELLED) return { kind: 'cancelled' };
          if (error.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
            return { kind: 'error', reason: 'unsupported', detail: error.code };
          }
          return { kind: 'error', reason: 'failed', detail: String(error.code) };
        }
        return { kind: 'error', reason: 'failed' };
      }
    },
    async signOut() {
      if (!configured) return;
      try {
        await GoogleSignin.signOut();
      } catch {
        // Best effort: the FaceType session is already gone.
      }
    },
  };
}
