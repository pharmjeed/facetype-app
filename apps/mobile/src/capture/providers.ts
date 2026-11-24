/**
 * Concrete capture providers.
 *
 * `NativeGeometryProvider` bridges to the ARKit (Swift) and ARCore (Kotlin)
 * modules. `SimulatorCaptureProvider` produces deterministic synthetic geometry
 * so the whole flow — including CI, where no camera exists — runs end to end
 * (FT-00 §4: a native camera that cannot run in CI must never block the build).
 */

import { NativeModules, Platform } from 'react-native';

import { QUALITY_PROFILE_ARTIFACT } from '@facetype/contracts';

import {
  CANONICAL_LANDMARK_TOPOLOGY,
  CANONICAL_TOPOLOGY_VERSION,
  type CaptureCapabilities,
  type CaptureProvider,
  type PoseLabel,
  POSE_TARGETS,
  type ProviderKind,
  type StandardFaceObservation,
} from './types.ts';
import {
  LANDMARK_COUNT,
  mapToMediaPipe478,
  TOPOLOGY_MAPPING_SHA256,
  TOPOLOGY_MAPPING_VERSION,
} from './topology.ts';
import { isFiniteRowMajorAffine, isRightHandedRigidRotation } from './coordinateContract.ts';
import { captureError } from './captureError.ts';
import { assertNativeQuality } from './nativeQuality.ts';
import { requireNativeCaptureModule } from './nativeModule.ts';
import { TOPOLOGY_MAPPING_MANIFEST_SHA256 } from './topologyManifest.ts';

interface NativeCaptureModule {
  isAvailable(): Promise<boolean>;
  start(): Promise<void>;
  captureGeometry(pose: string): Promise<{
    observationId: string;
    landmarkTopology: 'arkit-face-geometry' | 'arcore-face-mesh-468';
    topologyVersion: string;
    landmarks: number[];
    landmarkConfidence: number[];
    textureCoordinates: number[];
    triangleIndices: number[];
    headPose: number[];
    blendshapes: Record<string, number>;
    quality: {
      blur: number | null;
      exposure: number | null;
      occlusion: number | null;
      neutrality: number | null;
      faceCount: number | null;
      yawDeg: number;
      pitchDeg: number;
    };
    /**
     * Which FT-03 §3 signals this native path can measure (ADR-011).
     *
     * Optional in the type on purpose: an older native module that predates
     * the profile mechanism returns nothing here, and must land on the strict
     * `UNKNOWN` resolution rather than be assumed full.
     */
    qualityProfile?: string;
    qualityProfileVersion?: string;
    metricScaleReliable: boolean;
  }>;
  stop(): Promise<void>;
}

/**
 * Bridge to the platform face-geometry module.
 *
 * The native side calls only the public AR geometry APIs. It never touches
 * LocalAuthentication, the Secure Enclave or BiometricPrompt — see the module
 * headers in `ios/` and `android/`, which say so explicitly.
 */
export class NativeGeometryProvider implements CaptureProvider {
  readonly kind: 'arkit' | 'arcore';
  private readonly module: NativeCaptureModule | undefined;

  constructor(kind: 'arkit' | 'arcore') {
    this.kind = kind;
    this.module = (NativeModules as Record<string, NativeCaptureModule | undefined>)
      .FaceTypeCapture;
  }

