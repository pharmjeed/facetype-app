/** Provider mesh -> frozen MediaPipe-478 topology conversion.
 *
 * The 468 target UVs are from MediaPipe's Apache-2.0 canonical_face_model.obj.
 * Native ARKit/ARCore UVs and triangles define a piecewise-linear surface, so
 * barycentric interpolation maps each semantic MediaPipe UV to measured XYZ.
 * Neither native API measures the ten refined-landmark iris points. Those
 * indices receive finite eye-centre placeholders with confidence zero and are
 * explicitly listed as unavailable; they must never be treated as measurements.
 *
 * Coordinate/UV contract (audit P0-02 item 2) — stated explicitly because it
 * is otherwise an easy thing to get silently wrong:
 *   - `raw.landmarks` XYZ triples are copied through unchanged; this function
 *     performs no axis swap, sign flip, or unit conversion. The provider
 *     boundary (`providers.ts`) is responsible for millimetres and row-major
 *     head-pose layout before geometry reaches here.
 *   - `raw.textureCoordinates` V is used exactly as the provider reports it,
 *     against `TARGET_UV`'s V exactly as MediaPipe's own model file defines
 *     it — no V-flip/mirror is applied in either direction. That match is an
 *     assumption pending real-device evidence, not a verified equivalence:
 *     nothing in this repository confirms ARKit's and ARCore's UV origin
 *     convention agrees with MediaPipe's without a physical capture to check
 *     against, which is why P0-02 stays PARTIAL rather than FULL.
 */

import { fallbackSha256 } from '../api/client.ts';
import { captureError } from './captureError.ts';
import {
  CANONICAL_LANDMARK_TOPOLOGY,
  CANONICAL_TOPOLOGY_VERSION,
} from './types.ts';

export const LANDMARK_COUNT = 478;
// Bumped to -3 (audit P0-02, re-review of 6748fef): v2's `TARGET_UV_BASE64`
// was the upstream `.obj` file's `vt` lines in raw file order, not the UV
// per landmark. An OBJ face line is `f v1/vt1 v2/vt2 v3/vt3 ...`; a vertex's
// v-index and its vt-index are independent numbering, e.g. vertex 0's true
// UV in the pinned `canonical_face_model.obj` is `vt` line 440, not `vt`
// line 0. Reading `vt` lines in storage order therefore paired every
// landmark with a plausible-looking but semantically wrong UV; the mapping
// was internally self-consistent (its own checksum matched itself) but did
// not agree with what the module docstring already claimed the table was.
// Version 3 re-extracts the table by walking every `f` line's v/vt pairs and
// ordering the resulting UVs by v-index, which is what "the 468 target UVs
// from MediaPipe's canonical_face_model.obj" always should have meant. See
// `topologyManifest.ts`/`topology_manifest.py` for the reproduction steps
// and `topologyObjParser.test.ts` for the non-circular parser fixture that
// now guards this.
export const TOPOLOGY_MAPPING_VERSION = 'mp478-v1.uv-barycentric-3';
export const TOPOLOGY_MAPPING_SHA256 =
  '3c26dbea4f3a00a93ba6245c900779c4bc6fe8078c68b59b37e89a77c56fc6f4';

