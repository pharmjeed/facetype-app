/**
 * The client gate config is named by its hash in every capture and frame, so
 * the hash has to be reproducible by any reader (native, server, research)
 * from the canonical JSON alone.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  CLIENT_GATE_CONFIG,
  canonicalJson,
  gateConfigHash,
  gateConfigJson,
  sha256Hex,
  utf8,
} from '../src/index.ts';

test('the pure SHA-256 matches node:crypto on edge-length inputs', () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff);
    assert.equal(sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'), `length ${length}`);
  }
  assert.equal(
    sha256Hex(utf8('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('utf8 matches Buffer for Arabic and astral characters', () => {
  const text = 'وجه 😀 ok';
  assert.deepEqual(Buffer.from(utf8(text)), Buffer.from(text, 'utf8'));
});

test('canonical JSON sorts keys at every depth and has no whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 0 }], c: 'x' } }), '{"a":{"c":"x","d":[2,{"y":0,"z":1}]},"b":1}');
  assert.throws(() => canonicalJson({ a: Number.NaN }));
});

test('the gate hash is the SHA-256 of the canonical JSON the camera receives', () => {
  const json = gateConfigJson();
  assert.doesNotMatch(json, /\s/);
  assert.equal(gateConfigHash(), createHash('sha256').update(json, 'utf8').digest('hex'));
  assert.match(gateConfigHash(), /^[0-9a-f]{64}$/);
});

test('the A7.78-B numbers and their provenance labels are in force', () => {
  assert.equal(CLIENT_GATE_CONFIG.size.minFaceWidthPx, 220);
  assert.equal(CLIENT_GATE_CONFIG.size.preferredFaceWidthPx, 350);
  assert.equal(CLIENT_GATE_CONFIG.size.maxFaceWidthFrac, 0.7);
  assert.equal(CLIENT_GATE_CONFIG.sharpness.minRelativeToBurstMax, 0.5);
  assert.equal(CLIENT_GATE_CONFIG.labels['size.minFaceWidthPx'], 'validated');
  assert.equal(CLIENT_GATE_CONFIG.labels['sharpness.minRelativeToBurstMax'], 'default');
  assert.equal(CLIENT_GATE_CONFIG.labels['expression.maxSmile'], 'research');
  assert.equal(CLIENT_GATE_CONFIG.labels['burst.targetFrames'], 'owner');
  assert.equal(CLIENT_GATE_CONFIG.burst.targetFrames, 10);
});

test('every numeric leaf of the config carries a provenance label', () => {
  const { labels, ...rest } = CLIENT_GATE_CONFIG;
  const groups = Object.fromEntries(Object.entries(rest).filter(([key]) => key !== 'version')) as Record<
    string,
    object
  >;
  for (const [group, values] of Object.entries(groups)) {
    for (const key of Object.keys(values)) {
      assert.ok(labels[`${group}.${key}`], `missing label for ${group}.${key}`);
    }
  }
  for (const key of Object.keys(labels)) {
    const [group, leaf] = key.split('.') as [string, string];
    assert.ok(leaf in (groups as Record<string, object>)[group]!, `stale label ${key}`);
  }
});

test('changing any threshold changes the hash', () => {
  const changed = structuredClone(CLIENT_GATE_CONFIG);
  changed.size.minFaceWidthPx = 221;
  assert.notEqual(gateConfigHash(changed), gateConfigHash());
});
