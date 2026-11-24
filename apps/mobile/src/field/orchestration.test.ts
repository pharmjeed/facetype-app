/**
 * The end-to-end binding between a collecting handset and the field-study
 * platform, driven through the real orchestrator and the real capture sequence.
 *
 * WHY THIS SUITE EXISTS. Every module in this lane passed its own unit tests
 * while the app, taken as a whole, never called a single field-study endpoint:
 * it created anonymous scans, uploaded geometry, and the study dashboard stayed
 * at zero. That is not a defect any per-module test can see, because each module
 * was correct about the part it owned. What was missing was an assertion about
 * the *sequence* — that the calls happen, in the order the server requires, with
 * the arguments the server needs — so that is what this file asserts, against
 * the real `FieldStudyOrchestrator` and the real `runFieldCaptureSequence`.
 *
 * WHAT THE DOUBLES ARE FOR. `recordingApi` is a stand-in for the network and
 * nothing else: it implements `FieldStudyApi` exactly, records every call in
 * order with its arguments, and answers with the shapes the generated types
 * describe. Everything under test — the ordering rules, the fail-closed gates,
 * the participant lifecycle, the raw-frame confirmation — is production code.
 * There is no mock of the orchestrator and no stub of the capture sequence.
 *
 * THE ORDER BEING PINNED, once per participant:
 *
 *   fieldStudyPolicy
 *     -> joinFieldSession                       (once per session, not per person)
 *       -> addParticipant                       (server mints P-xxxxxx)
 *         -> recordConsent(research, true)
 *         -> recordConsent(photo, true|false)
 *           -> createScan
 *           -> attachCapture                    (before any byte is uploaded)
 *             -> createUpload(LANDMARKS_FTOB) -> PUT -> registerObservation
 *             -> createUpload(RAW_FRAME)      -> PUT -> completeRawUpload
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  CaptureStateResponse,
  ConsentFact,
  FieldSessionResponse,
  FieldStudyPolicyResponse,
  ObservationResponse,
  ParticipantSummary,
  RawUploadCompletionResponse,
  ScanResponse,
  UploadResponse,
} from '@facetype/contracts';

import type { FieldStudyApi } from '../api/fieldStudy.ts';
import { POSES, serialiseObservation } from '../capture/types.ts';
import { runFieldCaptureSequence } from './fieldCapture.ts';
import {
  assertRawUploadConfirmed,
  FieldStudyOrchestrator,
  PHOTO_CONSENT,
  RESEARCH_CONSENT,
  type FieldPoseTransport,
} from './orchestrator.ts';
import type { RawFrameChannel, RawFrameHandle } from './rawFrame.ts';
import { observationFixture } from './__fixtures__/observation.ts';

const GEOMETRY_SHA = 'c'.repeat(64);
const RAW_SHA = 'd'.repeat(64);

const POLICY: FieldStudyPolicyResponse = {
  capture_protocol: 'cap-1.0.0',
  consent_policy_version: 'consent-1.0.0',
  raw_photo_retention_days: 7,
  raw_photo_retention_enabled: true,
  max_raw_photo_retention_days: 30,
  consent_types: [RESEARCH_CONSENT, PHOTO_CONSENT],
  required_poses: [...POSES],
  not_a_personality_result: true,
};

const SESSION: FieldSessionResponse = {
  session_id: 'fs_riyadh_1',
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

interface Call {
  method: string;
  args: unknown[];
}

interface Overrides {
  policy?: FieldStudyPolicyResponse | (() => never);
  session?: FieldSessionResponse;
  participants?: string[];
  failOn?: Partial<Record<keyof FieldStudyApi, () => void>>;
  completion?: Partial<RawUploadCompletionResponse>;
  observation?: Partial<ObservationResponse>;
}

/**
 * A `FieldStudyApi` that records rather than fetches.
 *
 * It answers with the generated response shapes, so a field the orchestrator
 * reads but the server does not send would surface here as `undefined` rather
 * than being invented by the double.
 */
