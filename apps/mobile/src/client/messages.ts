/**
 * Which one sentence to show for a native reject reason or a server verdict
 * reason. Pure, so every contract value is checked to have a message.
 */

import type { ClientErrorKind } from './api/clientApi.ts';
import type { GuidanceMessage } from './guidance/guidance.ts';
import type { RejectReason } from './native/types.ts';
import type { StringKey } from './strings.ts';

/** Every `topRejectReason` the native contract may send (§5.9). */
export const REJECT_REASONS: readonly RejectReason[] = [
  'oneFace',
  'distanceOrSize',
  'centred',
  'facing',
  'light',
  'expression',
  'eyes',
  'sharp',
  'effects_active',
  'internal',
];

/** Native check name → the one message that helps (capture spec §3 wording). */
export function rejectReasonKey(reason: string | null, current: GuidanceMessage): StringKey | null {
  switch (reason) {
    case null:
      return null;
    case 'oneFace':
      return 'guide.multiple_faces';
    case 'distanceOrSize':
      return current === 'move_back' ? 'guide.move_back' : 'guide.move_closer';
    case 'centred':
      return 'guide.centre';
    case 'facing':
      return 'guide.look_straight';
    case 'light':
      return 'guide.light';
    case 'expression':
      return 'guide.no_smile';
    case 'eyes':
      return 'guide.eyes';
    case 'sharp':
      return 'guide.hold_still';
    case 'effects_active':
      return 'burst.effects';
    case 'internal':
      return 'burst.internal';
    default:
      return null;
  }
}

/** Server verdict reason → a specific retake sentence. */
export function verdictReasonKey(reason: string): StringKey {
  const r = reason.toLowerCase();
  // The server's post-finalize integrity re-hash (run_capture_check).
  if (r === 'upload_integrity') return 'reason.upload_integrity';
  if (r.includes('glasses')) return 'reason.glasses';
  if (r.includes('cover') || r.includes('occlu') || r.includes('mask')) return 'reason.face_covered';
  if (r.includes('second') || r.includes('multiple')) return 'reason.second_face';
  if (r.includes('frames') || r.includes('too_few')) return 'reason.too_few_frames';
  if (r.includes('quality') || r.includes('blur') || r.includes('light') || r.includes('sharp')) return 'reason.quality';
  return 'reason.generic';
}

/**
 * Every FT code a client route can return → one short Arabic sentence.
 * `tests/contract/test_client_mobile_api_contract.py` fails if the server
 * registry gains an FT-CLIENT-* code that is missing here.
 */
export const API_ERROR_KEYS: Readonly<Record<string, StringKey>> = {
  'FT-CLIENT-AUTH-UNCONFIGURED': 'signin.server_unconfigured',
  'FT-CLIENT-NONCE-INVALID': 'apierr.nonce_invalid',
  'FT-CLIENT-ACCOUNT-WITHDRAWING': 'apierr.account_withdrawing',
  'FT-CLIENT-PROFILE-INVALID': 'setup.fix_fields',
  'FT-CLIENT-ID-TAKEN': 'apierr.id_taken',
  'FT-CLIENT-PROFILE-REQUIRED': 'apierr.profile_required',
  'FT-CLIENT-CAPTURE-NOT-FOUND': 'apierr.capture_not_found',
  'FT-CLIENT-CAPTURE-CONFLICT': 'apierr.capture_conflict',
  'FT-CLIENT-CAPTURE-STATE': 'apierr.capture_state',
  'FT-CLIENT-FRAME-IMMUTABLE': 'apierr.frame_immutable',
  'FT-CLIENT-UPLOAD-MISSING': 'apierr.upload_missing',
  'FT-CLIENT-UPLOAD-MISMATCH': 'apierr.upload_mismatch',
  'FT-PRIV-003': 'apierr.consent_required',
  'FT-AUTH-001': 'common.session_expired',
  'FT-AUTH-002': 'signin.server_unconfigured',
  'FT-AUTH-003': 'common.session_expired',
  'FT-SYS-001': 'apierr.rate_limited',
  'FT-SYS-002': 'apierr.server',
};

const KIND_KEYS: Partial<Record<ClientErrorKind, StringKey>> = {
  network: 'common.network',
  session_expired: 'common.session_expired',
  unauthorized: 'common.session_expired',
  rate_limited: 'apierr.rate_limited',
  server: 'apierr.server',
};

/** The sentence for a server error code, else for its kind; null = show the generic «({code})» line. */
export function apiErrorKey(code: string | null | undefined, kind?: ClientErrorKind): StringKey | null {
  if (code && code in API_ERROR_KEYS) return API_ERROR_KEYS[code]!;
  return (kind && KIND_KEYS[kind]) ?? null;
}

const FIELD_KEYS: Readonly<Record<string, StringKey>> = {
  full_name: 'err.full_name',
  id_issuing_country: 'err.country',
  id_document_type: 'err.id_type',
  id_number: 'err.id_generic',
  phone: 'err.phone',
  sex: 'err.sex',
  birth_date: 'err.birth_date',
  nationality: 'err.nationality',
};

/**
 * A server field refusal (`action.fields` reason, or a 422 contract message)
 * → the same Arabic sentence the local check shows. Server text is never
 * displayed: it is English and may change.
 */
export function profileFieldErrorKey(field: string, reason: string): StringKey | null {
  if (field === 'birth_date' && reason === 'under_18') return 'err.underage';
  if (field === 'id_number' && reason === 'checksum') return 'err.id_checksum';
  return FIELD_KEYS[field] ?? null;
}
