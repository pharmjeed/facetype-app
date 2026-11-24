/**
 * The FT-03 §3 quality gate, client side.
 *
 * WHY THIS EXISTS. The server re-runs the quality engine on every registered
 * observation, so a bad frame can never reach the pipeline. But "the server
 * will reject it" is not the same as "the client did not upload it": before
 * this module, the mobile app checked only that each quality signal was
 * *present*, so a frame with `blur = 0.01` and `occlusion = 0.99` was
 * serialised, uploaded and registered before anything looked at the numbers.
 * That wastes the user's data and, worse, replaces a precise "retake this
 * pose because it is blurred" with a round trip that ends in a generic
 * failure.
 *
 * THE ARTIFACT. [QUALITY_THRESHOLD_ARTIFACT] is the shared, versioned copy of
 * the numbers `facetype_core.quality.thresholds.QualityThresholds` holds. Its
 * keys are deliberately the Python field names, and `tests/contract/
 * test_quality_thresholds_shared.py` fails the build if either side drifts --
 * so there is one artifact with one version, not two hand-synchronised lists.
 *
 * These numbers are engineering defaults, not scientific findings; FT-03 says
 * so, and the benchmark harness re-tunes them. Never hard-code one at a call
 * site.
 */

/** One immutable quality-threshold artifact, mirroring the Python dataclass. */
export const QUALITY_THRESHOLD_ARTIFACT = {
  version: 'q-1.0.0',

  one_face_only: true,
  blur_min: 0.7,
  exposure_min: 0.65,
  occlusion_max: 0.15,
  neutrality_min: 0.85,
  landmark_confidence_min: 0.55,

  front_yaw_tolerance_deg: 8.0,
  front_pitch_tolerance_deg: 8.0,
  lateral_yaw_min_deg: 20.0,
  lateral_yaw_max_deg: 35.0,
  vertical_pitch_min_deg: 8.0,
  vertical_pitch_max_deg: 20.0,

  identity_consistency_min: 0.8,
  min_accepted_poses: 4,
  overall_quality_min: 0.72,
  cross_view_residual_max: 0.035,
} as const;

/**
 * Which FT-03 §3 signals an acquisition path may leave unmeasured.
 *
 * WHY THIS EXISTS. The Android capture path cannot measure `occlusion` — not
 * for want of implementing it, but because no dependency reachable from that
 * app produces the evidence, checked at the model-output level rather than
 * assumed (ADR-010). An unmeasured signal is `FT-SCAN-014`, so a real capture
 * on that handset could never complete. Rather than fabricate a number or never
 * ship a scan, the absence is declared in a versioned artifact, carried with
 * the data forever, and kept out of every lane where science is done.
 *
 * THIS IS THE CLIENT MIRROR, AND IT DECIDES NOTHING. The server resolves the
 * profile itself, from its own copy of this mapping, and never trusts the
 * declaration. What this copy buys is the same thing the threshold artifact
 * buys: the client refuses a frame the server would refuse, instead of spending
 * an upload to find out. `tests/contract/test_quality_profiles_shared.py` fails
 * the build if the two copies drift.
 *
 * A RECOGNISED DECLARATION IS NECESSARY AND NEVER SUFFICIENT. Four ways to be
 * refused, all resolving to `UNKNOWN`, which waives nothing and is eligible for
 * nothing: no declaration, an unrecognised name, a provider the artifact does
 * not grant it to, and a version that is not this artifact's. Passing that check
 * buys a capture nothing on its own — it must still measure everything and pass
 * every gate. See ADR-011.
 */
export const QUALITY_PROFILE_ARTIFACT = {
  version: 'qp-1.0.0',

  profiles: {
    FULL: {
      unmeasuredAllowed: [] as readonly string[],
      governedEligible: true,
      tier: 'FULL',
      limitationCodes: [] as readonly string[],
    },
    REDUCED_GEOMETRY_NO_OCCLUSION: {
      // One signal. A second entry here is a specification change.
      unmeasuredAllowed: ['occlusion'] as readonly string[],
      governedEligible: false,
      tier: 'REDUCED',
      limitationCodes: ['OCCLUSION_UNASSESSED'] as readonly string[],
    },
  },

  /**
   * The closed mapping. A profile is granted only to a provider listed here.
   *
   * `arcore` alone for the reduced profile: it is the pinned ARCore + ML Kit +
   * MediaPipe path whose inability to measure occlusion was actually
   * established. ARKit measures it — Vision reports which regions it localised
   * — so it has no business claiming the waiver.
   */
  providers: {
    arkit: ['FULL'] as readonly string[],
    arcore: ['FULL', 'REDUCED_GEOMETRY_NO_OCCLUSION'] as readonly string[],
    mediapipe: ['FULL'] as readonly string[],
    research_image: ['FULL'] as readonly string[],
    simulator: ['FULL'] as readonly string[],
  },
} as const;

/** A profile after resolution. Never a client's raw claim. */
export interface ResolvedQualityProfile {
  name: string;
  unmeasuredAllowed: readonly string[];
  /**
   * Whether a capture under this profile MAY be eligible for the governed
   * lanes. Necessary, never sufficient: every caller ANDs it with "nothing was
   * left unmeasured" and "every gate passed".
   */
  governedEligible: boolean;
  tier: 'FULL' | 'REDUCED';
  limitationCodes: readonly string[];
}

