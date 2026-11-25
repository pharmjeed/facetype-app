import assert from 'node:assert/strict';
import { test } from 'node:test';

import { crossStart, isLang, lang, leftTextAlign, rowDirection, setLang, startTextAlign } from './i18n.ts';

test('Arabic is the default language', () => {
  assert.equal(lang(), 'ar');
});

test('Arabic text starts on the right whatever the native direction of this launch', () => {
  // LTR native layout (first launch after install): 'right' is rendered on the right.
  assert.equal(startTextAlign(false, 'ar'), 'right');
  // RTL native layout: React Native swaps left/right, so 'left' is rendered on the right.
  assert.equal(startTextAlign(true, 'ar'), 'left');
});

test('English text starts on the left whatever the native direction', () => {
  assert.equal(startTextAlign(false, 'en'), 'left');
  assert.equal(startTextAlign(true, 'en'), 'right');
});

test('rows put the first child at the reading start', () => {
  assert.equal(rowDirection(true, 'ar'), 'row');
  assert.equal(rowDirection(false, 'ar'), 'row-reverse');
  assert.equal(rowDirection(false, 'en'), 'row');
  assert.equal(rowDirection(true, 'en'), 'row-reverse');
  assert.equal(crossStart(true, 'ar'), 'flex-start');
  assert.equal(crossStart(false, 'ar'), 'flex-end');
});

test('a left-to-right number field stays physically on the left', () => {
  assert.equal(leftTextAlign(false), 'left');
  assert.equal(leftTextAlign(true), 'right');
});

test('setLang switches the current language; only ar and en are languages', () => {
  setLang('en');
  assert.equal(lang(), 'en');
  setLang('ar');
  assert.equal(lang(), 'ar');
  assert.ok(isLang('ar') && isLang('en'));
  assert.ok(!isLang('fr') && !isLang(null));
});
