import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LANDMARK_COUNT,
  mapToMediaPipe478,
  targetUvForTesting,
  TOPOLOGY_MAPPING_SHA256,
  verifyTopologyMappingIntegrity,
  type RawTopologyGeometry,
} from './topology.ts';

function planarProvider(
  provider: 'arkit-face-geometry' | 'arcore-face-mesh-468',
): RawTopologyGeometry {
  const count = 468;
  const uv = new Array<number>(count * 2).fill(0);
  const landmarks = new Array<number>(count * 3).fill(0);
  const confidence = new Array<number>(count).fill(0.9);
  const corners: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  for (let index = 0; index < corners.length; index += 1) {
    const [u, v] = corners[index]!;
    uv[index * 2] = u;
    uv[index * 2 + 1] = v;
    landmarks[index * 3] = u * 10;
    landmarks[index * 3 + 1] = v * 20;
    landmarks[index * 3 + 2] = u + v;
  }
  return {
    landmarkTopology: provider,
    topologyVersion:
      provider === 'arcore-face-mesh-468'
        ? 'arcore-augmented-face-468-v1'
        : 'arkit-face-geometry-uv-v1',
    landmarks,
    landmarkConfidence: confidence,
    textureCoordinates: uv,
    triangleIndices: [0, 1, 2, 0, 2, 3],
  };
}

// --- Analytic-surface fixtures (audit P0-02, remediation item 6) ----------
//
// The previous cross-provider test built the *same* single square for both
// "providers" — same vertex count, same order, same winding, same
// triangulation — so a bug that only shows up when two providers genuinely
// disagree in mesh structure could not fail it.
//
// Instead, both fixtures below sample the same affine plane
// `xyz(u,v) = ORIGIN + u*DU + v*DV`. Barycentric interpolation is an affine
// combination of its inputs, so interpolating this particular surface
// reproduces the exact closed-form answer at any covered point regardless of
// how many vertices the mesh has, what order they are stored in, how the
// domain is triangulated, or which winding the triangles use. That lets each
// fixture be checked against one ground truth instead of against each
// other's numbers, while still differing in every structural respect a real
// ARKit and ARCore mesh would.
const PLANE_ORIGIN = [1, 2, -3] as const;
const PLANE_DU = [10, -4, 2] as const;
const PLANE_DV = [-5, 7, 1] as const;

function analyticXyz(u: number, v: number): [number, number, number] {
  return [
    PLANE_ORIGIN[0] + u * PLANE_DU[0] + v * PLANE_DV[0],
    PLANE_ORIGIN[1] + u * PLANE_DU[1] + v * PLANE_DV[1],
    PLANE_ORIGIN[2] + u * PLANE_DU[2] + v * PLANE_DV[2],
  ];
}

interface GridMesh {
  uv: number[];
  landmarks: number[];
  confidence: number[];
  triangles: number[];
}

function buildGrid(options: {
  rows: number;
  cols: number;
  uRange?: readonly [number, number];
  vRange?: readonly [number, number];
  reverseWinding?: boolean;
  /** Bijection from logical row-major grid index to storage slot — models a
   * provider whose vertex array order has nothing to do with grid position. */
  permutation?: (logicalIndex: number, count: number) => number;
  degenerateTriangleAtFront?: boolean;
}): GridMesh {
  const { rows, cols } = options;
  const [uMin, uMax] = options.uRange ?? [0, 1];
  const [vMin, vMax] = options.vRange ?? [0, 1];
  const count = rows * cols;
  const permutation = options.permutation ?? ((index: number) => index);
  const uv = new Array<number>(count * 2);
  const landmarks = new Array<number>(count * 3);
  const confidence = new Array<number>(count).fill(0.87);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const logical = row * cols + col;
      const stored = permutation(logical, count);
      const u = uMin + ((uMax - uMin) * col) / (cols - 1);
      const v = vMin + ((vMax - vMin) * row) / (rows - 1);
      const [x, y, z] = analyticXyz(u, v);
      uv[stored * 2] = u;
      uv[stored * 2 + 1] = v;
      landmarks[stored * 3] = x;
      landmarks[stored * 3 + 1] = y;
      landmarks[stored * 3 + 2] = z;
    }
  }

  const triangles: number[] = [];
  if (options.degenerateTriangleAtFront) {
    // Three copies of the same vertex: zero area, must be skipped rather than
    // dividing by a near-zero denominator or matching first-and-wrongly.
    const zero = permutation(0, count);
    triangles.push(zero, zero, zero);
  }
  for (let row = 0; row < rows - 1; row += 1) {
    for (let col = 0; col < cols - 1; col += 1) {
      const a = permutation(row * cols + col, count);
      const b = permutation(row * cols + col + 1, count);
      const c = permutation((row + 1) * cols + col, count);
      const d = permutation((row + 1) * cols + col + 1, count);
      const first: [number, number, number] = options.reverseWinding ? [a, c, b] : [a, b, c];
      const second: [number, number, number] = options.reverseWinding ? [b, c, d] : [b, d, c];
      triangles.push(...first, ...second);
    }
  }
  return { uv, landmarks, confidence, triangles };
}

