/**
 * Profile field rules — docs/client-app-v1.md §2, exactly.
 *
 * The server applies the same rules and is authoritative; these exist so a
 * person sees «رقم الهوية الوطنية 10 أرقام…» next to the field instead of a
 * round trip that ends in a generic 422. Every function returns either the
 * canonical value that will be sent or an error key from `strings.ts`.
 *
 * Identifier checks are format checks only. Nothing here (or on the server)
 * verifies that a number belongs to the person typing it (ADR-015 §4).
 */

import { isCountryCode } from './countries.ts';
import type { StringKey } from './strings.ts';

export type IdDocumentType = 'national_id' | 'residence_id' | 'passport';
export type Sex = 'male' | 'female';

export const ID_DOCUMENT_TYPES: readonly IdDocumentType[] = ['national_id', 'residence_id', 'passport'];
export const SEXES: readonly Sex[] = ['male', 'female'];
export const MIN_AGE_YEARS = 18;
export const DEFAULT_COUNTRY_CALLING_CODE = '+966';

export type Checked<T> = { ok: true; value: T } | { ok: false; error: StringKey };

/** Arabic-Indic (U+0660–0669) and Eastern Arabic-Indic (U+06F0–06F9) digits → ASCII. */
export function normalizeDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

// Arabic letters (incl. extended letters used in Persian/Urdu names) with
// their optional diacritics, and Latin letters with accents (José, Müller).
const NAME_LETTER = '\\u0621-\\u063a\\u0641-\\u064a\\u0671-\\u06d3\\u06d5A-Za-z\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u024f';
const NAME_MARK = '\\u064b-\\u065f\\u0670';
// Marks get their own class so no class mixes a base letter with a combining mark.
const NAME_PATTERN = new RegExp(`^[${NAME_LETTER}](?:[${NAME_LETTER} '.\\-]|[${NAME_MARK}])*$`);
const LETTER_PATTERN = new RegExp(`[${NAME_LETTER}]`, 'g');

/** 2–100 chars: Arabic/Latin letters, spaces, `'`, `-`, `.`. */
export function checkFullName(raw: string): Checked<string> {
  const value = raw
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  const length = [...value].length;
  if (length < 2 || length > 100) return { ok: false, error: 'err.full_name' };
  if (!NAME_PATTERN.test(value)) return { ok: false, error: 'err.full_name' };
  if ((value.match(LETTER_PATTERN) ?? []).length < 2) return { ok: false, error: 'err.full_name' };
  return { ok: true, value };
}

export function checkCountry(raw: string, error: StringKey = 'err.country'): Checked<string> {
  const value = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(value) && isCountryCode(value) ? { ok: true, value } : { ok: false, error };
}

/** Luhn (mod 10) over a digit string; the Saudi NIN/Iqama check digit uses it. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** The canonical identifier: ASCII digits, no separators, upper case. */
export function canonicalIdNumber(raw: string): string {
  return normalizeDigits(raw).replace(/[\s\-_.‎‏]/g, '').toUpperCase();
}

export function checkIdNumber(
  country: string,
  type: IdDocumentType,
  raw: string,
): Checked<string> {
  const value = canonicalIdNumber(raw);
  if (country === 'SA' && type === 'national_id') {
    if (!/^1\d{9}$/.test(value)) return { ok: false, error: 'err.sa_national_id' };
    return luhnValid(value) ? { ok: true, value } : { ok: false, error: 'err.id_checksum' };
  }
  if (country === 'SA' && type === 'residence_id') {
    if (!/^2\d{9}$/.test(value)) return { ok: false, error: 'err.sa_residence_id' };
    return luhnValid(value) ? { ok: true, value } : { ok: false, error: 'err.id_checksum' };
  }
  return /^[A-Z0-9]{5,20}$/.test(value) ? { ok: true, value } : { ok: false, error: 'err.id_generic' };
}

/**
 * E.164, unverified (v1). With no country code the number is read as Saudi:
 * `05XXXXXXXX`, `5XXXXXXXX` and `9665XXXXXXXX` all become `+9665XXXXXXXX`.
 * A `+966` number must be a mobile (`5` + 8 digits).
 */
