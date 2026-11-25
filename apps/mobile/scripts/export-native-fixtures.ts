/**
 * Freeze the client app's behaviour into JSON fixtures before the React Native client lane is replaced by the
 * native iOS (SwiftUI) and Android (Compose) apps (owner decision 2026-11-25, ADR-017). The Swift and Kotlin
 * ports are tested against these files, so "same behaviour" is checked, not assumed. Also the single source of
 * the interface strings and country names for both native apps.
 *
 *   node --experimental-strip-types scripts/export-native-fixtures.ts   (from apps/mobile)
 *
 * Writes docs/fixtures/client/*.json. Every input here is synthetic.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLIENT_GATE_CONFIG, CLIENT_PROTOCOL_VERSION, gateConfigHash, gateConfigJson } from '@facetype/contracts';

import { mapProblem } from '../src/client/api/clientApi.ts';
import type { ClientMe } from '../src/client/api/types.ts';
import { burstDisposition, initialCaptureFlow, nextBurstOptions, phaseFromSpool, reduceCapture, type CaptureEvent } from '../src/client/captureFlow.ts';
import { initialClientState, needsSetup, reduceClient, type ClientEvent } from '../src/client/clientFlow.ts';
import { countries, countryName, filterCountries, searchCountries } from '../src/client/countries.ts';
import { ARABIC_MONTHS, ENGLISH_MONTHS, formatBirthDate } from '../src/client/datePicker.ts';
import { guidanceView, initialGuidance, rearmGuidance, stepGuidance, GUIDANCE_TIMING } from '../src/client/guidance/guidance.ts';
import { setLang } from '../src/client/i18n.ts';
import { API_ERROR_KEYS, apiErrorKey, moreReasonKey, profileFieldErrorKey, rejectReasonKey, verdictReasonKey } from '../src/client/messages.ts';
import type { FrameMeasure } from '../src/client/native/types.ts';
import { syntheticMeasure } from '../src/client/native/simulator.ts';
import { SPOOL_MAX_AGE_MS, MANIFEST_VERSION, TERMINAL_STAGES, type SpoolManifest, type SpoolStage } from '../src/client/spool/manifest.ts';
import { SPOOL_TIMING, nextRunInMs, type SpoolOutcome } from '../src/client/spool/spool.ts';
import { ATTEMPT_LIMITS, TELEMETRY_QUEUE_MAX } from '../src/client/spool/telemetryQueue.ts';
import { CONSENT_VERSION, CONSENT_VERSION_EN, EN, S } from '../src/client/strings.ts';
import { MAX_REASON_KEYS, outcomeForStage, wireReason, wireReasonCounts } from '../src/client/telemetry.ts';
import * as V from '../src/client/validation.ts';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/fixtures/client');
const TODAY = new Date(Date.UTC(2026, 10, 25));

function write(name: string, value: unknown): void {
  writeFileSync(path.join(OUT, name), `${JSON.stringify(value, null, 1)}\n`, 'utf8');
}

mkdirSync(OUT, { recursive: true });

// --- strings -------------------------------------------------------------------------------------------------
write('strings.json', {
  note: 'Interface strings, Arabic (default, right to left) and English. {token} placeholders are filled by the app.',
  consent_versions: { ar: CONSENT_VERSION, en: CONSENT_VERSION_EN },
  keys: Object.keys(S),
  ar: S,
  en: EN,
});

// --- countries -----------------------------------------------------------------------------------------------
const searchQueries = ['', 'sa', 'SA', 'سعود', 'السعودية', 'الامارات', 'امارات', 'مصر', 'egy', 'aland', 'Åland', 'united', 'كوريا', 'xx', 'غ', ' us '];
const countrySearch: Array<{ lang: string; query: string; search8: string[]; filter: string[] }> = [];
for (const lang of ['ar', 'en'] as const) {
  setLang(lang);
  for (const query of searchQueries) {
    countrySearch.push({ lang, query, search8: searchCountries(query).map((c) => c.code), filter: filterCountries(query).map((c) => c.code) });
  }
}
setLang('ar');
write('countries.json', {
  note: 'ISO 3166-1 alpha-2 with Arabic and English names; order_* is the display order of each language.',
  countries: countries('ar').map((c) => {
    setLang('en');
    const en = countryName(c.code);
    setLang('ar');
    return { code: c.code, ar: c.name, en };
  }),
  order_ar: countries('ar').map((c) => c.code),
  order_en: countries('en').map((c) => c.code),
  search: countrySearch,
});

// --- validation ----------------------------------------------------------------------------------------------
const names = ['سارة محمد العلي', ' محمد  أحمد ', 'Mary-Jane O’Neil', 'José Álvarez', 'A', 'ab', 'م', 'مُحَمَّد', 'Ali2', 'Dr. Smith', '  ', 'سالم-', "D'Arcy", 'x'.repeat(101), 'ﻻ', 'ـمحمد'];
const ids: Array<[string, string, string]> = [
  ['SA', 'national_id', '1000000008'], ['SA', 'national_id', '1000000009'], ['SA', 'national_id', '2000000006'],
  ['SA', 'national_id', '١٠٠٠٠٠٠٠٠٨'], ['SA', 'national_id', '1 000 000 008'], ['SA', 'residence_id', '2000000006'],
  ['SA', 'residence_id', '2000000007'], ['SA', 'residence_id', '1000000008'], ['SA', 'passport', 'a1234567'],
  ['EG', 'national_id', '29001011234567'], ['EG', 'passport', 'A12'], ['US', 'passport', 'X-12.345_6'],
  ['', null as unknown as string, '123456'], ['ZZ', 'national_id', 'ABCDE'],
];
const phones = ['0512345678', '512345678', '966512345678', '+966512345678', '00966512345678', '٠٥١٢٣٤٥٦٧٨', '+20 100 123 4567',
  '0412345678', '+9665123', '+1 (415) 555-0100', '12345', '+0123456789', '05123456', '+966 51 234 5678', '05-123-45678'];
const dates = ['1995-12-19', '1995-12-1', '1995/12/19', '1995.12.19', '2000-02-29', '1999-02-29', '1899-12-31', '1900-01-01',
  '2008-11-25', '2008-11-26', '2026-11-26', '1890-01-01', '19-12-1995', '', '١٩٩٥-١٢-١٩', '1995-13-01'];
const checked = (r: V.Checked<unknown>) => (r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error });
write('validation.json', {
  today: '2026-11-25',
  min_age_years: V.MIN_AGE_YEARS,
  default_calling_code: V.DEFAULT_COUNTRY_CALLING_CODE,
  full_name: names.map((input) => ({ input, ...checked(V.checkFullName(input)) })),
  id_number: ids.map(([country, type, input]) => ({ country, type, input, ...checked(V.checkIdNumber(country, type as V.IdDocumentType, input)) })),
  phone: phones.map((input) => ({ input, ...checked(V.checkPhone(input)) })),
  birth_date: dates.map((input) => ({ input, ...checked(V.checkBirthDate(input, TODAY)) })),
  country: ['SA', 'sa', 'XX', 'S', ''].map((input) => ({ input, ...checked(V.checkCountry(input)) })),
  luhn: ['1000000008', '1000000009', '79927398713', '2000000006'].map((input) => ({ input, valid: V.luhnValid(input) })),
  profile: [
    { full_name: 'سارة محمد العلي', id_issuing_country: 'SA', id_document_type: 'national_id', id_number: '1000000008', phone: '0512345678', sex: 'male', birth_date: '1995-12-19', nationality: 'SA' },
    { full_name: '', id_issuing_country: '', id_document_type: null, id_number: '', phone: '', sex: null, birth_date: '', nationality: '' },
    { full_name: 'Jane Doe', id_issuing_country: 'GB', id_document_type: 'passport', id_number: 'AB12345', phone: '+447700900123', sex: 'female', birth_date: '2010-01-01', nationality: 'GB' },
  ].map((form) => {
    const r = V.validateProfile(form as V.ProfileForm, TODAY);
    return { form, ...(r.ok ? { ok: true, value: r.value } : { ok: false, errors: r.errors }) };
  }),
});

// --- dates ---------------------------------------------------------------------------------------------------
setLang('ar');
const birthAr = ['1995-12-19', '2000-02-29', ''].map((v) => ({ input: v, output: formatBirthDate(v, 'ar') }));
write('dates.json', {
  months_ar: ARABIC_MONTHS,
  months_en: ENGLISH_MONTHS,
  format_birth_date: [...birthAr, ...['1995-12-19', '2000-02-29'].map((v) => ({ input: v, lang: 'en', output: formatBirthDate(v, 'en') }))],
});

// --- gate config ---------------------------------------------------------------------------------------------
write('gate.json', {
  protocol_version: CLIENT_PROTOCOL_VERSION,
  config: CLIENT_GATE_CONFIG,
  canonical_json: gateConfigJson(),
  sha256: gateConfigHash(),
  next_burst_options: nextBurstOptions(),
});

// --- guidance ------------------------------------------------------------------------------------------------
function good(tsMs: number, overrides: Partial<FrameMeasure> = {}): FrameMeasure {
  return { ...syntheticMeasure(10_000), tsMs, ...overrides };
}
type Scenario = { name: string; frames: FrameMeasure[]; rearmAfter?: number };
const at = (i: number) => 1_000 + i * 66;
const scenarios: Scenario[] = [
  { name: 'all_good', frames: Array.from({ length: 20 }, (_, i) => good(at(i))) },
  { name: 'no_face_then_good', frames: Array.from({ length: 40 }, (_, i) => (i < 10 ? syntheticMeasure(500, i) : good(at(i)))).map((f, i) => ({ ...f, tsMs: at(i) })) },
  { name: 'too_far', frames: Array.from({ length: 30 }, (_, i) => good(at(i), { distanceCm: 80, faceWidthPx: 150 })) },
  { name: 'too_close', frames: Array.from({ length: 30 }, (_, i) => good(at(i), { distanceCm: 25, faceWidthPx: 900 })) },
  { name: 'size_only_small', frames: Array.from({ length: 30 }, (_, i) => good(at(i), { distanceCm: null, faceWidthPx: 150 })) },
  { name: 'off_centre', frames: Array.from({ length: 30 }, (_, i) => good(at(i), { eyeMidX: 0.25 })) },
  { name: 'turned', frames: Array.from({ length: 30 }, (_, i) => good(at(i), { yaw: 20 })) },
  { name: 'tilted_roll', frames: Array.from({ length: 30 }, (_, i) => good(at(i), { roll: 25 })) },
  { name: 'dark', frames: Array.from({ length: 30 }, (_, i) => good(at(i), { crushFrac: 0.2 })) },
  { name: 'slow_exposure', frames: Array.from({ length: 30 }, (_, i) => good(at(i), { exposureTimeNs: 50_000_000 })) },
  { name: 'two_faces', frames: Array.from({ length: 30 }, (_, i) => good(at(i), { faces: 2 })) },
  { name: 'hold_with_two_bad', frames: Array.from({ length: 30 }, (_, i) => (i === 8 || i === 9 ? good(at(i), { eyeMidX: 0.1 }) : good(at(i)))) },
  { name: 'hold_broken_by_three_bad', frames: Array.from({ length: 30 }, (_, i) => (i >= 8 && i <= 10 ? good(at(i), { eyeMidX: 0.1 }) : good(at(i)))) },
  { name: 'flicker_message_hold', frames: Array.from({ length: 60 }, (_, i) => good(at(i), { eyeMidX: Math.floor(i / 6) % 2 === 0 ? 0.2 : 0.8 })) },
  { name: 'nan_values', frames: Array.from({ length: 20 }, (_, i) => good(at(i), { yaw: i % 3 === 0 ? Number.NaN : 0 })) },
  { name: 'rearm_after_ready', frames: Array.from({ length: 30 }, (_, i) => good(at(i))), rearmAfter: 15 },
];
write('guidance.json', {
  timing: GUIDANCE_TIMING,
  note: 'Each step: the measure fed to stepGuidance, then guidanceView. A NaN measure value is written as null (JSON); guidance treats both as missing.',
  scenarios: scenarios.map(({ name, frames, rearmAfter }) => {
    let state = initialGuidance(frames[0]?.tsMs ?? 0);
    const steps = frames.map((frame, i) => {
      state = stepGuidance(state, frame, CLIENT_GATE_CONFIG);
      if (rearmAfter !== undefined && i === rearmAfter) state = rearmGuidance(state);
      const view = guidanceView(state, CLIENT_GATE_CONFIG);
      return { measure: frame, rearmed: rearmAfter === i, view };
    });
    return { name, start_ms: frames[0]?.tsMs ?? 0, steps };
  }),
}, );

// --- messages ------------------------------------------------------------------------------------------------
write('messages.json', {
  api_error_keys: API_ERROR_KEYS,
  api_error_key: [
    ['FT-CLIENT-ID-TAKEN', null], ['FT-SYS-001', null], [null, 'network'], [null, 'session_expired'], [null, 'unauthorized'],
    [null, 'rate_limited'], [null, 'server'], ['UNKNOWN-CODE', 'validation'], [null, null],
  ].map(([code, kind]) => ({ code, kind, key: apiErrorKey(code as string | null, (kind ?? undefined) as never) })),
  profile_field_error_key: [
    ['birth_date', 'under_18'], ['birth_date', 'invalid'], ['id_number', 'checksum'], ['id_number', 'format'], ['phone', 'invalid'],
    ['full_name', 'x'], ['nationality', 'x'], ['id_issuing_country', 'x'], ['id_document_type', 'x'], ['sex', 'x'], ['unknown_field', 'x'],
  ].map(([field, reason]) => ({ field, reason, key: profileFieldErrorKey(field!, reason!) })),
  verdict_reason_key: ['upload_integrity', 'glasses_detected', 'face_covered', 'occluded', 'mask', 'second_face', 'multiple_faces',
    'too_few_frames', 'frames_short', 'low_quality', 'blur', 'light', 'sharpness', 'whatever'].map((reason) => ({ reason, key: verdictReasonKey(reason) })),
  more_reason_key: ['remove_glasses', 'face_camera', 'neutral_face', 'open_eyes', 'hold_still', 'one_face', 'same_person', 'more_photos', 'other', undefined]
    .map((reason) => ({ reason: reason ?? null, key: moreReasonKey(reason) })),
  reject_reason_key: (['oneFace', 'distanceOrSize', 'centred', 'facing', 'light', 'expression', 'eyes', 'sharp', 'effects_active', 'internal', 'unknown', null] as const)
    .flatMap((reason) => (['move_closer', 'move_back', 'centre'] as const).map((current) => ({ reason, current, key: rejectReasonKey(reason, current) }))),
});

// --- api error mapping ---------------------------------------------------------------------------------------
const problems: Array<[number, Record<string, unknown> | null, 'auth' | 'profile' | 'capture' | 'other']> = [
  [401, null, 'other'], [409, null, 'profile'], [409, null, 'capture'], [503, null, 'auth'], [503, null, 'other'], [400, null, 'other'],
  [422, { error_code: 'FT-SYS-003', retryable: true, errors: [{ field: 'body.phone', message: 'bad' }] }, 'profile'],
  [422, { error_code: 'FT-CLIENT-PROFILE-INVALID', action: { fields: { birth_date: 'under_18', id_number: 'checksum' } } }, 'profile'],
  [409, { error_code: 'FT-CLIENT-ID-TAKEN' }, 'profile'], [404, null, 'other'], [429, { retry_after_seconds: 7 }, 'other'],
  [500, null, 'other'], [502, { retryable: false }, 'other'], [418, null, 'other'],
  [409, { error_code: 'FT-CLIENT-UPLOAD-MISMATCH', action: { reason: 'jpeg_invalid' } }, 'capture'],
  [409, { error_code: 'FT-CLIENT-UPLOAD-MISMATCH', action: { reason: 'sha256_mismatch' } }, 'capture'],
  [409, { error_code: 'FT-CLIENT-UPLOAD-MISSING' }, 'capture'], [403, { error_code: 'FT-PRIV-003' }, 'capture'],
  [403, { error_code: 'FT-CLIENT-ACCOUNT-WITHDRAWING' }, 'other'], [400, { error_code: 'FT-CLIENT-NONCE-INVALID' }, 'auth'],
];
write('problems.json', {
  cases: problems.map(([status, body, context]) => {
    const e = mapProblem(status, body as never, context);
    return { status, body, context, kind: e.kind, code: e.code, retryable: e.retryable, retry_after_seconds: e.retryAfterSeconds, field_errors: e.fieldErrors };
  }),
});

// --- flows ---------------------------------------------------------------------------------------------------
const meDone = {
  account: { id: 'acc-1', provider: 'google', state: 'active', created_at: '2026-11-25T00:00:00Z' },
  profile: { full_name: 'x' }, consent: { store_accepted: true }, captures: { count: 0, last_at: null, latest_status: null, next_repeat_due_at: null }, personality: { status: 'unavailable' },
} as unknown as ClientMe;
const meNoProfile = { ...meDone, profile: null } as ClientMe;
const meNoConsent = { ...meDone, consent: null } as ClientMe;
const clientSequences: Array<{ name: string; events: ClientEvent[] }> = [
  { name: 'boot_no_session', events: [{ type: 'BOOT_NO_SESSION' }] },
  { name: 'sign_in_new_user', events: [{ type: 'BOOT_NO_SESSION' }, { type: 'SIGN_IN_STARTED', provider: 'google' }, { type: 'SESSION_READY', me: meNoProfile }, { type: 'PROFILE_SAVED', me: meDone }, { type: 'OPEN_CAPTURE' }, { type: 'CLOSE_CAPTURE' }] },
  { name: 'sign_in_failed_then_retry', events: [{ type: 'BOOT_NO_SESSION' }, { type: 'SIGN_IN_STARTED', provider: 'apple' }, { type: 'SIGN_IN_FAILED', error: 'cancelled' }, { type: 'SIGN_IN_STARTED', provider: 'google' }, { type: 'SESSION_READY', me: meDone }] },
  { name: 'busy_ignores_second_start', events: [{ type: 'BOOT_NO_SESSION' }, { type: 'SIGN_IN_STARTED', provider: 'apple' }, { type: 'SIGN_IN_STARTED', provider: 'google' }] },
  { name: 'consent_missing', events: [{ type: 'SESSION_READY', me: meNoConsent }, { type: 'OPEN_CAPTURE' }, { type: 'PROFILE_SAVED', me: meNoConsent }, { type: 'PROFILE_SAVED', me: meDone }] },
  { name: 'refresh_drops_to_setup', events: [{ type: 'SESSION_READY', me: meDone }, { type: 'ME_REFRESHED', me: meNoProfile }] },
  { name: 'session_expired', events: [{ type: 'SESSION_READY', me: meDone }, { type: 'OPEN_CAPTURE' }, { type: 'SIGNED_OUT', reason: 'session_expired' }] },
  { name: 'config_error', events: [{ type: 'CONFIG_ERROR', code: 'API_URL_INVALID' }, { type: 'SIGN_IN_STARTED', provider: 'google' }] },
  { name: 'refresh_ignored_on_boot', events: [{ type: 'ME_REFRESHED', me: meDone }] },
];
write('client_flow.json', {
  needs_setup: [[null, true], [meDone, false], [meNoProfile, true], [meNoConsent, true]].map(([me, expected]) => ({ me, needs_setup: needsSetup(me as ClientMe | null), expected })),
  sequences: clientSequences.map(({ name, events }) => {
    let state = initialClientState;
    return { name, initial: state, steps: events.map((event) => ({ event, state: (state = reduceClient(state, event)) })) };
  }),
});

function manifest(stage: SpoolStage, extra: Partial<SpoolManifest> = {}): SpoolManifest {
  return {
    version: MANIFEST_VERSION, accountId: 'acc-1', clientCaptureId: 'cc-1', createdAtMs: 0, updatedAtMs: 0, stage,
    captureId: stage === 'pending_create' ? null : 'cap-1', attempt: 1, protocolVersion: CLIENT_PROTOCOL_VERSION, gateConfigHash: gateConfigHash(),
    device: {}, camera: {}, verdict: null, checkingSinceMs: null, error: null, attemptTelemetry: null,
    frames: Array.from({ length: 10 }, (_, index) => ({ index, nativeId: `f${index}`, sha256: 'a'.repeat(64), bytes: 1, width: 1, height: 1, uploaded: index < 4, completed: index < 3 })),
    ...extra,
  } as SpoolManifest;
}
const outcomes: Array<[string, SpoolOutcome, number]> = [
  ['idle', { kind: 'idle' }, 0],
  ['uploading', { kind: 'waiting', manifest: manifest('uploading'), retryInMs: 2000, reason: 'server' }, 0],
  ['uploading_offline', { kind: 'waiting', manifest: manifest('uploading'), retryInMs: 2000, reason: 'offline' }, 0],
  ['pending_create', { kind: 'waiting', manifest: manifest('pending_create'), retryInMs: 2000, reason: 'offline' }, 0],
  ['checking_fresh', { kind: 'waiting', manifest: manifest('checking', { checkingSinceMs: 1000 }), retryInMs: 2000, reason: 'checking' }, 5_000],
  ['checking_slow', { kind: 'waiting', manifest: manifest('checking', { checkingSinceMs: 1000 }), retryInMs: 5000, reason: 'checking' }, 40_000],
  ['checking_measuring', { kind: 'waiting', manifest: manifest('checking', { checkingSinceMs: 1000, verdict: { id: 'cap-1', status: 'measuring', accepted_frames: 10, reasons: [] } as never }), retryInMs: 2000, reason: 'checking' }, 3_000],
  ['finalizing', { kind: 'waiting', manifest: manifest('finalizing'), retryInMs: 2000, reason: 'server' }, 0],
  ...(TERMINAL_STAGES.map((stage) => [stage, { kind: 'terminal', manifest: manifest(stage, { verdict: { id: 'cap-1', status: stage, accepted_frames: 10, reasons: ['glasses_detected'] } as never, error: stage === 'failed' ? 'upload_rejected_415' : null }) }, 0]) as Array<[string, SpoolOutcome, number]>),
  ['blocked', { kind: 'blocked', reason: 'session' }, 0],
];
write('spool.json', {
  timing: SPOOL_TIMING,
  max_age_ms: SPOOL_MAX_AGE_MS,
  manifest_version: MANIFEST_VERSION,
  terminal_stages: TERMINAL_STAGES,
  backoff_ms: Array.from({ length: 13 }, (_, n) => ({ n, ms: Math.min(SPOOL_TIMING.backoffBaseMs * 2 ** Math.min(n, 10), SPOOL_TIMING.backoffMaxMs) })),
  next_run_in_ms: [
    { outcome: { kind: 'idle' }, ms: nextRunInMs({ kind: 'idle' }) },
    { outcome: { kind: 'idle', telemetryRetryInMs: 4000 }, ms: nextRunInMs({ kind: 'idle', telemetryRetryInMs: 4000 } as SpoolOutcome) },
    { outcome: { kind: 'waiting', retryInMs: 9000, telemetryRetryInMs: 4000 }, ms: nextRunInMs({ kind: 'waiting', manifest: manifest('uploading'), retryInMs: 9000, reason: 'server', telemetryRetryInMs: 4000 } as SpoolOutcome) },
  ],
  phase_from_spool: outcomes.map(([name, outcome, nowMs]) => ({ name, now_ms: nowMs, outcome_kind: outcome.kind, stage: 'manifest' in outcome ? outcome.manifest.stage : null, phase: phaseFromSpool(outcome, nowMs) })),
  outcome_for_stage: (['pending_create', 'uploading', 'finalizing', 'checking', ...TERMINAL_STAGES] as SpoolStage[]).map((stage) => ({ stage, outcome: outcomeForStage(stage) })),
});

// capture flow sequences (synthetic frames, no image bytes)
const frames10 = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, width: 1, height: 1, sha256: 'a'.repeat(64), bytes: 1, meta: {} }));
const captureSequences: Array<{ name: string; events: CaptureEvent[] }> = [
  { name: 'happy', events: [{ type: 'START', nowMs: 1000 }, { type: 'BURST_STARTED', target: 10 }, { type: 'BURST_PROGRESS', progress: { accepted: 4, target: 10, elapsedMs: 900, topRejectReason: null } }, { type: 'BURST_RESULT', result: { status: 'complete', frames: frames10, topRejectReason: null } as never, nowMs: 3000 }, { type: 'ENQUEUED' }, { type: 'SPOOL_STATUS', outcome: outcomes[1]![1], nowMs: 4000 }, { type: 'SPOOL_STATUS', outcome: outcomes[4]![1], nowMs: 5000 }] },
  { name: 'partial_then_help', events: [{ type: 'START', nowMs: 0 }, { type: 'BURST_STARTED', target: 10 }, { type: 'BURST_RESULT', result: { status: 'partial', frames: frames10.slice(0, 4), topRejectReason: 'facing' } as never, nowMs: 30_000 }, { type: 'TICK', nowMs: 61_000 }, { type: 'RESUME', nowMs: 62_000 }] },
  { name: 'partial_late', events: [{ type: 'START', nowMs: 0 }, { type: 'BURST_STARTED', target: 10 }, { type: 'BURST_RESULT', result: { status: 'partial', frames: [], topRejectReason: 'light' } as never, nowMs: 61_000 }] },
  { name: 'camera_errors', events: [{ type: 'CAMERA_ERROR', code: 'internal' }, { type: 'START', nowMs: 0 }, { type: 'CAMERA_ERROR', code: 'permission_denied' }, { type: 'RESUME', nowMs: 10 }, { type: 'CAMERA_ERROR', code: 'camera_interrupted' }, { type: 'RESUME', nowMs: 20 }, { type: 'CAMERA_ERROR', code: 'model_unavailable' }] },
  { name: 'cancelled_burst', events: [{ type: 'START', nowMs: 0 }, { type: 'BURST_STARTED', target: 10 }, { type: 'BURST_RESULT', result: { status: 'cancelled', frames: [], topRejectReason: null } as never, nowMs: 100 }, { type: 'BURST_STARTED', target: 10 }, { type: 'BURST_FAILED', nowMs: 200 }] },
  { name: 'more_then_continue', events: [{ type: 'START', nowMs: 0 }, { type: 'BURST_STARTED', target: 10 }, { type: 'BURST_RESULT', result: { status: 'complete', frames: frames10, topRejectReason: null } as never, nowMs: 3000 }, { type: 'ENQUEUED' }, { type: 'SPOOL_STATUS', outcome: outcomes.find(([n]) => n === 'needs_more')![1], nowMs: 9000 }, { type: 'CONTINUE', nowMs: 9500 }] },
  { name: 'retake', events: [{ type: 'START', nowMs: 0 }, { type: 'BURST_STARTED', target: 10 }, { type: 'BURST_RESULT', result: { status: 'complete', frames: frames10, topRejectReason: null } as never, nowMs: 3000 }, { type: 'SPOOL_STATUS', outcome: outcomes.find(([n]) => n === 'needs_retake')![1], nowMs: 9000 }, { type: 'RETAKE' }] },
  { name: 'spool_during_tips_ignored', events: [{ type: 'SPOOL_STATUS', outcome: outcomes.find(([n]) => n === 'complete')![1], nowMs: 0 }, { type: 'SPOOL_STATUS', outcome: outcomes[1]![1], nowMs: 0 }] },
];
write('capture_flow.json', {
  guidance_limit_ms: 60_000,
  burst_disposition: [
    { result: { status: 'complete', frames: frames10, topRejectReason: null } },
    { result: { status: 'complete', frames: frames10.slice(0, 9), topRejectReason: null } },
    { result: { status: 'partial', frames: frames10.slice(0, 3), topRejectReason: 'light' } },
  ].map(({ result }) => {
    const d = burstDisposition(result as never);
    return { status: result.status, count: result.frames.length, keep: d.keep.map((f) => f.id), discard: d.discard };
  }),
  sequences: captureSequences.map(({ name, events }) => {
    let state = initialCaptureFlow(0);
    return { name, steps: events.map((event) => ({ event, state: (state = reduceCapture(state, event)) })) };
  }),
});

// --- telemetry -----------------------------------------------------------------------------------------------
write('telemetry.json', {
  max_reason_keys: MAX_REASON_KEYS,
  queue_max: TELEMETRY_QUEUE_MAX,
  attempt_limits: ATTEMPT_LIMITS,
  wire_reason: ['oneFace', 'distanceOrSize', 'centred', 'facing', 'light', 'expression', 'eyes', 'sharp', 'someNewReason', 'BAD-reason!', 'x'.repeat(50)].map((reason) => ({ reason, wire: wireReason(reason) })),
  wire_reason_counts: [{ input: { oneFace: 2, facing: 1, 'BAD!': 3 }, output: wireReasonCounts({ oneFace: 2, facing: 1, 'BAD!': 3 }) }],
});

console.log(`fixtures written to ${OUT}`);