  capabilities(): CaptureCapabilities {
    return {
      kind: this.kind,
      metricScale: true,
      mesh: true,
      // Both platforms now report per-expression activations: ARKit's own
      // blendshapes on iOS, MediaPipe's face-landmarker blendshape head on
      // Android (ADR-010). The flag says the payload carries them, not that the
      // two sets were produced by the same model.
      blendshapes: true,
      landmarkCount: LANDMARK_COUNT,
      requiresDeviceSupport: true,
      // ARKit measures all five FT-03 §3 signals; ARCore cannot measure
      // occlusion and says so rather than inventing one (ADR-010/ADR-011).
      qualityProfile:
        this.kind === 'arkit' ? 'FULL' : 'REDUCED_GEOMETRY_NO_OCCLUSION',
      qualityProfileVersion: QUALITY_PROFILE_ARTIFACT.version,
      unmeasuredSignals: this.kind === 'arkit' ? [] : ['occlusion'],
      notes:
        this.kind === 'arkit'
          ? 'ARKit face geometry on TrueDepth-capable devices. Never touches Face ID.'
          : 'REDUCED: ARCore geometry, on-device ML Kit blur/exposure/face-count and ' +
            'MediaPipe blendshape neutrality. Occlusion is NOT assessed on this ' +
            'device; captures are usable geometry but are never eligible for ' +
            'Gold Anchors, training, validation, promotion or inference. ' +
            'Never touches BiometricPrompt.',
    };
  }

