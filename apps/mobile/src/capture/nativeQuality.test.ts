/**
 * The code a native capture failure reaches the user as.
 *
 * The regression: `faceCount !== 1` was folded into a single `FT-SCAN-014`, so
 * "nobody is in frame" and "two people are in frame" — the two failures a user
 * can actually do something about — arrived as "quality could not be measured".
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { QUALITY_PROFILE_ARTIFACT } from '@facetype/contracts';

import { CaptureError } from './captureError.ts';
import { assertNativeQuality, type NativeQuality } from './nativeQuality.ts';

/**
 * The exact declaration the shipped ARCore module makes, field for field.
 *
 * Not a convenience object: it is the tuple under test. The waiver is granted
 * to this (profile, provider, version) and to nothing else, so every negative
 * case below is this tuple with exactly one field changed.
 */
const ANDROID = {
  profile: 'REDUCED_GEOMETRY_NO_OCCLUSION',
  provider: 'arcore',
  version: QUALITY_PROFILE_ARTIFACT.version,
} as const;

function quality(overrides: Partial<NativeQuality> = {}): NativeQuality {
  return {
    blur: 0.9,
    exposure: 0.9,
    occlusion: 0.05,
    neutrality: 0.95,
    faceCount: 1,
    yawDeg: 0,
    pitchDeg: 0,
    ...overrides,
  };
}

/**
 * The code `assertNativeQuality` reports, or `'accepted'`.
 *
 * The declaration arguments are optional here for the same reason they are
 * optional in the function: a caller that passes none is an older caller, and
 * must get the strict gate.
 */
function codeOf(
  overrides: Partial<NativeQuality>,
  declaration?: { profile?: string | null; provider?: string; version?: string | null },
): string {
  try {
    if (declaration === undefined) {
      assertNativeQuality(quality(overrides));
    } else {
      assertNativeQuality(
        quality(overrides),
        declaration.profile,
        declaration.provider,
        declaration.version,
      );
    }
  } catch (error) {
    assert.ok(error instanceof CaptureError, 'every rejection must carry a code');
    return error.code;
  }
  return 'accepted';
}

test('a complete, in-range quality record is accepted', () => {
  assert.equal(codeOf({}), 'accepted');
});

test('a measured count of zero is FT-SCAN-005, not a generic measurement failure', () => {
  assert.equal(codeOf({ faceCount: 0 }), 'FT-SCAN-005');
});

test('a measured count above one is FT-SCAN-004', () => {
  assert.equal(codeOf({ faceCount: 2 }), 'FT-SCAN-004');
  assert.equal(codeOf({ faceCount: 5 }), 'FT-SCAN-004');
});

test('an unmeasured count is FT-SCAN-014, because nothing was counted', () => {
  assert.equal(codeOf({ faceCount: null }), 'FT-SCAN-014');
  assert.equal(codeOf({ faceCount: Number.NaN }), 'FT-SCAN-014');
});

test('the count outranks a missing score, matching the server engine order', () => {
  // Both are wrong; the user is told the one they can act on.
  assert.equal(codeOf({ faceCount: 0, blur: null }), 'FT-SCAN-005');
  assert.equal(codeOf({ faceCount: 2, occlusion: null, neutrality: null }), 'FT-SCAN-004');
});

test('a genuinely unmeasured signal is still FT-SCAN-014', () => {
  // With no declaration at all, which is the strict UNKNOWN resolution.
  assert.equal(codeOf({ occlusion: null, neutrality: null }), 'FT-SCAN-014');
  assert.equal(codeOf({ blur: null }), 'FT-SCAN-014');
});

test('a score outside the unit interval is not trusted', () => {
  assert.equal(codeOf({ blur: 1.5 }), 'FT-SCAN-014');
  assert.equal(codeOf({ exposure: -0.1 }), 'FT-SCAN-014');
});

test('a non-finite pose angle is rejected rather than passed through', () => {
  assert.equal(codeOf({ yawDeg: Number.NaN }), 'FT-SCAN-014');
  assert.equal(codeOf({ pitchDeg: Number.POSITIVE_INFINITY }), 'FT-SCAN-014');
});

// ---------------------------------------------------------------------------
// Profile-aware validation (ADR-011).
//
// The live blocker: the shipped ARCore module declares
// REDUCED_GEOMETRY_NO_OCCLUSION and sends `occlusion: null` on purpose, and this
// gate rejected it with FT-SCAN-014 before `evaluateFrameQuality` could apply
// the approved waiver. Every capture on a Galaxy Tab S7 died here.
//
// The waiver is granted to one exact tuple. Each negative case below changes
// exactly one field of it, so a fix that widens the check — dropping the version
// comparison, ignoring the provider, treating "declared something" as enough,
// or waiving whatever happens to be null — fails at least one of them.
// ---------------------------------------------------------------------------