function recordingApi(overrides: Overrides = {}): { api: FieldStudyApi; calls: Call[] } {
  const calls: Call[] = [];
  const refs = overrides.participants ?? ['P-000001', 'P-000002', 'P-000003'];
  let allocated = 0;
  let scans = 0;

  const record = (method: keyof FieldStudyApi, ...args: unknown[]) => {
    calls.push({ method, args });
    overrides.failOn?.[method]?.();
  };

  const api: FieldStudyApi = {
    async fieldStudyPolicy() {
      record('fieldStudyPolicy');
      return (overrides.policy as FieldStudyPolicyResponse) ?? POLICY;
    },
    async joinFieldSession(joinCode) {
      record('joinFieldSession', joinCode);
      return overrides.session ?? SESSION;
    },
    async addParticipant(sessionId, idempotencyKey) {
      record('addParticipant', sessionId, idempotencyKey);
      const participantRef: string = refs[allocated] ?? 'P-999999';
      allocated += 1;
      const summary: ParticipantSummary = {
        participant_ref: participantRef,
        participant_id: `fsp_${allocated}`,
        created_at: '2026-08-28T09:05:00Z',
        research_consent_granted: false,
        photo_consent_granted: false,
        capture_count: 0,
        retained_photo_count: 0,
      };
      return summary;
    },
    async recordConsent(sessionId, participantRef, body) {
      record('recordConsent', sessionId, participantRef, body);
      const fact: ConsentFact = {
        consent_type: body.consent_type,
        granted: body.granted,
        policy_version: 'consent-1.0.0',
        recorded_at: '2026-08-28T09:06:00Z',
        withdrawn: !body.granted,
      };
      return [fact];
    },
    async createScan(body, idempotencyKey) {
      record('createScan', body, idempotencyKey);
      scans += 1;
      const scan: ScanResponse = {
        scan_id: `scan_${scans}`,
        status: 'CAPTURING',
        capture_protocol: 'cap-1.0.0',
        capture_mode: 'geometry_preferred',
        required_poses: [...POSES],
        attempt: 1,
        locale: 'ar-SA',
        privacy: { retain_raw_frames: false, research_opt_in: true },
        created_at: '2026-08-28T09:07:00Z',
      };
      return scan;
    },
    async attachCapture(sessionId, body) {
      record('attachCapture', sessionId, body);
      const state: CaptureStateResponse = {
        scan_id: body.scan_id,
        status: 'CAPTURING',
        collection_status: 'CAPTURING',
        processing_state: 'WAITING_FOR_QUALIFIED_POSES',
        retake_poses: [...POSES],
        attempt: 1,
        device_platform: 'android',
        captured_poses: [],
        missing_poses: [...POSES],
        pose_completion: 0,
        uploaded_artifacts: 0,
        pending_artifacts: 0,
        cluster: { state: 'NOT_YET_CLUSTERED' },
        geometry: { state: 'UNAVAILABLE' },
        created_at: '2026-08-28T09:07:01Z',
      };
      return state;
    },
    async getOwnCapture(sessionId, scanId) {
      record('getOwnCapture', sessionId, scanId);
      return {
        scan_id: scanId,
        status: 'CAPTURING',
        collection_status: 'COMPLETED',
        processing_state: 'READY',
        retake_poses: [],
        attempt: 1,
        device_platform: 'android',
        captured_poses: [...POSES],
        missing_poses: [],
        pose_completion: 1,
        uploaded_artifacts: 5,
        pending_artifacts: 0,
        cluster: { state: 'NOT_YET_CLUSTERED' },
        geometry: { state: 'UNAVAILABLE' },
        created_at: '2026-08-28T09:07:01Z',
      };
    },
    async createUpload(scanId, body) {
      record('createUpload', scanId, body);
      const response: UploadResponse = {
        upload_url: `/uploads/${body.artifact_kind}`,
        method: 'PUT',
        headers: { 'Content-Type': body.content_type ?? 'application/octet-stream' },
        object_key: `key/${body.artifact_kind}`,
        artifact_id: `artifact_${body.artifact_kind}`,
        expires_in_seconds: 900,
        max_bytes: 16 * 1024 * 1024,
      };
      return response;
    },
    async registerObservation(scanId, body) {
      record('registerObservation', scanId, body);
      const response: ObservationResponse = {
        observation_id: 'obs_server_1',
        scan_id: scanId,
        pose_label: body.pose_label,
        provider: body.provider,
        accepted: true,
        quality: {},
        failures: [],
        ...overrides.observation,
      };
      return response;
    },
    async completeRawUpload(scanId, artifactId, body) {
      record('completeRawUpload', scanId, artifactId, body);
      const response: RawUploadCompletionResponse = {
        artifact_id: artifactId,
        scan_id: scanId,
        kind: 'RAW_FRAME',
        uploaded: true,
        state: 'CONFIRMED',
        sha256: body.sha256,
        bytes: body.content_length ?? 2048,
        content_type: body.content_type ?? 'image/jpeg',
        retention_expires_at: '2026-09-04T09:10:00Z',
        attempt: 1,
        observation_registered: false,
        ...overrides.completion,
      };
      return response;
    },
  };

  return { api, calls };
}

/** Sequential, predictable idempotency keys, so the assertions can name them. */
function keyMinter(): () => string {
  let issued = 0;
  return () => {
    issued += 1;
    return `key-${issued}`;
  };
}

function rawChannel(): { channel: RawFrameChannel; events: string[] } {
  const events: string[] = [];
  const handle: RawFrameHandle = {
    token: 'slot-1',
    byteLength: 2048,
    sha256: RAW_SHA,
    width: 640,
    height: 480,
  };
  return {
    events,
    channel: {
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
    },
  };
}