const TARGET_UV_BASE64 = [
  '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',
  'UiqRPg+0Kj8xCXc+vQEeP1Pq0j0m/wc/cQSJPglQEz+Zg5g+YRsRP9y3qj5f7RA/Upy7PhDqEj8Wwso+aVMVPxoa1z5M+xY/RML3',
  'O8zrBD9+q90+I2jcPrvS6j5sWgU/I2ryPj6U6D7OwfM+rVHfPpDb7z6Sz+M+ETTePqbU1T6sj/c+kMDfPgMI9z4tJNg+qFfaPiI2',
  'HD96xOA+Tn8aPy9v5j4ofRk/IlWUPiy6IT+xp40+/fkiP5uSBD9qLgc/b9U1P0CGHj/QtgY/eCjaPtEkZT+e8D4/aVIiPwcmFz8o',
  'Ryk//kMWP3FaMD+hLRc/A7A5P+lhHD8bTBs/yqYYP7+eJz/l7ic/hUEhP5BnJz/qQC4/pBknP6G8Mz8PeyU/95BAP3zVFj/WWBo/',
  'huggPn9LOD+u2B8/EMlkPzmcGT/QQko/OdAbPw7dJD+XV+4+VDsHPz/+sj4bngY/Ab6jPkBqDz+uf68+utsVPyO7qj5KtAw/MGaj',
  'PgA8Ej8ydqI+TfYfP5w2iz4/VwM/p8rnPmbdAz8HDPI+5gM+P3h8Lz/iPxk/f4YLP6wBEj8tIec+OiEUP/fI7j47HDk/npbvPs41',
  'BD+pFwA/VK0pP7CSNz+0IDQ/Mew0PxWpVD81Yk4/K2kNP+eKMj9UjBs/mWclP9Y6JT84SZs+GcVuP60vij6oqA4/jbbaPqD7Cj8l',
  'ltQ+9DYeP9dOnD4Vixs/bZGcPssSOT+iYDo/Z9ETP5Oo3z6LNB0/Bvc3P57tHT9Bfj4/aCMrP1FNYT/AJEU/RppEP32yIj9hjU8/',
  'WDhFP0xQMz8OpFM/g6M4P2fxBj8Z6Ko+rpwNP9S2qT7fxRM/5PemPksADj+XAdc+SKUcPyWxnD5w0hg/ZECWPsWrGD8xspw+sDoK',
  'P62+4j6hnxE/NIKdPs09DD80gp0+Ck0GPzSCnT4fugg/3ShiPnIVBz9jDYc+xeMGPwx1kD564QY/QzuXPk/nBj+GBJw+ZXISP4YE',
  'nD5G0hI/m8mXPqirEz/siJM+tOkUP+dTjz5bJRw/t124PoNtfD85Q+E+hjgWP4j0mz6fIhc/qKqYPpUrCD9YA8w+1scTP1QA1D5D',
  'cwk/SPvPPqimID9n0gY/2GMqP1sJAT9enhY/tAHoPsEAQj/oMVo/aJE1P/lpTD8FNSw/tVA+P2e0GT9rgoA+heoOPxADPT9x/xE/',
  'sOdPPwySFj+xFWQ/DAc2P0jeGT809Ec/TIkQP9JVFj+Y3xk/uiw+P34BJT/ReBI/CvYPPzlHDT+yRu0+BkpSP5zdCj8UsUA/H/YK',
  'P8e4Nj+ZSQg/68cqP1YRCj/WjyE/UYcNPxjSGT9zSRE/2gIGP9QoGD8ujU8/+b/zPkVjRT+fqiY/JlYCP23j3z4fZRg/eNUDPxQE',
  'ez8aMxk/5dASP+F6FD/hXRo/XhLnPp/IOz9vfh8/NIQPP2dD9j5Func/1xa2Pm+7FD8V4xw/i6gJPy0+/T6rzkI/bohhPmNBTT9y',
  'GCw+A3dkP2Ah6z5h/FA/pPyEPqKXXT99kyo/9DMdP7kc7z2+SgI/51PXPnIxHj8Bvvs+DFtTP/kxGj8bZC4/WJAaP0wZKD96chk/',
  'MZkaP3BelD7e5E8/BKvSPk1pET/QD2M9ilYuP/RP0D0s1zs/Gm0FPq9CIj/N5hk/yVYbPxa+Gj/18xY/XOMbP4cVTj+cayg/c4Ac',
  'P1tBIz9QUCI/Ft8kP0wZKD9TByU/G2QuP9RDJD931jI/NQgjPzIecT8JUS4/d9YyPyTQHD+gjBU/DHXAPsnnDT8oK94+Ub4IP3k7',
  'wj5iEjY/eVg4PjElKj/8qBY+LSEPP+Boxz0gKF8/aw1VPh1bFz98SCA/71kLP/5kDD9c4x8/OkGbPdPBYj/rGsU+fSQNP4YEnD6Q',
  'Tg0/eTqXPhGKDT+dgZE+fR8OP17ViT7a5xE/YY5uPifcFz8T76A+PGkZP+1Koz6sixs/HQSlPrDGIT+6Saw+PIVAP3EgzD4BFww/',
  '/mAUP2tEED9Q4iM/m3YVP/abIT9WLBY/NIKdPjmcRT8QAqI+vhYIP63DJT97nxY/nkBIPvRSBT8PtA4/d2cRP1yrAT+YFAs/OBU5',
  'PtvCJz/cS4I+cvoeP1Aa2j6zJCA/5PVgPnUhLj+4yts+LowkPzaUyj7LZDQ/0sbBPqlQDT+vtAw+bM0WP+6T+z4Xmi8/0QhmPuRO',
  'JT9N2z8+R+MsPzKQlz5klE8/gxe1PupZOD8rF5I+I7xdP350oj6gxik/Yve1PuXwET/cngg/amgLP0M75z75EBA/7+bhPk0wCD99',
  'kfA+UtQVP9cxKj/ZeR8/W14tP83oJz/MCS4/4ucvP7x6LT9dazc/V7MqP+Y9Qj+sAR4/paJlP8H+Bz8Lfjs/41ATP769Mz87HBE/',
  'YqEqPyjuED9iLSI/5usSP56XGj+OWhU/d2QUP9gNFz+MEH4/zOsEP38zET/7dNw+9pYKP+BmBT/mzAY/OWPoPiofBj+tUd8+SRII',
  'P5LP4z685xA/+djVPvUsBD9jt98+DHkEP4Eg2D4f1xI/nDUcP+eJDz+Gyxo/z7wMP+upGT9v1TU/LLohPygsOT/9+SI/',
].join('');

