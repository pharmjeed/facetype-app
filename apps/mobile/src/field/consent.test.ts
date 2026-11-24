/**
 * Consent fail-closed behaviour.
 *
 * Each of these is a shape a consent record can really arrive in — restored
 * from storage, handed over a native bridge, built from a prop — and each of
 * them used to be the way a truthy check says yes.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFieldConsentRecord,
  mayCollect,
  mayRetainRawFrames,
  type FieldConsentRecord,
} from './consent.ts';

const VALID = {
  participantRef: 'P-000001',
  researchCollection: true,
  rawFrameRetention: false,
  policyVersion: 'consent-1.0.0',
  rawPhotoRetentionDays: 7,
  grantedAtMs: 1_700_000_000_000,
};

function record(overrides: Partial<FieldConsentRecord> = {}): FieldConsentRecord {
  return { ...VALID, ...overrides } as FieldConsentRecord;
}

test('no consent record at all authorises nothing', () => {
  assert.equal(mayCollect(null), false);
  assert.equal(mayCollect(undefined), false);
  assert.equal(mayRetainRawFrames(null), false);
  assert.equal(mayRetainRawFrames(undefined), false);
});

test('a granted research consent authorises collection but not photographs', () => {
  const consent = record();
  assert.equal(mayCollect(consent), true);
  assert.equal(mayRetainRawFrames(consent), false);
});

test('both grants together are what authorise a photograph', () => {
  const consent = record({ rawFrameRetention: true });
  assert.equal(mayCollect(consent), true);
  assert.equal(mayRetainRawFrames(consent), true);
});

test('a raw-frame opt-in without the research grant authorises nothing', () => {
  const consent = record({ researchCollection: false, rawFrameRetention: true });
  assert.equal(mayCollect(consent), false);
  assert.equal(mayRetainRawFrames(consent), false);
});

test('only a literal true is a grant — every truthy impostor is refused', () => {
  for (const truthy of ['true', 'yes', 1, {}, [], 'false', '0']) {
    const consent = record({ researchCollection: truthy as unknown as boolean });
    assert.equal(mayCollect(consent), false, `researchCollection=${JSON.stringify(truthy)}`);

    const raw = record({ rawFrameRetention: truthy as unknown as boolean });
    assert.equal(mayRetainRawFrames(raw), false, `rawFrameRetention=${JSON.stringify(truthy)}`);
  }
});

test('a consent bound to a non-opaque participant reference is not a consent', () => {
  for (const ref of ['Ali Hassan', 'ali@example.com', 'p-000001', '', 'P-1']) {
    assert.equal(mayCollect(record({ participantRef: ref })), false, ref);
  }
});

test('a consent with no stated policy version is refused', () => {
  assert.equal(mayCollect(record({ policyVersion: '' })), false);
  assert.equal(mayCollect(record({ policyVersion: '   ' })), false);
  assert.equal(mayCollect(record({ grantedAtMs: 0 })), false);
});

test('a retention period must be a whole number of days the server could have sent', () => {
  // Zero is legitimate — it is the production default and means no photograph
  // is kept — so it is accepted as a *stated* period and refused only as a
  // photograph authorisation, below. A fraction, a negative or a NaN is not a
  // period any deployment configured.
  assert.equal(mayCollect(record({ rawPhotoRetentionDays: 0 })), true);
  assert.equal(mayCollect(record({ rawPhotoRetentionDays: -1 })), false);
  assert.equal(mayCollect(record({ rawPhotoRetentionDays: 1.5 })), false);
  assert.equal(mayCollect(record({ rawPhotoRetentionDays: Number.NaN })), false);
  assert.equal(
    mayCollect(record({ rawPhotoRetentionDays: '7' as unknown as number })),
    false,
  );
});

test('photographs need a deployment that keeps one, not just a tick', () => {
  // The exact shape of a participant who agreed to photographs on a deployment
  // that retains none: the grant is real and it authorises nothing, because a
  // photograph kept for zero days is not one anybody consented to keeping.
  const consent = record({ rawFrameRetention: true, rawPhotoRetentionDays: 0 });
  assert.equal(mayCollect(consent), true);
  assert.equal(mayRetainRawFrames(consent), false);
});

test('buildFieldConsentRecord cannot represent a photograph-only consent', () => {
  const built = buildFieldConsentRecord({ ...VALID, researchCollection: false, rawFrameRetention: true });
  assert.equal(built, null);
});

test('buildFieldConsentRecord normalises grants to booleans it checks itself', () => {
  const built = buildFieldConsentRecord({
    ...VALID,
    researchCollection: 'true' as unknown as boolean,
  });
  assert.equal(built, null);

  const good = buildFieldConsentRecord({ ...VALID, rawFrameRetention: true });
  assert.notEqual(good, null);
  assert.equal(good!.researchCollection, true);
  assert.equal(good!.rawFrameRetention, true);
});
