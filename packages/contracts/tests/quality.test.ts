/**
 * The client-side FT-03 gate.
 *
 * Every threshold gets a case on both sides of the line, because a gate that
 * is present but mis-wired is worse than no gate: it produces an authoritative
 * "accepted" for a frame the server is about to reject.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateFrameQuality,
  meanConfidence,
  QUALITY_THRESHOLD_ARTIFACT,
  type FrameQualitySignals,
} from '../src/index.ts';

const GOOD_CONFIDENCE = 0.9;

function quality(overrides: Partial<FrameQualitySignals> = {}): FrameQualitySignals {
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

test('a good frontal frame passes', () => {
  const verdict = evaluateFrameQuality(quality(), 'front', GOOD_CONFIDENCE);
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.primaryErrorCode, null);
  assert.equal(verdict.qualityVersion, QUALITY_THRESHOLD_ARTIFACT.version);
});

test('a frame with no face is FT-SCAN-005 and one with several is FT-SCAN-004', () => {
  assert.equal(
    evaluateFrameQuality(quality({ faceCount: 0 }), 'front', GOOD_CONFIDENCE).primaryErrorCode,
    'FT-SCAN-005',
  );
  assert.equal(
    evaluateFrameQuality(quality({ faceCount: 3 }), 'front', GOOD_CONFIDENCE).primaryErrorCode,
    'FT-SCAN-004',
  );
});

test('blur is gated at the artifact threshold, not near it', () => {
  const atThreshold = quality({ blur: QUALITY_THRESHOLD_ARTIFACT.blur_min });
  assert.equal(evaluateFrameQuality(atThreshold, 'front', GOOD_CONFIDENCE).pass, true);

  const justBelow = quality({ blur: QUALITY_THRESHOLD_ARTIFACT.blur_min - 0.001 });
  const verdict = evaluateFrameQuality(justBelow, 'front', GOOD_CONFIDENCE);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.primaryErrorCode, 'FT-SCAN-006');
});

test('under- and over-exposure are distinguished so the prompt can differ', () => {
  assert.equal(
    evaluateFrameQuality(quality({ exposure: 0.2 }), 'front', GOOD_CONFIDENCE).primaryErrorCode,
    'FT-SCAN-007',
  );
  assert.equal(
    evaluateFrameQuality(quality({ exposure: 0.6 }), 'front', GOOD_CONFIDENCE).primaryErrorCode,
    'FT-SCAN-008',
  );
  assert.equal(
    evaluateFrameQuality(
      quality({ exposure: QUALITY_THRESHOLD_ARTIFACT.exposure_min }),
      'front',
      GOOD_CONFIDENCE,
    ).pass,
    true,
  );
});

test('occlusion above the maximum is FT-SCAN-009', () => {
  const occluded = quality({ occlusion: QUALITY_THRESHOLD_ARTIFACT.occlusion_max + 0.01 });
  assert.equal(
    evaluateFrameQuality(occluded, 'front', GOOD_CONFIDENCE).primaryErrorCode,
    'FT-SCAN-009',
  );
  assert.equal(
    evaluateFrameQuality(
      quality({ occlusion: QUALITY_THRESHOLD_ARTIFACT.occlusion_max }),
      'front',
      GOOD_CONFIDENCE,
    ).pass,
    true,
  );
});

test('a non-neutral expression is FT-SCAN-010', () => {
  const smiling = quality({ neutrality: QUALITY_THRESHOLD_ARTIFACT.neutrality_min - 0.01 });
  assert.equal(
    evaluateFrameQuality(smiling, 'front', GOOD_CONFIDENCE).primaryErrorCode,
    'FT-SCAN-010',
  );
});

test('a badly blurred and occluded frame is not silently accepted', () => {
  // The exact frame the pre-gate client uploaded: every signal present, every
  // one of them terrible.
  const bad = quality({ blur: 0.01, occlusion: 0.99, exposure: 0.02, neutrality: 0.1 });

  const verdict = evaluateFrameQuality(bad, 'front', GOOD_CONFIDENCE);

  assert.equal(verdict.pass, false);
  assert.deepEqual(verdict.failures, [
    'FT-SCAN-006',
    'FT-SCAN-007',
    'FT-SCAN-009',
    'FT-SCAN-010',
  ]);
  assert.equal(verdict.primaryErrorCode, 'FT-SCAN-006');
});

test('an unmeasured signal is FT-SCAN-014 exactly once, ahead of everything else', () => {
  const unmeasured = quality({ occlusion: null, neutrality: null });

  const verdict = evaluateFrameQuality(unmeasured, 'front', GOOD_CONFIDENCE);

  assert.equal(verdict.pass, false);
  assert.equal(verdict.primaryErrorCode, 'FT-SCAN-014');
  assert.equal(verdict.failures.filter((code) => code === 'FT-SCAN-014').length, 1);
  // The unknown defaults are the failing ones, so the frame is never rescued
  // by treating "not measured" as "fine".
  assert.ok(verdict.failures.includes('FT-SCAN-009'));
  assert.ok(verdict.failures.includes('FT-SCAN-010'));
});

test('an Android capture with real blur and exposure still fails closed today', () => {
  // Exactly what the ARCore path now produces: measured blur/exposure/count,
  // and an explicit "not measured" for the two signals no honest estimator
  // exists for yet.
  const androidToday = quality({ occlusion: null, neutrality: null, blur: 0.82, exposure: 0.78 });

  const verdict = evaluateFrameQuality(androidToday, 'front', GOOD_CONFIDENCE);

  assert.equal(verdict.pass, false);
  assert.equal(verdict.primaryErrorCode, 'FT-SCAN-014');
});

test('low landmark confidence is FT-SCAN-014', () => {
  const verdict = evaluateFrameQuality(
    quality(),
    'front',
    QUALITY_THRESHOLD_ARTIFACT.landmark_confidence_min - 0.01,
  );
  assert.equal(verdict.pass, false);
  assert.equal(verdict.primaryErrorCode, 'FT-SCAN-014');
});

test('a pose outside its protocol band is FT-SCAN-011', () => {
  const offAxis = quality({ yawDeg: 20 });
  assert.equal(
    evaluateFrameQuality(offAxis, 'front', GOOD_CONFIDENCE).primaryErrorCode,
    'FT-SCAN-011',
  );
  assert.equal(evaluateFrameQuality(quality({ yawDeg: 25 }), 'left_25', GOOD_CONFIDENCE).pass, true);
});

test('a lateral pose that turned the wrong way is a miss, not a near-miss', () => {
  // Correct magnitude, wrong hemisphere: the reconstruction needs both sides,
  // so this cannot be accepted as "close enough".
  assert.equal(
    evaluateFrameQuality(quality({ yawDeg: -25 }), 'left_25', GOOD_CONFIDENCE).primaryErrorCode,
    'FT-SCAN-011',
  );
  assert.equal(
    evaluateFrameQuality(quality({ yawDeg: 25 }), 'right_25', GOOD_CONFIDENCE).primaryErrorCode,
    'FT-SCAN-011',
  );
  assert.equal(
    evaluateFrameQuality(quality({ pitchDeg: -15 }), 'up_15', GOOD_CONFIDENCE).primaryErrorCode,
    'FT-SCAN-011',
  );
  assert.equal(
    evaluateFrameQuality(quality({ pitchDeg: 15 }), 'down_15', GOOD_CONFIDENCE).primaryErrorCode,
    'FT-SCAN-011',
  );
});

test('vertical poses are accepted inside their own band', () => {
  assert.equal(evaluateFrameQuality(quality({ pitchDeg: 15 }), 'up_15', GOOD_CONFIDENCE).pass, true);
  assert.equal(
    evaluateFrameQuality(quality({ pitchDeg: -15 }), 'down_15', GOOD_CONFIDENCE).pass,
    true,
  );
});

test('a non-finite pose angle is a failure rather than a pass', () => {
  assert.equal(
    evaluateFrameQuality(quality({ yawDeg: Number.NaN }), 'front', GOOD_CONFIDENCE).primaryErrorCode,
    'FT-SCAN-011',
  );
});

test('meanConfidence averages and survives an empty vector', () => {
  assert.equal(meanConfidence([1, 0.5, 0]), 0.5);
  assert.equal(meanConfidence(new Float32Array(0)), 0);
});

// ---------------------------------------------------------------------------
// Profiles, and the one representation a waiver accepts.
//
// `evaluateFrameQuality` had the same defect the native bridge had: it asked
// "is this a usable number?" and treated every answer of "no" as an exercise
// of the waiver. So under a granted profile, `occlusion: NaN` was recorded as
// a limitation, skipped the gate keyed on it, and passed as REDUCED — a
// crashed estimator laundered into an approved absence.
//
// The rule, in both languages: a profile grants permission to *say* a signal
// was not measured. It grants no tolerance for one that came back broken.
// `QualityEngine.evaluate_frame` draws the identical line.
// ---------------------------------------------------------------------------

const ARCORE_REDUCED = ['REDUCED_GEOMETRY_NO_OCCLUSION', 'arcore', 'qp-1.0.0'] as const;

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
];

test('the granted tuple waives an explicitly null occlusion', () => {
  const verdict = evaluateFrameQuality(
    quality({ occlusion: null }),
    'front',
    GOOD_CONFIDENCE,
    ...ARCORE_REDUCED,
  );
  assert.equal(verdict.pass, true);
  assert.equal(verdict.qualityProfile, 'REDUCED_GEOMETRY_NO_OCCLUSION');
  assert.equal(verdict.qualityTier, 'REDUCED');
  assert.deepEqual(verdict.measurementLimitations, ['OCCLUSION_UNASSESSED']);
});

test('a broken occlusion is a failure, never a limitation', () => {
  for (const value of NOT_A_MEASUREMENT) {
    const verdict = evaluateFrameQuality(
      quality({ occlusion: value as number | null }),
      'front',
      GOOD_CONFIDENCE,
      ...ARCORE_REDUCED,
    );
    const shown = String(value);
    assert.equal(verdict.pass, false, `occlusion=${shown} must not pass`);
    assert.equal(verdict.primaryErrorCode, 'FT-SCAN-014', `occlusion=${shown}`);
    // The half that matters most: corruption must not be *recorded* as an
    // approved absence. A limitation code is a claim about the device, and it
    // travels with the observation for the rest of its life.
    assert.deepEqual(verdict.measurementLimitations, [], `occlusion=${shown}`);
    assert.equal(verdict.qualityTier, 'FULL', `occlusion=${shown}`);
  }
});

test('a broken non-waived signal is a failure under the granted tuple too', () => {
  for (const signal of ['blur', 'exposure', 'neutrality', 'faceCount'] as const) {
    for (const value of NOT_A_MEASUREMENT) {
      const verdict = evaluateFrameQuality(
        quality({ [signal]: value as number | null }),
        'front',
        GOOD_CONFIDENCE,
        ...ARCORE_REDUCED,
      );
      assert.ok(
        verdict.failures.includes('FT-SCAN-014'),
        `${signal}=${String(value)} must fail FT-SCAN-014`,
      );
      assert.deepEqual(verdict.measurementLimitations, [], `${signal}=${String(value)}`);
    }
  }
});

test('an explicit null the profile does not waive is still a failure', () => {
  for (const signal of ['blur', 'exposure', 'neutrality', 'faceCount'] as const) {
    const verdict = evaluateFrameQuality(
      quality({ [signal]: null }),
      'front',
      GOOD_CONFIDENCE,
      ...ARCORE_REDUCED,
    );
    assert.ok(verdict.failures.includes('FT-SCAN-014'), signal);
    assert.deepEqual(verdict.measurementLimitations, [], signal);
  }
});

test('a null occlusion outside the granted tuple waives nothing', () => {
  const refused: readonly (readonly [string | null, string, string | null])[] = [
    ['FULL', 'arcore', 'qp-1.0.0'],
    ['REDUCED_GEOMETRY_NO_OCCLUSION', 'arkit', 'qp-1.0.0'],
    ['REDUCED_GEOMETRY_NO_OCCLUSION', 'simulator', 'qp-1.0.0'],
    ['REDUCED_GEOMETRY_NO_OCCLUSION', 'arcore', 'qp-0.9.0'],
    ['REDUCED_GEOMETRY_NO_OCCLUSION', 'arcore', null],
    ['REDUCED_GEOMETRY', 'arcore', 'qp-1.0.0'],
    [null, 'arcore', 'qp-1.0.0'],
  ];
  for (const [profile, provider, version] of refused) {
    const verdict = evaluateFrameQuality(
      quality({ occlusion: null }),
      'front',
      GOOD_CONFIDENCE,
      profile,
      provider,
      version,
    );
    const shown = `${String(profile)}/${provider}/${String(version)}`;
    assert.equal(verdict.pass, false, shown);
    assert.ok(verdict.failures.includes('FT-SCAN-014'), shown);
    assert.notEqual(verdict.qualityProfile, 'REDUCED_GEOMETRY_NO_OCCLUSION', shown);
    assert.deepEqual(verdict.measurementLimitations, [], shown);
    assert.equal(verdict.qualityTier, 'FULL', shown);
  }
});

test('the tier reports what was waived on this frame, not what could be', () => {
  // `QualityEngine.evaluate_frame` computes
  // `profile.tier if limitations else QualityTier.FULL`. This side fell back
  // to `profile.tier`, so a fully measured ARCore frame declaring the reduced
  // profile reported REDUCED on the client and FULL on the server -- for the
  // same frame, from the same artifact. The field's own documentation says
  // "REDUCED when a signal was genuinely waived on this frame".
  assert.equal(
    evaluateFrameQuality(quality(), 'front', GOOD_CONFIDENCE, ...ARCORE_REDUCED).qualityTier,
    'FULL',
  );
  assert.equal(
    evaluateFrameQuality(quality({ occlusion: null }), 'front', GOOD_CONFIDENCE, ...ARCORE_REDUCED)
      .qualityTier,
    'REDUCED',
  );
});
