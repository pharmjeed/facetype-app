/**
 * Profile rules of docs/client-app-v1.md §2. Every identifier below is
 * synthetic: built from a prefix plus a computed Luhn check digit, never a
 * real person's number.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ageInYears,
  canonicalIdNumber,
  checkBirthDate,
  checkCountry,
  checkFullName,
  checkIdNumber,
  checkPhone,
  luhnValid,
  normalizeDigits,
  validateProfile,
  type ProfileForm,
} from './validation.ts';

/** A synthetic 10-digit number with a valid Luhn check digit. */
function withCheckDigit(nine: string): string {
  for (let d = 0; d <= 9; d += 1) {
    if (luhnValid(`${nine}${d}`)) return `${nine}${d}`;
  }
  throw new Error('unreachable');
}

function toArabicIndic(ascii: string): string {
  return ascii.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
}

const TODAY = new Date(Date.UTC(2026, 10, 23));

test('Arabic-Indic and Eastern Arabic-Indic digits normalise to ASCII', () => {
  assert.equal(normalizeDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
  assert.equal(normalizeDigits('۰۱۲۳۴۵۶۷۸۹'), '0123456789');
  assert.equal(normalizeDigits('a1٢b'), 'a12b');
});

test('Luhn accepts the computed check digit and rejects every other one', () => {
  const valid = withCheckDigit('100000000');
  assert.equal(valid, '1000000008');
  assert.equal(luhnValid(valid), true);
  for (let d = 0; d <= 9; d += 1) {
    if (`100000000${d}` !== valid) assert.equal(luhnValid(`100000000${d}`), false);
  }
  assert.equal(luhnValid('12a4'), false);
});

test('SA national_id: 10 digits starting 1 with a Luhn check digit', () => {
  const id = withCheckDigit('123456789');
  assert.deepEqual(checkIdNumber('SA', 'national_id', id), { ok: true, value: id });
  assert.deepEqual(checkIdNumber('SA', 'national_id', toArabicIndic(id)), { ok: true, value: id });
  assert.deepEqual(checkIdNumber('SA', 'national_id', ` ${id.slice(0, 5)}-${id.slice(5)} `), { ok: true, value: id });

  const wrongCheck = `${id.slice(0, 9)}${(Number(id[9]) + 1) % 10}`;
  assert.deepEqual(checkIdNumber('SA', 'national_id', wrongCheck), { ok: false, error: 'err.id_checksum' });
  assert.deepEqual(checkIdNumber('SA', 'national_id', withCheckDigit('223456789')), {
    ok: false,
    error: 'err.sa_national_id',
  });
  assert.deepEqual(checkIdNumber('SA', 'national_id', '12345'), { ok: false, error: 'err.sa_national_id' });
});

test('SA residence_id: 10 digits starting 2 with a Luhn check digit', () => {
  const iqama = withCheckDigit('234567890');
  assert.deepEqual(checkIdNumber('SA', 'residence_id', iqama), { ok: true, value: iqama });
  assert.deepEqual(checkIdNumber('SA', 'residence_id', withCheckDigit('134567890')), {
    ok: false,
    error: 'err.sa_residence_id',
  });
  const wrong = `${iqama.slice(0, 9)}${(Number(iqama[9]) + 5) % 10}`;
  assert.deepEqual(checkIdNumber('SA', 'residence_id', wrong), { ok: false, error: 'err.id_checksum' });
});

test('every other document: 5–20 of [A-Z0-9], upper-cased and normalised', () => {
  assert.deepEqual(checkIdNumber('EG', 'passport', 'a12345'), { ok: true, value: 'A12345' });
  assert.deepEqual(checkIdNumber('SA', 'passport', 'x٣٤٥٦٧'), { ok: true, value: 'X34567' });
  assert.deepEqual(checkIdNumber('US', 'national_id', '1234'), { ok: false, error: 'err.id_generic' });
  assert.deepEqual(checkIdNumber('US', 'national_id', 'A'.repeat(21)), { ok: false, error: 'err.id_generic' });
  assert.deepEqual(checkIdNumber('FR', 'passport', 'AB#123'), { ok: false, error: 'err.id_generic' });
  assert.equal(canonicalIdNumber(' ab-12 3 '), 'AB123');
});

test('phone: E.164 with +966 as the default country code', () => {
  assert.deepEqual(checkPhone('0501234567'), { ok: true, value: '+966501234567' });
  assert.deepEqual(checkPhone('٠٥٠١٢٣٤٥٦٧'), { ok: true, value: '+966501234567' });
  assert.deepEqual(checkPhone('501234567'), { ok: true, value: '+966501234567' });
  assert.deepEqual(checkPhone('966501234567'), { ok: true, value: '+966501234567' });
  assert.deepEqual(checkPhone('00966 50 123 4567'), { ok: true, value: '+966501234567' });
  assert.deepEqual(checkPhone('+20 100 123 4567'), { ok: true, value: '+201001234567' });
  assert.deepEqual(checkPhone('+1 (415) 555-0100'), { ok: true, value: '+14155550100' });
  // A +966 number must be a mobile.
  assert.deepEqual(checkPhone('+966112345678'), { ok: false, error: 'err.phone' });
  // No country code and not a Saudi mobile: ambiguous, so refused.
  assert.deepEqual(checkPhone('2012345678'), { ok: false, error: 'err.phone' });
  assert.deepEqual(checkPhone('+0123456789'), { ok: false, error: 'err.phone' });
  assert.deepEqual(checkPhone('+1234567890123456'), { ok: false, error: 'err.phone' });
});

test("names: Arabic or Latin letters with spaces, ' - . and 2–100 characters", () => {
  assert.deepEqual(checkFullName('  محمد   عبدالله  '), { ok: true, value: 'محمد عبدالله' });
  assert.deepEqual(checkFullName("Seán O'Brien-Smith Jr."), { ok: true, value: "Seán O'Brien-Smith Jr." });
  assert.deepEqual(checkFullName('O’Neil'), { ok: true, value: "O'Neil" });
  assert.deepEqual(checkFullName('مُحَمَّد'), { ok: true, value: 'مُحَمَّد' });
  assert.equal(checkFullName('a').ok, false);
  assert.equal(checkFullName('Ali2').ok, false);
  assert.equal(checkFullName('Ali@Home').ok, false);
  assert.equal(checkFullName("-'.").ok, false);
  assert.equal(checkFullName('أ'.repeat(101)).ok, false);
  assert.equal(checkFullName('أ'.repeat(100)).ok, true);
  assert.equal(checkFullName('李小龍').ok, false);
});

test('birth date: ISO, a real date, and age ≥ 18 on the day', () => {
  assert.deepEqual(checkBirthDate('2008-11-23', TODAY), { ok: true, value: '2008-11-23' });
  assert.deepEqual(checkBirthDate('2008-11-24', TODAY), { ok: false, error: 'err.underage' });
  assert.deepEqual(checkBirthDate('١٩٩٥-٠٤-٢٣', TODAY), { ok: true, value: '1995-04-23' });
  assert.deepEqual(checkBirthDate('1995/4/3', TODAY), { ok: true, value: '1995-04-03' });
  assert.deepEqual(checkBirthDate('1995-02-30', TODAY), { ok: false, error: 'err.birth_date' });
  assert.deepEqual(checkBirthDate('2030-01-01', TODAY), { ok: false, error: 'err.birth_date' });
  assert.deepEqual(checkBirthDate('23-04-1995', TODAY), { ok: false, error: 'err.birth_date' });
  assert.deepEqual(checkBirthDate('1899-12-31', TODAY), { ok: false, error: 'err.birth_date' });
  // 29 February birthdays come of age on 1 March in a non-leap year.
  assert.equal(ageInYears({ y: 2008, m: 2, d: 29 }, new Date(Date.UTC(2026, 1, 28))), 17);
  assert.equal(ageInYears({ y: 2008, m: 2, d: 29 }, new Date(Date.UTC(2026, 2, 1))), 18);
});

test('countries are ISO 3166-1 alpha-2 codes from the full list', () => {
  assert.deepEqual(checkCountry('sa'), { ok: true, value: 'SA' });
  assert.deepEqual(checkCountry('JP'), { ok: true, value: 'JP' });
  assert.equal(checkCountry('XX').ok, false);
  assert.equal(checkCountry('SAU').ok, false);
});

test('validateProfile returns canonical values or one error per bad field', () => {
  const id = withCheckDigit('112233445');
  const form: ProfileForm = {
    full_name: ' سارة  أحمد ',
    id_issuing_country: 'sa',
    id_document_type: 'national_id',
    id_number: toArabicIndic(id),
    phone: '0551234567',
    sex: 'female',
    birth_date: '1990-01-15',
    nationality: 'eg',
  };
  assert.deepEqual(validateProfile(form, TODAY), {
    ok: true,
    value: {
      full_name: 'سارة أحمد',
      id_issuing_country: 'SA',
      id_document_type: 'national_id',
      id_number: id,
      phone: '+966551234567',
      sex: 'female',
      birth_date: '1990-01-15',
      nationality: 'EG',
    },
  });

  const bad = validateProfile(
    { ...form, full_name: 'x', id_number: '999', phone: '12', sex: null, birth_date: '2010-01-01', nationality: '' },
    TODAY,
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.deepEqual(bad.errors, {
      full_name: 'err.full_name',
      id_number: 'err.sa_national_id',
      phone: 'err.phone',
      sex: 'err.sex',
      birth_date: 'err.underage',
      nationality: 'err.nationality',
    });
  }
});