export function checkPhone(raw: string): Checked<string> {
  let value = normalizeDigits(raw).replace(/[\s\-().‎‏]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  if (!value.startsWith('+')) {
    if (/^05\d{8}$/.test(value)) value = `${DEFAULT_COUNTRY_CALLING_CODE}${value.slice(1)}`;
    else if (/^5\d{8}$/.test(value)) value = `${DEFAULT_COUNTRY_CALLING_CODE}${value}`;
    else if (/^9665\d{8}$/.test(value)) value = `+${value}`;
    else return { ok: false, error: 'err.phone' };
  }
  if (!/^\+[1-9]\d{6,14}$/.test(value)) return { ok: false, error: 'err.phone' };
  if (value.startsWith('+966') && !/^\+9665\d{8}$/.test(value)) return { ok: false, error: 'err.phone' };
  return { ok: true, value };
}

export function checkSex(raw: string | null | undefined): Checked<Sex> {
  return raw === 'male' || raw === 'female' ? { ok: true, value: raw } : { ok: false, error: 'err.sex' };
}

export function checkIdType(raw: string | null | undefined): Checked<IdDocumentType> {
  return ID_DOCUMENT_TYPES.includes(raw as IdDocumentType)
    ? { ok: true, value: raw as IdDocumentType }
    : { ok: false, error: 'err.id_type' };
}

/** Completed years between an ISO birth date and `today` (both UTC calendar dates). */
export function ageInYears(birth: { y: number; m: number; d: number }, today: Date): number {
  const ty = today.getUTCFullYear();
  const tm = today.getUTCMonth() + 1;
  const td = today.getUTCDate();
  let age = ty - birth.y;
  if (tm < birth.m || (tm === birth.m && td < birth.d)) age -= 1;
  return age;
}

/** ISO `YYYY-MM-DD`, a real calendar date, not in the future, and age ≥ 18. */
export function checkBirthDate(raw: string, today: Date = new Date()): Checked<string> {
  const value = normalizeDigits(raw).trim().replace(/[/.]/g, '-');
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (!match) return { ok: false, error: 'err.birth_date' };
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    y < 1900 ||
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return { ok: false, error: 'err.birth_date' };
  }
  const age = ageInYears({ y, m, d }, today);
  if (age < 0) return { ok: false, error: 'err.birth_date' };
  if (age < MIN_AGE_YEARS) return { ok: false, error: 'err.underage' };
  if (age > 130) return { ok: false, error: 'err.birth_date' };
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { ok: true, value: iso };
}

export interface ProfileForm {
  full_name: string;
  id_issuing_country: string;
  id_document_type: IdDocumentType | null;
  id_number: string;
  phone: string;
  sex: Sex | null;
  birth_date: string;
  nationality: string;
}

export interface ProfileValues {
  full_name: string;
  id_issuing_country: string;
  id_document_type: IdDocumentType;
  id_number: string;
  phone: string;
  sex: Sex;
  birth_date: string;
  nationality: string;
}

export type ProfileErrors = Partial<Record<keyof ProfileForm, StringKey>>;

export function validateProfile(
  form: ProfileForm,
  today: Date = new Date(),
): { ok: true; value: ProfileValues } | { ok: false; errors: ProfileErrors } {
  const errors: ProfileErrors = {};
  const name = checkFullName(form.full_name);
  const country = checkCountry(form.id_issuing_country);
  const type = checkIdType(form.id_document_type);
  const id =
    country.ok && type.ok
      ? checkIdNumber(country.value, type.value, form.id_number)
      : checkIdNumber('', 'passport', form.id_number);
  const phone = checkPhone(form.phone);
  const sex = checkSex(form.sex);
  const birth = checkBirthDate(form.birth_date, today);
  const nationality = checkCountry(form.nationality, 'err.nationality');

  if (!name.ok) errors.full_name = name.error;
  if (!country.ok) errors.id_issuing_country = country.error;
  if (!type.ok) errors.id_document_type = type.error;
  if (!id.ok) errors.id_number = id.error;
  if (!phone.ok) errors.phone = phone.error;
  if (!sex.ok) errors.sex = sex.error;
  if (!birth.ok) errors.birth_date = birth.error;
  if (!nationality.ok) errors.nationality = nationality.error;

  if (
    !name.ok || !country.ok || !type.ok || !id.ok || !phone.ok || !sex.ok || !birth.ok || !nationality.ok
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      full_name: name.value,
      id_issuing_country: country.value,
      id_document_type: type.value,
      id_number: id.value,
      phone: phone.value,
      sex: sex.value,
      birth_date: birth.value,
      nationality: nationality.value,
    },
  };
}