test('the exact Android reduced tuple may leave occlusion unmeasured', () => {
  assert.equal(
    codeOf({ occlusion: null }, { ...ANDROID }),
    'accepted',
    'the shipped ARCore declaration must get its approved occlusion waiver',
  );
});

test('the same null occlusion under FULL is refused', () => {
  // FULL waives nothing. A path that claims to measure everything and then
  // sends a null has contradicted itself.
  assert.equal(codeOf({ occlusion: null }, { ...ANDROID, profile: 'FULL' }), 'FT-SCAN-014');
});

test('an undeclared or unrecognised profile is refused', () => {
  for (const profile of [null, undefined, '', 'UNKNOWN', 'REDUCED', 'REDUCED_GEOMETRY', 'reduced_geometry_no_occlusion']) {
    assert.equal(
      codeOf({ occlusion: null }, { ...ANDROID, profile }),
      'FT-SCAN-014',
      `profile ${String(profile)} must not waive anything`,
    );
  }
  // And with no declaration argument at all.
  assert.equal(codeOf({ occlusion: null }), 'FT-SCAN-014');
});

test('the reduced profile is refused to every provider it is not granted to', () => {
  // ARKit measures occlusion, so claiming the ARCore waiver is a spoof whether
  // it is a bug or an attack. The closed mapping in the shared artifact — not
  // this module — is what says so.
  for (const provider of ['arkit', 'mediapipe', 'simulator', 'research_image', '', 'not_a_provider']) {
    assert.equal(
      codeOf({ occlusion: null }, { ...ANDROID, provider }),
      'FT-SCAN-014',
      `${provider} must not receive ARCore's waiver`,
    );
  }
});

test('a declaration carrying the wrong artifact version is refused', () => {
  // A build predating qp-1.0.0 can put a familiar string under a familiar key
  // without implementing what the key means.
  for (const version of [null, undefined, '', 'qp-0.9.0', 'qp-1.0.1', 'qp-1.0.0 ', 'q-1.0.0']) {
    assert.equal(
      codeOf({ occlusion: null }, { ...ANDROID, version }),
      'FT-SCAN-014',
      `version ${String(version)} must not resolve the waiver`,
    );
  }
});

test('the reduced profile waives occlusion and nothing else', () => {
  // The single most important assertion here. Any other null is still an
  // unmeasured signal under this exact, granted, current declaration.
  for (const signal of ['blur', 'exposure', 'neutrality'] as const) {
    assert.equal(
      codeOf({ [signal]: null }, { ...ANDROID }),
      'FT-SCAN-014',
      `${signal} is not waived by the reduced profile`,
    );
  }
  assert.equal(codeOf({ blur: null, occlusion: null }, { ...ANDROID }), 'FT-SCAN-014');
  assert.equal(codeOf({ yawDeg: Number.NaN }, { ...ANDROID }), 'FT-SCAN-014');
  assert.equal(codeOf({ pitchDeg: Number.NaN, occlusion: null }, { ...ANDROID }), 'FT-SCAN-014');
});

test('an unmeasured face count is FT-SCAN-014 even under the reduced profile', () => {
  assert.equal(codeOf({ faceCount: null, occlusion: null }, { ...ANDROID }), 'FT-SCAN-014');
  assert.equal(codeOf({ faceCount: Number.NaN, occlusion: null }, { ...ANDROID }), 'FT-SCAN-014');
});

test('the face count keeps its priority under the reduced profile', () => {
  // The waiver changes which signals must be present. It does not change which
  // answer the user is given when the detector did produce a count.
  assert.equal(codeOf({ faceCount: 0, occlusion: null }, { ...ANDROID }), 'FT-SCAN-005');
  assert.equal(codeOf({ faceCount: 2, occlusion: null }, { ...ANDROID }), 'FT-SCAN-004');
  assert.equal(codeOf({ faceCount: 5, occlusion: null }, { ...ANDROID }), 'FT-SCAN-004');
  // ...and still outranks a missing non-waived score.
  assert.equal(codeOf({ faceCount: 0, blur: null, occlusion: null }, { ...ANDROID }), 'FT-SCAN-005');
  assert.equal(codeOf({ faceCount: 2, blur: null, occlusion: null }, { ...ANDROID }), 'FT-SCAN-004');
});

