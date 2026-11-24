/**
 * Capture provider contract — FT-01 §6.
 *
 * Mirrors `facetype_core.capture.base` exactly, so a provider's output is
 * already a `StandardFaceObservation` by the time it leaves the device.
 *
 * The most important property of this interface is what it omits.
 *
 * There is **no** method, field or option that reads a biometric template.
 * ARKit and ARCore expose face *geometry* to any app; Face ID and the Android
 * biometric subsystem expose nothing and live behind the Secure Enclave / TEE.
 * FT-00 §3 forbids even attempting to reach them, so this interface offers no
 * hook that a future implementer could mistake for one. `make security-scan`
 * fails the build if such an API appears anywhere in the tree.
 */

export const POSES = ['front', 'left_25', 'right_25', 'up_15', 'down_15'] as const;
export type PoseLabel = (typeof POSES)[number];

export type ProviderKind = 'arkit' | 'arcore' | 'mediapipe' | 'simulator';

export const CANONICAL_LANDMARK_TOPOLOGY = 'mediapipe-478' as const;
export const CANONICAL_TOPOLOGY_VERSION = 'mp478-v1' as const;

/** Angles the guided protocol asks for, in degrees (FT-03 §3). */
export const POSE_TARGETS: Record<PoseLabel, { yaw: number; pitch: number }> = {
  front: { yaw: 0, pitch: 0 },
  left_25: { yaw: 25, pitch: 0 },
  right_25: { yaw: -25, pitch: 0 },
  up_15: { yaw: 0, pitch: 15 },
  down_15: { yaw: 0, pitch: -15 },
};

/** Live quality signals shown during capture. Scores only — never pixels. */
export interface FrameQuality {
  /** Null means the provider did not measure this signal; quality gates fail closed. */
  blur: number | null;
  exposure: number | null;
  occlusion: number | null;
  neutrality: number | null;
  faceCount: number;
  yawDeg: number;
  pitchDeg: number;
}

/** One normalised observation, ready to upload. */
export interface StandardFaceObservation {
  observationId: string;
  source: ProviderKind;
  poseLabel: PoseLabel;
  timestampMs: number;
  /** The frozen device/wire/worker index contract. */
  landmarkTopology: typeof CANONICAL_LANDMARK_TOPOLOGY;
  topologyVersion: typeof CANONICAL_TOPOLOGY_VERSION;
  /** Version and integrity identity of the provider-to-canonical mapping. */
  topologyMappingVersion: string;
  topologyMappingSha256: string;
  /** Checksum of the reproducible mapping-provenance manifest — algorithm,
   * iris policy, coverage-fallback policy (audit P0-02 item 8;
   * `topologyManifest.ts`). Integrity is not accuracy: see that module. */
  topologyMappingManifestSha256: string;
  /** How much of the frozen 468-point target UV set this observation's own
   * mapping actually covered (audit P0-02 item 1/independent review of
   * 15d1fab) — diagnostic evidence carried alongside the geometry, not just
   * computed transiently during capture. */
  topologyCoverage: {
    coveredCount: number;
    targetCount: number;
    uncoveredTargetIndices: number[];
  };
  /** `coveredCount / targetCount`, 1.0 for a fully-covered mapping (the
   * MediaPipe passthrough and simulator paths). Diagnostic-only, never a
   * confidence-weighted average of raw landmark confidence. */
  topologyMappingConfidence: number;
  /** Largest UV-space gap between an uncovered target and the nearest source
   * vertex; 0 when `topologyCoverage.uncoveredTargetIndices` is empty. */
  maxUncoveredUvGap: number;
  /** Canonical indices represented by a geometric placeholder, never a measurement. */
  unavailableLandmarkIndices: number[];
  /** Flattened `[478, 3]` landmark coordinates in the provider's metric frame. */
  landmarks: Float32Array;
  landmarkConfidence: Float32Array;
  /** Row-major 4x4 rigid head transform. */
  headPose: Float32Array;
  blendshapes: Record<string, number>;
  quality: FrameQuality;
  /**
   * The acquisition capability profile this path declares (ADR-011).
   *
   * A *claim*, not a verdict. It says which FT-03 §3 signals this device
   * genuinely cannot measure, and the server resolves it against its own closed
   * (provider, profile) mapping before honouring any of it. Declaring one can
   * only ever reduce what this capture is trusted for.
   */
  declaredQualityProfile: string;
  /** The capability-artifact version this path claims to implement. */
  declaredProfileVersion: string;
  /** True only when the device reported trustworthy metric depth. */
  metricScaleReliable: boolean;
}

export interface CaptureCapabilities {
  kind: ProviderKind;
  metricScale: boolean;
  mesh: boolean;
  blendshapes: boolean;
  landmarkCount: number;
  requiresDeviceSupport: boolean;
  /** The profile this provider declares for every capture it produces. */
  qualityProfile: string;
  /** The capability-artifact version it implements. */
  qualityProfileVersion: string;
  /** FT-03 §3 signals this provider cannot measure. Empty for a full path. */
  unmeasuredSignals: readonly string[];
  notes: string;
}

export interface CaptureProvider {
  readonly kind: ProviderKind;
  capabilities(): CaptureCapabilities;
  isAvailable(): Promise<boolean>;
  start(): Promise<void>;
  /** Capture one pose. Rejects with an FT error code on a quality failure. */
  capture(pose: PoseLabel): Promise<StandardFaceObservation>;
  stop(): Promise<void>;
}

/**
 * Preference order from FT-01 §6: device metric geometry beats RGB inference,
 * and the simulator is last so it is only ever used when nothing real exists.
 */
export const PREFERENCE_ORDER: ProviderKind[] = ['arkit', 'arcore', 'mediapipe', 'simulator'];

export async function selectProvider(
  providers: CaptureProvider[],
): Promise<CaptureProvider | null> {
  const available: Partial<Record<ProviderKind, CaptureProvider>> = {};
  for (const provider of providers) {
    if (await provider.isAvailable()) available[provider.kind] = provider;
  }
  for (const kind of PREFERENCE_ORDER) {
    const provider = available[kind];
    if (provider) return provider;
  }
  return null;
}

/**
 * Serialise an observation for upload.
 *
 * Re-exported from `./wire.ts`, which owns the FTOB format definition. This
 * used to be a private binary layout that the worker could not read: it was
 * labelled `LANDMARKS_NPZ` and fed to `numpy.load`, which fails before any
 * geometry runs. Geometry only; no frame ever leaves the device.
 */
export { serialiseObservation } from './wire.ts';
