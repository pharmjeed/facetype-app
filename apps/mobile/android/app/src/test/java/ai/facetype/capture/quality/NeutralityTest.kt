package ai.facetype.capture.quality

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the neutrality estimator will and will not put a number on.
 *
 * THE FAILURE THIS GUARDS AGAINST. Neutrality is gated at 0.85, and the gate
 * treats a missing signal and a low signal very differently: one is
 * `FT-SCAN-014` ("we could not assess this") and the other is `FT-SCAN-010`
 * ("hold a neutral expression"). An estimator that quietly treated an absent
 * activation as zero would turn the first into a *passing* score — the most
 * expensive possible bug here, because it does not fail, it succeeds wrongly.
 * Every test below is about that boundary rather than about the arithmetic.
 *
 * The arithmetic itself is deliberately not re-derived here. It is asserted
 * against the iOS implementation, key for key and weight for weight, by
 * `tests/contract/test_native_projects.py::test_both_platforms_score_neutrality_the_same_way`
 * — a duplicate expected-value table in this file would drift from Swift
 * without anything noticing.
 */
class NeutralityTest {

  @Test
  fun `a face at rest scores at the top of the scale`() {
    val score = Neutrality.score(RESTING_ACTIVATIONS)
    assertNotNull(score)
    assertEquals(1.0, score!!, 1e-9)
  }

  @Test
  fun `a wide-open jaw is not neutral, however still the rest of the face is`() {
    val score = Neutrality.score(activationsWith("jawOpen", 1.0f))
    assertNotNull(score)
    // 1 - (0.7 * 1.0 + 0.3 * 1.0), the single activation being the only one
    // present: the peak term is what keeps one loud expression decisive.
    assertEquals(0.0, score!!, 1e-9)
    assertTrue("a fully open jaw must fail the 0.85 gate", score < 0.85)
  }

  @Test
  fun `a missing activation abstains rather than counting as zero`() {
    for (key in Neutrality.EXPRESSIVE_ACTIVATIONS) {
      val incomplete = RESTING_ACTIVATIONS - key
      assertNull(
        "$key is absent, so the face may or may not be at rest -- there is no " +
          "score to report, and reporting one would be a pass invented from a gap",
        Neutrality.score(incomplete),
      )
    }
  }

  @Test
  fun `an activation outside the unit range abstains`() {
    for (value in listOf(-0.01f, 1.01f, Float.NaN, Float.POSITIVE_INFINITY)) {
      assertNull(
        "$value is not an activation this estimator was written against",
        Neutrality.score(activationsWith("mouthPucker", value)),
      )
    }
  }

  @Test
  fun `an empty map abstains`() {
    assertNull(Neutrality.score(emptyMap()))
  }

  @Test
  fun `categories the estimator does not read never change the score`() {
    val withExtras = RESTING_ACTIVATIONS +
      mapOf("tongueOut" to 1.0f, "noseSneerLeft" to 0.9f, "eyeLookUpRight" to 0.5f)
    assertEquals(Neutrality.score(RESTING_ACTIVATIONS), Neutrality.score(withExtras))
  }

  @Test
  fun `every score it does report is inside the gated range`() {
    // The gate compares against a [0, 1] threshold; a score outside that range
    // would be compared anyway, silently.
    for (key in Neutrality.EXPRESSIVE_ACTIVATIONS) {
      for (value in listOf(0f, 0.13f, 0.5f, 0.87f, 1f)) {
        val score = Neutrality.score(activationsWith(key, value))
        assertNotNull(score)
        assertTrue("$key=$value scored $score", score!! >= 0.0 && score <= 1.0)
      }
    }
  }

  @Test
  fun `a louder expression always scores less neutral`() {
    var previous = Double.MAX_VALUE
    for (value in listOf(0f, 0.2f, 0.4f, 0.6f, 0.8f, 1f)) {
      val score = Neutrality.score(activationsWith("mouthSmileLeft", value))!!
      assertTrue("$value scored $score, not below the previous $previous", score < previous)
      previous = score
    }
  }

  @Test
  fun `KNOWN QUIRK - adding a quieter activation raises the score`() {
    // NOT an endorsement. This documents a real property of the estimator this
    // repository already ships on iOS, which this file reproduces deliberately:
    // the mean term averages only the activations that FIRED, so a second,
    // smaller activation pulls that average down and the face is scored as more
    // at rest than when it was doing strictly less.
    //
    // It is bounded -- the 0.7 peak term still dominates, so no amount of small
    // activations rescues a loud one -- and the effect is well inside the
    // uncalibrated band the 0.85 gate already sits in. It is recorded here
    // rather than fixed because the fix (averaging over all twelve activations,
    // which makes the score monotone) would change what neutrality means on
    // iOS as well, and this lane is not authorised to move an accepted iOS
    // number. Raised with Codex in the F1 handoff.
    val loudAlone = Neutrality.score(activationsWith("jawOpen", 0.6f))!!
    val loudPlusQuiet = Neutrality.score(
      RESTING_ACTIVATIONS + mapOf("jawOpen" to 0.6f, "cheekPuff" to 0.2f),
    )!!
    assertTrue(
      "the quirk has changed shape: alone=$loudAlone, with a quieter one=$loudPlusQuiet",
      loudPlusQuiet > loudAlone,
    )
    // The bound that keeps it harmless: the peak term alone already fails the
    // gate, so the quirk cannot turn an expressive face into a passing one.
    assertTrue(loudPlusQuiet < QUALITY_NEUTRALITY_MIN)
  }

  private companion object {
    /** `QUALITY_THRESHOLD_ARTIFACT.neutrality_min`, restated for one assertion. */
    const val QUALITY_NEUTRALITY_MIN = 0.85
  }
}
