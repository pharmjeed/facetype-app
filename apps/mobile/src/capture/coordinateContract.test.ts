import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isFiniteRowMajorAffine,
  isRightHandedRigidRotation,
  rotationBlock,
} from './coordinateContract.ts';

function identityPose(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function rotationAboutZ(angleDeg: number, tx = 0, ty = 0, tz = 0): number[] {
  const angle = (angleDeg * Math.PI) / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, -s, 0, tx, s, c, 0, ty, 0, 0, 1, tz, 0, 0, 0, 1];
}

test('identity is a right-handed rigid rotation', () => {
  assert.ok(isFiniteRowMajorAffine(identityPose()));
  assert.ok(isRightHandedRigidRotation(identityPose()));
});

test('a real rotation with translation is accepted', () => {
  const pose = rotationAboutZ(37, 10, -5, 320);
  assert.ok(isFiniteRowMajorAffine(pose));
  assert.ok(isRightHandedRigidRotation(pose));
});

test('rotationBlock extracts rows 0-2, columns 0-2 in row-major order', () => {
  const pose = rotationAboutZ(90);
  assert.deepEqual(rotationBlock(pose), [
    pose[0], pose[1], pose[2],
    pose[4], pose[5], pose[6],
    pose[8], pose[9], pose[10],
  ]);
});

test('a reflection (determinant -1) is rejected', () => {
  const pose = identityPose();
  pose[0] = -1; // flips handedness; still orthonormal
  assert.ok(isFiniteRowMajorAffine(pose), 'shape/affine-ness alone must still pass');
  assert.equal(isRightHandedRigidRotation(pose), false);
});

test('a uniformly scaled rotation block is rejected', () => {
  const pose = identityPose();
  pose[0] = 2;
  pose[5] = 2;
  pose[10] = 2;
  assert.equal(isRightHandedRigidRotation(pose), false);
});

test('a skewed (sheared) rotation block is rejected', () => {
  const pose = identityPose();
  pose[1] = 0.5; // shear: no rigid transform produces this
  assert.equal(isRightHandedRigidRotation(pose), false);
});

test('a non-affine bottom row is rejected by the affine check first', () => {
  const pose = identityPose();
  pose[14] = 0.3; // bottom row must be [0,0,0,1]
  assert.equal(isFiniteRowMajorAffine(pose), false);
});

test('a non-finite value is rejected', () => {
  const pose = identityPose();
  pose[5] = Number.NaN;
  assert.equal(isFiniteRowMajorAffine(pose), false);
});
