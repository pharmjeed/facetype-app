/**
 * The consent gate, tested where it is decided rather than through a renderer.
 *
 * What is asserted is the part that has a consequence: no press acts without a
 * server-allocated reference, no press acts while busy, and a photograph is granted
 * only by the separate opt-in on a deployment that keeps photographs at all.
 *
 * The button's wording is asserted here too, in both languages, because the
 * press *is* the research grant now: a label that stopped saying "I agree"
 * would turn the only affirmative act on the screen back into a neutral
 * "next".
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  consentActionsEnabled,
  photoOptInForParticipant,
  resolvePhotoOptIn,
  resolveStartAction,
  type ConsentActionState,
} from './consentAction.ts';
import { fieldStrings, ft } from './strings.ts';

const ready: ConsentActionState = {
  participantRef: 'P-000123',
  busy: false,
  photosOfferable: true,
  photoOptIn: false,
};

test('nothing is actionable before the server has allocated a reference', () => {
  assert.equal(consentActionsEnabled({ ...ready, participantRef: null }), false);
  assert.deepEqual(resolveStartAction({ ...ready, participantRef: null }), {
    start: false,
    reason: 'NO_PARTICIPANT_REF',
  });
});

test('a press while a consent is in flight is dropped, not queued', () => {
  assert.equal(consentActionsEnabled({ ...ready, busy: true }), false);
  assert.deepEqual(resolveStartAction({ ...ready, busy: true }), { start: false, reason: 'BUSY' });
});

test('the affirmative press starts capture without granting photographs', () => {
  assert.equal(consentActionsEnabled(ready), true);
  assert.deepEqual(resolveStartAction(ready), { start: true, photoGranted: false });
});

test('a photograph is granted only by the separate opt-in', () => {
  assert.deepEqual(resolveStartAction({ ...ready, photoOptIn: true }), {
    start: true,
    photoGranted: true,
  });
});

test('a deployment that keeps no photograph cannot grant one', () => {
  assert.deepEqual(resolveStartAction({ ...ready, photosOfferable: false, photoOptIn: true }), {
    start: true,
    photoGranted: false,
  });
  assert.equal(resolvePhotoOptIn({ ...ready, photosOfferable: false }, true), false);
});

test('the photograph opt-in cannot be changed while a consent is in flight', () => {
  assert.equal(resolvePhotoOptIn({ ...ready, busy: true, photoOptIn: false }, true), false);
  assert.equal(resolvePhotoOptIn({ ...ready, busy: true, photoOptIn: true }, false), true);
});

test('the affirmative action is affirmative in both languages', () => {
  assert.equal(ft('en', 'field.consent.agree_start'), 'I agree and start capture');
  assert.equal(ft('ar', 'field.consent.agree_start'), 'أوافق وأبدأ التصوير');
  // Arabic falling back to the English template would put an operator in front
  // of a participant who cannot read what they are being asked to agree to.
  assert.notEqual(
    ft('ar', 'field.consent.agree_start'),
    ft('en', 'field.consent.agree_start'),
  );
});

test('the removed checkbox copy is gone and its statement survives', () => {
  // The sentence the participant agrees to is still shown; only the redundant
  // tick and the now-impossible "consent is required" hint were removed.
  for (const language of ['ar', 'en'] as const) {
    const keys = Object.keys(fieldStrings[language]);
    assert.ok(keys.includes('field.consent.research_statement'), language);
    assert.ok(!keys.includes('field.consent.research_checkbox'), language);
    assert.ok(!keys.includes('field.consent.blocked'), language);
    assert.ok(keys.includes('field.consent.raw_checkbox'), language);
  }
});

test('the photograph opt-in is on only while the same participant is on screen', () => {
  assert.equal(photoOptInForParticipant('P-000123', 'P-000123', true), true);
  assert.equal(photoOptInForParticipant('P-000123', 'P-000124', true), false);
  assert.equal(photoOptInForParticipant(null, 'P-000124', true), false);
});