function transport(
  puts: string[],
  rawFrame: RawFrameChannel | null = null,
): FieldPoseTransport {
  return {
    capture: async (pose) => observationFixture(pose),
    serialise: serialiseObservation,
    digest: async () => GEOMETRY_SHA,
    upload: async (slot) => {
      puts.push(`PUT ${slot.upload_url}`);
    },
    rawFrame,
    now: () => 1_700_000_000_500,
  };
}

/** Everything up to and including the attach, for one participant. */
async function bindParticipant(
  orchestrator: FieldStudyOrchestrator,
  { photoGranted = false }: { photoGranted?: boolean } = {},
): Promise<{ participantRef: string; scanId: string }> {
  const participantRef = await orchestrator.allocateParticipant();
  await orchestrator.recordConsent({
    researchGranted: true,
    photoGranted,
    locale: 'ar-SA',
    nowMs: 1_700_000_000_000,
  });
  const scanId = await orchestrator.createAndAttachScan({
    platform: 'android',
    deviceModel: 'unknown',
    appVersion: '1.0.0',
    providerCapability: 'arcore',
    locale: 'ar-SA',
  });
  return { participantRef, scanId };
}

async function joined(overrides: Overrides = {}) {
  const { api, calls } = recordingApi(overrides);
  const orchestrator = new FieldStudyOrchestrator(api, keyMinter());
  await orchestrator.loadPolicy();
  await orchestrator.join('JOIN-CODE-42');
  return { orchestrator, calls };
}

// --------------------------------------------------------------------------
// the whole sequence
// --------------------------------------------------------------------------

test('one consented participant produces exactly the platform sequence, in order', async () => {
  const { orchestrator, calls } = await joined();
  const { channel, events } = rawChannel();
  const puts: string[] = [];

  const { participantRef, scanId } = await bindParticipant(orchestrator, { photoGranted: true });
  const outcome = await runFieldCaptureSequence(
    'front',
    orchestrator.activeParticipant!.consent!,
    orchestrator.poseDeps(transport(puts, channel)),
  );

  assert.deepEqual(
    calls.map((call) => call.method),
    [
      'fieldStudyPolicy',
      'joinFieldSession',
      'addParticipant',
      'recordConsent',
      'recordConsent',
      'createScan',
      'attachCapture',
      'createUpload',
      'registerObservation',
      'createUpload',
      'completeRawUpload',
    ],
  );

  // -- the arguments, call by call ----------------------------------------
  assert.deepEqual(calls[0]!.args, []);
  assert.deepEqual(calls[1]!.args, ['JOIN-CODE-42']);

  // The allocation carries the session and an idempotency key, and nothing
  // that could identify anybody.
  assert.deepEqual(calls[2]!.args, ['fs_riyadh_1', 'key-1']);
  assert.equal(participantRef, 'P-000001');

  // Research first, then photographs. Both before the scan exists.
  assert.deepEqual(calls[3]!.args, [
    'fs_riyadh_1',
    'P-000001',
    { consent_type: RESEARCH_CONSENT, granted: true, locale: 'ar-SA' },
  ]);
  assert.deepEqual(calls[4]!.args, [
    'fs_riyadh_1',
    'P-000001',
    { consent_type: PHOTO_CONSENT, granted: true, locale: 'ar-SA' },
  ]);

  // The scan is created under the server's protocol and the session's consent
  // wording version, never a build constant, and with its own key.
  const createScan = calls[5]!.args[0] as Record<string, unknown>;
  assert.equal(createScan.capture_protocol, 'cap-1.0.0');
  assert.equal(createScan.consent_policy_version, 'consent-1.0.0');
  assert.deepEqual(createScan.privacy, { retain_raw_frames: true, research_opt_in: true });
  assert.equal(createScan.obstruction_self_attested, true);
  assert.equal(calls[5]!.args[1], 'key-2');

  // The attach names the participant and the scan, and happens before any
  // upload slot is requested.
  assert.deepEqual(calls[6]!.args, [
    'fs_riyadh_1',
    { participant_ref: 'P-000001', scan_id: 'scan_1' },
  ]);
  assert.equal(scanId, 'scan_1');

  // Geometry: slot, PUT, observation.
  const geometrySlot = calls[7]!.args[1] as Record<string, unknown>;
  assert.equal(geometrySlot.artifact_kind, 'LANDMARKS_FTOB');
  assert.equal(geometrySlot.pose_label, 'front');
  assert.equal(geometrySlot.content_type, 'application/vnd.facetype.ftob');
  const observation = calls[8]!.args[1] as Record<string, unknown>;
  assert.equal(observation.artifact_kind, 'LANDMARKS_FTOB');
  assert.equal(observation.artifact_id, 'artifact_LANDMARKS_FTOB');
  assert.equal(observation.pose_label, 'front');

  // Photograph: slot, PUT, completion — and the completion carries the digest,
  // the size and the content type, and no pose label.
  const rawSlot = calls[9]!.args[1] as Record<string, unknown>;
  assert.equal(rawSlot.artifact_kind, 'RAW_FRAME');
  assert.equal(rawSlot.content_type, 'image/jpeg');
  assert.equal(rawSlot.sha256, RAW_SHA);
  assert.deepEqual(calls[10]!.args, [
    'scan_1',
    'artifact_RAW_FRAME',
    { sha256: RAW_SHA, content_length: 2048, content_type: 'image/jpeg' },
  ]);
  assert.equal('pose_label' in (calls[10]!.args[2] as object), false);

  assert.deepEqual(puts, ['PUT /uploads/LANDMARKS_FTOB', 'PUT /uploads/RAW_FRAME']);
  assert.deepEqual(events, ['capture', 'read', 'discard']);
  assert.equal(outcome.rawFrameSent, true);
  assert.equal(outcome.rawFrameUploaded, true);
  assert.equal(outcome.rawFrameErrorCode, null);
});