  async isAvailable(): Promise<boolean> {
    if (!this.module) return false;
    const expected = Platform.OS === 'ios' ? 'arkit' : 'arcore';
    if (this.kind !== expected) return false;
    try {
      return await this.module.isAvailable();
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    await requireNativeCaptureModule(this.module).start();
  }

  async capture(pose: PoseLabel): Promise<StandardFaceObservation> {
    const raw = await requireNativeCaptureModule(this.module).captureGeometry(pose);
    const expectedTopology =
      this.kind === 'arkit' ? 'arkit-face-geometry' : 'arcore-face-mesh-468';
    if (raw.landmarkTopology !== expectedTopology) {
      throw captureError(
        'FT-REC-006',
        `${this.kind} returned unexpected topology ${raw.landmarkTopology}`,
      );
    }
    // Profile-aware, and only in the reducing direction. The native module's
    // own declaration is forwarded verbatim -- `?? ''` rather than a default, so
    // a module that says nothing resolves to UNKNOWN and gets the strict gate
    // instead of being assumed to implement whatever this JavaScript expects.
    // `this.kind` is the provider the closed mapping is keyed on, and it is
    // this object's own identity, not anything the native side can assert: an
    // ARKit module cannot claim ARCore's occlusion waiver by saying so.
    assertNativeQuality(
      raw.quality,
      raw.qualityProfile ?? '',
      this.kind,
      raw.qualityProfileVersion ?? '',
    );
    // Coordinate/units/matrix-layout contract at the provider boundary (audit
    // P0-02 item 2). This is the one place a native bridge's numbers become a
    // `StandardFaceObservation`, so the contract is enforced, not assumed:
    //   - matrix layout: row-major 4x4, so the bottom row is [0,0,0,1] and
    //     translation lives in the last COLUMN (indices 3/7/11) — the same
    //     convention Android's `FaceGeometryMath.toRowMajorMillimeters` and
    //     Python's `remove_head_pose` (`pose[:3, 3]`) both assume.
    //   - units: millimetres. Native bridges convert their metre-scale SDK
    //     output before this point (`* 1000` / `* 1000f`); nothing here
    //     re-scales, so a bridge that forgot the conversion is caught only by
    //     the coordinate-contract regression tests, never silently corrected.
    //   - handedness/axis identity across ARKit vs. ARCore vs. the canonical
    //     MediaPipe frame is UNVERIFIED here and anywhere else in this
    //     repository: no physical device capture or vendor documentation has
    //     been used to confirm the three coordinate frames agree. `topology.ts`
    //     copies provider XYZ through its barycentric mapping unchanged (no
    //     axis swap, no sign flip, no UV V-flip), which is a stated,
    //     explicitly unverified assumption pending real-device evidence, not
    //     a verified equivalence (P0-02 stays PARTIAL for exactly this reason).
    if (!isFiniteRowMajorAffine(raw.headPose)) {
      throw captureError('FT-REC-006', 'native head pose is not a finite row-major affine matrix');
    }
    // Independent review of 15d1fab: shape/affine-ness alone does not rule
    // out a reflected or scaled rotation block, which would silently corrupt
    // pose removal and everything downstream of it.
    if (!isRightHandedRigidRotation(raw.headPose)) {
      throw captureError(
        'FT-REC-006',
        'native head pose rotation is not a right-handed rigid rotation ' +
          '(orthonormal, determinant +1)',
      );
    }
    const mapped = mapToMediaPipe478(raw);
    if (
      mapped.landmarks.length !== LANDMARK_COUNT * 3 ||
      mapped.landmarkConfidence.length !== LANDMARK_COUNT
    ) {
      throw captureError('FT-REC-006', `topology adapter did not produce ${LANDMARK_COUNT} points`);
    }
    return {
      observationId: raw.observationId,
      source: this.kind,
      poseLabel: pose,
      timestampMs: Date.now(),
      landmarkTopology: mapped.landmarkTopology,
      topologyVersion: mapped.topologyVersion,
      topologyMappingVersion: mapped.topologyMappingVersion,
      topologyMappingSha256: mapped.topologyMappingSha256,
      topologyMappingManifestSha256: TOPOLOGY_MAPPING_MANIFEST_SHA256,
      topologyCoverage: {
        coveredCount: mapped.coverage.coveredCount,
        targetCount: mapped.coverage.targetCount,
        uncoveredTargetIndices: mapped.coverage.uncoveredTargetIndices,
      },
      topologyMappingConfidence: mapped.coverage.coveredCount / mapped.coverage.targetCount,
      maxUncoveredUvGap: mapped.maxUncoveredUvGap,
      unavailableLandmarkIndices: mapped.unavailableLandmarkIndices,
      landmarks: mapped.landmarks,
      landmarkConfidence: mapped.landmarkConfidence,
      headPose: Float32Array.from(raw.headPose),
      blendshapes: raw.blendshapes,
      quality: {
        blur: raw.quality.blur,
        exposure: raw.quality.exposure,
        occlusion: raw.quality.occlusion,
        neutrality: raw.quality.neutrality,
        faceCount: raw.quality.faceCount!,
        yawDeg: raw.quality.yawDeg,
        pitchDeg: raw.quality.pitchDeg,
      },
      // The native module's own word for what it can measure, forwarded
      // verbatim. `?? ''` rather than a default profile: a module that says
      // nothing must resolve to UNKNOWN and gate strictly, not be assumed to
      // match whatever this build of the JavaScript expects of it.
      declaredQualityProfile: raw.qualityProfile ?? '',
      // `?? ''` again: a native module that says nothing must be refused, not
      // assumed to implement whatever version this JavaScript was built
      // against. That assumption is the exact thing the version check exists
      // to prevent.
      declaredProfileVersion: raw.qualityProfileVersion ?? '',
      metricScaleReliable: raw.metricScaleReliable,
    };
  }

  async stop(): Promise<void> {
    await requireNativeCaptureModule(this.module).stop();
  }
}

/**
 * Deterministic synthetic capture.
 *
 * Backs CI, the simulator build and the manual QA flow. The geometry is
 * procedurally generated and corresponds to no person.
 */
export class SimulatorCaptureProvider implements CaptureProvider {
  readonly kind: ProviderKind = 'simulator';

  constructor(private readonly subjectKey: string = 'sim-000001') {}

