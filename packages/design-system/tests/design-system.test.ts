/** Token and microcopy invariants that both apps depend on. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MIN_TAP_TARGET, colors, cssVariables, direction, statusColors, t } from '../src/index.ts';

test('the palette matches the FT-07 §2 token table', () => {
  assert.equal(colors.primary, '#245C8A');
  assert.equal(colors.accent, '#2C7A7B');
  assert.equal(colors.danger, '#B54343');
  assert.equal(colors.border, '#D8E1EA');
});

test('tap targets meet the 44pt minimum', () => {
  assert.equal(MIN_TAP_TARGET, 44);
});

test('MODEL_UNAVAILABLE is neutral, not an error colour', () => {
  assert.equal(statusColors.MODEL_UNAVAILABLE, colors.muted);
  assert.equal(statusColors.FAILED, colors.danger);
  assert.notEqual(statusColors.MODEL_UNAVAILABLE, statusColors.FAILED);
});

test('Arabic is RTL and is the default locale family', () => {
  assert.equal(direction('ar-SA'), 'rtl');
  assert.equal(direction('en-US'), 'ltr');
});

test('microcopy interpolates placeholders', () => {
  assert.equal(t('en-US', 'scan.step', { current: 2, total: 5 }), 'Step 2/5');
  assert.ok(t('ar-SA', 'result.retake.body', { pose: 'اليسار' }).includes('اليسار'));
});

test('the result copy never claims causation', () => {
  const arabic = t('ar-SA', 'result.non_causal');
  assert.ok(arabic.includes('تشابه تشريحي'));
  assert.ok(arabic.includes('وليس سببًا'));
  assert.ok(t('en-US', 'result.non_causal').includes('not a cause'));
});

test('the model-unavailable copy names no type', () => {
  const arabic = t('ar-SA', 'result.model_unavailable');
  const english = t('en-US', 'result.model_unavailable');
  for (const text of [arabic, english]) {
    assert.ok(!/\b(ENTP|INFJ|ISTJ|ESFP)\b/.test(text));
  }
  assert.ok(english.includes('not approved'));
});

test('CSS variables cover every colour token', () => {
  const css = cssVariables();
  for (const key of Object.keys(colors)) {
    assert.ok(css.includes(`--${key}:`), key);
  }
});