test('a participant who declines photographs still has that answer recorded', async () => {
  const { orchestrator, calls } = await joined();
  await bindParticipant(orchestrator, { photoGranted: false });

  const consents = calls.filter((call) => call.method === 'recordConsent');
  assert.equal(consents.length, 2, 'both facts are recorded, not just the granted one');
  assert.deepEqual((consents[1]!.args[2] as { consent_type: string; granted: boolean }), {
    consent_type: PHOTO_CONSENT,
    granted: false,
    locale: 'ar-SA',
  });
  // And the scan is created saying so, so the server never dates a raw frame
  // under a retention this participant did not agree to.
  const createScan = calls.find((call) => call.method === 'createScan')!;
  assert.deepEqual((createScan.args[0] as { privacy: unknown }).privacy, {
    retain_raw_frames: false,
    research_opt_in: true,
  });
});

test('no photograph is created for a participant who declined, even with a channel wired', async () => {
  const { orchestrator, calls } = await joined();
  const { channel, events } = rawChannel();
  const puts: string[] = [];

  await bindParticipant(orchestrator, { photoGranted: false });
  const outcome = await runFieldCaptureSequence(
    'front',
    orchestrator.activeParticipant!.consent!,
    orchestrator.poseDeps(transport(puts, channel)),
  );

  assert.deepEqual(events, [], 'the native channel is never touched');
  assert.deepEqual(puts, ['PUT /uploads/LANDMARKS_FTOB']);
  assert.equal(calls.some((call) => call.method === 'completeRawUpload'), false);
  assert.equal(outcome.rawFrameSent, false);
});

// --------------------------------------------------------------------------
// every pre-camera gate fails closed
// --------------------------------------------------------------------------

test('a policy the deployment will not answer for blocks the session and the camera', async () => {
  const { api, calls } = recordingApi({
    failOn: {
      fieldStudyPolicy: () => {
        throw new Error('403');
      },
    },
  });
  const orchestrator = new FieldStudyOrchestrator(api, keyMinter());

  await assert.rejects(
    () => orchestrator.loadPolicy(),
    (error: { code?: string }) => error.code === 'FIELD_POLICY_UNAVAILABLE',
  );
  // No fallback to a build-supplied promise: the session cannot even be joined.
  await assert.rejects(
    () => orchestrator.join('JOIN-CODE-42'),
    (error: { code?: string }) => error.code === 'FIELD_POLICY_UNAVAILABLE',
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ['fieldStudyPolicy'],
  );
});

test('a policy that contradicts itself blocks the session before anyone is asked anything', async () => {
  const { api, calls } = recordingApi({
    policy: { ...POLICY, raw_photo_retention_days: 0, raw_photo_retention_enabled: true },
  });
  const orchestrator = new FieldStudyOrchestrator(api, keyMinter());
  await assert.rejects(
    () => orchestrator.loadPolicy(),
    (error: { code?: string }) => error.code === 'FIELD_POLICY_RETENTION_INCONSISTENT',
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ['fieldStudyPolicy'],
  );
});

test('a device that has not joined cannot allocate, consent, attach or capture', async () => {
  const { api, calls } = recordingApi();
  const orchestrator = new FieldStudyOrchestrator(api, keyMinter());
  await orchestrator.loadPolicy();

  const notJoined = (error: { code?: string }) => error.code === 'FIELD_NOT_JOINED';
  await assert.rejects(() => orchestrator.allocateParticipant(), notJoined);
  await assert.rejects(
    () =>
      orchestrator.recordConsent({
        researchGranted: true,
        photoGranted: false,
        locale: 'ar-SA',
        nowMs: 1,
      }),
    notJoined,
  );
  assert.throws(() => orchestrator.poseDeps(transport([])), notJoined);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['fieldStudyPolicy'],
  );
});

