/**
 * The client capture gate (docs/client-native-interface.md §1, docs/capture-spec-v2.md).
 *
 * ONE ARTIFACT, THREE READERS. The TypeScript guidance reads these numbers to
 * choose the message on screen; the native camera (Android and iOS) receives
 * the same object as JSON through the `gateConfig` view prop and applies it to
 * every frame it accepts; the server receives `gateConfigHash()` with every
 * capture and every frame's metadata. Native code must not hard-code a
 * threshold, and a second hand-written copy anywhere is how the three stop
 * agreeing.
 *
 * EVERY NUMBER CARRIES ITS PROVENANCE in `labels`:
 *   owner     — an owner decision (e.g. ten frames);
 *   research  — a rule used to build the standard, never tuned on results;
 *   default   — an engineering default, unvalidated, recorded with every frame;
 *   validated — measured by the pre-registered test (A7.78-B).
 *
 * THE HASH. SHA-256 (hex) of the canonical JSON: object keys sorted at every
 * depth, no whitespace, arrays in order, numbers as `JSON.stringify` writes
 * them. Python reproduces it with
 * `json.dumps(cfg, sort_keys=True, separators=(",", ":"))` as long as the
 * values stay ASCII and integral numbers stay integers. The hash is computed in
 * plain TypeScript because Hermes has no WebCrypto and this must be
 * synchronous (it is part of the props the camera is mounted with).
 */

export type ThresholdLabel = 'owner' | 'research' | 'default' | 'validated';

/**
 * The capture protocol named in every capture and every frame's
 * `protocol_version` (docs/client-native-interface.md §5.10).
 */
export const CLIENT_PROTOCOL_VERSION = 'capture-spec-v2';

export interface ClientGateConfig {
  version: 'client-gate-1';
  stream: {
    preferredSizes: [number, number][];
    minSize: [number, number];
    preferredMinFps: number;
    jpegQuality: number;
  };
  /** MediaPipe `numFaces`; any detected second face blocks storing. */
  faces: { maxFaces: 2 };
  pose: { enterDeg: number; exitDeg: number; rollMessageDeg: number };
  distance: { enterCm: [number, number]; exitCm: [number, number]; irisMm: number };
  /**
   * Face width = distance between MediaPipe landmarks 234 and 454 in
   * delivered-frame pixels. 220 px is the A7.78-B validated floor.
   */
  size: { minFaceWidthPx: number; preferredFaceWidthPx: number; maxFaceWidthFrac: number };
  centre: { eyeMidX: [number, number]; faceCentreY: [number, number]; edgeMarginFrac: number };
  light: { maxClipFrac: number; maxCrushFrac: number; cheekRatio: [number, number] };
  expression: { maxSmile: number; maxJawOpen: number };
  eyes: { maxBlink: number; minRelativeOpening: number };
  /**
   * Sharpness = contrast-normalised Laplacian energy of the central face crop
   * (Laplacian variance / intensity variance). Relative to the burst's sharpest
   * frame because an absolute floor rejected sharp originals in A7.78-B.
   */
  sharpness: { minRelativeToBurstMax: number };
  burst: {
    targetFrames: number;
    maxDurationMs: number;
    minSpacingMs: number;
    minCoverageMs: number;
    holdMs: number;
  };
  labels: Record<string, ThresholdLabel>;
}

export const CLIENT_GATE_CONFIG: ClientGateConfig = {
  version: 'client-gate-1',
  stream: {
    preferredSizes: [
      [3840, 2160],
      [1920, 1080],
    ],
    minSize: [1280, 720],
    preferredMinFps: 15,
    jpegQuality: 95,
  },
  faces: { maxFaces: 2 },
  pose: { enterDeg: 8, exitDeg: 12, rollMessageDeg: 15 },
  distance: { enterCm: [35, 60], exitCm: [32, 65], irisMm: 11.7 },
  size: { minFaceWidthPx: 220, preferredFaceWidthPx: 350, maxFaceWidthFrac: 0.7 },
  centre: { eyeMidX: [0.4, 0.6], faceCentreY: [0.35, 0.65], edgeMarginFrac: 0.05 },
  light: { maxClipFrac: 0.01, maxCrushFrac: 0.02, cheekRatio: [0.5, 2] },
  expression: { maxSmile: 0.3, maxJawOpen: 0.05 },
  eyes: { maxBlink: 0.5, minRelativeOpening: 0.7 },
  sharpness: { minRelativeToBurstMax: 0.5 },
  burst: { targetFrames: 10, maxDurationMs: 8000, minSpacingMs: 66, minCoverageMs: 1000, holdMs: 500 },
  labels: {
    'stream.preferredSizes': 'default',
    'stream.minSize': 'default',
    'stream.preferredMinFps': 'default',
    'stream.jpegQuality': 'default',
    'faces.maxFaces': 'default',
    'pose.enterDeg': 'default',
    'pose.exitDeg': 'default',
    'pose.rollMessageDeg': 'default',
    'distance.enterCm': 'default',
    'distance.exitCm': 'default',
    'distance.irisMm': 'default',
    'size.minFaceWidthPx': 'validated',
    'size.preferredFaceWidthPx': 'default',
    'size.maxFaceWidthFrac': 'default',
    'centre.eyeMidX': 'default',
    'centre.faceCentreY': 'default',
    'centre.edgeMarginFrac': 'default',
    'light.maxClipFrac': 'default',
    'light.maxCrushFrac': 'default',
    'light.cheekRatio': 'default',
    'expression.maxSmile': 'research',
    'expression.maxJawOpen': 'research',
    'eyes.maxBlink': 'default',
    'eyes.minRelativeOpening': 'default',
    'sharpness.minRelativeToBurstMax': 'default',
    'burst.targetFrames': 'owner',
    'burst.maxDurationMs': 'default',
    'burst.minSpacingMs': 'default',
    'burst.minCoverageMs': 'default',
    'burst.holdMs': 'default',
  },
};

/**
 * Canonical JSON: sorted keys at every depth, no whitespace.
 *
 * Throws on values JSON cannot represent faithfully (non-finite numbers,
 * functions, undefined inside arrays): a config that silently serialised to
 * `null` would hash differently from what native actually applies.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
}

/** The exact string handed to the native camera's `gateConfig` prop. */
export function gateConfigJson(config: ClientGateConfig = CLIENT_GATE_CONFIG): string {
  return canonicalJson(config);
}

/** SHA-256 hex of the canonical JSON of the gate config. */
export function gateConfigHash(config: ClientGateConfig = CLIENT_GATE_CONFIG): string {
  return sha256Hex(utf8(gateConfigJson(config)));
}

/** UTF-8 bytes of a string, without relying on a TextEncoder global. */
export function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** FIPS 180-4 SHA-256, synchronous, for inputs below 512 MiB. */
export function sha256Hex(bytes: Uint8Array): string {
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const length = bytes.length;
  const padded = new Uint8Array((((length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000), false);
  view.setUint32(padded.length - 4, (length * 8) >>> 0, false);

  const w = new Int32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getInt32(chunk + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0;
    h[1] = (h[1]! + b) | 0;
    h[2] = (h[2]! + c) | 0;
    h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0;
    h[5] = (h[5]! + f) | 0;
    h[6] = (h[6]! + g) | 0;
    h[7] = (h[7]! + hh) | 0;
  }
  return h.map((value) => (value >>> 0).toString(16).padStart(8, '0')).join('');
}
