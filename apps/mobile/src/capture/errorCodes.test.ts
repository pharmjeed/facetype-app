import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CAMERA_PERMISSION_DENIED,
  CAMERA_PERMISSION_UNAVAILABLE,
  CAPTURE_UNAVAILABLE,
  FT_ERROR_CODE_PATTERN,
  nativeCaptureErrorCode,
  resolveCaptureErrorCode,
  UNKNOWN_ERROR_CODE,
} from './errorCodes.ts';

/**
 * React Native builds the error a rejected native promise produces by taking
 * the reject block's `(code, message)` and doing roughly
 * `Object.assign(new Error(message), {code})`. Reproducing that shape here is
 * what makes these assertions about the real bridge rather than about a
 * convenient fiction.
 */
function nativeRejection(code: string, message = 'native failure'): Error {
  return Object.assign(new Error(message), { code });
}

test('a native reject code survives to the caller', () => {
  for (const code of ['FT-SCAN-004', 'FT-SCAN-005', 'FT-SCAN-014', 'FT-REC-005']) {
    assert.equal(nativeCaptureErrorCode(nativeRejection(code)), code);
  }
});

test('the pose hints ScanScreen can show are all reachable codes', () => {
  // Exactly the keys of ScanScreen's ERROR_HINT table. Each one is only
  // useful if a capture failure can actually arrive carrying it; before
  // resolveCaptureErrorCode existed, every one of them was replaced by
  // FT-SYS-003 and the table was dead code.
  const hinted = [
    'FT-SCAN-004',
    'FT-SCAN-005',
    'FT-SCAN-006',
    'FT-SCAN-007',
    'FT-SCAN-008',
    'FT-SCAN-009',
    'FT-SCAN-010',
  ];
  for (const code of hinted) {
    assert.equal(
      resolveCaptureErrorCode(nativeRejection(code), null),
      code,
      `${code} must reach ScanScreen's hint table`,
    );
  }
});

test('a server error code wins over anything on the thrown object', () => {
  // The server decided something about this observation; that decision is
  // more specific than whatever local code happened to be attached.
  assert.equal(resolveCaptureErrorCode(nativeRejection('FT-REC-005'), 'FT-SCAN-013'), 'FT-SCAN-013');
});

test('the camera-permission codes both platforms raise are preserved', () => {
  // iOS rejects start() with this code; Android throws it from consent().
  assert.equal(
    nativeCaptureErrorCode(nativeRejection(CAMERA_PERMISSION_DENIED)),
    CAMERA_PERMISSION_DENIED,
  );
  assert.equal(
    nativeCaptureErrorCode(new Error(CAMERA_PERMISSION_DENIED)),
    CAMERA_PERMISSION_DENIED,
  );
  assert.equal(
    nativeCaptureErrorCode(new Error(CAMERA_PERMISSION_UNAVAILABLE)),
    CAMERA_PERMISSION_UNAVAILABLE,
  );
});

test('nothing that is not a code is reported as one', () => {
  const notCodes: unknown[] = [
    new Error('Network request failed'),
    new Error(''),
    nativeRejection('EUNSPECIFIED'),
    nativeRejection('FT-SCAN-4'),
    nativeRejection('ft-scan-004'),
    nativeRejection('prefix FT-SCAN-004 suffix'),
    // A code has to *announce* the failure, not merely appear in the prose
    // describing it. Loosening the message parser far enough to catch these
    // would let any sentence quoting a code impersonate one.
    new Error('prefix FT-SCAN-004 suffix'),
    new Error('failed with FT-SCAN-014'),
    new Error('FT-SCAN-014abc: not a code'),
    new Error('ft-scan-014: lowercase is not a code'),
    Object.assign(new Error('x'), { code: 500 }),
    'FT-SCAN-004',
    null,
    undefined,
    42,
  ];
  for (const value of notCodes) {
    assert.equal(nativeCaptureErrorCode(value), null, `${String(value)} is not an error code`);
    assert.equal(resolveCaptureErrorCode(value, null), UNKNOWN_ERROR_CODE);
  }
});

test('the code pattern matches the shape the error-code spec defines', () => {
  assert.ok(FT_ERROR_CODE_PATTERN.test('FT-SCAN-014'));
  assert.ok(FT_ERROR_CODE_PATTERN.test('FT-REC-005'));
  assert.ok(FT_ERROR_CODE_PATTERN.test('FT-SYS-003'));
  assert.ok(!FT_ERROR_CODE_PATTERN.test('FT-SCAN-0141'));
  assert.ok(!FT_ERROR_CODE_PATTERN.test('FT--004'));
});

test('the client-side guards that actually fire keep their codes', () => {
  // Verbatim from the throw sites: `assertMeasuredQuality` in App.tsx and the
  // eight validation guards in NativeGeometryProvider.capture. These are the
  // failures a user hits most often -- a bridge that returned an unmeasurable
  // quality signal, or numbers that did not satisfy the coordinate contract --
  // and the first version of this module missed every one of them, because it
  // only matched whole-string codes and these announce themselves as
  // `CODE: explanation`.
  const thrown: Array<[string, string]> = [
    ['FT-SCAN-014: unmeasured quality signals: blur,exposure', 'FT-SCAN-014'],
    ['FT-SCAN-014: blur is outside [0,1]', 'FT-SCAN-014'],
    ['FT-SCAN-014: native face count or pose is invalid', 'FT-SCAN-014'],
    ['FT-REC-006: arkit returned unexpected topology arcore-face-mesh-468', 'FT-REC-006'],
    ['FT-REC-006: native head pose is not a finite row-major affine matrix', 'FT-REC-006'],
    ['FT-REC-006: topology adapter did not produce 478 points', 'FT-REC-006'],
    ['FT-REC-005: native capture module is unavailable', 'FT-REC-005'],
  ];
  for (const [message, expected] of thrown) {
    assert.equal(resolveCaptureErrorCode(new Error(message), null), expected, message);
  }
});

test('a bare code as the whole message still resolves', () => {
  assert.equal(nativeCaptureErrorCode(new Error('FT-SCAN-004')), 'FT-SCAN-004');
  assert.equal(nativeCaptureErrorCode(new Error(CAPTURE_UNAVAILABLE)), CAPTURE_UNAVAILABLE);
});

test('a native reject code on .code still wins over the message', () => {
  // RN sets both; the code is the authoritative one, and the message is free
  // text that may happen to start with something code-shaped.
  const error = Object.assign(new Error('FT-REC-006: something else entirely'), {
    code: 'FT-SCAN-004',
  });
  assert.equal(nativeCaptureErrorCode(error), 'FT-SCAN-004');
});
