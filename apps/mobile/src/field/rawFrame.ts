/**
 * The raw-frame export channel: a consented JPEG of the participant's face.
 *
 * WHAT THIS IS NOT. It is not a screenshot, and no path in this app can make
 * one. Both native implementations export the *camera image* of a frame the AR
 * session already had in hand (ARCore's `Frame.acquireCameraImage`, ARKit's
 * `ARFrame.capturedImage`) and encode it directly. Nothing reads the window,
 * the surface, the view hierarchy or the display, so the JPEG cannot contain
 * the app's own UI, another app's content, or anything else that happened to be
 * on screen — and there is no screen-capture API for a reviewer to find,
 * because none is used.
 *
 * WHERE THE BYTES LIVE. Natively, in memory, in a single-slot store, for as
 * long as one upload takes. They are never written to disk: a file would be a
 * second copy of a stranger's face with its own lifetime, its own backup
 * exposure and its own deletion path to get wrong, and it buys nothing, because
 * a presigned PUT needs the bytes in the JavaScript heap anyway. `capture()`
 * therefore returns only *metadata* — a token, a length and a digest — so the
 * upload slot can be requested before any pixel crosses the bridge, and
 * `read()` is called exactly once, immediately before the PUT.
 *
 * CLEANUP IS THE CALLER'S OBLIGATION AND THE PLATFORM'S BACKSTOP.
 * `runFieldCaptureSequence` discards in a `finally`, so a success, a failure
 * and a cancellation all end with the slot zeroed. The native side
 * independently discards everything on host pause (the app going to the
 * background), on `stop()`, and on bridge invalidation, so a session that ends
 * in a way JavaScript never hears about does not leave a face in the heap.
 *
 * This module is framework-free: it validates the bridge's payload and decodes
 * base64, and is unit-tested directly. The `NativeModules` lookup lives in
 * `nativeRawFrame.ts`.
 */

import { captureError } from '../capture/captureError.ts';

/** What the native side hands back. Metadata only — never pixels. */
export interface RawFrameHandle {
  /** Opaque native slot identifier. Not a path, not a name, not an id. */
  token: string;
  byteLength: number;
  /** Computed natively over the exact bytes, so the upload can be declared. */
  sha256: string;
  width: number;
  height: number;
}

export interface RawFrameChannel {
  /**
   * Export the current camera frame as a JPEG, held natively.
   *
   * Takes no pose: the frame is whatever the AR session has live at the
   * moment of the call, and the pose it belongs to is already carried by the
   * upload request. A pose argument the native side ignored would read like a
   * guarantee that the photograph is of that pose's analysed frame, which it
   * is not — it is the frame immediately after it.
   */
  capture(): Promise<RawFrameHandle>;
  /** The bytes, once there is somewhere to send them. */
  read(handle: RawFrameHandle): Promise<Uint8Array>;
  /** Zero and drop one held frame. Idempotent. */
  discard(handle: RawFrameHandle): Promise<void>;
  /** Zero and drop everything held. Idempotent. */
  discardAll(): Promise<void>;
}

/** Client-local reasons, deliberately not shaped like server FT codes. */
export const RAW_FRAME_MALFORMED = 'FIELD_RAW_EXPORT_MALFORMED';
export const RAW_FRAME_BYTES_MISMATCH = 'FIELD_RAW_BYTES_MISMATCH';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Turn an untyped bridge payload into a handle, or refuse it.
 *
 * The length and the digest are what the upload slot is requested with, and
 * the server rejects an object whose stored bytes do not match either one. A
 * malformed payload accepted here would surface much later as an opaque
 * `FT-SCAN-013` against a scan that had already uploaded its geometry.
 */
