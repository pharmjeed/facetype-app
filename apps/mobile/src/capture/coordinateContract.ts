/**
 * Coordinate/matrix-layout contract at the provider boundary (audit P0-02
 * item 2, hardened further after independent review of 15d1fab).
 *
 * Factored out of `providers.ts` — which uses TypeScript parameter-property
 * class syntax Babel understands but Node's `--experimental-strip-types`
 * does not — the same way Android's `FaceGeometryMath.kt` was factored out
 * of `FaceTypePreviewView.kt`: so this pure, dependency-free matrix math is
 * directly unit-testable (`coordinateContract.test.ts`), not just exercised
 * indirectly through a class the test runner cannot import.
 */

/** True when `headPose` is 16 finite numbers laid out as a row-major affine
 * 4x4: the bottom row is `[0,0,0,1]` (translation lives in the last column,
 * indices 3/7/11 — see `FaceGeometryMath.toRowMajorMillimeters` and Python's
 * `remove_head_pose`, `pose[:3, 3]`). This only checks shape/affine-ness, not
 * that the rotation block is a genuine rigid rotation — see
 * `isRightHandedRigidRotation` for that. */
export function isFiniteRowMajorAffine(headPose: readonly number[]): boolean {
  return (
    headPose.length === 16 &&
    headPose.every((value) => Number.isFinite(value)) &&
    Math.abs(headPose[12]!) <= 1e-5 &&
    Math.abs(headPose[13]!) <= 1e-5 &&
    Math.abs(headPose[14]!) <= 1e-5 &&
    Math.abs(headPose[15]! - 1) <= 1e-5
  );
}

/** Extracts the row-major 3x3 rotation block (rows 0-2, columns 0-2) as a
 * flat 9-element row-major array. Callers must already know `headPose` has
 * 16 finite entries (see `isFiniteRowMajorAffine`). */
export function rotationBlock(headPose: readonly number[]): readonly number[] {
  return [
    headPose[0]!, headPose[1]!, headPose[2]!,
    headPose[4]!, headPose[5]!, headPose[6]!,
    headPose[8]!, headPose[9]!, headPose[10]!,
  ];
}

function determinant3x3(m: readonly number[]): number {
  const [a, b, c, d, e, f, g, h, i] = m as [
    number, number, number, number, number, number, number, number, number,
  ];
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

/** True when the 3x3 rotation block of a row-major head pose is a
 * right-handed rigid rotation: orthonormal (its rows are unit-length and
 * mutually perpendicular) with determinant +1 (audit P0-02, independent
 * review of 15d1fab).
 *
 * A reflected (determinant -1) or scaled/skewed (non-orthonormal) matrix is
 * not a rigid head transform; letting one through would silently corrupt
 * pose removal and every downstream measurement instead of failing at the
 * boundary that received it. Tolerance is generous (not machine epsilon): a
 * real device/SDK transform is only ever close to exactly orthonormal.
 */
export function isRightHandedRigidRotation(
  headPose: readonly number[],
  tolerance = 1e-2,
): boolean {
  const rows: ReadonlyArray<readonly [number, number, number]> = [
    [headPose[0]!, headPose[1]!, headPose[2]!],
    [headPose[4]!, headPose[5]!, headPose[6]!],
    [headPose[8]!, headPose[9]!, headPose[10]!],
  ];
  const dot = (u: readonly [number, number, number], v: readonly [number, number, number]) =>
    u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

  for (const row of rows) {
    if (Math.abs(Math.sqrt(dot(row, row)) - 1) > tolerance) return false;
  }
  if (Math.abs(dot(rows[0]!, rows[1]!)) > tolerance) return false;
  if (Math.abs(dot(rows[0]!, rows[2]!)) > tolerance) return false;
  if (Math.abs(dot(rows[1]!, rows[2]!)) > tolerance) return false;

  return Math.abs(determinant3x3(rotationBlock(headPose)) - 1) <= tolerance;
}