test('a join code the server refuses leaves the device unjoined and allocates nobody', async () => {
  const { api, calls } = recordingApi({
    failOn: {
      joinFieldSession: () => {
        throw Object.assign(new Error('bad code'), { code: 'FT-FIELD-003' });
      },
    },
  });
  const orchestrator = new FieldStudyOrchestrator(api, keyMinter());
  await orchestrator.loadPolicy();

  await assert.rejects(() => orchestrator.join('WRONG-CODE'), { code: 'FT-FIELD-003' });
  assert.equal(orchestrator.joined, null);
  await assert.rejects(
    () => orchestrator.allocateParticipant(),
    (error: { code?: string }) => error.code === 'FIELD_NOT_JOINED',
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ['fieldStudyPolicy', 'joinFieldSession'],
  );
});

test('a join code that is not a session code is not sent at all', async () => {
  // The bounds are the server's own (`min_length=4, max_length=64`). Checking
  // them here is not validation theatre: a request that cannot succeed still
  // puts the operator's spoken code on the wire and into a request log.
  await Promise.all(
    ['', '   ', 'abc', 'x'.repeat(65)].map(async (bad) => {
      const { api, calls } = recordingApi();
      const orchestrator = new FieldStudyOrchestrator(api, keyMinter());
      await orchestrator.loadPolicy();
      await assert.rejects(
        () => orchestrator.join(bad),
        (error: { code?: string }) => error.code === 'FIELD_JOIN_CODE_MALFORMED',
        JSON.stringify(bad),
      );
      assert.deepEqual(
        calls.map((call) => call.method),
        ['fieldStudyPolicy'],
        JSON.stringify(bad),
      );
    }),
  );
});

test('a join code with spaces around it is still the code the operator read out', async () => {
  const { orchestrator, calls } = await joined();
  assert.deepEqual(calls[1]!.args, ['JOIN-CODE-42']);
  assert.equal(orchestrator.joined?.sessionId, 'fs_riyadh_1');

  const { api, calls: padded } = recordingApi();
  const second = new FieldStudyOrchestrator(api, keyMinter());
  await second.loadPolicy();
  await second.join('  JOIN-CODE-42  ');
  assert.deepEqual(padded[1]!.args, ['JOIN-CODE-42']);
});

test('joining twice is refused, so a device cannot drift to another study mid-session', async () => {
  const { orchestrator, calls } = await joined();
  await assert.rejects(
    () => orchestrator.join('ANOTHER-CODE'),
    (error: { code?: string }) => error.code === 'FIELD_ALREADY_JOINED',
  );
  assert.equal(calls.filter((call) => call.method === 'joinFieldSession').length, 1);
});

test('an allocation that fails records no consent and creates no scan', async () => {
  const { api, calls } = recordingApi({
    failOn: {
      addParticipant: () => {
        throw Object.assign(new Error('session closed'), { code: 'FT-FIELD-005' });
      },
    },
  });
  const orchestrator = new FieldStudyOrchestrator(api, keyMinter());
  await orchestrator.loadPolicy();
  await orchestrator.join('JOIN-CODE-42');

  await assert.rejects(() => orchestrator.allocateParticipant(), { code: 'FT-FIELD-005' });
  assert.deepEqual(
    calls.map((call) => call.method),
    ['fieldStudyPolicy', 'joinFieldSession', 'addParticipant'],
  );
  // And the camera cannot open: there is nothing to attribute a scan to.
  assert.throws(
    () => orchestrator.poseDeps(transport([])),
    (error: { code?: string }) => error.code === 'FIELD_PARTICIPANT_NOT_ALLOCATED',
  );
});

test('a reference the server did not mint in the study shape is refused', async () => {
  // A server that answered with a name, an email address or a free-text label
  // would put a direct identifier on the consent screen and into the receipt.
  for (const unusable of ['Ali Hassan', 'ali@example.com', 'p-000001', '']) {
    const { api } = recordingApi({ participants: [unusable] });
    const orchestrator = new FieldStudyOrchestrator(api, keyMinter());
    await orchestrator.loadPolicy();
    await orchestrator.join('JOIN-CODE-42');
    await assert.rejects(
      () => orchestrator.allocateParticipant(),
      (error: { code?: string }) => error.code === 'FIELD_PARTICIPANT_REF_UNUSABLE',
      unusable,
    );
  }
});

test('a research consent that fails stops the photograph question and the scan', async () => {
  const { api, calls } = recordingApi({
    failOn: {
      recordConsent: () => {
        throw Object.assign(new Error('offline'), { code: 'FT-SYS-002' });
      },
    },
  });
  const orchestrator = new FieldStudyOrchestrator(api, keyMinter());
  await orchestrator.loadPolicy();
  await orchestrator.join('JOIN-CODE-42');
  await orchestrator.allocateParticipant();

  await assert.rejects(
    () =>
      orchestrator.recordConsent({
        researchGranted: true,
        photoGranted: true,
        locale: 'ar-SA',
        nowMs: 1_700_000_000_000,
      }),
    { code: 'FT-SYS-002' },
  );

  // One consent attempt, and nothing after it.
  assert.deepEqual(
    calls.map((call) => call.method),
    ['fieldStudyPolicy', 'joinFieldSession', 'addParticipant', 'recordConsent'],
  );
  await assert.rejects(
    () =>
      orchestrator.createAndAttachScan({
        platform: 'android',
        deviceModel: 'unknown',
        appVersion: '1.0.0',
        providerCapability: 'arcore',
        locale: 'ar-SA',
      }),
    (error: { code?: string }) => error.code === 'FIELD_CONSENT_NOT_RECORDED',
  );
});

