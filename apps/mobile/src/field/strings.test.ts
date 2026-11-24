/**
 * The consent copy is the product's promise to a research participant, so the
 * things that make it informed are asserted rather than proof-read: both
 * languages say the same things, and every number the wording depends on is
 * actually interpolated into it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { fieldStrings, ft, type FieldStringKey } from './strings.ts';

const arKeys = Object.keys(fieldStrings.ar).sort();
const enKeys = Object.keys(fieldStrings.en).sort();

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

test('the two languages carry the same keys', () => {
  assert.deepEqual(arKeys, enKeys);
});

test('no string is blank in either language', () => {
  for (const key of arKeys) {
    assert.ok(fieldStrings.ar[key as FieldStringKey].trim().length > 0, `ar ${key}`);
    assert.ok(fieldStrings.en[key as FieldStringKey].trim().length > 0, `en ${key}`);
  }
});

test('a translation cannot silently drop a number the consent depends on', () => {
  // A retention period that appears in one language and not the other is a
  // participant told a different thing depending on which locale the operator
  // happened to be running.
  for (const key of arKeys) {
    assert.deepEqual(
      placeholders(fieldStrings.ar[key as FieldStringKey]),
      placeholders(fieldStrings.en[key as FieldStringKey]),
      key,
    );
  }
});

test('the four things that make a consent informed are all interpolated', () => {
  // Purpose is stated flatly and needs no token. The other four do: the
  // wording version the geometry is kept under, the photograph period, who may
  // see it and who is accountable, and the route to deletion with the
  // reference to quote.
  assert.deepEqual(placeholders(fieldStrings.ar['field.consent.geometry']), ['version']);
  assert.deepEqual(placeholders(fieldStrings.ar['field.consent.raw_retention']), ['days']);
  assert.deepEqual(placeholders(fieldStrings.ar['field.consent.access']).sort(), [
    'access',
    'custodian',
  ]);
  assert.deepEqual(placeholders(fieldStrings.ar['field.consent.deletion']).sort(), [
    'contact',
    'ref',
  ]);
});

test('the consent copy promises no geometry retention period, because none is defined', () => {
  // The platform contract states a photograph retention period and nothing
  // else. A "kept for N days" sentence about geometry would be the app
  // inventing a duration on the deployment's behalf — the exact defect that
  // moved the retention figure out of the build in the first place — so no
  // string in this lane interpolates a day count for anything but photographs.
  for (const locale of ['ar', 'en'] as const) {
    for (const key of ['field.consent.geometry', 'field.receipt.retention'] as const) {
      assert.deepEqual(placeholders(fieldStrings[locale][key]), ['version'], `${locale} ${key}`);
    }
  }
  // And the key that used to carry it is gone rather than merely unused.
  assert.equal('field.consent.retention' in fieldStrings.en, false);
});

test('a deployment that keeps no photograph says so instead of asking', () => {
  for (const locale of ['ar', 'en'] as const) {
    const copy = fieldStrings[locale]['field.consent.raw_unavailable'];
    assert.ok(copy.trim().length > 0, locale);
    // No interpolation: there is no period to state, and a "{days}" left in a
    // sentence nobody filled in is how a zero becomes a promise.
    assert.deepEqual(placeholders(copy), []);
  }
});

test('the join screen states the server figures and nothing the build decided', () => {
  assert.deepEqual(placeholders(fieldStrings.ar['field.join.retention_on']), ['days']);
  assert.deepEqual(placeholders(fieldStrings.ar['field.join.policy_version']), ['version']);
  assert.deepEqual(placeholders(fieldStrings.ar['field.join.protocol']), ['protocol']);
  assert.deepEqual(placeholders(fieldStrings.ar['field.join.policy_blocked']), ['code']);
  // The hint says the code is not kept, in both languages, because that is a
  // promise the implementation actually makes.
  for (const locale of ['ar', 'en'] as const) {
    assert.ok(fieldStrings[locale]['field.join.code_hint'].trim().length > 0, locale);
  }
});

test('the setup screen never invites an operator to type a reference', () => {
  // The text field is gone; so is the copy that explained what to type into
  // it, and so are the six refusals that only existed because it could be
  // typed into wrong.
  for (const gone of [
    'field.setup.participant_hint',
    'field.setup.participant_generate',
    'field.ref.FIELD_REF_EMAIL',
    'field.ref.FIELD_REF_NAME',
    'field.ref.FIELD_REF_PHONE',
    'field.ref.FIELD_REF_FREE_TEXT',
    'field.ref.FIELD_REF_FORMAT',
    'field.ref.FIELD_REF_EMPTY',
  ]) {
    assert.equal(gone in fieldStrings.en, false, gone);
    assert.equal(gone in fieldStrings.ar, false, gone);
  }
  assert.deepEqual(placeholders(fieldStrings.ar['field.setup.ref_allocated']), ['ref']);
});

test('interpolation substitutes every token and leaves nothing unresolved', () => {
  const rendered = ft('ar', 'field.consent.access', {
    access: 'باحثو الدراسة فقط',
    custodian: 'عمليات البحث',
  });
  assert.ok(rendered.includes('باحثو الدراسة فقط'));
  assert.ok(rendered.includes('عمليات البحث'));
  assert.doesNotMatch(rendered, /\{\w+\}/);

  const english = ft('en-GB', 'field.consent.raw_retention', { days: 7 });
  assert.equal(english, 'If you agree to photographs: each photo is deleted after 7 days.');
});

test('an unknown locale falls back to English rather than to the raw key', () => {
  assert.equal(ft('fr-FR', 'field.receipt.next'), 'Next participant');
  assert.equal(ft('ar-SA', 'field.receipt.next'), fieldStrings.ar['field.receipt.next']);
});

test('the banner states the disposition in both languages', () => {
  assert.match(fieldStrings.en['field.banner.title'], /CALIBRATION/);
  assert.match(fieldStrings.en['field.banner.title'], /PROVISIONAL/);
  assert.match(fieldStrings.en['field.banner.title'], /NOT VALIDATED/);
  // معايرة = calibration, مبدئية = provisional, غير معتمدة = not approved.
  assert.match(fieldStrings.ar['field.banner.title'], /معايرة/);
  assert.match(fieldStrings.ar['field.banner.title'], /مبدئية/);
  assert.match(fieldStrings.ar['field.banner.title'], /غير معتمدة/);
});