function reverseIndexPermutation(logicalIndex: number, count: number): number {
  return count - 1 - logicalIndex;
}

function providerFromGrid(
  provider: 'arkit-face-geometry' | 'arcore-face-mesh-468',
  mesh: GridMesh,
): RawTopologyGeometry {
  return {
    landmarkTopology: provider,
    topologyVersion:
      provider === 'arcore-face-mesh-468'
        ? 'arcore-augmented-face-468-v1'
        : 'arkit-face-geometry-uv-v1',
    landmarks: mesh.landmarks,
    landmarkConfidence: mesh.confidence,
    textureCoordinates: mesh.uv,
    triangleIndices: mesh.triangles,
  };
}

function assertClose(actual: number, expected: number, tolerance: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} !~= ${expected}`);
}

function assertMatchesAnalyticSurface(
  mapped: ReturnType<typeof mapToMediaPipe478>,
  tolerance = 1e-4,
): void {
  for (let index = 0; index < 468; index += 1) {
    if (mapped.coverage.uncoveredTargetIndices.includes(index)) continue;
    const [u, v] = targetUvForTesting(index);
    const [ex, ey, ez] = analyticXyz(u, v);
    assertClose(mapped.landmarks[index * 3]!, ex, tolerance, `landmark ${index} x`);
    assertClose(mapped.landmarks[index * 3 + 1]!, ey, tolerance, `landmark ${index} y`);
    assertClose(mapped.landmarks[index * 3 + 2]!, ez, tolerance, `landmark ${index} z`);
  }
}

test('mapping table has its pinned SHA-256 integrity identity', () => {
  assert.match(TOPOLOGY_MAPPING_SHA256, /^[a-f0-9]{64}$/);
  assert.doesNotThrow(verifyTopologyMappingIntegrity);
});

test('ARCore 468 becomes 478 while ten unmeasured iris points stay unavailable', () => {
  const mapped = mapToMediaPipe478(planarProvider('arcore-face-mesh-468'));
  assert.equal(mapped.landmarks.length, LANDMARK_COUNT * 3);
  assert.deepEqual(mapped.unavailableLandmarkIndices, [468, 469, 470, 471, 472, 473, 474, 475, 476, 477]);
  assert.deepEqual(Array.from(mapped.landmarkConfidence.slice(468)), new Array(10).fill(0));
  // Expected from the closed-form quad formula (`landmarks[i] = [u*10, v*20,
  // u+v]` at target UV 0) rather than a hardcoded magic number (audit P0-02,
  // re-review of 6748fef): a literal here would have kept passing against
  // whatever `TARGET_UV[0]` happened to be, including the wrong v2 value, so
  // it never could have caught the UV-ordering bug. Deriving the expectation
  // from `targetUvForTesting` at run time means this test actually exercises
  // "does the mapper interpolate this provider correctly at landmark 0's
  // real target UV," which fails if either the table or the interpolation
  // regresses.
  const [u0, v0] = targetUvForTesting(0);
  assertClose(mapped.landmarks[0]!, u0 * 10, 1e-5, 'landmark 0 x');
  assertClose(mapped.landmarks[1]!, v0 * 20, 1e-5, 'landmark 0 y');
  assertClose(mapped.landmarks[2]!, u0 + v0, 1e-5, 'landmark 0 z');
});

