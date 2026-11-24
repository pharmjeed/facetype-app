/**
 * The field capture sequence.
 *
 * The four properties these tests exist for, none of which is observable by
 * reading a screen or a reducer:
 *
 *  - no consent, no camera call;
 *  - no raw-frame consent, no raw frame ever created or uploaded;
 *  - a sample that fails the production gate is still uploaded and registered,
 *    with its verdict preserved rather than repaired;
 *  - the native raw-frame slot is discarded on every exit path;
 *  - a raw frame is only *confirmed* once the server says so, so a PUT whose
 *    completion call fails reports `rawFrameUploaded: false` while still
 *    recording, in `rawFrameSent`, that the bytes did leave the device.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { StandardFaceObservation } from '../capture/types.ts';
import type { FieldConsentRecord } from './consent.ts';
import {
  FIELD_CONSENT_REQUIRED,
  FIELD_CAPTURE_CANCELLED,
  fieldQualityRecord,
  runFieldCaptureSequence,
  type FieldCaptureDeps,
  type FieldUploadSlot,
} from './fieldCapture.ts';
import type { RawFrameChannel, RawFrameHandle } from './rawFrame.ts';
import { observationFixture } from './__fixtures__/observation.ts';

const CONSENT: FieldConsentRecord = {
  participantRef: 'P-000001',
  researchCollection: true,
  rawFrameRetention: false,
  policyVersion: 'consent-1.0.0',
  rawPhotoRetentionDays: 7,
  grantedAtMs: 1_700_000_000_000,
};

interface Recorder {
  calls: string[];
  uploads: { kind: string; contentType: string; length: number; sha256: string }[];
  completions: {
    artifactId: string;
    sha256: string;
    contentLength: number;
    contentType: string;
  }[];
  registered: number;
}

function slotFor(kind: string): FieldUploadSlot {
  return {
    artifact_id: `artifact_${kind}`,
    upload_url: `/uploads/${kind}`,
    method: 'PUT',
    headers: {},
  };
}

function deps(
  overrides: Partial<FieldCaptureDeps> = {},
  observation: StandardFaceObservation = observationFixture(),
): { deps: FieldCaptureDeps; log: Recorder } {
  const log: Recorder = { calls: [], uploads: [], completions: [], registered: 0 };
  const base: FieldCaptureDeps = {
    async capture() {
      log.calls.push('capture');
      return observation;
    },
    serialise() {
      log.calls.push('serialise');
      return new Uint8Array([1, 2, 3, 4]);
    },
    async digest() {
      log.calls.push('digest');
      return 'c'.repeat(64);
    },
    async createUpload(request) {
      log.calls.push(`createUpload:${request.artifact_kind}`);
      log.uploads.push({
        kind: request.artifact_kind,
        contentType: request.content_type,
        length: request.content_length,
        sha256: request.sha256,
      });
      return slotFor(request.artifact_kind);
    },
    async upload(slot) {
      log.calls.push(`upload:${slot.artifact_id}`);
    },
    async registerObservation() {
      log.calls.push('registerObservation');
      log.registered += 1;
      return { accepted: true, failures: [] };
    },
    async completeRawUpload(request) {
      log.calls.push(`completeRawUpload:${request.artifact_id}`);
      log.completions.push({
        artifactId: request.artifact_id,
        sha256: request.sha256,
        contentLength: request.content_length,
        contentType: request.content_type,
      });
    },
    rawFrame: null,
    now: () => 1_700_000_000_500,
    ...overrides,
  };
  return { deps: base, log };
}

function rawChannel(overrides: Partial<RawFrameChannel> = {}): {
  channel: RawFrameChannel;
  events: string[];
} {
  const events: string[] = [];
  const handle: RawFrameHandle = {
    token: 'slot-1',
    byteLength: 2048,
    sha256: 'd'.repeat(64),
    width: 640,
    height: 480,
  };
  const channel: RawFrameChannel = {
    async capture() {
      events.push('capture');
      return handle;
    },
    async read() {
      events.push('read');
      return new Uint8Array(2048);
    },
    async discard() {
      events.push('discard');
    },
    async discardAll() {
      events.push('discardAll');
    },
    ...overrides,
  };
  return { channel, events };
}

test('an already cancelled attempt never opens the camera or creates an upload', async () => {
  const controller = new AbortController();
  controller.abort();
  const { deps: fieldDeps, log } = deps();
  await assert.rejects(runFieldCaptureSequence('front', CONSENT, fieldDeps, controller.signal), {
    code: FIELD_CAPTURE_CANCELLED,
  });
  assert.deepEqual(log.calls, []);
});

for (const cancelAfter of [
  'capture', 'rawCapture', 'digest', 'geometrySlot', 'geometryUpload',
  'register', 'rawSlot', 'rawRead', 'rawUpload', 'rawComplete',
]) {
  test(`cancellation after ${cancelAfter} blocks later work and releases any raw frame`, async () => {
    const controller = new AbortController();
    const timeline: string[] = [];
    async function step<T>(name: string, operation: () => Promise<T>): Promise<T> {
      timeline.push(name);
      const result = await operation();
      if (name === cancelAfter) controller.abort();
      return result;
    }
    const raw = rawChannel();
    const rawCapture = raw.channel.capture;
    const rawRead = raw.channel.read;
    raw.channel.capture = () => step('rawCapture', () => rawCapture());
    raw.channel.read = (handle) => step('rawRead', () => rawRead(handle));
    const { deps: fieldDeps } = deps({ rawFrame: raw.channel });
    const original = { ...fieldDeps };
    fieldDeps.capture = (pose) => step('capture', () => original.capture(pose));
    fieldDeps.digest = (payload) => step('digest', () => original.digest(payload));
    fieldDeps.createUpload = (request) => step(
      request.artifact_kind === 'RAW_FRAME' ? 'rawSlot' : 'geometrySlot',
      () => original.createUpload(request),
    );
    fieldDeps.upload = (slot, payload) => step(
      slot.artifact_id === 'artifact_RAW_FRAME' ? 'rawUpload' : 'geometryUpload',
      () => original.upload(slot, payload),
    );
    fieldDeps.registerObservation = (request) => step('register', () => original.registerObservation(request));
    fieldDeps.completeRawUpload = (request) => step('rawComplete', () => original.completeRawUpload(request));
    await assert.rejects(
      runFieldCaptureSequence('front', { ...CONSENT, rawFrameRetention: true }, fieldDeps, controller.signal),
      { code: FIELD_CAPTURE_CANCELLED },
    );
    assert.equal(timeline.at(-1), cancelAfter, 'no subsequent acquisition or network step may start');
    if (cancelAfter === 'capture') assert.deepEqual(raw.events, []);
    else assert.equal(raw.events.filter((event) => event === 'discard').length, 1);
  });
}

test('without a collection consent the camera is never called', async () => {
  const { deps: fieldDeps, log } = deps();
  await assert.rejects(
    () => runFieldCaptureSequence('front', null, fieldDeps),
    (error: { code?: string }) => error.code === FIELD_CONSENT_REQUIRED,
  );
  assert.deepEqual(log.calls, []);
});

test('a consent record that does not authorise collection is refused the same way', async () => {
  const { deps: fieldDeps, log } = deps();
  await assert.rejects(
    () =>
      runFieldCaptureSequence('front', { ...CONSENT, researchCollection: false }, fieldDeps),
    (error: { code?: string }) => error.code === FIELD_CONSENT_REQUIRED,
  );
  assert.deepEqual(log.calls, []);
});

test('geometry is uploaded and registered, and no raw frame exists without consent', async () => {
  const { channel, events } = rawChannel();
  // The channel is wired but consent withholds it: this is the case where a
  // wiring mistake alone would be enough to photograph someone.
  const { deps: fieldDeps, log } = deps({ rawFrame: channel });

  const outcome = await runFieldCaptureSequence('front', CONSENT, fieldDeps);

  assert.equal(outcome.gatePassed, true);
  assert.equal(outcome.rawFrameUploaded, false);
  assert.equal(outcome.rawFrameErrorCode, null);
  assert.deepEqual(events, []);
  assert.deepEqual(
    log.uploads.map((upload) => upload.kind),
    ['LANDMARKS_FTOB'],
  );
  assert.equal(log.registered, 1);
});

test('with raw consent the JPEG is taken before the network work and uploaded after it', async () => {
  const { channel, events } = rawChannel();
  const { deps: fieldDeps, log } = deps({ rawFrame: channel });

  const outcome = await runFieldCaptureSequence(
    'front',
    { ...CONSENT, rawFrameRetention: true },
    fieldDeps,
  );

  assert.equal(outcome.rawFrameUploaded, true);
  assert.deepEqual(events, ['capture', 'read', 'discard']);
  assert.deepEqual(
    log.calls,
    [
      'capture',
      'serialise',
      'digest',
      'createUpload:LANDMARKS_FTOB',
      'upload:artifact_LANDMARKS_FTOB',
      'registerObservation',
      'createUpload:RAW_FRAME',
      'upload:artifact_RAW_FRAME',
      'completeRawUpload:artifact_RAW_FRAME',
    ],
  );
  // Completion carries the artifact the slot was minted for, the native digest
  // the slot was signed with, and restatements of the size and content type.
  // It carries no pose label: `RawUploadCompletionRequest` forbids extra
  // fields, and a photograph is not a pose.
  assert.deepEqual(log.completions, [
    {
      artifactId: 'artifact_RAW_FRAME',
      sha256: 'd'.repeat(64),
      contentLength: 2048,
      contentType: 'image/jpeg',
    },
  ]);
  assert.ok(
    log.completions.every((completion) => !('pose' in completion) && !('pose_label' in completion)),
    'a completion request must not carry a pose label',
  );
  // And exactly one observation was registered: the geometry. A RAW_FRAME is
  // never filed as a second ScanObservation.
  assert.equal(log.registered, 1);
  const raw = log.uploads.find((upload) => upload.kind === 'RAW_FRAME')!;
  assert.equal(raw.contentType, 'image/jpeg');
  assert.equal(raw.length, 2048);
  // The digest is the native one over the exact bytes, not a JS re-derivation.
  assert.equal(raw.sha256, 'd'.repeat(64));
});

test('a sample below the production gate is still uploaded, with its verdict kept', async () => {
  const blurred = observationFixture('front', {
    quality: { ...observationFixture().quality, blur: 0.2 },
  });
  const { deps: fieldDeps, log } = deps({}, blurred);

  const outcome = await runFieldCaptureSequence('front', CONSENT, fieldDeps);

  assert.equal(outcome.gatePassed, false);
  assert.ok(outcome.gateFailures.includes('FT-SCAN-006'));
  assert.equal(outcome.verdict.primaryErrorCode, 'FT-SCAN-006');
  // Uploaded and registered anyway: the failing sample is the calibration
  // evidence. And the metric is reported as measured, not repaired.
  assert.equal(log.registered, 1);
  assert.equal(outcome.metrics.blur, 0.2);
});

test('an unmeasured signal travels as null and is never replaced with a number', async () => {
  const broken = observationFixture('front', {
    quality: {
      ...observationFixture().quality,
      blur: Number.NaN,
      neutrality: null,
    },
  });
  const record = fieldQualityRecord(broken);
  assert.equal(record.blur, null);
  assert.equal(record.neutrality, null);
  assert.equal(record.occlusion, null);
  assert.equal(record.face_count, 1);

  const { deps: fieldDeps } = deps({}, broken);
  const outcome = await runFieldCaptureSequence('front', CONSENT, fieldDeps);
  assert.equal(outcome.metrics.blur, null);
  assert.ok(outcome.gateFailures.includes('FT-SCAN-014'));
});

test("the server's own verdict on the observation is preserved verbatim", async () => {
  const { deps: fieldDeps } = deps({
    async registerObservation() {
      return { accepted: false, failures: ['FT-SCAN-009', 'FT-SCAN-011'] };
    },
  });
  const outcome = await runFieldCaptureSequence('front', CONSENT, fieldDeps);
  assert.equal(outcome.serverAccepted, false);
  assert.deepEqual(outcome.serverFailures, ['FT-SCAN-009', 'FT-SCAN-011']);
});

test('a geometry upload failure still discards the raw frame it had already taken', async () => {
  const { channel, events } = rawChannel();
  const { deps: fieldDeps } = deps({
    rawFrame: channel,
    async upload() {
      throw Object.assign(new Error('storage refused'), { code: 'FT-SCAN-013' });
    },
  });

  await assert.rejects(
    () => runFieldCaptureSequence('front', { ...CONSENT, rawFrameRetention: true }, fieldDeps),
    (error: { code?: string }) => error.code === 'FT-SCAN-013',
  );
  assert.deepEqual(events, ['capture', 'discard']);
});

test('a raw upload failure discards the frame and does not cost the participant the pose', async () => {
  const { channel, events } = rawChannel();
  let uploadCount = 0;
  const { deps: fieldDeps, log } = deps({
    rawFrame: channel,
    async upload() {
      uploadCount += 1;
      if (uploadCount === 2) throw Object.assign(new Error('nope'), { code: 'FT-SYS-002' });
    },
  });

  const outcome = await runFieldCaptureSequence(
    'front',
    { ...CONSENT, rawFrameRetention: true },
    fieldDeps,
  );

  assert.equal(outcome.rawFrameUploaded, false);
  assert.equal(outcome.rawFrameErrorCode, 'FT-SYS-002');
  assert.equal(log.registered, 1, 'the geometry observation still counts');
  assert.deepEqual(events, ['capture', 'read', 'discard']);
});

test('a raw export that fails outright leaves the geometry path untouched', async () => {
  const { channel, events } = rawChannel({
    async capture() {
      events.push('capture-attempt');
      throw Object.assign(new Error('no frame'), { code: 'FT-SCAN-014' });
    },
  });
  const { deps: fieldDeps, log } = deps({ rawFrame: channel });

  const outcome = await runFieldCaptureSequence(
    'front',
    { ...CONSENT, rawFrameRetention: true },
    fieldDeps,
  );

  assert.equal(outcome.rawFrameUploaded, false);
  assert.equal(outcome.rawFrameErrorCode, 'FT-SCAN-014');
  assert.equal(log.registered, 1);
  // Nothing was ever held natively, so nothing is discarded.
  assert.deepEqual(events, ['capture-attempt']);
});

test('a discard that itself fails does not replace the real error', async () => {
  const { channel } = rawChannel({
    async discard() {
      throw new Error('bridge gone');
    },
  });
  const { deps: fieldDeps } = deps({
    rawFrame: channel,
    async registerObservation() {
      throw Object.assign(new Error('rejected'), { code: 'FT-SCAN-012' });
    },
  });

  await assert.rejects(
    () => runFieldCaptureSequence('front', { ...CONSENT, rawFrameRetention: true }, fieldDeps),
    (error: { code?: string }) => error.code === 'FT-SCAN-012',
  );
});

test('a device with no raw-frame export still collects geometry for a consenting participant', async () => {
  const { deps: fieldDeps, log } = deps({ rawFrame: null });
  const outcome = await runFieldCaptureSequence(
    'front',
    { ...CONSENT, rawFrameRetention: true },
    fieldDeps,
  );
  assert.equal(outcome.rawFrameUploaded, false);
  assert.equal(log.registered, 1);
  assert.deepEqual(
    log.uploads.map((upload) => upload.kind),
    ['LANDMARKS_FTOB'],
  );
});

test('a PUT whose completion call fails is not reported as a stored photograph', async () => {
  // The bytes are in the bucket and the server has not confirmed holding
  // them — either the call failed or the response did not actually confirm
  // this artifact. Claiming the photograph was stored would be a claim the
  // backend contradicts.
  const { channel, events } = rawChannel();
  const { deps: fieldDeps, log } = deps({
    rawFrame: channel,
    async completeRawUpload() {
      throw Object.assign(new Error('unconfirmed'), {
        code: 'FIELD_RAW_COMPLETION_MISMATCH',
      });
    },
  });

  const outcome = await runFieldCaptureSequence(
    'front',
    { ...CONSENT, rawFrameRetention: true },
    fieldDeps,
  );

  assert.equal(outcome.rawFrameUploaded, false);
  assert.equal(outcome.rawFrameErrorCode, 'FIELD_RAW_COMPLETION_MISMATCH');
  // The PUT did happen — the failure is the confirmation, not the transfer —
  // and the participant is owed that fact even though the server has no record
  // of it: their face is in the object store either way.
  assert.equal(outcome.rawFrameSent, true);
  // The pose is still collected.
  assert.ok(log.calls.includes('upload:artifact_RAW_FRAME'));
  assert.equal(log.registered, 1);
  assert.equal(outcome.gatePassed, true);
  // The native slot is still zeroed on the way out.
  assert.deepEqual(events, ['capture', 'read', 'discard']);
});

test('a completion failure with no code of its own still reports a code', async () => {
  const { channel } = rawChannel();
  const { deps: fieldDeps } = deps({
    rawFrame: channel,
    async completeRawUpload() {
      throw new Error('socket closed');
    },
  });

  const outcome = await runFieldCaptureSequence(
    'front',
    { ...CONSENT, rawFrameRetention: true },
    fieldDeps,
  );

  assert.equal(outcome.rawFrameUploaded, false);
  assert.equal(outcome.rawFrameErrorCode, 'FT-SYS-003');
});

test('completion is never called for a raw frame that was never uploaded', async () => {
  const { channel } = rawChannel();
  let uploadCount = 0;
  const { deps: fieldDeps, log } = deps({
    rawFrame: channel,
    async upload() {
      uploadCount += 1;
      if (uploadCount === 2) throw Object.assign(new Error('nope'), { code: 'FT-SYS-002' });
    },
  });

  const outcome = await runFieldCaptureSequence(
    'front',
    { ...CONSENT, rawFrameRetention: true },
    fieldDeps,
  );

  assert.equal(outcome.rawFrameUploaded, false);
  // The transfer itself failed, so nothing left the device.
  assert.equal(outcome.rawFrameSent, false);
  assert.equal(outcome.rawFrameErrorCode, 'FT-SYS-002');
  assert.deepEqual(log.completions, []);
});

test('no raw consent means no completion call and no RAW_FRAME upload at all', async () => {
  const { channel } = rawChannel();
  const { deps: fieldDeps, log } = deps({ rawFrame: channel });

  const outcome = await runFieldCaptureSequence('front', CONSENT, fieldDeps);

  assert.equal(outcome.rawFrameUploaded, false);
  assert.deepEqual(log.completions, []);
  assert.ok(!log.calls.some((call) => call.startsWith('completeRawUpload')));
});
