/**
 * The JS ↔ native client camera contract, typed exactly as
 * docs/client-native-interface.md §2–§4. Kept free of `react-native` imports
 * so guidance, spool and tests can use it under plain Node.
 *
 * Native owns frames, per-frame QA (unsmoothed, from the shared gate config),
 * JPEG encoding, burst selection, the encrypted spool and the uploads. TS owns
 * guidance and presentation; nothing here re-decides whether a frame is good.
 */

/** Per-frame, unsmoothed checks computed natively with the gate config. */
export interface FrameChecks {
  oneFace: boolean;
  distanceOrSize: boolean;
  centred: boolean;
  facing: boolean;
  light: boolean;
  expression: boolean;
  eyes: boolean;
  sharp: boolean;
}

/** `onFrameMeasure` payload, ≤ 15 Hz, for guidance only. */
export interface FrameMeasure {
  frameId: string;
  tsMs: number;
  faces: number;
  yaw: number;
  pitch: number;
  roll: number;
  interPupilPx: number;
  /** [x, y, w, h], normalised 0–1 to the delivered frame. */
  faceBox: [number, number, number, number];
  eyeMidX: number;
  faceCentreY: number;
  /** Landmarks 234↔454 distance in delivered-frame px. */
  faceWidthPx: number;
  /** An estimate (iris 11.7 mm + focal length); null when the focal length is unknown. */
  distanceCm: number | null;
  clipFrac: number;
  crushFrac: number;
  cheekRatio: number;
  smile: number;
  jawOpen: number;
  blinkL: number;
  blinkR: number;
  sharpness: number;
  gyroDegPerS: number;
  checks: FrameChecks;
  /** Sensor exposure time; null when unknown (§5.11). > 1/30 s → «اجعل الضوء أمامك». */
  exposureTimeNs: number | null;
}

export interface BurstProgress {
  accepted: number;
  target: number;
  elapsedMs: number;
  topRejectReason: string | null;
}

export type CameraErrorCode =
  | 'permission_denied'
  | 'camera_unavailable'
  | 'camera_interrupted'
  | 'model_unavailable'
  | 'effects_active'
  | 'internal';

export interface CameraError {
  code: CameraErrorCode;
  message: string;
}

export const CAMERA_ERROR_CODES: readonly CameraErrorCode[] = [
  'permission_denied',
  'camera_unavailable',
  'camera_interrupted',
  'model_unavailable',
  'effects_active',
  'internal',
];

export function toCameraError(value: unknown): CameraError {
  const record = (value ?? {}) as { code?: unknown; message?: unknown };
  const code = CAMERA_ERROR_CODES.includes(record.code as CameraErrorCode)
    ? (record.code as CameraErrorCode)
    : 'internal';
  return { code, message: typeof record.message === 'string' ? record.message : '' };
}

export interface CameraCapabilities {
  platform: 'android' | 'ios';
  deviceModel: string;
  manufacturer: string;
  osVersion: string;
  frontCamera: {
    id: string;
    sizes: [number, number][];
    focalLengthsMm: number[];
    sensorSizeMm: [number, number] | null;
    hasIntrinsicCalibration: boolean;
    distortionCorrection: 'on' | 'off' | 'unsupported';
  };
  mediapipeModelSha256: string;
}

export interface BurstOptions {
  targetFrames: number;
  maxDurationMs: number;
  minSpacingMs: number;
  minCoverageMs: number;
}

/** Stored server-side verbatim (snake_case keys, §4); opaque to JS. */
export type FrameMeta = Record<string, unknown>;

export interface BurstFrame {
  id: string;
  width: number;
  height: number;
  sha256: string;
  bytes: number;
  meta: FrameMeta;
}

export interface BurstResult {
  status: 'complete' | 'partial' | 'cancelled';
  topRejectReason: string | null;
  frames: BurstFrame[];
}

export interface UploadTarget {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
}

export interface SpoolEntry {
  id: string;
  bytes: number;
  createdAtMs: number;
}

/** `NativeModules.FaceTypeClientCamera`, identical on Android and iOS. */
export interface ClientCameraModule {
  getCapabilities(): Promise<CameraCapabilities>;
  startBurst(options: BurstOptions): Promise<BurstResult>;
  cancelBurst(): Promise<void>;
  /** Streams the decrypted JPEG with its exact Content-Length; retries are JS's job. */
  uploadFrame(id: string, target: UploadTarget): Promise<{ status: number }>;
  deleteFrames(ids: string[]): Promise<void>;
  listSpool(): Promise<SpoolEntry[]>;
}

/** `topRejectReason` values (§5.9): the check names plus two non-check reasons. */
export type RejectReason = keyof FrameChecks | 'effects_active' | 'internal';

/** Promise rejection codes of the native module (§5.9). */
export type NativeRejectionCode =
  | 'burst_in_progress'
  | 'invalid_argument'
  | 'not_found'
  | 'spool_unreadable'
  | 'spool_error'
  | 'upload_failed';

const REJECTION_CODES: readonly NativeRejectionCode[] = [
  'burst_in_progress',
  'invalid_argument',
  'not_found',
  'spool_unreadable',
  'spool_error',
  'upload_failed',
];

/** The contract code of a rejected native promise, or null for anything else. */
export function nativeErrorCode(error: unknown): NativeRejectionCode | null {
  const code = (error as { code?: unknown } | null)?.code;
  return REJECTION_CODES.includes(code as NativeRejectionCode) ? (code as NativeRejectionCode) : null;
}
