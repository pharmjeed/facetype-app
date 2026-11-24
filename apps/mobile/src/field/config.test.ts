/**
 * A build with no usable study governance document must not be able to ask
 * anybody for consent, because it has no true answer to "who is accountable for
 * this and where do I go to have it deleted".
 *
 * The retention period and the consent wording version are deliberately *not*
 * tested here any more, because they are no longer here: they come from
 * `GET /field-study/policy` and are covered by `policy.test.ts`. A build-time
 * retention promise was the defect, not the contract.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFieldStudyConfig } from './config.ts';

const COMPLETE = {
  custodian: 'FaceType AI research operations',
  access_restriction: 'named study researchers only',
  deletion_contact: 'privacy@example.org',
};

test('a complete document parses into the values the consent copy states', () => {
  assert.deepEqual(parseFieldStudyConfig(JSON.stringify(COMPLETE)), {
    custodian: 'FaceType AI research operations',
    accessRestriction: 'named study researchers only',
    deletionContact: 'privacy@example.org',
  });
});

test('an absent or unparseable configuration disables the study', () => {
  assert.equal(parseFieldStudyConfig(undefined), null);
  assert.equal(parseFieldStudyConfig(null), null);
  assert.equal(parseFieldStudyConfig(''), null);
  assert.equal(parseFieldStudyConfig('   '), null);
  assert.equal(parseFieldStudyConfig('{'), null);
  assert.equal(parseFieldStudyConfig('"a string"'), null);
  assert.equal(parseFieldStudyConfig('[]'), null);
  assert.equal(parseFieldStudyConfig('null'), null);
});

test('every field is required — there is no partial acceptance', () => {
  for (const key of Object.keys(COMPLETE)) {
    const partial: Record<string, unknown> = { ...COMPLETE };
    delete partial[key];
    assert.equal(parseFieldStudyConfig(JSON.stringify(partial)), null, `missing ${key}`);
  }
});

test('blank strings are absences, not values', () => {
  assert.equal(parseFieldStudyConfig(JSON.stringify({ ...COMPLETE, custodian: '   ' })), null);
  assert.equal(parseFieldStudyConfig(JSON.stringify({ ...COMPLETE, deletion_contact: '' })), null);
  assert.equal(
    parseFieldStudyConfig(JSON.stringify({ ...COMPLETE, access_restriction: 42 })),
    null,
  );
});

test('a configuration written for the previous build still enables the lane', () => {
  // The retention keys it carries are now the server's business. Refusing the
  // document over them would take the field study offline on every handset the
  // moment the app stopped reading them, which is a worse failure than
  // ignoring three keys: nothing in this build can consult them, so nothing in
  // this build can be misled by them.
  const legacy = {
    ...COMPLETE,
    policy_version: 'field-study-consent-1.0.0',
    retention_days: 30,
    raw_frame_retention_hours: 72,
  };
  const parsed = parseFieldStudyConfig(JSON.stringify(legacy));
  assert.deepEqual(parsed, {
    custodian: 'FaceType AI research operations',
    accessRestriction: 'named study researchers only',
    deletionContact: 'privacy@example.org',
  });
  // And the stale numbers are genuinely gone rather than carried unused.
  assert.deepEqual(Object.keys(parsed!).sort(), [
    'accessRestriction',
    'custodian',
    'deletionContact',
  ]);
});
