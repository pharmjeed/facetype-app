/**
 * FTOB — the observation wire format, device side.
 *
 * The Python reader is `facetype_core.wire`, and
 * `tests/contract/test_mobile_wire_contract.py` runs THIS file for real and
 * feeds its exact output to that reader. If the two drift, that test fails.
 *
 * Layout:
 *
 *     offset  size  content
 *     0       4     magic "FTOB"
 *     4       2     uint16 LE  format version
 *     6       4     uint32 LE  header byte length H
 *     10      H     UTF-8 JSON header
 *     10+H    ...   little-endian float32 payload
 *
 * The header is self-describing: every array declares name, dtype, shape and
 * byte range, so the reader never infers layout from field order.
 */

import type { StandardFaceObservation } from './types.ts';

export const FTOB_MAGIC = 'FTOB';
export const FTOB_VERSION = 1;
export const FTOB_SCHEMA = 'ftob-1.0.0';
/** magic + version + header length */
export const FTOB_HEADER_SIZE = 10;

interface ArrayDescriptor {
  name: string;
  dtype: 'float32';
  shape: number[];
  offset: number;
  length: number;
}

/**
 * Little-endian float32 bytes.
 *
 * `Float32Array` uses the platform byte order, and both ARM and x86 are
 * little-endian, but writing through a DataView with an explicit flag means the
 * format does not silently depend on that.
 */
function toLittleEndian(values: Float32Array): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i += 1) {
    view.setFloat32(i * 4, values[i]!, true);
  }
  return out;
}

/** Serialise one observation to FTOB bytes. Geometry only; no frame is included. */
export function serialiseObservation(observation: StandardFaceObservation): Uint8Array {
  const landmarkCount = observation.landmarks.length / 3;
  if (!Number.isInteger(landmarkCount) || landmarkCount <= 0) {
    throw new Error(`landmarks must be a flat [N, 3] array, got ${observation.landmarks.length}`);
  }
  if (observation.landmarkConfidence.length !== landmarkCount) {
    throw new Error(
      `landmarkConfidence has ${observation.landmarkConfidence.length} entries, ` +
        `expected ${landmarkCount}`,
    );
  }
  if (observation.headPose.length !== 16) {
    throw new Error(`headPose must be a 4x4 matrix, got ${observation.headPose.length} values`);
  }
  if (observation.landmarkTopology !== 'mediapipe-478' || observation.topologyVersion !== 'mp478-v1') {
    throw new Error(
      `unsupported topology ${observation.landmarkTopology}@${observation.topologyVersion}`,
    );
  }
  if (landmarkCount !== 478) {
    throw new Error(`mediapipe-478 requires exactly 478 landmarks, got ${landmarkCount}`);
  }
  if (!observation.topologyMappingVersion || !/^[a-f0-9]{64}$/.test(observation.topologyMappingSha256)) {
    throw new Error('topology mapping version and SHA-256 integrity identity are required');
  }
  const unavailable = new Set(observation.unavailableLandmarkIndices);
  if (
    unavailable.size !== observation.unavailableLandmarkIndices.length ||
    observation.unavailableLandmarkIndices.some(
      (index) => !Number.isInteger(index) || index < 0 || index >= landmarkCount,
    )
  ) {
    throw new Error('unavailableLandmarkIndices must be unique canonical indices');
  }
  for (const index of unavailable) {
    if (observation.landmarkConfidence[index] !== 0) {
      throw new Error(`unavailable landmark ${index} must have zero confidence`);
    }
  }

  const parts: Array<{ name: string; shape: number[]; bytes: Uint8Array }> = [
    {
      name: 'landmarks_xyz',
      shape: [landmarkCount, 3],
      bytes: toLittleEndian(observation.landmarks),
    },
    {
      name: 'landmark_confidence',
      shape: [landmarkCount],
      bytes: toLittleEndian(observation.landmarkConfidence),
    },
    { name: 'head_pose', shape: [4, 4], bytes: toLittleEndian(observation.headPose) },
  ];

  const arrays: ArrayDescriptor[] = [];
  let bodyLength = 0;
  for (const part of parts) {
    arrays.push({
      name: part.name,
      dtype: 'float32',
      shape: part.shape,
      offset: bodyLength,
      length: part.bytes.length,
    });
    bodyLength += part.bytes.length;
  }

  // Keys are declared in sorted order so the same observation always produces
  // identical bytes, which is what makes the client's upload checksum
  // reproducible. Do NOT pass a key array to JSON.stringify to achieve this:
  // that argument is a replacer filter and it applies to nested objects too,
  // which would silently strip every array descriptor's fields.
  const header = {
    arrays,
    blendshapes: observation.blendshapes ?? {},
    // Inside the hashed header on purpose. The registration request declares
    // the same profile, and the server compares the two: a payload whose
    // artifact says one thing and whose request says another is a mismatch it
    // must reject, and that check only means something if this value is
    // covered by the checksum the client already commits to.
    declared_quality_profile: observation.declaredQualityProfile,
    declared_profile_version: observation.declaredProfileVersion,
    landmark_topology: observation.landmarkTopology,
    topology_mapping_sha256: observation.topologyMappingSha256,
    topology_mapping_version: observation.topologyMappingVersion,
    topology_mapping_manifest_sha256: observation.topologyMappingManifestSha256,
    topology_coverage: observation.topologyCoverage,
    topology_mapping_confidence: observation.topologyMappingConfidence,
    max_uncovered_uv_gap: observation.maxUncoveredUvGap,
    topology_version: observation.topologyVersion,
    unavailable_landmark_indices: [...unavailable].sort((left, right) => left - right),
    landmark_count: landmarkCount,
    metric_scale_reliable: observation.metricScaleReliable,
    observation_id: observation.observationId,
    pose_label: observation.poseLabel,
    quality: observation.quality ?? {},
    schema: FTOB_SCHEMA,
    source: observation.source,
    timestamp_ms: observation.timestampMs,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));

  const out = new Uint8Array(FTOB_HEADER_SIZE + headerBytes.length + bodyLength);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i += 1) {
    out[i] = FTOB_MAGIC.charCodeAt(i);
  }
  view.setUint16(4, FTOB_VERSION, true);
  view.setUint32(6, headerBytes.length, true);
  out.set(headerBytes, FTOB_HEADER_SIZE);

  let offset = FTOB_HEADER_SIZE + headerBytes.length;
  for (const part of parts) {
    out.set(part.bytes, offset);
    offset += part.bytes.length;
  }
  return out;
}
