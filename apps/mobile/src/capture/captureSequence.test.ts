/**
 * The ordering guarantees of one pose capture.
 *
 * The regression these lock down shipped: the client checked only that each
 * quality signal was *present*, so a frame with `blur = 0.01` and
 * `occlusion = 0.99` was serialised, uploaded and registered, and the user's
 * only feedback was whatever the server said several seconds later.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { QUALITY_PROFILE_ARTIFACT } from '@facetype/contracts';

import { CaptureError, captureError } from './captureError.ts';
import { runCaptureSequence, type CaptureSequenceDeps, type UploadSlot } from './captureSequence.ts';
import {
  CANONICAL_LANDMARK_TOPOLOGY,
  CANONICAL_TOPOLOGY_VERSION,
  type FrameQuality,
  type StandardFaceObservation,
} from './types.ts';

const SLOT: UploadSlot = {
  artifact_id: 'art_1',
  upload_url: '/objects/art_1',
  method: 'PUT',
  headers: {},
};

function observation(quality: Partial<FrameQuality> = {}): StandardFaceObservation {
  return {
    observationId: 'obs_1',
    source: 'arcore',
    poseLabel: 'front',
    timestampMs: 1_700_000_000_000,
    landmarkTopology: CANONICAL_LANDMARK_TOPOLOGY,
    topologyVersion: CANONICAL_TOPOLOGY_VERSION,
    topologyMappingVersion: 'mp478-v1.uv-barycentric-1',
    topologyMappingSha256: 'a'.repeat(64),
    topologyMappingManifestSha256: 'b'.repeat(64),
    topologyCoverage: {
      coveredCount: 478,
      targetCount: 478,
      uncoveredTargetIndices: [],
    },
    topologyMappingConfidence: 1,
    maxUncoveredUvGap: 0,
    unavailableLandmarkIndices: [],
    landmarks: new Float32Array(478 * 3),
    landmarkConfidence: Float32Array.from({ length: 478 }, () => 0.92),
    headPose: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    blendshapes: {},
    quality: {
      blur: 0.9,
      exposure: 0.9,
      occlusion: 0.05,
      neutrality: 0.95,
      faceCount: 1,
      yawDeg: 0,
      pitchDeg: 0,
      ...quality,
    },
    declaredQualityProfile: 'FULL',
  declaredProfileVersion: QUALITY_PROFILE_ARTIFACT.version,
  metricScaleReliable: true,
  };
}

interface Recorder {
  calls: string[];
  deps: CaptureSequenceDeps;
}

function recorder(
  overrides: Partial<CaptureSequenceDeps> & { observation?: StandardFaceObservation } = {},
): Recorder {
  const calls: string[] = [];
  const subject = overrides.observation ?? observation();
  const deps: CaptureSequenceDeps = {
    capture: async () => {
      calls.push('capture');
      return subject;
    },
    serialise: () => {
      calls.push('serialise');
      return new Uint8Array([1, 2, 3]);
    },
    digest: async () => {
      calls.push('digest');
      return 'b'.repeat(64);
    },
    createUpload: async () => {
      calls.push('createUpload');
      return SLOT;
    },
    upload: async () => {
      calls.push('upload');
    },
    registerObservation: async () => {
      calls.push('registerObservation');
    },
    ...stripObservation(overrides),
  };
  return { calls, deps };
}

function stripObservation(
  overrides: Partial<CaptureSequenceDeps> & { observation?: StandardFaceObservation },
): Partial<CaptureSequenceDeps> {
  const rest: Partial<CaptureSequenceDeps> & { observation?: StandardFaceObservation } = {
    ...overrides,
  };
  delete rest.observation;
  return rest;
}

test('an accepted frame is serialised, uploaded and then registered, in that order', async () => {
  const { calls, deps } = recorder();

  const result = await runCaptureSequence('front', deps);

  assert.deepEqual(calls, [
    'capture',
    'serialise',
    'digest',
    'createUpload',
    'upload',
    'registerObservation',
  ]);
  assert.equal(result.verdict.pass, true);
});

test('a frame that fails the quality gate is never uploaded', async () => {
  // The exact frame the pre-gate client happily registered.
  const { calls, deps } = recorder({
    observation: observation({ blur: 0.01, occlusion: 0.99 }),
  });

  const error = await rejection(() => runCaptureSequence('front', deps));

  assert.ok(error instanceof CaptureError);
  assert.equal(error.code, 'FT-SCAN-006');
  assert.deepEqual(calls, ['capture']);
  assert.ok(!calls.includes('createUpload'));
  assert.ok(!calls.includes('upload'));
  assert.ok(!calls.includes('registerObservation'));
});

test('an unmeasured signal fails closed before any upload', async () => {
  // What the ARCore path produces today: real blur/exposure/faceCount, and an
  // explicit "not measured" for occlusion and neutrality.
  const { calls, deps } = recorder({
    observation: observation({ occlusion: null, neutrality: null }),
  });

  const error = await rejection(() => runCaptureSequence('front', deps));

  assert.equal(error.code, 'FT-SCAN-014');
  assert.deepEqual(calls, ['capture']);
});

test('each failing gate reports its own code, not a generic one', async () => {
  const cases: Array<[Partial<FrameQuality>, string]> = [
    [{ faceCount: 0 }, 'FT-SCAN-005'],
    [{ faceCount: 2 }, 'FT-SCAN-004'],
    [{ blur: 0.2 }, 'FT-SCAN-006'],
    [{ exposure: 0.2 }, 'FT-SCAN-007'],
    [{ exposure: 0.6 }, 'FT-SCAN-008'],
    [{ occlusion: 0.9 }, 'FT-SCAN-009'],
    [{ neutrality: 0.2 }, 'FT-SCAN-010'],
    [{ yawDeg: 30 }, 'FT-SCAN-011'],
  ];
  for (const [quality, expected] of cases) {
    const { calls, deps } = recorder({ observation: observation(quality) });
    const error = await rejection(() => runCaptureSequence('front', deps));
    assert.equal(error.code, expected, JSON.stringify(quality));
    assert.deepEqual(calls, ['capture'], JSON.stringify(quality));
  }
});

test('a native rejection reaches the caller with its own code intact', async () => {
  const native = Object.assign(new Error('More than one face is in the frame.'), {
    code: 'FT-SCAN-004',
  });
  const { calls, deps } = recorder({
    capture: async () => {
      throw native;
    },
  });

  const error = await rejection(() => runCaptureSequence('front', deps));

  assert.equal((error as { code?: string }).code, 'FT-SCAN-004');
  assert.deepEqual(calls, []);
});

test('a failed upload never registers the observation', async () => {
  const { calls, deps } = recorder({
    upload: async () => {
      calls.push('upload');
      throw captureError('FT-SYS-002', 'storage rejected the bytes');
    },
  });

  const error = await rejection(() => runCaptureSequence('front', deps));

  assert.equal(error.code, 'FT-SYS-002');
  assert.ok(calls.includes('createUpload'));
  assert.ok(!calls.includes('registerObservation'));
});

test('the upload declares the digest and length of the bytes it actually sends', async () => {
  let declared: { content_length: number; sha256: string } | null = null;
  const payload = new Uint8Array([9, 8, 7, 6]);
  const { deps } = recorder({
    serialise: () => payload,
    digest: async () => 'c'.repeat(64),
    createUpload: async (request) => {
      declared = { content_length: request.content_length, sha256: request.sha256 };
      return SLOT;
    },
  });

  await runCaptureSequence('front', deps);

  assert.deepEqual(declared, { content_length: 4, sha256: 'c'.repeat(64) });
});

test('the registered quality record is the wire shape, on the wire names', async () => {
  let registered: Record<string, number | null> | null = null;
  const { deps } = recorder({
    registerObservation: async (request) => {
      registered = request.quality;
    },
  });

  await runCaptureSequence('front', deps);

  assert.deepEqual(registered, {
    blur: 0.9,
    exposure: 0.9,
    occlusion: 0.05,
    neutrality: 0.95,
    face_count: 1,
    yaw_deg: 0,
    pitch_deg: 0,
  });
});

test('low landmark confidence fails closed', async () => {
  const subject = observation();
  const lowConfidence: StandardFaceObservation = {
    ...subject,
    landmarkConfidence: Float32Array.from({ length: 478 }, () => 0.1),
  };
  const { calls, deps } = recorder({ observation: lowConfidence });

  const error = await rejection(() => runCaptureSequence('front', deps));

  assert.equal(error.code, 'FT-SCAN-014');
  assert.deepEqual(calls, ['capture']);
});

async function rejection(block: () => Promise<unknown>): Promise<CaptureError> {
  try {
    await block();
  } catch (error) {
    return error as CaptureError;
  }
  throw new Error('expected the sequence to reject');
}