/**
 * What an undeclared, unknown or mis-provided declaration resolves to.
 *
 * Deliberately not `FULL`. It gates identically — every signal mandatory — but
 * is never eligible for governed use, because "we do not know what produced
 * this" is a different claim from "this was fully measured".
 */
const UNKNOWN_PROFILE: ResolvedQualityProfile = {
  name: 'UNKNOWN',
  unmeasuredAllowed: [],
  governedEligible: false,
  tier: 'FULL',
  limitationCodes: [],
};

/** Resolves a declaration against the closed mapping, or `UNKNOWN`. */
export function resolveQualityProfile(
  declared: string | null | undefined,
  provider: string,
  declaredVersion?: string | null,
): ResolvedQualityProfile {
  if (declared === null || declared === undefined) return UNKNOWN_PROFILE;
  // The version is not ceremony. It is the difference between "this payload
  // has a float under `occlusion`" and "this build implements qp-1.0.0's
  // definition of occlusion". A client predating the artifact can do the first
  // without the second, so an absent or wrong version is refused outright.
  if (declaredVersion !== QUALITY_PROFILE_ARTIFACT.version) return UNKNOWN_PROFILE;
  const allowed = (
    QUALITY_PROFILE_ARTIFACT.providers as Record<string, readonly string[] | undefined>
  )[provider];
  if (!allowed || !allowed.includes(declared)) return UNKNOWN_PROFILE;
  const profile = (
    QUALITY_PROFILE_ARTIFACT.profiles as Record<
      string,
      | {
          unmeasuredAllowed: readonly string[];
          governedEligible: boolean;
          tier: string;
          limitationCodes: readonly string[];
        }
      | undefined
    >
  )[declared];
  if (!profile) return UNKNOWN_PROFILE;
  return {
    name: declared,
    unmeasuredAllowed: profile.unmeasuredAllowed,
    governedEligible: profile.governedEligible,
    tier: profile.tier === 'REDUCED' ? 'REDUCED' : 'FULL',
    limitationCodes: profile.limitationCodes,
  };
}

/** Signals the client measures per frame. `null` means "not measured". */
export interface FrameQualitySignals {
  blur: number | null;
  exposure: number | null;
  occlusion: number | null;
  neutrality: number | null;
  faceCount: number | null;
  yawDeg: number;
  pitchDeg: number;
}

export interface FrameQualityVerdict {
  pass: boolean;
  /** Every gate this frame failed, in the engine's fixed evaluation order. */
  failures: string[];
  /** The code to report. `null` only when the frame passed. */
  primaryErrorCode: string | null;
  /** The artifact these gates came from, so a verdict can name its own rules. */
  qualityVersion: string;
  /** The resolved profile's name — `UNKNOWN` unless the mapping granted one. */
  qualityProfile: string;
  /** `REDUCED` when a signal was genuinely waived on this frame. */
  qualityTier: 'FULL' | 'REDUCED';
  /** Structured codes for signals left unmeasured. Never a score. */
  measurementLimitations: string[];
}

/** The signals a frame must actually carry a number for. */
type MeasuredSignal = 'faceCount' | 'blur' | 'exposure' | 'occlusion' | 'neutrality';

/**
 * Evaluates one frame against the artifact.
 *
 * The order of the checks is the contract, not an implementation detail:
 * `primaryErrorCode` is what the user is shown and what the retake prompt is
 * keyed on, so it has to be the same code the server would report for the same
 * frame. It matches `QualityEngine.evaluate_frame` statement for statement.
 */