test('a photograph consent that fails after the research one still stops the camera', async () => {
  let consents = 0;
  const { api, calls } = recordingApi({
    failOn: {
      recordConsent: () => {
        consents += 1;
        if (consents === 2) {
          throw Object.assign(new Error('offline'), { code: 'FT-SYS-002' });
        }
      },
    },
  });
  const orchestrator = new FieldStudyOrchestrator(api, keyMinter());
  await orchestrator.loadPolicy();
  await orchestrator.join('JOIN-CODE-42');
  await orchestrator.allocateParticipant();

  await assert.rejects(
    () =>
      orchestrator.recordConsent({
        researchGranted: true,
        photoGranted: true,
        locale: 'ar-SA',
        nowMs: 1_700_000_000_000,
      }),
    { code: 'FT-SYS-002' },
  );
  assert.equal(calls.some((call) => call.method === 'createScan'), false);
  assert.throws(
    () => orchestrator.poseDeps(transport([])),
    (error: { code?: string }) => error.code === 'FIELD_CONSENT_NOT_RECORDED',
  );
});

test('a refused research grant is never sent as a grant', async () => {
  const { orchestrator, calls } = await joined();
  await orchestrator.allocateParticipant();
  const before = calls.length;

  await assert.rejects(
    () =>
      orchestrator.recordConsent({
        researchGranted: false,
        photoGranted: false,
        locale: 'ar-SA',
        nowMs: 1_700_000_000_000,
      }),
    (error: { code?: string }) => error.code === 'FIELD_CONSENT_NOT_RECORDED',
  );
  assert.equal(calls.length, before, 'nothing at all is sent for a refusal handled this way');
});

test('a participant who declines is recorded as declining, not merely dropped', async () => {
  const { orchestrator, calls } = await joined();
  await orchestrator.allocateParticipant();
  await orchestrator.declineParticipant('ar-SA');

  const consents = calls.filter((call) => call.method === 'recordConsent');
  assert.equal(consents.length, 1);
  assert.deepEqual(consents[0]!.args[2], {
    consent_type: RESEARCH_CONSENT,
    granted: false,
    locale: 'ar-SA',
  });
  // "Asked and declined" is a different fact from "never asked", and no scan
  // was created either way.
  assert.equal(calls.some((call) => call.method === 'createScan'), false);
});

test('a photograph grant is refused on a deployment that keeps no photograph', async () => {
  const { api, calls } = recordingApi({
    policy: { ...POLICY, raw_photo_retention_days: 0, raw_photo_retention_enabled: false },
    session: { ...SESSION, raw_photo_retention_days: 0, raw_photo_retention_enabled: false },
  });
  const orchestrator = new FieldStudyOrchestrator(api, keyMinter());
  await orchestrator.loadPolicy();
  await orchestrator.join('JOIN-CODE-42');
  await orchestrator.allocateParticipant();

  await assert.rejects(
    () =>
      orchestrator.recordConsent({
        researchGranted: true,
        photoGranted: true,
        locale: 'ar-SA',
        nowMs: 1_700_000_000_000,
      }),
    (error: { code?: string }) => error.code === 'FIELD_PHOTO_CONSENT_UNAVAILABLE',
  );
  // Refused before either fact is written: a grant for something that cannot
  // happen is not a grant to record.
  assert.equal(calls.some((call) => call.method === 'recordConsent'), false);

  // Geometry collection still works on such a deployment — the photograph
  // question is what closes, not the study.
  await orchestrator.recordConsent({
    researchGranted: true,
    photoGranted: false,
    locale: 'ar-SA',
    nowMs: 1_700_000_000_000,
  });
  assert.equal(orchestrator.activeParticipant?.consent?.rawPhotoRetentionDays, 0);
});

test('a scan that could not be attached may not upload anything', async () => {
  const { api, calls } = recordingApi({
    failOn: {
      attachCapture: () => {
        throw Object.assign(new Error('not yours'), { code: 'FT-SCAN-001' });
      },
    },
  });
  const orchestrator = new FieldStudyOrchestrator(api, keyMinter());
  await orchestrator.loadPolicy();
  await orchestrator.join('JOIN-CODE-42');
  await assert.rejects(() => bindParticipant(orchestrator), { code: 'FT-SCAN-001' });

  // The scan exists — it has to, for the attach to name it — but nothing may
  // be uploaded against it, because an unattached scan is an anonymous scan
  // and a raw frame on one is dated under the ephemeral policy.
  assert.deepEqual(
    calls.map((call) => call.method),
    [
      'fieldStudyPolicy',
      'joinFieldSession',
      'addParticipant',
      'recordConsent',
      'recordConsent',
      'createScan',
      'attachCapture',
    ],
  );
  assert.throws(
    () => orchestrator.poseDeps(transport([])),
    (error: { code?: string }) => error.code === 'FIELD_CAPTURE_NOT_ATTACHED',
  );
});

