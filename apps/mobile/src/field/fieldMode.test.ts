/**
 * The boundary between the two lanes.
 *
 * Adding a field-study mode is only safe if it is genuinely separate: the
 * production capture path must be exactly as strict afterwards as it was
 * before, and the field path must not be reachable without the mode being
 * turned on deliberately. Both are asserted here against the real modules,
 * not described in a comment.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { runCaptureSequence } from '../capture/captureSequence.ts';
import { evaluateFieldObservation, runFieldCaptureSequence } from './fieldCapture.ts';
import { fieldStudyEnabled } from './mode.ts';
import { fieldStrings } from './strings.ts';
import type { FieldConsentRecord } from './consent.ts';
import { observationFixture } from './__fixtures__/observation.ts';

const CONSENT: FieldConsentRecord = {
  participantRef: 'P-000001',
  researchCollection: true,
  rawFrameRetention: false,
  policyVersion: 'consent-1.0.0',
  rawPhotoRetentionDays: 7,
  grantedAtMs: 1_700_000_000_000,
};

const blurred = observationFixture('front', {
  quality: { ...observationFixture().quality, blur: 0.2 },
});

test('the production sequence still refuses to upload a frame that fails the gate', async () => {
  let uploadsRequested = 0;
  await assert.rejects(
    () =>
      runCaptureSequence('front', {
        capture: async () => blurred,
        serialise: () => new Uint8Array([1]),
        digest: async () => 'c'.repeat(64),
        createUpload: async () => {
          uploadsRequested += 1;
          throw new Error('the production path must never reach here for a failing frame');
        },
        upload: async () => {},
        registerObservation: async () => {},
      }),
    (error: { code?: string }) => error.code === 'FT-SCAN-006',
  );
  assert.equal(uploadsRequested, 0);
});

test('the field sequence uploads the same frame, and calls it below the gate', async () => {
  let uploadsRequested = 0;
  const outcome = await runFieldCaptureSequence('front', CONSENT, {
    capture: async () => blurred,
    serialise: () => new Uint8Array([1]),
    digest: async () => 'c'.repeat(64),
    createUpload: async (request) => {
      uploadsRequested += 1;
      return {
        artifact_id: 'a1',
        upload_url: '/u',
        method: 'PUT',
        headers: {},
        kind: request.artifact_kind,
      };
    },
    upload: async () => {},
    registerObservation: async () => ({ accepted: false, failures: ['FT-SCAN-006'] }),
    completeRawUpload: async () => {
      throw new Error('no raw frame is taken in this test, so nothing completes');
    },
    rawFrame: null,
    now: () => 1,
  });

  assert.equal(uploadsRequested, 1);
  assert.equal(outcome.gatePassed, false);
  assert.deepEqual(outcome.gateFailures, ['FT-SCAN-006']);
});

test('both lanes read the same verdict from the same artifact', () => {
  // The field lane does not carry its own thresholds, its own profile
  // resolution or its own copy of the gate: a threshold change moves both.
  const verdict = evaluateFieldObservation(blurred);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.primaryErrorCode, 'FT-SCAN-006');
  assert.equal(verdict.qualityProfile, 'REDUCED_GEOMETRY_NO_OCCLUSION');
  assert.deepEqual(verdict.measurementLimitations, ['OCCLUSION_UNASSESSED']);

  const passing = evaluateFieldObservation(observationFixture('front'));
  assert.equal(passing.pass, true);
});

test('field mode is off unless a build turns it on with a usable configuration', () => {
  const config = JSON.stringify({
    custodian: 'research operations',
    access_restriction: 'named researchers only',
    deletion_contact: 'privacy@example.org',
  });

  assert.equal(fieldStudyEnabled(undefined, config), false);
  assert.equal(fieldStudyEnabled('0', config), false);
  assert.equal(fieldStudyEnabled('false', config), false);
  assert.equal(fieldStudyEnabled('', config), false);
  // The flag alone is not enough: without a study configuration there is no
  // accountable custodian, no access restriction and no deletion route to
  // state, so no consent could be informed. (The retention period is no longer
  // among these — it comes from the server, and `policy.test.ts` covers it.)
  assert.equal(fieldStudyEnabled('1', undefined), false);
  assert.equal(fieldStudyEnabled('1', '{}'), false);
  assert.equal(
    fieldStudyEnabled('1', JSON.stringify({ custodian: 'research operations' })),
    false,
  );

  assert.equal(fieldStudyEnabled('1', config), true);
  assert.equal(fieldStudyEnabled('true', config), true);
});

test('the field container cannot reach anything that produces or fetches a result', () => {
  // A source-level assertion on purpose. The quarantine claim in
  // `docs/field-study.md` is "finalizeScan is never called", and the only way
  // to check a call that does not happen is to check that the call site does
  // not exist. A behavioural test would have to enumerate every path that
  // might make it, which is the assertion this replaces.
  const body = strippedSource('FieldStudyApp.tsx');

  for (const forbidden of ['finalizeScan', 'getResult', 'getJob', 'pollUntilTerminal', 'retake(']) {
    assert.ok(
      !body.includes(forbidden),
      `FieldStudyApp must not reference ${forbidden}: a field capture has no result`,
    );
  }

  // And it must not persist a participant to disk for a later launch to
  // restore, which is the other half of participant isolation — and the reason
  // a cold restart cannot reissue P-000001: there is nothing to restore, so
  // the operator is asked for the join code again.
  for (const forbidden of ['persistScanState', 'AsyncStorage', 'asyncStorage']) {
    assert.ok(!body.includes(forbidden), `FieldStudyApp must not reference ${forbidden}`);
  }
});

test('no part of the field lane deletes a scan and calls it a participant erasure', () => {
  // The receipt used to offer "Delete this participant's data now" bound to
  // `DELETE /scans/{id}`. That deletes a scan: the participant row, the
  // reference and both consent facts survive it, so the participant was told
  // their data was gone while records about them remained. Real erasure is
  // `DELETE /field-study/sessions/{id}/participants/{ref}` under
  // `field_study:admin`, which a collecting device does not hold — so the
  // honest thing this build can do is route the request, and the strongest way
  // to keep it honest is for the call not to exist anywhere in the lane.
  for (const file of [
    'FieldStudyApp.tsx',
    'orchestrator.ts',
    'session.ts',
    'screens/FieldReceiptScreen.tsx',
  ]) {
    assert.ok(!strippedSource(file).includes('deleteScan'), `${file} must not call deleteScan`);
  }

  // The port the orchestrator is typed against does not expose it either, so
  // this is a compile-time impossibility rather than a convention.
  const port = readFileSync(
    join(import.meta.dirname, '..', 'api', 'fieldStudy.ts'),
    'utf8',
  ).replace(/^\s*(?:\/\/|\/\*|\*).*$/gm, '');
  for (const forbidden of ['deleteScan', 'finalizeScan', 'getResult', 'getJob']) {
    assert.ok(!port.includes(forbidden), `FieldStudyApi must not expose ${forbidden}`);
  }
});

test('the receipt tells the participant how deletion actually happens', () => {
  // Both languages, because a participant is read one of them and the promise
  // must be the same promise. The wording routes to the operator and quotes
  // the reference; it does not claim the device deleted anything.
  for (const locale of ['ar', 'en'] as const) {
    const steps = fieldStrings[locale]['field.receipt.deletion_steps'];
    assert.match(steps, /\{contact\}/);
    assert.match(steps, /\{ref\}/);
    assert.ok(fieldStrings[locale]['field.receipt.no_delete_here'].trim().length > 0);
  }
  // And there is no "delete now" copy left to bind a button to.
  assert.equal('field.receipt.delete_now' in fieldStrings.en, false);
  assert.equal('field.receipt.delete_now' in fieldStrings.ar, false);
});

/** A module's source with comment lines removed. */
function strippedSource(relative: string): string {
  // Comments are stripped first: the module headers explain at length which
  // calls they deliberately do not make, and naming them there must not trip
  // the check that they are not made.
  return readFileSync(join(import.meta.dirname, relative), 'utf8').replace(
    /^\s*(?:\/\/|\/\*|\*).*$/gm,
    '',
  );
}
