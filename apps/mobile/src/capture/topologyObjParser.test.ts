/** Non-circular proof that the frozen `TARGET_UV_BASE64` table in
 * `topology.ts` is the *semantic* per-vertex UV from the pinned upstream
 * `canonical_face_model.obj` (audit P0-02, re-review of 6748fef).
 *
 * `topology.test.ts`'s "mapping table has its pinned SHA-256 integrity
 * identity" only proves the frozen table has not drifted from *itself*.
 * That could not catch the actual v2 bug: the table was built from the
 * `.obj`'s `vt` lines in raw file order, not the UV each landmark's own
 * vertex declares via its face `v/vt` associations. An OBJ face line is
 * `f v1/vt1 v2/vt2 v3/vt3 ...`; a vertex's `v` index and its `vt` index are
 * independent numbering -- in the pinned file, vertex 0's true UV is `vt`
 * line 440, not `vt` line 0. Reading `vt` lines in storage order paired
 * every landmark with a plausible-looking but wrong UV while staying
 * perfectly self-consistent (its own checksum matched itself).
 *
 * This file parses the pinned `__fixtures__/canonical_face_model.obj` fixture
 * independently of `topology.ts`'s frozen table and proves the *correct*
 * (face-association) extraction reproduces `TOPOLOGY_MAPPING_SHA256` while
 * the *naive* (line-order) extraction reproduces the known v2 bug and
 * nothing else. This repository has no network access at test time by
 * design, so the fixture is a committed copy of the exact pinned revision,
 * verified below against the manifest's `source_file_sha256`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { fallbackSha256 } from '../api/client.ts';
import { TOPOLOGY_MAPPING_MANIFEST } from './topologyManifest.ts';
import { TOPOLOGY_MAPPING_SHA256 } from './topology.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, '__fixtures__', 'canonical_face_model.obj');

// The exact v2 regression this module guards against: reading `vt` lines in
// raw file order instead of resolving them through each face's v/vt
// association. Recorded as a literal so the regression stays pinned even if
// this file is edited.
const KNOWN_V2_REGRESSION_SHA256 =
  '232b997cec62ca623c885fab78295b2bee9e526c2cbadd8cd42e769c0aaab76f';

function packUv(pairs: ReadonlyArray<readonly [number, number]>): Uint8Array {
  const out = new Uint8Array(pairs.length * 2 * 4);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const [u, v] of pairs) {
    view.setFloat32(offset, u, true);
    view.setFloat32(offset + 4, v, true);
    offset += 8;
  }
  return out;
}

/** Correct extraction: each vertex's UV is resolved through the face `v/vt`
 * associations that actually declare it, ordered by vertex index. Throws if
 * a vertex is associated with two different UVs across faces, or is never
 * referenced by any face at all. */
function semanticTargetUvBytes(objText: string): Uint8Array {
  let vCount = 0;
  const vtList: Array<[number, number]> = [];
  const vToVt = new Map<number, number>();
  // Split on either line-ending style and drop empty tokens from trailing
  // whitespace: the fixture is committed `-text` (see `.gitattributes`) so
  // this should never see CRLF in practice, but a parser this load-bearing
  // must not silently misparse (e.g. a trailing "\r" token, Number("") - 1
  // === -1) if a future checkout ever mangles it anyway.
  for (const rawLine of objText.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('vt ')) {
      const [, u, v] = line.split(/\s+/).filter(Boolean);
      vtList.push([Number(u), Number(v)]);
    } else if (line.startsWith('v ')) {
      vCount += 1;
    } else if (line.startsWith('f ')) {
      for (const token of line.split(/\s+/).slice(1).filter(Boolean)) {
        const [vIndexStr, vtIndexStr] = token.split('/');
        const vIndex = Number(vIndexStr) - 1;
        const vtIndex = Number(vtIndexStr) - 1;
        const existing = vToVt.get(vIndex);
        if (existing !== undefined && existing !== vtIndex) {
          throw new Error(
            `vertex ${vIndex} is associated with two different UVs (${existing} and ${vtIndex}) across faces`,
          );
        }
        vToVt.set(vIndex, vtIndex);
      }
    }
  }
  const missing: number[] = [];
  for (let index = 0; index < vCount; index += 1) {
    if (!vToVt.has(index)) missing.push(index);
  }
  if (missing.length > 0) {
    throw new Error(`${missing.length} vertices are never referenced by any face: ${missing.slice(0, 5)}`);
  }
  const ordered: Array<[number, number]> = [];
  for (let index = 0; index < vCount; index += 1) {
    ordered.push(vtList[vToVt.get(index)!]!);
  }
  return packUv(ordered);
}

/** The exact v2 bug: `vt` lines read in raw file order, treating storage
 * slot N as landmark N's UV and never consulting a face's v/vt pairing. */
function naiveLineOrderTargetUvBytes(objText: string): Uint8Array {
  const vtList: Array<[number, number]> = [];
  for (const rawLine of objText.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('vt ')) {
      const [, u, v] = line.split(/\s+/).filter(Boolean);
      vtList.push([Number(u), Number(v)]);
    }
  }
  return packUv(vtList);
}

function loadFixture(): string {
  return readFileSync(FIXTURE_PATH, 'utf8');
}