export interface RawTopologyGeometry {
  landmarkTopology: 'arkit-face-geometry' | 'arcore-face-mesh-468' | 'mediapipe-478';
  topologyVersion: string;
  landmarks: readonly number[];
  landmarkConfidence: readonly number[];
  textureCoordinates?: readonly number[];
  triangleIndices?: readonly number[];
}

export interface CanonicalTopologyGeometry {
  landmarks: Float32Array;
  landmarkConfidence: Float32Array;
  landmarkTopology: typeof CANONICAL_LANDMARK_TOPOLOGY;
  topologyVersion: typeof CANONICAL_TOPOLOGY_VERSION;
  topologyMappingVersion: string;
  topologyMappingSha256: string;
  /** Canonical indices carrying a placeholder rather than a measurement: the
   * ten iris points ARKit/ARCore never report, plus any target UV the
   * provider's own triangulation did not cover (fail-closed, never a
   * nearest-vertex guess). */
  unavailableLandmarkIndices: number[];
  /** Evidence for how much of the frozen 468-point target UV set the native
   * mesh actually covered, so a caller can tell "fully measured" apart from
   * "mapped with gaps" without recomputing the mapping. */
  coverage: {
    method: 'barycentric-uv-interpolation' | 'identity';
    targetCount: number;
    coveredCount: number;
    uncoveredTargetIndices: number[];
  };
  /** Diagnostic only, never used to fabricate a position: the largest UV-space
   * gap between an uncovered target and the nearest source vertex. Zero when
   * fully covered. */
  maxUncoveredUvGap: number;
}

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeBase64(value: string): Uint8Array {
  const output = new Uint8Array((value.length * 3) / 4 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0));
  let bits = 0;
  let bitCount = 0;
  let cursor = 0;
  for (const character of value) {
    if (character === '=') break;
    const digit = BASE64_ALPHABET.indexOf(character);
    if (digit < 0) throw new Error('invalid topology mapping base64');
    bits = (bits << 6) | digit;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      output[cursor] = (bits >>> bitCount) & 0xff;
      cursor += 1;
    }
  }
  return output;
}

const TARGET_UV_BYTES = decodeBase64(TARGET_UV_BASE64);
const TARGET_UV = new Float32Array(
  TARGET_UV_BYTES.buffer,
  TARGET_UV_BYTES.byteOffset,
  TARGET_UV_BYTES.byteLength / 4,
);

/** Test-only accessor for the frozen target UV table. Production code never
 * needs this: `mapToMediaPipe478` samples it internally. Exposed so tests can
 * check mapped output against a closed-form answer without duplicating the
 * (large, checksummed) UV data. */
export function targetUvForTesting(index: number): readonly [number, number] {
  return [TARGET_UV[index * 2]!, TARGET_UV[index * 2 + 1]!];
}

export function verifyTopologyMappingIntegrity(): void {
  const actual = fallbackSha256(TARGET_UV_BYTES);
  if (actual !== TOPOLOGY_MAPPING_SHA256 || TARGET_UV.length !== 468 * 2) {
    throw captureError('FT-REC-006', 'topology mapping integrity check failed');
  }
}

