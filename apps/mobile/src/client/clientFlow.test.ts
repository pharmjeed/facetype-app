/** Navigation reducer: boot → signedOut → profileSetup → profile ⇄ capture. */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ClientMe } from './api/types.ts';
import { initialClientState, needsSetup, reduceClient, type ClientEvent, type ClientState } from './clientFlow.ts';

const BARE: ClientMe = {
  account: { id: 'acc-1', provider: 'mock', state: 'active', created_at: '2026-11-23T00:00:00Z' },
  profile: null,
  consent: null,
  captures: { count: 0, last_at: null, latest_status: null, next_repeat_due_at: null },
  personality: { status: 'MODEL_UNAVAILABLE' },
};

const READY: ClientMe = {
  ...BARE,
  profile: {
    revision_id: 'rev-1',
    revision: 1,
    full_name: 'سارة محمد',
    id_issuing_country: 'SA',
    id_document_type: 'national_id',
    id_number: '1000000008',
    phone: '+966501234567',
    sex: 'female',
    birth_date: '1996-01-15',
    nationality: 'SA',
    age_years: 30,
    identity_verification: 'self_declared',
    updated_at: '2026-11-23T00:00:00Z',
  },
  consent: {
    id: 'c-1',
    version: 'client-notice-v1',
    store_accepted: true,
    research_use: true,
    created_at: '2026-11-23T00:00:00Z',
  },
};

function run(events: ClientEvent[], from: ClientState = initialClientState): ClientState {
  return events.reduce(reduceClient, from);
}

test('needs setup until there is a profile AND the required consent', () => {
  assert.equal(needsSetup(null), true);
  assert.equal(needsSetup(BARE), true);
  assert.equal(needsSetup({ ...READY, consent: null }), true);
  assert.equal(needsSetup({ ...READY, consent: { ...READY.consent!, store_accepted: false } }), true);
  assert.equal(needsSetup({ ...READY, profile: null }), true);
  assert.equal(needsSetup(READY), false);
});

test('boot without a session lands on sign-in', () => {
  assert.equal(run([{ type: 'BOOT_NO_SESSION' }]).screen, 'signedOut');
});

test('a first sign-in goes to profile setup; a complete account goes home', () => {
  assert.equal(run([{ type: 'BOOT_NO_SESSION' }, { type: 'SESSION_READY', me: BARE }]).screen, 'profileSetup');
  assert.equal(run([{ type: 'SESSION_READY', me: READY }]).screen, 'profile');
});

test('sign-in busy/error states, and one provider at a time', () => {
  let state = run([{ type: 'BOOT_NO_SESSION' }, { type: 'SIGN_IN_STARTED', provider: 'apple' }]);
  assert.equal(state.signInBusy, 'apple');
  state = reduceClient(state, { type: 'SIGN_IN_STARTED', provider: 'google' });
  assert.equal(state.signInBusy, 'apple', 'a second provider cannot start mid-flight');
  state = reduceClient(state, { type: 'SIGN_IN_FAILED', error: 'cancelled' });
  assert.equal(state.signInBusy, null);
  assert.equal(state.signInError, 'cancelled');
  state = reduceClient(state, { type: 'SIGN_IN_STARTED', provider: 'google' });
  assert.equal(state.signInError, null);
});

test('saving the profile without consent stays on setup; with it, goes home', () => {
  const setup = run([{ type: 'SESSION_READY', me: BARE }]);
  assert.equal(reduceClient(setup, { type: 'PROFILE_SAVED', me: { ...READY, consent: null } }).screen, 'profileSetup');
  assert.equal(reduceClient(setup, { type: 'PROFILE_SAVED', me: READY }).screen, 'profile');
});

test('profile ⇄ capture, and capture only with a complete account', () => {
  const home = run([{ type: 'SESSION_READY', me: READY }]);
  const capture = reduceClient(home, { type: 'OPEN_CAPTURE' });
  assert.equal(capture.screen, 'capture');
  assert.equal(reduceClient(capture, { type: 'CLOSE_CAPTURE' }).screen, 'profile');
  const incomplete = { ...home, me: BARE };
  assert.equal(reduceClient(incomplete, { type: 'OPEN_CAPTURE' }).screen, 'profile');
});

test('a refreshed /me that lost the required consent sends the profile back to setup', () => {
  const home = run([{ type: 'SESSION_READY', me: READY }]);
  const next = reduceClient(home, { type: 'ME_REFRESHED', me: { ...READY, consent: null } });
  assert.equal(next.screen, 'profileSetup');
  // But a refresh never yanks someone out of the camera.
  const capture = reduceClient(home, { type: 'OPEN_CAPTURE' });
  assert.equal(reduceClient(capture, { type: 'ME_REFRESHED', me: { ...READY, consent: null } }).screen, 'capture');
});

test('an ended session returns to sign-in and forgets /me', () => {
  const home = run([{ type: 'SESSION_READY', me: READY }]);
  const out = reduceClient(home, { type: 'SIGNED_OUT', reason: 'session_expired' });
  assert.equal(out.screen, 'signedOut');
  assert.equal(out.me, null);
  assert.equal(out.notice, 'session_expired');
});

test('a config error is shown on sign-in and blocks every provider', () => {
  const state = run([{ type: 'CONFIG_ERROR', code: 'API_URL_UNCONFIGURED' }]);
  assert.equal(state.screen, 'signedOut');
  assert.equal(state.configError, 'API_URL_UNCONFIGURED');
  assert.equal(reduceClient(state, { type: 'SIGN_IN_STARTED', provider: 'google' }).signInBusy, null);
});

test('there are exactly four screens after boot', () => {
  const screens = new Set<string>();
  let state = run([{ type: 'BOOT_NO_SESSION' }]);
  screens.add(state.screen);
  for (const event of [
    { type: 'SESSION_READY', me: BARE },
    { type: 'PROFILE_SAVED', me: READY },
    { type: 'OPEN_CAPTURE' },
    { type: 'CLOSE_CAPTURE' },
  ] as ClientEvent[]) {
    state = reduceClient(state, event);
    screens.add(state.screen);
  }
  assert.deepEqual([...screens].sort(), ['capture', 'profile', 'profileSetup', 'signedOut']);
});