export function evaluateFrameQuality(
  quality: FrameQualitySignals,
  poseLabel: string | null,
  meanLandmarkConfidence: number,
  /**
   * The profile this capture path declares, and the provider declaring it.
   *
   * Omitted, they resolve to `UNKNOWN` and the gate is strict — which is what
   * an older caller gets, and the right thing for one: a caller that has not
   * been taught about profiles has not been taught what it may leave out.
   */
  declaredProfile?: string | null,
  provider?: string,
  declaredProfileVersion?: string | null,
): FrameQualityVerdict {
  const thresholds = QUALITY_THRESHOLD_ARTIFACT;
  const failures: string[] = [];
  const limitations: string[] = [];
  const profile = resolveQualityProfile(declaredProfile, provider ?? '', declaredProfileVersion);

  const measured = (key: MeasuredSignal, unknownDefault: number): number => {
    const value = quality[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    // A WAIVER PERMITS EXACTLY ONE THING: the literal `null`.
    //
    // The profile grants permission to *say* a signal was not measured. It
    // grants no tolerance for a measurement that came back broken. `NaN`, an
    // infinity, an absent property and a value of some other type are what a
    // crashed estimator or a mismatched native build produces, and treating
    // them as an honest "not measured" would let real corruption enter the
    // pipeline wearing the waiver's clothes -- recorded as a limitation,
    // skipping the gate keyed on it, and passing. So they fail closed
    // whatever the profile says. `QualityEngine.evaluate_frame` draws the same
    // line, and `tests/contract/test_client_quality_gate_parity.py` keeps the
    // two honest.
    if (value === null && profile.unmeasuredAllowed.includes(key)) {
      // Recorded as an absence, never as a value. The default is returned
      // only so the caller below has something to compare; the gate keyed on
      // it is skipped, and the number never reaches a score.
      for (const code of profile.limitationCodes) {
        if (!limitations.includes(code)) limitations.push(code);
      }
      return unknownDefault;
    }
    // An unmeasured signal is one failure however many signals are missing:
    // the user is told the capture could not be assessed, once.
    if (!failures.includes('FT-SCAN-014')) failures.push('FT-SCAN-014');
    return unknownDefault;
  };

  const faceCount = measured('faceCount', 0);
  if (thresholds.one_face_only) {
    if (faceCount < 1) failures.push('FT-SCAN-005');
    else if (faceCount > 1) failures.push('FT-SCAN-004');
  }

  const blur = measured('blur', 0);
  if (blur < thresholds.blur_min) failures.push('FT-SCAN-006');

  const exposure = measured('exposure', 0);
  if (exposure < thresholds.exposure_min) {
    // Under- and over-exposure are different instructions to the user, and
    // the split point is the middle of the scale, not a threshold.
    failures.push(exposure < 0.5 ? 'FT-SCAN-007' : 'FT-SCAN-008');
  }

  const occlusion = measured('occlusion', 1);
  const occlusionUnmeasured = limitations.includes('OCCLUSION_UNASSESSED');
  if (!occlusionUnmeasured && occlusion > thresholds.occlusion_max) {
    failures.push('FT-SCAN-009');
  }

  const neutrality = measured('neutrality', 0);
  if (neutrality < thresholds.neutrality_min) failures.push('FT-SCAN-010');

  if (
    !Number.isFinite(meanLandmarkConfidence) ||
    meanLandmarkConfidence < thresholds.landmark_confidence_min
  ) {
    failures.push('FT-SCAN-014');
  }

  if (!poseWithinProtocol(quality, poseLabel)) failures.push('FT-SCAN-011');

  return {
    pass: failures.length === 0,
    failures,
    primaryErrorCode: failures[0] ?? null,
    qualityVersion: thresholds.version,
    qualityProfile: profile.name,
    // Derived from what was actually waived ON THIS FRAME, not from what
    // the profile is capable of waiving -- which is what the field's own
    // documentation says, and what `QualityEngine.evaluate_frame` does
    // (`profile.tier if limitations else QualityTier.FULL`). Falling back
    // to `profile.tier` made a fully measured ARCore frame report REDUCED
    // on the client and FULL on the server, for the same frame.
    qualityTier: limitations.length > 0 ? 'REDUCED' : 'FULL',
    measurementLimitations: limitations,
  };
}

/**
 * Checks the observed yaw/pitch against the band the protocol asks for.
 *
 * Hemisphere matters: a "left" capture that yawed right is a miss, not a
 * near-miss, because the reconstruction needs both sides.
 */
function poseWithinProtocol(quality: FrameQualitySignals, poseLabel: string | null): boolean {
  const t = QUALITY_THRESHOLD_ARTIFACT;
  if (poseLabel === null) return true;
  const yaw = quality.yawDeg;
  const pitch = quality.pitchDeg;
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return false;

  const within = (value: number, low: number, high: number): boolean => value >= low && value <= high;

  switch (poseLabel) {
    case 'front':
      return (
        within(Math.abs(yaw), 0, t.front_yaw_tolerance_deg) &&
        within(Math.abs(pitch), 0, t.front_pitch_tolerance_deg)
      );
    case 'left_25':
      return (
        yaw >= 0 &&
        within(Math.abs(yaw), t.lateral_yaw_min_deg, t.lateral_yaw_max_deg) &&
        within(Math.abs(pitch), 0, t.vertical_pitch_max_deg)
      );
    case 'right_25':
      return (
        yaw <= 0 &&
        within(Math.abs(yaw), t.lateral_yaw_min_deg, t.lateral_yaw_max_deg) &&
        within(Math.abs(pitch), 0, t.vertical_pitch_max_deg)
      );
    case 'up_15':
      return (
        pitch >= 0 &&
        within(Math.abs(pitch), t.vertical_pitch_min_deg, t.vertical_pitch_max_deg) &&
        within(Math.abs(yaw), 0, t.front_yaw_tolerance_deg * 2)
      );
    case 'down_15':
      return (
        pitch <= 0 &&
        within(Math.abs(pitch), t.vertical_pitch_min_deg, t.vertical_pitch_max_deg) &&
        within(Math.abs(yaw), 0, t.front_yaw_tolerance_deg * 2)
      );
    default:
      return true;
  }
}

/** Mean of a landmark-confidence vector, or 0 for an empty one. */
export function meanConfidence(confidence: ArrayLike<number>): number {
  if (confidence.length === 0) return 0;
  let total = 0;
  for (let index = 0; index < confidence.length; index += 1) total += confidence[index] ?? 0;
  return total / confidence.length;
}
