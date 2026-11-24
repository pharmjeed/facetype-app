import assert from 'node:assert/strict';
import test from 'node:test';

import { automaticCaptureHint, neutralCaptureGuidance } from './neutralGuidance.ts';
import { POSES, POSE_TARGETS } from './types.ts';

test('camera overlay translates measurement failures without showing internal codes', () => {
  for (const code of ['FT-SCAN-004', 'FT-SCAN-005', 'FT-SCAN-006', 'FT-SCAN-007', 'FT-SCAN-008', 'FT-SCAN-009', 'FT-SCAN-010', 'FT-SCAN-011', 'FT-SCAN-014']) {
    for (const locale of ['ar-SA', 'en']) {
      assert.ok(automaticCaptureHint(locale, code).length > 5);
      assert.doesNotMatch(automaticCaptureHint(locale, code), /FT-SCAN/);
    }
  }
  assert.match(automaticCaptureHint('ar', null), /تلقائي/);
  assert.match(automaticCaptureHint('en', 'FT-SCAN-011'), /pose/);
});

test('every required pose has readable guidance and the same neutral-face preparation', () => {
  for (const locale of ['ar', 'en']) {
    const baseline = neutralCaptureGuidance(locale, 'front');
    for (const pose of POSES) {
      const guidance = neutralCaptureGuidance(locale, pose);
      assert.ok(guidance.label.trim());
      assert.ok(guidance.instruction.trim());
      assert.equal(guidance.neutral, baseline.neutral);
      assert.equal(guidance.preparation, baseline.preparation);
      assert.doesNotMatch(guidance.label, /_\d/);
    }
  }
});

test('Arabic regional locales retain Arabic instructions; unknown locales fall back to English', () => {
  for (const locale of ['ar-SA', 'ar_SA', 'AR']) {
    assert.deepEqual(neutralCaptureGuidance(locale, 'front'), neutralCaptureGuidance('ar', 'front'));
  }
  assert.deepEqual(neutralCaptureGuidance('fr', 'front'), neutralCaptureGuidance('en', 'front'));
});

test('head movement guidance does not replace the five-pose protocol or its angles', () => {
  assert.deepEqual(POSES, ['front', 'left_25', 'right_25', 'up_15', 'down_15']);
  assert.deepEqual(POSE_TARGETS, {
    front: { yaw: 0, pitch: 0 }, left_25: { yaw: 25, pitch: 0 },
    right_25: { yaw: -25, pitch: 0 }, up_15: { yaw: 0, pitch: 15 },
    down_15: { yaw: 0, pitch: -15 },
  });
  assert.match(neutralCaptureGuidance('ar', 'up_15').instruction, /لا حاجبيك/);
  assert.match(neutralCaptureGuidance('en', 'up_15').instruction, /not your eyebrows/);
});