  capabilities(): CaptureCapabilities {
    return {
      kind: 'simulator',
      metricScale: false,
      mesh: false,
      blendshapes: true,
      landmarkCount: LANDMARK_COUNT,
      requiresDeviceSupport: false,
      qualityProfile: 'FULL',
      qualityProfileVersion: QUALITY_PROFILE_ARTIFACT.version,
      unmeasuredSignals: [],
      notes: 'Synthetic geometry; never a real person.',
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async start(): Promise<void> {}

  async capture(pose: PoseLabel): Promise<StandardFaceObservation> {
    // A small deterministic PRNG keeps a subject's geometry stable across
    // captures, so the identity-consistency check behaves as it would live.
    const seed = hash(`${this.subjectKey}:${pose}`);
    const random = mulberry32(seed);
    const target = POSE_TARGETS[pose];

    const landmarks = new Float32Array(LANDMARK_COUNT * 3);
    const confidence = new Float32Array(LANDMARK_COUNT);
    const yaw = (target.yaw * Math.PI) / 180;
    const pitch = (target.pitch * Math.PI) / 180;

    for (let index = 0; index < LANDMARK_COUNT; index += 1) {
      const angle = (index / LANDMARK_COUNT) * Math.PI * 2;
      const radius = 40 + 30 * Math.cos(angle * 3);
      const x = radius * Math.cos(angle);
      const y = radius * Math.sin(angle) - 20;
      const z = 20 * Math.cos(angle * 2);

      const rx = x * Math.cos(yaw) + z * Math.sin(yaw);
      const rz = -x * Math.sin(yaw) + z * Math.cos(yaw);
      const ry = y * Math.cos(pitch) - rz * Math.sin(pitch);

      landmarks[index * 3] = rx + (random() - 0.5) * 0.6;
      landmarks[index * 3 + 1] = ry + (random() - 0.5) * 0.6;
      landmarks[index * 3 + 2] = rz + 320 + (random() - 0.5) * 0.6;
      confidence[index] = 0.9 + random() * 0.09;
    }

    const headPose = Float32Array.from([
      Math.cos(yaw), 0, Math.sin(yaw), 0,
      0, 1, 0, 0,
      -Math.sin(yaw), 0, Math.cos(yaw), 320,
      0, 0, 0, 1,
    ]);

    return {
      observationId: `obs_sim_${pose}_${Date.now()}`,
      source: 'simulator',
      poseLabel: pose,
      timestampMs: Date.now(),
      landmarkTopology: CANONICAL_LANDMARK_TOPOLOGY,
      topologyVersion: CANONICAL_TOPOLOGY_VERSION,
      topologyMappingVersion: TOPOLOGY_MAPPING_VERSION,
      topologyMappingSha256: TOPOLOGY_MAPPING_SHA256,
      topologyMappingManifestSha256: TOPOLOGY_MAPPING_MANIFEST_SHA256,
      // Synthetic geometry is generated directly on the canonical topology
      // (no native-provider mapping is needed), so coverage is complete by
      // construction — the same as the MediaPipe RGB passthrough branch in
      // `mapToMediaPipe478`.
      // 468, not LANDMARK_COUNT (478): `targetCount` counts the frozen
      // target UV set the mapping algorithm covers, matching the `coverage`
      // shape `mapToMediaPipe478` itself returns (see topology.ts).
      topologyCoverage: { coveredCount: 468, targetCount: 468, uncoveredTargetIndices: [] },
      topologyMappingConfidence: 1,
      maxUncoveredUvGap: 0,
      unavailableLandmarkIndices: [],
      landmarks,
      landmarkConfidence: confidence,
      headPose,
      blendshapes: { jawOpen: 0.01, mouthSmileLeft: 0.01 },
      quality: {
        blur: 0.93,
        exposure: 0.9,
        occlusion: 0.02,
        neutrality: 0.98,
        faceCount: 1,
        yawDeg: target.yaw,
        pitchDeg: target.pitch,
      },
      declaredQualityProfile: 'FULL',
      declaredProfileVersion: QUALITY_PROFILE_ARTIFACT.version,
      metricScaleReliable: false,
    };
  }

  async stop(): Promise<void> {}
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Providers in preference order for the current platform. */
export function defaultProviders(allowSimulator = __DEV__): CaptureProvider[] {
  const providers: CaptureProvider[] = [
    new NativeGeometryProvider(Platform.OS === 'ios' ? 'arkit' : 'arcore'),
  ];
  if (allowSimulator) providers.push(new SimulatorCaptureProvider());
  return providers;
}
