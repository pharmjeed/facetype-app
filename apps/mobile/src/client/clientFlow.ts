/**
 * The client app's navigation as a pure reducer (docs/client-app-v1.md §1).
 *
 *   boot ─▶ signedOut ─▶ profileSetup ─▶ profile ⇄ capture
 *                ▲
 *                └──── session expired
 *
 * Four screens and nothing else: no photo review, no result page. Since the
 * owner decision of 2026-11-24 the profile has no «تعديل البيانات», no
 * sign-out and no account deletion, so the only way back to the sign-in
 * screen is an ended session.
 */

import type { ClientMe } from './api/types.ts';
import type { ProviderId } from './auth/types.ts';

export type ClientScreen = 'boot' | 'signedOut' | 'profileSetup' | 'profile' | 'capture';

export type SignInError =
  | 'cancelled'
  | 'network'
  | 'server_unconfigured'
  | 'unconfigured'
  | 'unsupported'
  | 'nonce_invalid'
  | 'account_withdrawing'
  | 'failed';

export type SignedOutNotice = 'session_expired' | null;

export interface ClientState {
  screen: ClientScreen;
  me: ClientMe | null;
  signInBusy: ProviderId | null;
  signInError: SignInError | null;
  notice: SignedOutNotice;
  /** A build that cannot reach any backend (API_URL_*): shown, never guessed around. */
  configError: string | null;
}

export type ClientEvent =
  | { type: 'CONFIG_ERROR'; code: string }
  | { type: 'BOOT_NO_SESSION' }
  | { type: 'SIGN_IN_STARTED'; provider: ProviderId }
  | { type: 'SIGN_IN_FAILED'; error: SignInError }
  | { type: 'SESSION_READY'; me: ClientMe }
  | { type: 'ME_REFRESHED'; me: ClientMe }
  | { type: 'PROFILE_SAVED'; me: ClientMe }
  | { type: 'OPEN_CAPTURE' }
  | { type: 'CLOSE_CAPTURE' }
  | { type: 'SIGNED_OUT'; reason: 'session_expired' };

export const initialClientState: ClientState = {
  screen: 'boot',
  me: null,
  signInBusy: null,
  signInError: null,
  notice: null,
  configError: null,
};

/** A capture needs a profile and a recorded notice consent (POST /captures refuses otherwise). */
export function needsSetup(me: ClientMe | null): boolean {
  return !me || me.profile === null || !me.consent || me.consent.store_accepted !== true;
}

function signedIn(state: ClientState, me: ClientMe): ClientState {
  const setup = needsSetup(me);
  return {
    ...state,
    me,
    screen: setup ? 'profileSetup' : 'profile',
    signInBusy: null,
    signInError: null,
    notice: null,
  };
}

export function reduceClient(state: ClientState, event: ClientEvent): ClientState {
  switch (event.type) {
    case 'CONFIG_ERROR':
      return { ...state, configError: event.code, screen: 'signedOut' };
    case 'BOOT_NO_SESSION':
      return state.screen === 'boot' ? { ...state, screen: 'signedOut', me: null } : state;
    case 'SIGN_IN_STARTED':
      if (state.screen !== 'signedOut' || state.signInBusy !== null || state.configError) return state;
      return { ...state, signInBusy: event.provider, signInError: null, notice: null };
    case 'SIGN_IN_FAILED':
      return state.screen === 'signedOut' ? { ...state, signInBusy: null, signInError: event.error } : state;
    case 'SESSION_READY':
      return state.screen === 'boot' || state.screen === 'signedOut' ? signedIn(state, event.me) : state;
    case 'ME_REFRESHED': {
      if (state.screen === 'boot' || state.screen === 'signedOut') return state;
      // Lost the consent record or profile: back to setup.
      if (state.screen === 'profile' && needsSetup(event.me)) {
        return { ...state, me: event.me, screen: 'profileSetup' };
      }
      return { ...state, me: event.me };
    }
    case 'PROFILE_SAVED':
      if (state.screen !== 'profileSetup') return state;
      return needsSetup(event.me)
        ? { ...state, me: event.me }
        : { ...state, me: event.me, screen: 'profile' };
    case 'OPEN_CAPTURE':
      return state.screen === 'profile' && !needsSetup(state.me) ? { ...state, screen: 'capture' } : state;
    case 'CLOSE_CAPTURE':
      return state.screen === 'capture' ? { ...state, screen: 'profile' } : state;
    case 'SIGNED_OUT':
      return {
        ...initialClientState,
        configError: state.configError,
        screen: 'signedOut',
        notice: event.reason,
      };
  }
}
