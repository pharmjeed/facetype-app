/**
 * The raw-frame bridge contract.
 *
 * A malformed handle accepted here becomes a signed upload slot for a length
 * and a digest that do not describe the bytes, and the failure surfaces much
 * later as an opaque checksum rejection against a scan that had already
 * uploaded its geometry. So the payload is validated at the boundary.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RAW_FRAME_BYTES_MISMATCH,
  RAW_FRAME_MALFORMED,
  createRawFrameChannel,
  decodeBase64,
  toRawFrameHandle,
} from './rawFrame.ts';

const GOOD = {
  token: 'slot-1',
  byteLength: 2048,
  sha256: 'a'.repeat(64),
  width: 640,
  height: 480,
};

test('a well-formed native payload becomes a handle', () => {
  assert.deepEqual(toRawFrameHandle(GOOD), GOOD);
  // Nothing else the bridge sent is carried through: a handle is exactly these
  // five fields, so an accidental `path` or `uri` cannot ride along.
  assert.deepEqual(Object.keys(toRawFrameHandle({ ...GOOD, path: '/tmp/x.jpg' })).sort(), [
    'byteLength',
    'height',
    'sha256',
    'token',
    'width',
  ]);
});

test('a malformed payload is refused rather than uploaded against', () => {
  const bad: unknown[] = [
    null,
    undefined,
    {},
    { ...GOOD, token: '' },
    { ...GOOD, byteLength: 0 },
    { ...GOOD, byteLength: -1 },
    { ...GOOD, byteLength: 2048.5 },
    { ...GOOD, byteLength: '2048' },
    { ...GOOD, sha256: 'A'.repeat(64) },
    { ...GOOD, sha256: 'a'.repeat(63) },
    { ...GOOD, sha256: 'not a digest' },
    { ...GOOD, width: 0 },
    { ...GOOD, height: -480 },
  ];
  for (const payload of bad) {
    assert.throws(
      () => toRawFrameHandle(payload),
      (error: { code?: string }) => error.code === RAW_FRAME_MALFORMED,
      JSON.stringify(payload),
    );
  }
});

test('base64 decodes to the exact bytes, including both padding lengths', () => {
  assert.deepEqual(Array.from(decodeBase64('')), []);
  assert.deepEqual(Array.from(decodeBase64('/9j/4A==')), [0xff, 0xd8, 0xff, 0xe0]);
  assert.deepEqual(Array.from(decodeBase64('AAECAwQ=')), [0, 1, 2, 3, 4]);
  assert.deepEqual(Array.from(decodeBase64('AAECAwQF')), [0, 1, 2, 3, 4, 5]);
  // Bridges wrap long strings; the wrapping is not part of the data.
  assert.deepEqual(Array.from(decodeBase64('AAEC\nAwQF')), [0, 1, 2, 3, 4, 5]);
});

test('base64 that is not base64 is refused, not silently truncated', () => {
  for (const value of ['AAE', 'AA=A', '****', 'AAEC AwQ']) {
    assert.throws(
      () => decodeBase64(value),
      (error: { code?: string }) => error.code === RAW_FRAME_MALFORMED,
      value,
    );
  }
});

test('a build with no raw-frame export yields no channel at all', () => {
  assert.equal(createRawFrameChannel(undefined), null);
  assert.equal(createRawFrameChannel(null), null);
  assert.equal(createRawFrameChannel({}), null);
  // A partially-implemented bridge is not a channel either: half a cleanup
  // path is worse than none, because it looks like one.
  assert.equal(
    createRawFrameChannel({
      captureRawFrame: async () => GOOD,
      readRawFrame: async () => '',
    }),
    null,
  );
});

test('the channel refuses bytes that are not the ones the slot was signed for', async () => {
  const channel = createRawFrameChannel({
    captureRawFrame: async () => ({ ...GOOD, byteLength: 6 }),
    readRawFrame: async () => 'AAECAwQF',
    discardRawFrame: async () => {},
    discardAllRawFrames: async () => {},
  })!;

  const handle = await channel.capture();
  assert.deepEqual(Array.from(await channel.read(handle)), [0, 1, 2, 3, 4, 5]);

  const shifty = createRawFrameChannel({
    captureRawFrame: async () => GOOD,
    // Declared 2048, returns 6: a concurrent discard or a second capture
    // replaced the slot under an in-flight upload.
    readRawFrame: async () => 'AAECAwQF',
    discardRawFrame: async () => {},
    discardAllRawFrames: async () => {},
  })!;
  const stale = await shifty.capture();
  await assert.rejects(
    () => shifty.read(stale),
    (error: { code?: string }) => error.code === RAW_FRAME_BYTES_MISMATCH,
  );
});

test('discard and discardAll reach the native module with the opaque token only', async () => {
  const seen: string[] = [];
  const channel = createRawFrameChannel({
    captureRawFrame: async () => GOOD,
    readRawFrame: async () => '',
    discardRawFrame: async (token: string) => {
      seen.push(`discard:${token}`);
    },
    discardAllRawFrames: async () => {
      seen.push('discardAll');
    },
  })!;

  const handle = await channel.capture();
  await channel.discard(handle);
  await channel.discardAll();
  assert.deepEqual(seen, ['discard:slot-1', 'discardAll']);
});