function validateRaw(raw: RawTopologyGeometry): number {
  const expectedVersion: Record<RawTopologyGeometry['landmarkTopology'], string> = {
    'arkit-face-geometry': 'arkit-face-geometry-uv-v1',
    'arcore-face-mesh-468': 'arcore-augmented-face-468-v1',
    'mediapipe-478': CANONICAL_TOPOLOGY_VERSION,
  };
  if (raw.topologyVersion !== expectedVersion[raw.landmarkTopology]) {
    throw captureError(
      'FT-REC-006',
      `unsupported native topology ${raw.landmarkTopology}@${raw.topologyVersion}`,
    );
  }
  const count = raw.landmarks.length / 3;
  if (!Number.isInteger(count) || raw.landmarkConfidence.length !== count) {
    throw captureError('FT-REC-006', 'native landmarks/confidence count mismatch');
  }
  if (raw.landmarkTopology === 'arcore-face-mesh-468' && count !== 468) {
    throw captureError('FT-REC-006', `ARCore topology requires 468 vertices, got ${count}`);
  }
  if (raw.landmarkTopology === 'arkit-face-geometry' && count < 468) {
    throw captureError('FT-REC-006', `ARKit face geometry is implausibly sparse (${count} vertices)`);
  }
  if (raw.landmarkTopology === 'mediapipe-478' && count !== LANDMARK_COUNT) {
    throw captureError('FT-REC-006', `MediaPipe topology requires 478 vertices, got ${count}`);
  }
  if (raw.landmarks.some((value) => !Number.isFinite(value))) {
    throw captureError('FT-REC-006', 'native landmarks contain a non-finite coordinate');
  }
  if (
    raw.landmarkConfidence.some(
      (value) => !Number.isFinite(value) || value < 0 || value > 1,
    )
  ) {
    throw captureError('FT-REC-006', 'native landmark confidence is outside [0,1]');
  }
  return count;
}

function barycentric(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): [number, number, number] | null {
  const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(denominator) < 1e-12) return null;
  const a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / denominator;
  const b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / denominator;
  const c = 1 - a - b;
  return a >= -1e-5 && b >= -1e-5 && c >= -1e-5 ? [a, b, c] : null;
}

function nearestVertexGap(uv: readonly number[], x: number, y: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < uv.length / 2; index += 1) {
    const dx = uv[index * 2]! - x;
    const dy = uv[index * 2 + 1]! - y;
    const distance = dx * dx + dy * dy;
    if (distance < best) best = distance;
  }
  return Math.sqrt(best);
}

interface SurfaceSample {
  xyz: [number, number, number];
  confidence: number;
  /** False when no provider triangle contains the target UV. */
  covered: boolean;
  /** UV-space distance to the nearest source vertex; diagnostic evidence
   * only — never used to place a point. Zero when `covered` is true. */
  uvGapToNearestVertex: number;
}

function sampleSurface(raw: RawTopologyGeometry, x: number, y: number): SurfaceSample {
  const uv = raw.textureCoordinates!;
  const triangles = raw.triangleIndices!;
  for (let offset = 0; offset < triangles.length; offset += 3) {
    const aIndex = triangles[offset]!;
    const bIndex = triangles[offset + 1]!;
    const cIndex = triangles[offset + 2]!;
    const weights = barycentric(
      x,
      y,
      uv[aIndex * 2]!,
      uv[aIndex * 2 + 1]!,
      uv[bIndex * 2]!,
      uv[bIndex * 2 + 1]!,
      uv[cIndex * 2]!,
      uv[cIndex * 2 + 1]!,
    );
    if (!weights) continue;
    const xyz = [0, 0, 0] as [number, number, number];
    let confidence = 0;
    for (const [weight, index] of [
      [weights[0], aIndex],
      [weights[1], bIndex],
      [weights[2], cIndex],
    ] as const) {
      xyz[0] += weight * raw.landmarks[index * 3]!;
      xyz[1] += weight * raw.landmarks[index * 3 + 1]!;
      xyz[2] += weight * raw.landmarks[index * 3 + 2]!;
      confidence += weight * raw.landmarkConfidence[index]!;
    }
    return { xyz, confidence, covered: true, uvGapToNearestVertex: 0 };
  }
  // Fail-closed (audit P0-02): the target UV falls outside every triangle the
  // provider's own mesh defines. A previous version of this function guessed
  // the nearest source vertex here and reported that vertex's own confidence,
  // which fabricated a measurement with false certainty for a point the
  // provider never actually covered. There is no vertex close enough to
  // stand in for an uncovered point, so this reports zero confidence and the
  // gap as diagnostic evidence; the caller marks the index unavailable.
  return {
    xyz: [0, 0, 0],
    confidence: 0,
    covered: false,
    uvGapToNearestVertex: nearestVertexGap(uv, x, y),
  };
}

