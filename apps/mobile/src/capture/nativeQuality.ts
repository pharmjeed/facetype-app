/**
 * Validation of the quality record a native capture module returns.
 *
 * WHY IT IS ITS OWN MODULE. `providers.ts` imports `react-native`, which a
 * plain Node test cannot load, so anything defined there can only be checked by
 * reading it. This rule is worth more than that: the *order* of its checks
 * decides which error code the user sees, and getting the order wrong is
 * invisible — the capture still fails, just with a less useful reason.
 *
 * THE BUG THIS FIXES. `raw.quality.faceCount !== 1` was folded into a single
 * `FT-SCAN-014` ("could not be measured"). But a detector that measured the
 * frame and found nobody, or found two people, has produced a *result*, and
 * `FT-SCAN-005` / `FT-SCAN-004` are the codes that tell the user to move into
 * frame or ask the other person to step out. Collapsing them threw away the
 * only actionable part of the answer.
 *
 * THE SECOND BUG THIS FIXES. This gate ran *before* `evaluateFrameQuality` and
 * knew nothing about quality profiles, so it demanded a number for every
 * signal unconditionally. The Android lane declares
 * `REDUCED_GEOMETRY_NO_OCCLUSION` and sends `occlusion: null` on purpose
 * (ADR-011), which meant every otherwise-perfect ARCore capture died here with
 * `FT-SCAN-014` before the approved waiver was ever consulted — a live blocker
 * on a Galaxy Tab S7: the scan silently returned to step 1 and nothing was
 * uploaded.
 *
 * IT IS NOT A BYPASS, AND IT OWNS NO POLICY. Which signals may be absent is
 * decided by `resolveQualityProfile` in the shared quality artifact — the same
 * function `evaluateFrameQuality` and (independently) the server use. This
 * module asks it; it does not carry its own copy of the mapping, so a profile
 * cannot be widened here without widening it for the server too. An absent,
 * unrecognised, wrong-provider or wrong-version declaration resolves to
 * `UNKNOWN`, which waives nothing, and this gate stays exactly as strict as it
 * was.
 */

import { resolveQualityProfile } from '@facetype/contracts';

import { captureError } from './captureError.ts';

/** The quality record shape a native module returns, before validation. */
export interface NativeQuality {
  blur: number | null;
  exposure: number | null;
  occlusion: number | null;
  neutrality: number | null;
  faceCount: number | null;
  yawDeg: number;
  pitchDeg: number;
}

const SCORES = ['blur', 'exposure', 'occlusion', 'neutrality'] as const;

/**
 * Throws a coded `CaptureError` unless every signal the resolved profile
 * requires is present and in range.
 *
 * The order matches `QualityEngine.evaluate_frame`: an unmeasured count is
 * `FT-SCAN-014`, a measured but wrong count is its own code, and only then are
 * the remaining signals considered.
 *
 * The declaration is the native module's own claim about what it can measure,
 * forwarded verbatim. It is resolved, never believed: everything after the
 * first argument is only ever able to *reduce* what this frame is trusted for,
 * and omitting it (an older caller) lands on `UNKNOWN` and the strict gate.
 *
 * WHAT A WAIVER PERMITS, EXACTLY. One thing: the literal `null`. A profile
 * grants permission to *say* a signal was not measured; it grants no tolerance
 * for a measurement that came back broken. `NaN`, an infinity, an absent
 * property and a value of some other type are not declarations of absence —
 * they are what a crashed estimator, an uninitialised buffer or a mismatched
 * native build produces, and under a waiver they would be indistinguishable
 * from an honest "I cannot measure this". So they are `FT-SCAN-014` whatever
 * the profile says. This matters more here than anywhere else in the app: the
 * `NativeQuality` type is erased at runtime, and what actually arrives is
 * whatever JSON the native bridge put on the wire.
 */
export function assertNativeQuality(
  quality: NativeQuality,
  declaredProfile?: string | null,
  provider?: string,
  declaredProfileVersion?: string | null,
): void {
  const profile = resolveQualityProfile(declaredProfile, provider ?? '', declaredProfileVersion);
  const waived = (signal: keyof NativeQuality): boolean =>
    profile.unmeasuredAllowed.includes(signal);
  /** The measurement this signal carries, or `null` if it carries none. */
  const measurement = (signal: keyof NativeQuality): number | null => {
    const raw = quality[signal];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  };
  /** Whether the module *declared* this signal unmeasured. Exactly `null`. */
  const declaredUnmeasured = (signal: keyof NativeQuality): boolean =>
    quality[signal] === null;

  if (measurement('faceCount') === null) {
    if (!declaredUnmeasured('faceCount')) {
      throw captureError('FT-SCAN-014', 'unusable quality signals: faceCount');
    }
    // The count keeps its priority whatever the profile says. If a profile ever
    // waived it, `QualityEngine.evaluate_frame` substitutes 0 and reports "no
    // face", so this reports the same thing rather than inventing a third
    // answer; today no profile in the artifact waives it, and this is the
    // strict `FT-SCAN-014` branch.
    if (!waived('faceCount')) {
      throw captureError('FT-SCAN-014', 'unmeasured quality signals: faceCount');
    }
    throw captureError('FT-SCAN-005', 'no face is visible in the captured frame');
  }
  const faceCount = measurement('faceCount') as number;
  if (faceCount < 1) {
    throw captureError('FT-SCAN-005', 'no face is visible in the captured frame');
  }
  if (faceCount > 1) {
    throw captureError('FT-SCAN-004', `${faceCount} faces are visible in the captured frame`);
  }

  // Broken before absent, and before the profile is consulted at all: a signal
  // that came back as `NaN` under a profile that waives it is not exercising
  // the waiver, and reporting it as "unmeasured" would file a bug as a policy.
  const unusable = SCORES.filter(
    (signal) => measurement(signal) === null && !declaredUnmeasured(signal),
  );
  if (unusable.length > 0) {
    throw captureError('FT-SCAN-014', `unusable quality signals: ${unusable.join(',')}`);
  }
  const missing = SCORES.filter((signal) => declaredUnmeasured(signal) && !waived(signal));
  if (missing.length > 0) {
    throw captureError('FT-SCAN-014', `unmeasured quality signals: ${missing.join(',')}`);
  }
  for (const signal of SCORES) {
    const score = measurement(signal);
    // `null` here is a waived signal the module declared absent, and there is
    // nothing to range-check. Everything else is already a finite number: a
    // profile grants permission not to measure something, never a licence to
    // send a number outside the scale and have it believed.
    if (score === null) continue;
    if (score < 0 || score > 1) {
      throw captureError('FT-SCAN-014', `${signal} is outside [0,1]`);
    }
  }
  // Pose angles are not waivable by any profile, so they are plain numbers or
  // the frame is not usable.
  if (!Number.isFinite(quality.yawDeg) || !Number.isFinite(quality.pitchDeg)) {
    throw captureError('FT-SCAN-014', 'native head pose angles are invalid');
  }
}