// --------------------------------------------------------------------------
// the raw-frame confirmation
// --------------------------------------------------------------------------

test('a completion that does not confirm this photograph is not a confirmation', async () => {
  const cases: [string, Partial<RawUploadCompletionResponse>][] = [
    ['the server did not mark it stored', { uploaded: false }],
    ['it confirmed geometry, not a photograph', { kind: 'LANDMARKS_FTOB' }],
    ['it registered an observation', { observation_registered: true }],
    ['it said nothing about registering one', { observation_registered: undefined }],
    ['it is about a different artifact', { artifact_id: 'artifact_something_else' }],
    ['the digest does not match the bytes that were sent', { sha256: 'e'.repeat(64) }],
  ];

  for (const [reason, completion] of cases) {
    const { api, calls } = recordingApi({ completion });
    const orchestrator = new FieldStudyOrchestrator(api, keyMinter());
    await orchestrator.loadPolicy();
    await orchestrator.join('JOIN-CODE-42');
    const { channel, events } = rawChannel();
    const puts: string[] = [];
    await bindParticipant(orchestrator, { photoGranted: true });

    const outcome = await runFieldCaptureSequence(
      'front',
      orchestrator.activeParticipant!.consent!,
      orchestrator.poseDeps(transport(puts, channel)),
    );

    assert.equal(outcome.rawFrameUploaded, false, reason);
    assert.equal(outcome.rawFrameErrorCode, 'FIELD_RAW_COMPLETION_MISMATCH', reason);
    // The bytes did leave the device, and the participant is owed that fact.
    assert.equal(outcome.rawFrameSent, true, reason);
    // The pose is still collected, exactly one observation is registered, and
    // the native slot is still zeroed.
    assert.equal(calls.filter((call) => call.method === 'registerObservation').length, 1, reason);
    assert.deepEqual(events, ['capture', 'read', 'discard'], reason);
  }
});

test('a photograph is never registered as an observation', async () => {
  const { orchestrator, calls } = await joined();
  const { channel } = rawChannel();
  await bindParticipant(orchestrator, { photoGranted: true });
  await runFieldCaptureSequence(
    'front',
    orchestrator.activeParticipant!.consent!,
    orchestrator.poseDeps(transport([], channel)),
  );

  const observations = calls.filter((call) => call.method === 'registerObservation');
  assert.equal(observations.length, 1, 'one pose, one observation — never a second for the photo');
  const body = observations[0]!.args[1] as { artifact_kind: string; artifact_id: string };
  assert.equal(body.artifact_kind, 'LANDMARKS_FTOB');
  assert.notEqual(body.artifact_id, 'artifact_RAW_FRAME');
  // And the completion route is the only thing the photograph went through.
  assert.equal(calls.filter((call) => call.method === 'completeRawUpload').length, 1);
});

test('the completion assertion is the thing that decides, and it is checkable alone', () => {
  const confirmed: RawUploadCompletionResponse = {
    artifact_id: 'artifact_RAW_FRAME',
    scan_id: 'scan_1',
    kind: 'RAW_FRAME',
    uploaded: true,
    state: 'CONFIRMED',
    sha256: RAW_SHA,
    bytes: 2048,
    content_type: 'image/jpeg',
    retention_expires_at: '2026-09-04T09:10:00Z',
    attempt: 1,
    observation_registered: false,
  };
  const expected = { artifactId: 'artifact_RAW_FRAME', sha256: RAW_SHA };
  assert.doesNotThrow(() => assertRawUploadConfirmed(confirmed, expected));
  // A server that upper-cases the digest has still confirmed the same bytes.
  assert.doesNotThrow(() =>
    assertRawUploadConfirmed({ ...confirmed, sha256: RAW_SHA.toUpperCase() }, expected),
  );
  assert.throws(
    () => assertRawUploadConfirmed(null, expected),
    (error: { code?: string }) => error.code === 'FIELD_RAW_COMPLETION_MISMATCH',
  );
});

// --------------------------------------------------------------------------
// the next participant, and the cold restart
// --------------------------------------------------------------------------

