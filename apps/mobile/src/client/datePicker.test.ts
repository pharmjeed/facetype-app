import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ARABIC_MONTHS,
  FIRST_YEAR,
  clampDay,
  daysInMonth,
  formatBirthDate,
  parseIso,
  toIso,
  wheelStart,
  yearsDescending,
} from './datePicker.ts';
import { checkBirthDate } from './validation.ts';

const today = new Date(Date.UTC(2026, 10, 25));

test('month lengths include leap years', () => {
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2023, 2), 28);
  assert.equal(daysInMonth(1900, 2), 28);
  assert.equal(daysInMonth(2000, 2), 29);
  assert.equal(daysInMonth(1995, 4), 30);
  assert.equal(daysInMonth(1995, 12), 31);
});

test('years run from this year back to the first year, newest first', () => {
  const years = yearsDescending(today);
  assert.equal(years[0], 2026);
  assert.equal(years.at(-1), FIRST_YEAR);
  assert.equal(years.length, 2026 - FIRST_YEAR + 1);
});

test('moving the month or year never leaves an impossible day', () => {
  assert.deepEqual(clampDay({ y: 1995, m: 4, d: 31 }), { y: 1995, m: 4, d: 30 });
  assert.deepEqual(clampDay({ y: 2023, m: 2, d: 30 }), { y: 2023, m: 2, d: 28 });
  assert.deepEqual(clampDay({ y: 2024, m: 2, d: 29 }), { y: 2024, m: 2, d: 29 });
});

test('ISO round trip, and impossible dates are not parsed', () => {
  assert.deepEqual(parseIso('1995-04-23'), { y: 1995, m: 4, d: 23 });
  assert.equal(toIso({ y: 1995, m: 4, d: 3 }), '1995-04-03');
  assert.equal(parseIso('1995-02-30'), null);
  assert.equal(parseIso('1995-13-01'), null);
  assert.equal(parseIso('23-04-1995'), null);
  assert.equal(parseIso(''), null);
});

test('the wheels open on the saved date, else 1 January thirty years ago', () => {
  assert.deepEqual(wheelStart('1995-04-23', today), { y: 1995, m: 4, d: 23 });
  assert.deepEqual(wheelStart('', today), { y: 1996, m: 1, d: 1 });
});

test('every date the wheels can produce is one validation reads the same way', () => {
  const picked = toIso(clampDay({ y: 1995, m: 4, d: 23 }));
  const checked = checkBirthDate(picked, today);
  assert.equal(checked.ok, true);
  assert.equal(checked.ok && checked.value, '1995-04-23');
});

test('the field shows day, Arabic month name and year', () => {
  assert.equal(ARABIC_MONTHS.length, 12);
  assert.equal(formatBirthDate('1995-04-23'), '23 أبريل 1995');
  assert.equal(formatBirthDate(''), '');
  assert.equal(formatBirthDate('1995-04-23', 'en'), '23 April 1995');
});