function appendUnavailableIris(landmarks: Float32Array, confidence: Float32Array): number[] {
  const unavailable = Array.from({ length: 10 }, (_, index) => 468 + index);
  const eyeRings = [
    [33, 133, 159, 145],
    [362, 263, 386, 374],
  ];
  for (let eye = 0; eye < 2; eye += 1) {
    const ring = eyeRings[eye]!;
    const centre = [0, 0, 0];
    for (const index of ring) {
      for (let axis = 0; axis < 3; axis += 1) centre[axis]! += landmarks[index * 3 + axis]! / ring.length;
    }
    for (let point = 0; point < 5; point += 1) {
      const index = 468 + eye * 5 + point;
      landmarks.set(centre, index * 3);
      confidence[index] = 0; // Placeholder only: ARKit/ARCore did not measure an iris landmark.
    }
  }
  return unavailable;
}

export function mapToMediaPipe478(raw: RawTopologyGeometry): CanonicalTopologyGeometry {
  verifyTopologyMappingIntegrity();
  const sourceCount = validateRaw(raw);
  if (raw.landmarkTopology === 'mediapipe-478') {
    return {
      landmarks: Float32Array.from(raw.landmarks),
      landmarkConfidence: Float32Array.from(raw.landmarkConfidence),
      landmarkTopology: CANONICAL_LANDMARK_TOPOLOGY,
      topologyVersion: CANONICAL_TOPOLOGY_VERSION,
      topologyMappingVersion: TOPOLOGY_MAPPING_VERSION,
      topologyMappingSha256: TOPOLOGY_MAPPING_SHA256,
      unavailableLandmarkIndices: [],
      coverage: { method: 'identity', targetCount: 468, coveredCount: 468, uncoveredTargetIndices: [] },
      maxUncoveredUvGap: 0,
    };
  }
  if (raw.textureCoordinates?.length !== sourceCount * 2 || !raw.triangleIndices?.length) {
    throw captureError('FT-REC-006', 'native UV topology and triangles are required');
  }
  if (
    raw.textureCoordinates.some((value) => !Number.isFinite(value)) ||
    raw.triangleIndices.length % 3 !== 0
  ) {
    throw captureError('FT-REC-006', 'native UV topology is malformed');
  }
  if (
    raw.triangleIndices.some(
      (index) => !Number.isInteger(index) || index < 0 || index >= sourceCount,
    )
  ) {
    throw captureError('FT-REC-006', 'native triangle index is outside the vertex array');
  }

  const landmarks = new Float32Array(LANDMARK_COUNT * 3);
  const confidence = new Float32Array(LANDMARK_COUNT);
  const uncoveredTargetIndices: number[] = [];
  let maxUncoveredUvGap = 0;
  for (let index = 0; index < 468; index += 1) {
    const sample = sampleSurface(raw, TARGET_UV[index * 2]!, TARGET_UV[index * 2 + 1]!);
    landmarks.set(sample.xyz, index * 3);
    confidence[index] = sample.confidence;
    if (!sample.covered) {
      uncoveredTargetIndices.push(index);
      maxUncoveredUvGap = Math.max(maxUncoveredUvGap, sample.uvGapToNearestVertex);
    }
  }
  const irisIndices = appendUnavailableIris(landmarks, confidence);
  // Uncovered target UVs and the ten unmeasured iris points share the same
  // contract: zero confidence, a geometric placeholder, and membership in
  // `unavailableLandmarkIndices` — never a value a caller could mistake for a
  // measurement.
  const unavailableLandmarkIndices = [...uncoveredTargetIndices, ...irisIndices].sort(
    (left, right) => left - right,
  );
  return {
    landmarks,
    landmarkConfidence: confidence,
    landmarkTopology: CANONICAL_LANDMARK_TOPOLOGY,
    topologyVersion: CANONICAL_TOPOLOGY_VERSION,
    topologyMappingVersion: TOPOLOGY_MAPPING_VERSION,
    topologyMappingSha256: TOPOLOGY_MAPPING_SHA256,
    unavailableLandmarkIndices,
    coverage: {
      method: 'barycentric-uv-interpolation',
      targetCount: 468,
      coveredCount: 468 - uncoveredTargetIndices.length,
      uncoveredTargetIndices,
    },
    maxUncoveredUvGap,
  };
}