test('the next participant gets the server’s next reference, on the same joined session', async () => {
  const { orchestrator, calls } = await joined();

  const first = await bindParticipant(orchestrator);
  orchestrator.releaseParticipant();
  const second = await bindParticipant(orchestrator);

  assert.equal(first.participantRef, 'P-000001');
  assert.equal(second.participantRef, 'P-000002');
  assert.notEqual(first.scanId, second.scanId);

  // Joined once, for both. The session is what survives a participant reset.
  assert.equal(calls.filter((call) => call.method === 'joinFieldSession').length, 1);
  assert.equal(orchestrator.joined?.sessionId, 'fs_riyadh_1');

  // Every allocation and every scan carries its own key, so a retry of one
  // cannot be replayed as the other.
  const keys = calls
    .filter((call) => call.method === 'addParticipant' || call.method === 'createScan')
    .map((call) => call.args[1]);
  assert.deepEqual(keys, ['key-1', 'key-2', 'key-3', 'key-4']);
  assert.equal(new Set(keys).size, 4);

  // And the previous participant is gone from the device, not merely replaced.
  assert.equal(orchestrator.activeParticipant?.participantRef, 'P-000002');
});

test('an allocation retried after a lost response reuses its key rather than minting a ref', async () => {
  let attempts = 0;
  const { api, calls } = recordingApi({
    failOn: {
      addParticipant: () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('timeout'), { retryable: true });
      },
    },
  });
  const orchestrator = new FieldStudyOrchestrator(api, keyMinter());
  await orchestrator.loadPolicy();
  await orchestrator.join('JOIN-CODE-42');

  await assert.rejects(() => orchestrator.allocateParticipant());
  await orchestrator.allocateParticipant();

  const allocations = calls.filter((call) => call.method === 'addParticipant');
  assert.equal(allocations.length, 2);
  // The same key both times: the server replays the first answer instead of
  // handing a second reference to somebody who already has one.
  assert.deepEqual(
    allocations.map((call) => call.args[1]),
    ['key-1', 'key-1'],
  );
});

test('allocating twice for the same person hands back the same reference', async () => {
  // A double tap on the allocate button, or an effect that fires twice. The
  // idempotency key protects a *retry* of a failed call and is retired by a
  // successful one, so this needs its own guard.
  const { orchestrator, calls } = await joined();
  assert.equal(await orchestrator.allocateParticipant(), 'P-000001');
  assert.equal(await orchestrator.allocateParticipant(), 'P-000001');
  assert.equal(calls.filter((call) => call.method === 'addParticipant').length, 1);
});

test('a cold restart has no session and no participant, and cannot reissue P-000001', async () => {
  // Nothing in this lane is persisted, so "cold restart" is a fresh
  // orchestrator over a fresh API. The correct behaviour is to fail closed and
  // ask the operator for the join code again — which is exactly why the device
  // can no longer hand out a reference the server has never seen.
  const { api, calls } = recordingApi({ participants: ['P-000007'] });
  const restarted = new FieldStudyOrchestrator(api, keyMinter());

  assert.equal(restarted.joined, null);
  assert.equal(restarted.activeParticipant, null);
  await assert.rejects(
    () => restarted.allocateParticipant(),
    (error: { code?: string }) => error.code === 'FIELD_NOT_JOINED',
  );
  assert.deepEqual(calls, []);

  // After re-joining, the reference is whatever the server's counter says —
  // which is not `P-000001`, because this session has already enrolled people.
  await restarted.loadPolicy();
  await restarted.join('JOIN-CODE-42');
  assert.equal(await restarted.allocateParticipant(), 'P-000007');
});

test('leaving the session clears the participant and the join together', async () => {
  const { orchestrator } = await joined();
  await bindParticipant(orchestrator);
  orchestrator.leaveSession();

  assert.equal(orchestrator.joined, null);
  assert.equal(orchestrator.activeParticipant, null);
  assert.equal(orchestrator.activeScanId, null);
  await assert.rejects(
    () => orchestrator.allocateParticipant(),
    (error: { code?: string }) => error.code === 'FIELD_NOT_JOINED',
  );
});

test('the whole five-pose protocol runs on one attached scan', async () => {
  const { orchestrator, calls } = await joined();
  const puts: string[] = [];
  await bindParticipant(orchestrator);

  for (const pose of POSES) {
    await runFieldCaptureSequence(
      pose,
      orchestrator.activeParticipant!.consent!,
      orchestrator.poseDeps(transport(puts)),
    );
  }

  assert.equal(calls.filter((call) => call.method === 'createScan').length, 1);
  assert.equal(calls.filter((call) => call.method === 'attachCapture').length, 1);
  assert.equal(calls.filter((call) => call.method === 'registerObservation').length, 5);
  assert.deepEqual(
    calls
      .filter((call) => call.method === 'registerObservation')
      .map((call) => (call.args[1] as { pose_label: string }).pose_label),
    [...POSES],
  );
  // Nothing that could produce a result was ever reached. The scan stays in
  // CAPTURING server-side because no finalize call exists to make.
  for (const forbidden of ['finalizeScan', 'getJob', 'getResult', 'deleteScan']) {
    assert.equal(calls.some((call) => call.method === forbidden), false, forbidden);
  }
});
