/**
 * Sign in with Apple via `@invertase/react-native-apple-authentication`.
 *
 * NONCE. The app first asks the server for a one-time nonce (POST
 * /auth/nonce). The library SHA-256-hashes the value it is given before
 * handing it to Apple on both platforms (iOS: RNAppleAuthModule.m; Android:
 * documented in AndroidConfig.nonce), so the raw server nonce goes in, Apple
 * embeds SHA-256(nonce) in the identity token, and the raw nonce is sent back
 * to the server, which checks the hash and consumes the nonce (single use,
 * 10 min).
 *
 * iOS uses the native sheet (bundle id = client id). Android uses the
 * library's web flow with the Services ID and redirect URI from build env; a
 * build without them shows Apple disabled with «غير مُعد بعد».
 *
 * Only the name scope is requested (to prefill «الاسم الكامل»); no email.
 */

import { Platform } from 'react-native';
import { appleAuth, appleAuthAndroid } from '@invertase/react-native-apple-authentication';

import { uuidV4 } from '../api/clientApi.ts';
import type { AuthConfig } from './config.ts';
import type { AuthProvider, ProviderAvailability, SignInContext, SignInOutcome } from './types.ts';

function joinName(parts: Array<string | null | undefined>): string | null {
  const name = parts.filter((part): part is string => typeof part === 'string' && part.trim() !== '').join(' ');
  return name.trim() || null;
}

export function appleProvider(config: AuthConfig['apple']): AuthProvider {
  const android = appleAuthAndroid as Partial<typeof appleAuthAndroid>;

  function availability(): ProviderAvailability {
    if (Platform.OS === 'ios') return appleAuth.isSupported ? 'ready' : 'unsupported';
    if (Platform.OS === 'android') {
      if (!config.androidConfigured) return 'unconfigured';
      return android.isSupported === true ? 'ready' : 'unsupported';
    }
    return 'unsupported';
  }

  async function signInIos(nonce: string): Promise<SignInOutcome> {
    try {
      const response = await appleAuth.performRequest({
        requestedOperation: appleAuth.Operation.LOGIN,
        requestedScopes: [appleAuth.Scope.FULL_NAME],
        nonce,
      });
      if (!response.identityToken) return { kind: 'error', reason: 'failed', detail: 'no_identity_token' };
      return {
        kind: 'credential',
        credential: {
          provider: 'apple',
          identityToken: response.identityToken,
          nonce,
          fullName: joinName([response.fullName?.givenName, response.fullName?.familyName]),
        },
      };
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === appleAuth.Error.CANCELED) return { kind: 'cancelled' };
      return { kind: 'error', reason: 'failed', detail: code ?? undefined };
    }
  }

  async function signInAndroid(nonce: string): Promise<SignInOutcome> {
    if (!android.configure || !android.signIn || !config.serviceId || !config.redirectUri) {
      return { kind: 'error', reason: 'unconfigured' };
    }
    const state = uuidV4();
    try {
      android.configure({
        clientId: config.serviceId,
        redirectUri: config.redirectUri,
        responseType: android.ResponseType?.ALL,
        scope: android.Scope?.NAME,
        nonce,
        state,
      });
      const response = await android.signIn();
      if (response.state !== state) return { kind: 'error', reason: 'failed', detail: 'state_mismatch' };
      if (!response.id_token) return { kind: 'error', reason: 'failed', detail: 'no_identity_token' };
      return {
        kind: 'credential',
        credential: {
          provider: 'apple',
          identityToken: response.id_token,
          nonce,
          fullName: joinName([response.user?.name?.firstName, response.user?.name?.lastName]),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (android.Error && message === android.Error.SIGNIN_CANCELLED) return { kind: 'cancelled' };
      return { kind: 'error', reason: 'failed', detail: message };
    }
  }

  return {
    id: 'apple',
    availability,
    async signIn(context: SignInContext): Promise<SignInOutcome> {
      const state = availability();
      if (state !== 'ready') return { kind: 'error', reason: state };
      const nonce = await context.getNonce();
      return Platform.OS === 'ios' ? signInIos(nonce) : signInAndroid(nonce);
    },
  };
}