export function toRawFrameHandle(raw: unknown): RawFrameHandle {
  const value = raw as Partial<RawFrameHandle> | null;
  const token = value?.token;
  const byteLength = value?.byteLength;
  const sha256 = value?.sha256;
  const width = value?.width;
  const height = value?.height;

  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    typeof byteLength !== 'number' ||
    !Number.isInteger(byteLength) ||
    byteLength <= 0 ||
    typeof sha256 !== 'string' ||
    !SHA256_HEX.test(sha256) ||
    typeof width !== 'number' ||
    !Number.isInteger(width) ||
    width <= 0 ||
    typeof height !== 'number' ||
    !Number.isInteger(height) ||
    height <= 0
  ) {
    throw captureError(RAW_FRAME_MALFORMED, 'the raw-frame bridge returned an unusable handle');
  }
  return { token, byteLength, sha256, width, height };
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decode standard base64 into bytes.
 *
 * Hand-written rather than reaching for `atob` or a package: React Native's
 * global set differs between Hermes versions and platforms, and a JPEG that
 * silently decodes to the wrong bytes is an upload the server rejects with a
 * checksum error that points nowhere near the cause. Whitespace is tolerated
 * (some bridges wrap long lines); anything else is refused.
 */
export function decodeBase64(value: string): Uint8Array {
  const compact = value.replace(/[\r\n\t ]/g, '');
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  const body = padding > 0 ? compact.slice(0, -padding) : compact;
  if (compact.length % 4 !== 0) {
    throw captureError(RAW_FRAME_MALFORMED, 'raw-frame base64 has a truncated quantum');
  }

  const out = new Uint8Array((compact.length / 4) * 3 - padding);
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < body.length; index += 1) {
    const digit = BASE64_ALPHABET.indexOf(body[index]!);
    if (digit < 0) {
      throw captureError(RAW_FRAME_MALFORMED, 'raw-frame base64 contains a non-base64 character');
    }
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex] = (buffer >> bits) & 0xff;
      outIndex += 1;
    }
  }
  if (outIndex !== out.length) {
    throw captureError(RAW_FRAME_MALFORMED, 'raw-frame base64 decoded to an unexpected length');
  }
  return out;
}

/** The native surface this channel needs. Optional on purpose: see below. */
export interface NativeRawFrameModule {
  captureRawFrame(): Promise<unknown>;
  readRawFrame(token: string): Promise<string>;
  discardRawFrame(token: string): Promise<void>;
  discardAllRawFrames(): Promise<void>;
}

/**
 * Wrap a native module as a channel, or return `null` when the running build
 * has no raw-frame export at all.
 *
 * `null` is a first-class answer rather than a failure: an older native binary,
 * the simulator provider and a web bundle all genuinely cannot export a camera
 * frame, and a field session on one of them must still collect geometry. The
 * caller reports "no photograph was taken" on the receipt instead of failing
 * the participant — and, because the channel is absent rather than stubbed,
 * there is no object present that could later be mistaken for a working one.
 */
export function createRawFrameChannel(
  module: Partial<NativeRawFrameModule> | undefined | null,
): RawFrameChannel | null {
  if (
    !module ||
    typeof module.captureRawFrame !== 'function' ||
    typeof module.readRawFrame !== 'function' ||
    typeof module.discardRawFrame !== 'function' ||
    typeof module.discardAllRawFrames !== 'function'
  ) {
    return null;
  }
  const native = module as NativeRawFrameModule;
  return {
    async capture() {
      return toRawFrameHandle(await native.captureRawFrame());
    },
    async read(handle) {
      const bytes = decodeBase64(await native.readRawFrame(handle.token));
      // The slot could only have changed under us through a concurrent
      // discard or a second capture, either of which means these are not the
      // bytes the upload slot was signed for.
      if (bytes.byteLength !== handle.byteLength) {
        throw captureError(
          RAW_FRAME_BYTES_MISMATCH,
          `raw frame read back ${bytes.byteLength} bytes, declared ${handle.byteLength}`,
        );
      }
      return bytes;
    },
    async discard(handle) {
      await native.discardRawFrame(handle.token);
    },
    async discardAll() {
      await native.discardAllRawFrames();
    },
  };
}
