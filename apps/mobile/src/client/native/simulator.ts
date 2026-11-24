/**
 * A camera that does not exist, for dev bundles and tests.
 *
 * Used only when `NativeModules.FaceTypeClientCamera` is absent. It emits
 * SYNTHETIC measures from a script (no face → too far → off-centre → ready)
 * and returns synthetic frames whose bytes are a fixed pattern — never an
 * image, never a face. Every synthetic frame's meta says `synthetic: true` and
 * `device_model: "simulator"` so a server can refuse it, and release bundles
 * never mount it (`clientCamera.ts`). It exists so the guidance, burst, upload
 * and verdict flow can be exercised end to end without hardware.
 */

import { gateConfigHash, sha256Hex } from '@facetype/contracts';

import type {
  BurstOptions,
  BurstResult,
  CameraCapabilities,
  ClientCameraModule,
  FrameMeasure,
  SpoolEntry,
  UploadTarget,
} from './types.ts';

const PASS_CHECKS = {
  oneFace: true,
  distanceOrSize: true,
  centred: true,
  facing: true,
  light: true,
  expression: true,
  eyes: true,
  sharp: true,
};

/** The scripted measure at `tMs` after the simulated camera started. */
export function syntheticMeasure(tMs: number, frame = 0): FrameMeasure {
  const base: FrameMeasure = {
    frameId: `sim-${frame}`,
    tsMs: tMs,
    faces: 1,
    yaw: 1,
    pitch: -1,
    roll: 0.5,
    interPupilPx: 120,
    faceBox: [0.3, 0.25, 0.4, 0.5],
    eyeMidX: 0.5,
    faceCentreY: 0.5,
    faceWidthPx: 380,
    distanceCm: 45,
    clipFrac: 0.002,
    crushFrac: 0.004,
    cheekRatio: 1.05,
    smile: 0.05,
    jawOpen: 0.01,
    blinkL: 0.1,
    blinkR: 0.1,
    sharpness: 0.8,
    gyroDegPerS: 2,
    exposureTimeNs: 1e9 / 60,
    checks: { ...PASS_CHECKS },
  };
  if (tMs < 1000) {
    return { ...base, faces: 0, faceWidthPx: 0, distanceCm: null, checks: { ...PASS_CHECKS, oneFace: false } };
  }
  if (tMs < 2500) {
    return {
      ...base,
      faceWidthPx: 150,
      distanceCm: 80,
      faceBox: [0.42, 0.35, 0.16, 0.22],
      checks: { ...PASS_CHECKS, distanceOrSize: false },
    };
  }
  if (tMs < 4000) {
    return {
      ...base,
      eyeMidX: 0.72,
      faceBox: [0.52, 0.25, 0.4, 0.5],
      checks: { ...PASS_CHECKS, centred: false },
    };
  }
  return base;
}

function syntheticBytes(seed: number): Uint8Array {
  const bytes = new Uint8Array(2048);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 13 + seed * 7) & 0xff;
  return bytes;
}

export interface SimulatorOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Frames to return per burst before reporting partial (default: all requested). */
  framesPerBurst?: number;
}

export class SimulatorClientCamera implements ClientCameraModule {
  readonly isSimulator = true;
  private readonly spool = new Map<string, { bytes: Uint8Array; createdAtMs: number }>();
  private readonly fetchImpl: typeof fetch | null;
  private readonly now: () => number;
  private readonly framesPerBurst: number | null;
  private counter = 0;
  private cancelled = false;

  constructor(options: SimulatorOptions = {}) {
    this.fetchImpl = options.fetch ?? (typeof fetch === 'function' ? fetch : null);
    this.now = options.now ?? (() => Date.now());
    this.framesPerBurst = options.framesPerBurst ?? null;
  }

  async getCapabilities(): Promise<CameraCapabilities> {
    return {
      platform: 'android',
      deviceModel: 'simulator',
      manufacturer: 'simulator',
      osVersion: 'simulator',
      frontCamera: {
        id: 'simulator-front',
        sizes: [[1920, 1080]],
        focalLengthsMm: [],
        sensorSizeMm: null,
        hasIntrinsicCalibration: false,
        distortionCorrection: 'unsupported',
      },
      mediapipeModelSha256: 'simulator',
    };
  }

  async startBurst(options: BurstOptions): Promise<BurstResult> {
    this.cancelled = false;
    const count = Math.min(options.targetFrames, this.framesPerBurst ?? options.targetFrames);
    if (this.cancelled) return { status: 'cancelled', topRejectReason: null, frames: [] };
    const hash = gateConfigHash();
    const frames = Array.from({ length: count }, () => {
      this.counter += 1;
      const id = `sim-frame-${this.counter}`;
      const bytes = syntheticBytes(this.counter);
      this.spool.set(id, { bytes, createdAtMs: this.now() });
      return {
        id,
        width: 1920,
        height: 1080,
        sha256: sha256Hex(bytes),
        bytes: bytes.length,
        meta: {
          synthetic: true,
          frame_id: id,
          device_model: 'simulator',
          device_manufacturer: 'simulator',
          gate_config_hash: hash,
          ts_wall_ms: this.now(),
        },
      };
    });
    return {
      status: count >= options.targetFrames ? 'complete' : 'partial',
      topRejectReason: count >= options.targetFrames ? null : 'facing',
      frames,
    };
  }

  async cancelBurst(): Promise<void> {
    this.cancelled = true;
  }

  async uploadFrame(id: string, target: UploadTarget): Promise<{ status: number }> {
    const entry = this.spool.get(id);
    if (!entry) throw new Error(`simulator spool has no frame ${id}`);
    if (!this.fetchImpl) return { status: 200 };
    const response = await this.fetchImpl(target.url, {
      method: target.method,
      headers: target.headers,
      // Dev-only: RN's fetch accepts an ArrayBuffer body for the PUT.
      body: entry.bytes.buffer as ArrayBuffer,
    });
    return { status: response.status };
  }

  async deleteFrames(ids: string[]): Promise<void> {
    for (const id of ids) this.spool.delete(id);
  }

  async listSpool(): Promise<SpoolEntry[]> {
    return [...this.spool.entries()].map(([id, entry]) => ({
      id,
      bytes: entry.bytes.length,
      createdAtMs: entry.createdAtMs,
    }));
  }
}