test('a waiver is permission not to measure, not permission to send a bad number', () => {
  // A profile that waives `occlusion` says nothing about an occlusion score
  // that *is* present: out of [0,1] it is refused exactly as before.
  assert.equal(codeOf({ occlusion: 1.5 }, { ...ANDROID }), 'FT-SCAN-014');
  assert.equal(codeOf({ occlusion: -0.1 }, { ...ANDROID }), 'FT-SCAN-014');
  assert.equal(codeOf({ blur: 1.5, occlusion: null }, { ...ANDROID }), 'FT-SCAN-014');
});

test('a fully measured Android frame is accepted under its own declaration', () => {
  // Declaring the reduced profile does not force the signal to be absent.
  assert.equal(codeOf({}, { ...ANDROID }), 'accepted');
  assert.equal(codeOf({}, { ...ANDROID, profile: 'FULL' }), 'accepted');
});

// ---------------------------------------------------------------------------
// A waiver permits exactly one thing: the literal `null`.
//
// The gap Codex found in c77bf05: the first version asked "is this a usable
// number?" and treated every answer of "no" as an exercise of the waiver. So
// under the granted Android tuple, `occlusion: NaN` — a crashed estimator, an
// uninitialised buffer, a mismatched native build — was accepted as an honest
// "not measured", recorded as a limitation, and passed. The `NativeQuality`
// type is erased at runtime and what actually arrives is whatever JSON the
// bridge put on the wire, so this is the one gate where a runtime type check
// is not paranoia.
//
// Every case below is the exact granted tuple. If the distinction between
// "declared absent" and "came back broken" is ever collapsed again, in either
// direction, at least one of them fails.
// ---------------------------------------------------------------------------

/** Values that are not measurements and are not `null` either. */
const NOT_A_MEASUREMENT: readonly unknown[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  undefined,
  'null',
  '0.05',
  {},
  [],
  true,
  false,
];

test('a waived signal that came back broken is FT-SCAN-014, not a waiver', () => {
  for (const value of NOT_A_MEASUREMENT) {
    assert.equal(
      // The cast is the point: nothing stops a native module putting this on
      // the wire, and the type that says otherwise does not exist at runtime.
      codeOf({ occlusion: value as number | null }, { ...ANDROID }),
      'FT-SCAN-014',
      `occlusion=${String(value)} is corrupt data, not a declared absence`,
    );
  }
});

test('only an explicit null exercises the occlusion waiver', () => {
  // The positive half of the same rule, so neither can be satisfied by
  // loosening the other.
  assert.equal(codeOf({ occlusion: null }, { ...ANDROID }), 'accepted');
  assert.equal(codeOf({ occlusion: 0.05 }, { ...ANDROID }), 'accepted');
});

test('a broken non-waived signal is FT-SCAN-014 under the granted tuple too', () => {
  for (const signal of ['blur', 'exposure', 'neutrality'] as const) {
    for (const value of NOT_A_MEASUREMENT) {
      assert.equal(
        codeOf({ [signal]: value as number | null }, { ...ANDROID }),
        'FT-SCAN-014',
        `${signal}=${String(value)} must fail`,
      );
    }
  }
});

test('a broken face count is FT-SCAN-014 and never a count', () => {
  // `true` would be 1 and `[]` would be 0 under `Number()` coercion. Neither
  // is a face count, and neither may become one.
  for (const value of NOT_A_MEASUREMENT) {
    assert.equal(
      codeOf({ faceCount: value as number | null }, { ...ANDROID }),
      'FT-SCAN-014',
      `faceCount=${String(value)} must not be coerced into a count`,
    );
  }
});

test('a broken signal does not outrank a measured face-count answer', () => {
  // The priority rule is about what the *detector* found, and it found
  // something here. Corruption elsewhere does not take that away.
  assert.equal(
    codeOf({ faceCount: 0, occlusion: Number.NaN }, { ...ANDROID }),
    'FT-SCAN-005',
  );
  assert.equal(
    codeOf({ faceCount: 2, occlusion: Number.POSITIVE_INFINITY }, { ...ANDROID }),
    'FT-SCAN-004',
  );
});

test('a broken pose angle is still rejected under the granted tuple', () => {
  // No profile waives pose, so this is unchanged — asserted here so a future
  // profile cannot quietly acquire it.
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined, null, 'ok']) {
    assert.equal(
      codeOf({ yawDeg: value as number, occlusion: null }, { ...ANDROID }),
      'FT-SCAN-014',
      `yawDeg=${String(value)} must fail`,
    );
    assert.equal(
      codeOf({ pitchDeg: value as number, occlusion: null }, { ...ANDROID }),
      'FT-SCAN-014',
      `pitchDeg=${String(value)} must fail`,
    );
  }
});
