/**
 * The policy gate.
 *
 * The consent screen quotes exactly two server-supplied things — the wording
 * version and the photograph retention period — so this suite is about the
 * cases where quoting them would be wrong: the document is absent, malformed,
 * or internally contradictory, or the joined session disagrees with the
 * deployment. Every one of those refuses rather than picks a half.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { FieldSessionResponse, FieldStudyPolicyResponse } from '@facetype/contracts';

import { POSES } from '../capture/types.ts';
import {
  FIELD_POLICY_MALFORMED,
  FIELD_POLICY_PROTOCOL_UNSUPPORTED,
  FIELD_POLICY_RETENTION_INCONSISTENT,
  FIELD_SESSION_NOT_OPEN,
  mayOfferPhotoConsent,
  narrowPolicyToSession,
  resolveFieldStudyPolicy,
} from './policy.ts';

const POLICY: FieldStudyPolicyResponse = {
  capture_protocol: 'cap-1.0.0',
  consent_policy_version: 'consent-1.0.0',
  raw_photo_retention_days: 7,
  raw_photo_retention_enabled: true,
  max_raw_photo_retention_days: 30,
  consent_types: ['field_study_research_data', 'field_study_raw_photo_retention'],
  required_poses: [...POSES],
  not_a_personality_result: true,
};

const SESSION: FieldSessionResponse = {
  session_id: 'fs_abc',
  label: 'Riyadh pilot',
  site_code: 'RUH-1',
  status: 'OPEN',
  capture_protocol: 'cap-1.0.0',
  consent_policy_version: 'consent-1.0.0',
  raw_photo_retention_days: 7,
  raw_photo_retention_enabled: true,
  participant_count: 0,
  created_at: '2026-08-28T09:00:00Z',
  provisional: true,
  not_a_personality_result: true,
};

function policy(overrides: Partial<FieldStudyPolicyResponse> = {}) {
  const resolved = resolveFieldStudyPolicy({ ...POLICY, ...overrides });
  assert.ok(resolved.ok, 'fixture must resolve');
  return resolved.policy;
}

test('a well-formed policy becomes the terms the consent screen states', () => {
  assert.deepEqual(policy(), {
    captureProtocol: 'cap-1.0.0',
    consentPolicyVersion: 'consent-1.0.0',
    rawPhotoRetentionDays: 7,
    rawPhotoRetentionEnabled: true,
    maxRawPhotoRetentionDays: 30,
    requiredPoses: [...POSES],
  });
});

test('the production default — retention disabled — is a policy, not a failure', () => {
  // Zero days is what every deployment ships with. It must not take the field
  // study offline; it must take the photograph question off the screen.
  const disabled = policy({ raw_photo_retention_days: 0, raw_photo_retention_enabled: false });
  assert.equal(disabled.rawPhotoRetentionDays, 0);
  assert.equal(mayOfferPhotoConsent(disabled), false);
  assert.equal(mayOfferPhotoConsent(policy()), true);
  assert.equal(mayOfferPhotoConsent(null), false);
});

test('an absent or non-object document is refused', () => {
  for (const value of [null, undefined, 'a string', 42]) {
    const result = resolveFieldStudyPolicy(value as never);
    assert.equal(result.ok, false, String(value));
    assert.equal(result.ok === false && result.reason, FIELD_POLICY_MALFORMED);
  }
});

test('a blank or over-long version is refused rather than sent to the server', () => {
  // `consent_policy_version` and `capture_protocol` are `max_length=32`
  // server-side, so a longer one would be rejected at `createScan` — after the
  // participant had already consented under it.
  for (const bad of ['', '   ', 'x'.repeat(33), 42, null]) {
    for (const key of ['consent_policy_version', 'capture_protocol'] as const) {
      const result = resolveFieldStudyPolicy({ ...POLICY, [key]: bad } as never);
      assert.equal(result.ok, false, `${key}=${JSON.stringify(bad)}`);
      assert.equal(result.ok === false && result.reason, FIELD_POLICY_MALFORMED);
    }
  }
});

test('a retention period must be a whole, non-negative, bounded number of days', () => {
  for (const bad of ['7', 7.5, -1, Number.NaN, null, true]) {
    const result = resolveFieldStudyPolicy({ ...POLICY, raw_photo_retention_days: bad } as never);
    assert.equal(result.ok, false, JSON.stringify(bad));
  }
  // Longer than the deployment's own ceiling is a contradiction, not a value
  // to clamp: one of the two numbers is wrong and neither is safe to read out.
  const overCeiling = resolveFieldStudyPolicy({
    ...POLICY,
    raw_photo_retention_days: 31,
    max_raw_photo_retention_days: 30,
  });
  assert.equal(overCeiling.ok === false && overCeiling.reason, FIELD_POLICY_RETENTION_INCONSISTENT);
});

test('a policy that contradicts itself about retention is refused outright', () => {
  const enabledButZero = resolveFieldStudyPolicy({
    ...POLICY,
    raw_photo_retention_days: 0,
    raw_photo_retention_enabled: true,
  });
  assert.equal(
    enabledButZero.ok === false && enabledButZero.reason,
    FIELD_POLICY_RETENTION_INCONSISTENT,
  );

  const disabledButPositive = resolveFieldStudyPolicy({
    ...POLICY,
    raw_photo_retention_days: 7,
    raw_photo_retention_enabled: false,
  });
  assert.equal(
    disabledButPositive.ok === false && disabledButPositive.reason,
    FIELD_POLICY_RETENTION_INCONSISTENT,
  );

  const notABoolean = resolveFieldStudyPolicy({
    ...POLICY,
    raw_photo_retention_enabled: 'true',
  } as never);
  assert.equal(notABoolean.ok === false && notABoolean.reason, FIELD_POLICY_MALFORMED);
});

test('a protocol asking for different poses than this build knows is refused', () => {
  for (const poses of [
    ['front'],
    [...POSES, 'profile_90'],
    ['front', 'left_25', 'right_25', 'up_15', 'down_30'],
    [],
    'front',
  ]) {
    const result = resolveFieldStudyPolicy({ ...POLICY, required_poses: poses } as never);
    assert.equal(result.ok, false, JSON.stringify(poses));
    assert.equal(result.ok === false && result.reason, FIELD_POLICY_PROTOCOL_UNSUPPORTED);
  }
});

test('pose order is presentation, not protocol', () => {
  const reordered = resolveFieldStudyPolicy({
    ...POLICY,
    required_poses: ['down_15', 'front', 'up_15', 'right_25', 'left_25'],
  });
  assert.ok(reordered.ok);
  assert.deepEqual(reordered.policy.requiredPoses, [...POSES]);
});

test('the joined session, not the deployment, supplies what the participant is told', () => {
  const narrowed = narrowPolicyToSession(policy(), {
    ...SESSION,
    consent_policy_version: 'consent-1.1.0',
    raw_photo_retention_days: 3,
  });
  assert.ok(narrowed.ok);
  // The session's own figures: this is what `record_consent` will write against
  // the participant and what the photograph will actually be dated with.
  assert.equal(narrowed.policy.consentPolicyVersion, 'consent-1.1.0');
  assert.equal(narrowed.policy.rawPhotoRetentionDays, 3);
  // And the deployment's remain the bounds.
  assert.equal(narrowed.policy.maxRawPhotoRetentionDays, 30);
  assert.equal(narrowed.policy.captureProtocol, 'cap-1.0.0');
});

test('a session that keeps no photograph closes the photograph question', () => {
  const narrowed = narrowPolicyToSession(policy(), {
    ...SESSION,
    raw_photo_retention_days: 0,
    raw_photo_retention_enabled: false,
  });
  assert.ok(narrowed.ok);
  assert.equal(mayOfferPhotoConsent(narrowed.policy), false);
});

test('a session claiming more retention than the deployment allows is refused', () => {
  // The server takes the lower of the two before enforcing anything, so this
  // cannot happen without one of the two being wrong — and neither is a safe
  // thing to read to somebody about a photograph of their face.
  const longer = narrowPolicyToSession(policy(), { ...SESSION, raw_photo_retention_days: 14 });
  assert.equal(longer.ok === false && longer.reason, FIELD_POLICY_RETENTION_INCONSISTENT);

  const overCeiling = narrowPolicyToSession(policy({ raw_photo_retention_days: 30 }), {
    ...SESSION,
    raw_photo_retention_days: 31,
  });
  assert.equal(overCeiling.ok === false && overCeiling.reason, FIELD_POLICY_RETENTION_INCONSISTENT);
});

test('a session that is not open cannot be collected into', () => {
  for (const status of ['CLOSED', 'ARCHIVED', '', 'open']) {
    const result = narrowPolicyToSession(policy(), { ...SESSION, status });
    assert.equal(result.ok, false, status);
    assert.equal(result.ok === false && result.reason, FIELD_SESSION_NOT_OPEN);
  }
});

test('a session with no usable id is refused before anything is attributed to it', () => {
  for (const id of ['', '   ', null, 42]) {
    const result = narrowPolicyToSession(policy(), { ...SESSION, session_id: id } as never);
    assert.equal(result.ok, false, JSON.stringify(id));
    assert.equal(result.ok === false && result.reason, FIELD_POLICY_MALFORMED);
  }
  const missing = narrowPolicyToSession(policy(), null);
  assert.equal(missing.ok === false && missing.reason, FIELD_POLICY_MALFORMED);
});