test('provider vertex count is validated rather than trusted', () => {
  const raw = planarProvider('arcore-face-mesh-468');
  const truncated: RawTopologyGeometry = {
    ...raw,
    landmarks: raw.landmarks.slice(0, 467 * 3),
    landmarkConfidence: raw.landmarkConfidence.slice(0, 467),
  };
  assert.throws(() => mapToMediaPipe478(truncated), /requires 468 vertices/);
});

test('native topology version and numeric payload are verified', () => {
  const raw = planarProvider('arcore-face-mesh-468');
  assert.throws(
    () => mapToMediaPipe478({ ...raw, topologyVersion: 'arcore-future-layout' }),
    /unsupported native topology/,
  );
  const invalidCoordinate = [...raw.landmarks];
  invalidCoordinate[9] = Number.NaN;
  assert.throws(
    () => mapToMediaPipe478({ ...raw, landmarks: invalidCoordinate }),
    /non-finite coordinate/,
  );
  const invalidConfidence = [...raw.landmarkConfidence];
  invalidConfidence[3] = 1.1;
  assert.throws(
    () => mapToMediaPipe478({ ...raw, landmarkConfidence: invalidConfidence }),
    /outside \[0,1\]/,
  );
});

test('cross-provider mapping matches the analytic surface despite different vertex counts, order and triangulation', () => {
  // ARKit-style: 23x21 = 483 vertices (a real ARKit face mesh has far more
  // vertices than MediaPipe's 468), stored in reverse index order, wound the
  // opposite way from the ARCore-style grid below.
  const arkit = mapToMediaPipe478(
    providerFromGrid(
      'arkit-face-geometry',
      buildGrid({ rows: 23, cols: 21, reverseWinding: true, permutation: reverseIndexPermutation }),
    ),
  );
  // ARCore-style: exactly 468 vertices (Google's documented count), stored in
  // natural row-major order, standard winding.
  const arcore = mapToMediaPipe478(
    providerFromGrid('arcore-face-mesh-468', buildGrid({ rows: 26, cols: 18 })),
  );

  assert.notEqual(arkit.landmarks.length, undefined);
  assertMatchesAnalyticSurface(arkit);
  assertMatchesAnalyticSurface(arcore);
  // Repeatability: mapping is a pure function of the input mesh.
  const arkitAgain = mapToMediaPipe478(
    providerFromGrid(
      'arkit-face-geometry',
      buildGrid({ rows: 23, cols: 21, reverseWinding: true, permutation: reverseIndexPermutation }),
    ),
  );
  assert.deepEqual(arkit.landmarks, arkitAgain.landmarks);
});

test('vertex storage order does not change the mapped result', () => {
  const natural = mapToMediaPipe478(
    providerFromGrid('arcore-face-mesh-468', buildGrid({ rows: 26, cols: 18 })),
  );
  const permuted = mapToMediaPipe478(
    providerFromGrid(
      'arcore-face-mesh-468',
      buildGrid({ rows: 26, cols: 18, permutation: reverseIndexPermutation }),
    ),
  );
  assertMatchesAnalyticSurface(natural);
  assertMatchesAnalyticSurface(permuted);
});

test('triangle winding order does not change the mapped result', () => {
  const standardWinding = mapToMediaPipe478(
    providerFromGrid('arcore-face-mesh-468', buildGrid({ rows: 26, cols: 18 })),
  );
  const reversedWinding = mapToMediaPipe478(
    providerFromGrid('arcore-face-mesh-468', buildGrid({ rows: 26, cols: 18, reverseWinding: true })),
  );
  assertMatchesAnalyticSurface(standardWinding);
  assertMatchesAnalyticSurface(reversedWinding);
});

test('a degenerate zero-area triangle ahead of a valid one is skipped, not fatal', () => {
  const mapped = mapToMediaPipe478(
    providerFromGrid(
      'arcore-face-mesh-468',
      buildGrid({ rows: 26, cols: 18, degenerateTriangleAtFront: true }),
    ),
  );
  assertMatchesAnalyticSurface(mapped);
});

