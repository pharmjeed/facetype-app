/**
 * A `StandardFaceObservation` the field tests can vary one signal of.
 *
 * Built here rather than in each test so that "a sample that fails the
 * production gate" differs from "a sample that passes it" by exactly the field
 * under test — otherwise a test asserting that a failing sample is still
 * uploaded could be passing for the wrong reason.
 */

import { QUALITY_PROFILE_ARTIFACT } from '@facetype/contracts';

import {
  CANONICAL_LANDMARK_TOPOLOGY,
  CANONICAL_TOPOLOGY_VERSION,
  POSE_TARGETS,
  type PoseLabel,
  type StandardFaceObservation,
} from '../../capture/types.ts';

const LANDMARK_COUNT = 478;

export function observationFixture(
  pose: PoseLabel = 'front',
  overrides: Partial<StandardFaceObservation> = {},
): StandardFaceObservation {
  const target = POSE_TARGETS[pose];
  const landmarks = new Float32Array(LANDMARK_COUNT * 3);
  for (let index = 0; index < LANDMARK_COUNT * 3; index += 1) landmarks[index] = index % 37;
  const confidence = new Float32Array(LANDMARK_COUNT).fill(0.95);

  return {
    observationId: `obs_test_${pose}`,
    source: 'arcore',
    poseLabel: pose,
    timestampMs: 1_700_000_000_000,
    landmarkTopology: CANONICAL_LANDMARK_TOPOLOGY,
    topologyVersion: CANONICAL_TOPOLOGY_VERSION,
    topologyMappingVersion: 'map-test',
    topologyMappingSha256: 'a'.repeat(64),
    topologyMappingManifestSha256: 'b'.repeat(64),
    topologyCoverage: { coveredCount: 468, targetCount: 468, uncoveredTargetIndices: [] },
    topologyMappingConfidence: 1,
    maxUncoveredUvGap: 0,
    unavailableLandmarkIndices: [],
    landmarks,
    landmarkConfidence: confidence,
    headPose: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 320, 0, 0, 0, 1]),
    blendshapes: { jawOpen: 0.01 },
    quality: {
      blur: 0.93,
      exposure: 0.9,
      // ARCore's declared profile waives occlusion; a null here is the honest
      // unmeasured value that path really sends.
      occlusion: null,
      neutrality: 0.98,
      faceCount: 1,
      yawDeg: target.yaw,
      pitchDeg: target.pitch,
    },
    declaredQualityProfile: 'REDUCED_GEOMETRY_NO_OCCLUSION',
    declaredProfileVersion: QUALITY_PROFILE_ARTIFACT.version,
    metricScaleReliable: false,
    ...overrides,
  };
}
