/**
 * Native rejection codes have to survive the crossing into JavaScript.
 *
 * The regression these lock down is real and shipped: every native rejection
 * -- including the ones the Kotlin and Swift modules work hardest to
 * distinguish -- was reported to the user as `FT-SYS-003`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CaptureError, captureError, isFaceTypeErrorCode, normalizeCaptureError } from './captureError.ts';

/** How React Native surfaces `promise.reject(code, message)` from Kotlin/Swift. */
function nativeRejection(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

test('a native rejection keeps the code the native module chose', () => {
  for (const code of ['FT-SCAN-004', 'FT-SCAN-005', 'FT-SCAN-014', 'FT-REC-005', 'FT-REC-006']) {
    const normalized = normalizeCaptureError(nativeRejection(code, 'native said so'));
    assert.equal(normalized.code, code);
    assert.equal(normalized.message, 'native said so');
  }
});

test('the generated API client error keeps its errorCode', () => {
  const apiError = Object.assign(new Error('api said so'), { errorCode: 'FT-SCAN-011' });

  assert.equal(normalizeCaptureError(apiError).code, 'FT-SCAN-011');
});

test('an already-typed CaptureError passes through unchanged', () => {
  const original = captureError('FT-SCAN-006', 'blurred');

  assert.equal(normalizeCaptureError(original), original);
});

test('a genuinely unclassified failure becomes the fallback code', () => {
  assert.equal(normalizeCaptureError(new Error('socket hang up')).code, 'FT-SYS-003');
  assert.equal(normalizeCaptureError('a string').code, 'FT-SYS-003');
  assert.equal(normalizeCaptureError(null).code, 'FT-SYS-003');
  assert.equal(normalizeCaptureError(undefined).code, 'FT-SYS-003');
});

test('a caller may choose a different fallback without affecting carried codes', () => {
  assert.equal(normalizeCaptureError(new Error('nope'), 'FT-REC-005').code, 'FT-REC-005');
  assert.equal(
    normalizeCaptureError(nativeRejection('FT-SCAN-005', 'no face'), 'FT-REC-005').code,
    'FT-SCAN-005',
  );
});

test('message text is never parsed for a code', () => {
  // An error whose *text* mentions a code but whose `code` property does not:
  // trusting the message would make every translated string load-bearing.
  const misleading = new Error('FT-SCAN-004: more than one face');

  assert.equal(normalizeCaptureError(misleading).code, 'FT-SYS-003');
});

test('a malformed code is not trusted', () => {
  assert.equal(normalizeCaptureError(nativeRejection('EUNSPECIFIED', 'rn default')).code, 'FT-SYS-003');
  assert.equal(normalizeCaptureError(nativeRejection('ft-scan-004', 'lowercase')).code, 'FT-SYS-003');
  assert.equal(normalizeCaptureError(nativeRejection('FT-SCAN-4', 'short')).code, 'FT-SYS-003');
});

test('isFaceTypeErrorCode recognises the code shape and nothing else', () => {
  assert.equal(isFaceTypeErrorCode('FT-SCAN-014'), true);
  assert.equal(isFaceTypeErrorCode('FT-SYS-003'), true);
  assert.equal(isFaceTypeErrorCode('FT-SCAN-0141'), false);
  assert.equal(isFaceTypeErrorCode(''), false);
  assert.equal(isFaceTypeErrorCode(404), false);
});

test('a CaptureError is a real Error carrying its cause', () => {
  const cause = new Error('underlying');
  const error = captureError('FT-REC-006', 'topology mismatch', { cause });

  assert.ok(error instanceof Error);
  assert.ok(error instanceof CaptureError);
  assert.equal(error.code, 'FT-REC-006');
  assert.equal((error as { cause?: unknown }).cause, cause);
});
