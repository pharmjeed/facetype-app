/**
 * Contract helper tests.
 *
 * These assert the rules a client must not get wrong: never show a type on a
 * non-COMPLETED result, always surface the exact pose a retake needs, and never
 * crash on an enum value a newer server introduced (FT-04 §12).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FaceTypeApiError,
  REQUIRED_POSES,
  canDisplayType,
  confidenceBucket,
  retakePose,
  toErrorAction,
} from '../src/index.ts';
import type { ResultResponse } from '../generated/types.ts';

function result(overrides: Partial<ResultResponse> = {}): ResultResponse {
  return {
    schema_version: 'result-2.0',
    scan_id: 'scn_test',
    status: 'MODEL_UNAVAILABLE',
    quality: { overall: 0.95 },
    morphology: { genome_schema: 'fg-1.0.0' },
    personality: null,
    explanation: {},
    versions: {},
    error_codes: [],
    ...overrides,
  } as ResultResponse;
}

test('the five guided poses are the cap-1.0.0 protocol', () => {
  assert.deepEqual([...REQUIRED_POSES], ['front', 'left_25', 'right_25', 'up_15', 'down_15']);
});

test('a type is displayable only on a COMPLETED result that has one', () => {
  assert.equal(canDisplayType(result()), false);

  const completedWithType = result({
    status: 'COMPLETED',
    personality: {
      model_version: 'mbti-1.0.0',
      calibration_version: 'cal-1.0.0',
      dimensions: {},
      types: [],
      top_type: 'ENTP',
      confidence: 0.64,
      uncertainty: 0.36,
      abstention_reasons: [],
      research_watermark: false,
    },
  });
  assert.equal(canDisplayType(completedWithType), true);
});

test('an abstained result never displays a type, even with a distribution', () => {
  const abstained = result({
    status: 'ABSTAINED',
    personality: {
      model_version: 'mbti-1.0.0',
      calibration_version: 'cal-1.0.0',
      dimensions: {},
      types: [{ type: 'ENTP', p: 0.12 }],
      top_type: null,
      confidence: null,
      uncertainty: 0.9,
      abstention_reasons: ['LOW_MARGIN'],
      research_watermark: false,
    },
  });
  assert.equal(canDisplayType(abstained), false);
});

test('confidence buckets never round to a certainty', () => {
  assert.equal(confidenceBucket(null), 'unknown');
  assert.equal(confidenceBucket(0.2), 'low');
  assert.equal(confidenceBucket(0.5), 'medium');
  assert.equal(confidenceBucket(0.95), 'high');
});

test('an unknown action degrades to UNKNOWN rather than crashing', () => {
  assert.equal(toErrorAction('RETAKE_POSE'), 'RETAKE_POSE');
  assert.equal(toErrorAction('SOMETHING_NEW_FROM_A_FUTURE_SERVER'), 'UNKNOWN');
  assert.equal(toErrorAction(undefined), 'UNKNOWN');
});

test('a retake error names the exact pose to redo', () => {
  const error = new FaceTypeApiError({
    type: 'https://facetype.local/problems/scan-quality',
    title: 'Scan quality insufficient',
    status: 422,
    error_code: 'FT-SCAN-011',
    detail: 'A required angle is still missing.',
    message_key: 'error.ft_scan_011',
    retryable: true,
    action: { type: 'RETAKE_POSE', pose: 'left_25' },
  });
  assert.equal(retakePose(error), 'left_25');
  assert.equal(error.errorCode, 'FT-SCAN-011');
  assert.equal(error.retryable, true);
});

test('a non-retake error yields no pose', () => {
  const error = new FaceTypeApiError({
    type: 'https://facetype.local/problems/unauthenticated',
    title: 'Authentication required',
    status: 401,
    error_code: 'FT-AUTH-001',
    detail: 'Authentication is required.',
    message_key: 'error.ft_auth_001',
    retryable: false,
    action: { type: 'LOGIN_OR_NEW_SESSION' },
  });
  assert.equal(retakePose(error), null);
  assert.equal(retakePose(new Error('nope')), null);
});