test('a target UV outside every provider triangle is reported unavailable, never guessed', () => {
  // Shrink the covered domain so target UVs near the edge of the frozen
  // MediaPipe UV layout (e.g. face contour, ears) fall outside every
  // triangle. A fixed provider mesh legitimately cannot see everywhere the
  // canonical topology asks about.
  const raw = providerFromGrid(
    'arcore-face-mesh-468',
    buildGrid({ rows: 26, cols: 18, uRange: [0.2, 0.8], vRange: [0.2, 0.8] }),
  );
  const mapped = mapToMediaPipe478(raw);

  assert.ok(mapped.coverage.uncoveredTargetIndices.length > 0, 'the shrunk domain must miss some targets');
  assert.equal(
    mapped.coverage.coveredCount,
    468 - mapped.coverage.uncoveredTargetIndices.length,
  );
  assert.ok(mapped.maxUncoveredUvGap > 0);
  for (const index of mapped.coverage.uncoveredTargetIndices) {
    assert.equal(mapped.landmarkConfidence[index], 0);
    assert.deepEqual(
      [mapped.landmarks[index * 3], mapped.landmarks[index * 3 + 1], mapped.landmarks[index * 3 + 2]],
      [0, 0, 0],
      `uncovered index ${index} must be a zero placeholder, not a fabricated position`,
    );
    assert.ok(
      mapped.unavailableLandmarkIndices.includes(index),
      `uncovered index ${index} must be listed unavailable`,
    );
  }
  // Every previously-passing "does mapping cover the frozen topology" style
  // assertion still holds for the points the shrunk mesh *does* cover.
  assertMatchesAnalyticSurface(mapped);
});

test('mapping commutes with a rigid transform of the source mesh', () => {
  // A face rotated/translated by head pose must map to the same rotated/
  // translated result — the barycentric sampler must not secretly depend on
  // the mesh's absolute position or orientation.
  const angle = Math.PI / 7;
  const rotation: readonly (readonly number[])[] = [
    [Math.cos(angle), 0, Math.sin(angle)],
    [0, 1, 0],
    [-Math.sin(angle), 0, Math.cos(angle)],
  ];
  const translation = [12.5, -4.25, 7.0] as const;

  function applyRigid(point: readonly [number, number, number]): [number, number, number] {
    return [
      rotation[0]![0]! * point[0] + rotation[0]![1]! * point[1] + rotation[0]![2]! * point[2] + translation[0],
      rotation[1]![0]! * point[0] + rotation[1]![1]! * point[1] + rotation[1]![2]! * point[2] + translation[1],
      rotation[2]![0]! * point[0] + rotation[2]![1]! * point[1] + rotation[2]![2]! * point[2] + translation[2],
    ];
  }

  const base = buildGrid({ rows: 23, cols: 21 });
  const transformed: GridMesh = {
    ...base,
    landmarks: (() => {
      const out = new Array<number>(base.landmarks.length);
      for (let i = 0; i < base.landmarks.length; i += 3) {
        const [x, y, z] = applyRigid([base.landmarks[i]!, base.landmarks[i + 1]!, base.landmarks[i + 2]!]);
        out[i] = x;
        out[i + 1] = y;
        out[i + 2] = z;
      }
      return out;
    })(),
  };

  const mappedBase = mapToMediaPipe478(providerFromGrid('arkit-face-geometry', base));
  const mappedTransformed = mapToMediaPipe478(providerFromGrid('arkit-face-geometry', transformed));

  for (let index = 0; index < 468; index += 1) {
    const original: [number, number, number] = [
      mappedBase.landmarks[index * 3]!,
      mappedBase.landmarks[index * 3 + 1]!,
      mappedBase.landmarks[index * 3 + 2]!,
    ];
    const expected = applyRigid(original);
    assertClose(mappedTransformed.landmarks[index * 3]!, expected[0], 1e-3, `rigid landmark ${index} x`);
    assertClose(mappedTransformed.landmarks[index * 3 + 1]!, expected[1], 1e-3, `rigid landmark ${index} y`);
    assertClose(mappedTransformed.landmarks[index * 3 + 2]!, expected[2], 1e-3, `rigid landmark ${index} z`);
  }
});
