/**
 * Calendar arithmetic for the birth-date wheels (day, month, year). Pure, so it is unit-tested without React
 * Native. The stored value stays the ISO `YYYY-MM-DD` string that `validation.ts` checks.
 */

import { lang, type Lang } from './i18n.ts';

export const ARABIC_MONTHS = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر',
] as const;

export const ENGLISH_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Month names in the current interface language. */
export function monthNames(language: Lang = lang()): readonly string[] {
  return language === 'en' ? ENGLISH_MONTHS : ARABIC_MONTHS;
}

/** The oldest year the wheel offers; validation refuses anything earlier. */
export const FIRST_YEAR = 1900;

export interface Ymd {
  y: number;
  m: number;
  d: number;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Years from this year back to FIRST_YEAR, newest first. */
export function yearsDescending(today: Date): number[] {
  const out: number[] = [];
  for (let y = today.getUTCFullYear(); y >= FIRST_YEAR; y -= 1) out.push(y);
  return out;
}

/** Keeps the day inside the month after the month or year wheel moves (31 March -> 30 April). */
export function clampDay(value: Ymd): Ymd {
  return { ...value, d: Math.min(value.d, daysInMonth(value.y, value.m)) };
}

export function parseIso(value: string): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const out = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
  if (out.m < 1 || out.m > 12 || out.d < 1 || out.d > daysInMonth(out.y, out.m)) return null;
  return out;
}

export function toIso({ y, m, d }: Ymd): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Where the wheels open when nothing is chosen yet: 1 January, thirty years ago. Nothing is saved until «تم». */
export function wheelStart(value: string, today: Date): Ymd {
  return parseIso(value) ?? { y: today.getUTCFullYear() - 30, m: 1, d: 1 };
}

/** «23 أبريل 1995» / "23 April 1995" for the field; the ISO string is what is stored and sent. */
export function formatBirthDate(value: string, language: Lang = lang()): string {
  const parsed = parseIso(value);
  if (!parsed) return value;
  return `${parsed.d} ${monthNames(language)[parsed.m - 1]} ${parsed.y}`;
}