test('the pinned fixture matches the manifest source_file_sha256', () => {
  const objText = loadFixture();
  const actual = fallbackSha256(new TextEncoder().encode(objText));
  assert.equal(actual, TOPOLOGY_MAPPING_MANIFEST.target_uv.source_file_sha256);
});

test('the face-association parser reproduces the pinned target UV checksum from the fixture .obj', () => {
  const objText = loadFixture();
  const parsed = semanticTargetUvBytes(objText);
  assert.equal(parsed.byteLength, 468 * 2 * 4);
  assert.equal(fallbackSha256(parsed), TOPOLOGY_MAPPING_SHA256);
  assert.equal(TOPOLOGY_MAPPING_SHA256, TOPOLOGY_MAPPING_MANIFEST.target_uv.checksum_sha256);
});

test('naive vt-line-order parsing reproduces the known v2 regression, not the pinned checksum', () => {
  const objText = loadFixture();
  const naive = naiveLineOrderTargetUvBytes(objText);
  assert.equal(fallbackSha256(naive), KNOWN_V2_REGRESSION_SHA256);
  assert.notEqual(fallbackSha256(naive), TOPOLOGY_MAPPING_SHA256);
});

test('a V-flipped target UV does not match the pinned checksum', () => {
  const objText = loadFixture();
  const parsed = semanticTargetUvBytes(objText);
  const view = new DataView(parsed.buffer, parsed.byteOffset, parsed.byteLength);
  const flipped = new Uint8Array(parsed.byteLength);
  const flippedView = new DataView(flipped.buffer);
  for (let i = 0; i < parsed.byteLength / 8; i += 1) {
    const u = view.getFloat32(i * 8, true);
    const v = view.getFloat32(i * 8 + 4, true);
    flippedView.setFloat32(i * 8, u, true);
    flippedView.setFloat32(i * 8 + 4, 1 - v, true);
  }
  assert.notDeepEqual(Array.from(flipped), Array.from(parsed));
  assert.notEqual(fallbackSha256(flipped), TOPOLOGY_MAPPING_SHA256);
});

// --- Permutation negative (synthetic fixture) ------------------------------
//
// A small, hand-built OBJ where the `vt` list is stored in an order that has
// nothing to do with vertex order, proving the face-association parser is
// invariant to `vt` storage order while the naive line-order parser is not
// -- in isolation, without depending on the real fixture's specific numbers.
const PERMUTED_SQUARE_OBJ = [
  'v 0.0 0.0 0.0',
  'v 1.0 0.0 0.0',
  'v 1.0 1.0 0.0',
  'v 0.0 1.0 0.0',
  'vt 1.0 1.0',
  'vt 0.0 0.0',
  'vt 0.0 1.0',
  'vt 1.0 0.0',
  'f 1/2 2/4 3/1',
  'f 1/2 3/1 4/3',
  '',
].join('\n');

const EXPECTED_SQUARE_UV: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.0],
  [1.0, 0.0],
  [1.0, 1.0],
  [0.0, 1.0],
];

function unpackUv(bytes: Uint8Array): Array<[number, number]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < bytes.byteLength / 8; i += 1) {
    pairs.push([view.getFloat32(i * 8, true), view.getFloat32(i * 8 + 4, true)]);
  }
  return pairs;
}

test('permutation of vt storage order does not change the semantic result', () => {
  const parsed = unpackUv(semanticTargetUvBytes(PERMUTED_SQUARE_OBJ));
  for (let i = 0; i < EXPECTED_SQUARE_UV.length; i += 1) {
    assert.ok(Math.abs(parsed[i]![0] - EXPECTED_SQUARE_UV[i]![0]) < 1e-6, `pair ${i} u`);
    assert.ok(Math.abs(parsed[i]![1] - EXPECTED_SQUARE_UV[i]![1]) < 1e-6, `pair ${i} v`);
  }
});

test('naive line order is wrong for the same permuted storage', () => {
  const naive = unpackUv(naiveLineOrderTargetUvBytes(PERMUTED_SQUARE_OBJ));
  let anyDifferent = false;
  for (let i = 0; i < EXPECTED_SQUARE_UV.length; i += 1) {
    if (
      Math.abs(naive[i]![0] - EXPECTED_SQUARE_UV[i]![0]) > 1e-6 ||
      Math.abs(naive[i]![1] - EXPECTED_SQUARE_UV[i]![1]) > 1e-6
    ) {
      anyDifferent = true;
    }
  }
  assert.ok(anyDifferent, 'the naive parser must disagree with the face-association result');
});

test('a vertex associated with two different UVs across faces is rejected', () => {
  const inconsistent = PERMUTED_SQUARE_OBJ.replace('f 1/2 3/1 4/3', 'f 1/3 3/1 4/3');
  assert.throws(() => semanticTargetUvBytes(inconsistent), /two different UVs/);
});

test('a vertex never referenced by any face is rejected', () => {
  const orphaned = PERMUTED_SQUARE_OBJ.split('\n')
    .filter((line) => line !== 'f 1/2 3/1 4/3')
    .join('\n');
  assert.throws(() => semanticTargetUvBytes(orphaned), /never referenced/);
});
