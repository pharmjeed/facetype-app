package ai.facetype.capture.quality

import kotlin.math.abs

/**
 * How far one frame is from a face at rest, from per-expression activations.
 *
 * WHY THIS IS THE SAME FUNCTION AS iOS. `FaceTypeCapture.swift` computes
 * neutrality from ARKit's blendshapes, and ADR-009 accepted that on the
 * grounds that blendshapes are "a documented, calibrated per-expression
 * activation set" — evidence that exists, over the whole face, rather than a
 * detector's confidence reinterpreted as a scene measurement. It rejected the
 * Android equivalent because the only thing available there was ML Kit's
 * `smilingProbability`: one classifier over the mouth, with no jaw, brow or
 * lip-pucker evidence behind it.
 *
 * MediaPipe's face-landmarker bundle carries a blendshape head that produces
 * the same *class* of evidence under the same category vocabulary, so the
 * honest thing is to run the identical estimator rather than invent a second
 * one. Two platforms computing neutrality two different ways would make the
 * number mean two different things while the gate treats it as one.
 * `tests/contract/test_native_projects.py` compares the two implementations'
 * keys and weights so they cannot drift apart silently. ADR-010 has the
 * evidence.
 *
 * WHAT IT IS NOT. Calibrated. The 0.85 gate these scores are compared against
 * is an engineering default that FT-03 §3 itself says must be re-fitted by the
 * benchmark harness, and nothing here changes that — on either platform. This
 * makes the measurement real; it does not make the threshold right.
 *
 * Expression is a nuisance variable to be measured and removed, never a
 * personality feature (FT-01 §15).
 */
internal object Neutrality {

  /**
   * The activations read, in the iOS order.
   *
   * Twelve of the fifty-two, chosen to span the regions FT-03 means by "at
   * rest": jaw, mouth (smile, frown, pucker), brow (inner raise, lowering),
   * eyes (squint) and cheeks. Every key is present in both ARKit's set and
   * MediaPipe's; the estimator abstains rather than skipping one that is not.
   */
  val EXPRESSIVE_ACTIVATIONS: List<String> = listOf(
    "jawOpen", "mouthSmileLeft", "mouthSmileRight", "browInnerUp",
    "mouthFrownLeft", "mouthFrownRight", "browDownLeft", "browDownRight",
    "eyeSquintLeft", "eyeSquintRight", "cheekPuff", "mouthPucker",
  )

  /**
   * The single loudest activation dominates the score, because one wide-open
   * jaw is not neutral however still the rest of the face is; the mean of the
   * activations that fired is the smaller term, so a face doing several small
   * things is not scored as if it were doing nothing. Both weights are
   * engineering defaults carried over from the iOS implementation.
   */
  const val PEAK_WEIGHT: Double = 0.7
  const val MEAN_WEIGHT: Double = 0.3

  /**
   * Scores [blendshapes], or returns `null` to abstain.
   *
   * Abstains — rather than substituting a default — when any activation it
   * reads is absent or outside `[0, 1]`. A missing key means the model that
   * produced this map is not the model this function was written against, and
   * scoring eleven activations as though the twelfth were zero would report a
   * more neutral face than the evidence supports. `null` reaches the client
   * and the server gates as `FT-SCAN-014`, which is the truthful answer.
   */
  fun score(blendshapes: Map<String, Float>): Double? {
    var peak = 0.0
    var presentTotal = 0.0
    var presentCount = 0
    for (key in EXPRESSIVE_ACTIVATIONS) {
      val raw = blendshapes[key]?.toDouble() ?: return null
      if (!raw.isFinite() || raw < 0.0 || raw > 1.0) return null
      val activation = abs(raw)
      if (activation > peak) peak = activation
      if (activation > 0.0) {
        presentTotal += activation
        presentCount += 1
      }
    }
    val mean = if (presentCount == 0) 0.0 else presentTotal / presentCount
    return (1.0 - (PEAK_WEIGHT * peak + MEAN_WEIGHT * mean)).coerceIn(0.0, 1.0)
  }
}
