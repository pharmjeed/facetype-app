package ai.facetype.client

import ai.facetype.client.ClientFixtures.goodGeometry
import ai.facetype.client.ClientFixtures.goodMeasurement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FrameChecksTest {
  private val config = ClientFixtures.config

  private fun checks(m: FrameMeasurement) = FrameCheckEvaluator.evaluate(m, config)

  @Test
  fun `a frontal neutral well-lit face passes every check`() {
    val c = checks(goodMeasurement())
    assertTrue(c.toString(), c.allPass)
    assertNull(c.firstFailure())
  }

  @Test
  fun `no face fails everything and a detected second face fails oneFace`() {
    val none = checks(goodMeasurement(faces = 0, geometry = null))
    assertEquals(FrameChecks.NONE_PASS, none)
    assertEquals(FrameChecks.REASON_ONE_FACE, none.firstFailure())

    val two = checks(goodMeasurement(faces = 2))
    assertFalse(two.oneFace)
    assertFalse(two.allPass)
    // The other checks are still measured on the primary face, for guidance.
    assertTrue(two.facing && two.light && two.expression)
    assertEquals(FrameChecks.REASON_ONE_FACE, two.firstFailure())
  }

  @Test
  fun `face size is checked always, distance only when the focal length is known`() {
    // 219 px < 220 px floor (validated A7.78-B).
    assertFalse(checks(goodMeasurement(geometry = goodGeometry(faceWidthPx = 219.0))).distanceOrSize)
    assertTrue(checks(goodMeasurement(geometry = goodGeometry(faceWidthPx = 220.0))).distanceOrSize)
    // Wider than 70% of the 1080 px frame.
    assertFalse(checks(goodMeasurement(geometry = goodGeometry(faceWidthPx = 760.0))).distanceOrSize)
    // Size passes, distance out of the enter range.
    assertFalse(checks(goodMeasurement(distanceCm = 30.0)).distanceOrSize)
    assertFalse(checks(goodMeasurement(distanceCm = 61.0)).distanceOrSize)
    assertTrue(checks(goodMeasurement(distanceCm = 35.0)).distanceOrSize)
    // Focal known but the distance could not be estimated: fails, never assumed.
    assertFalse(checks(goodMeasurement(distanceCm = null)).distanceOrSize)
    // Focal unknown: size alone decides.
    assertTrue(checks(goodMeasurement(focalKnown = false, distanceCm = null)).distanceOrSize)
    assertFalse(
      checks(
        goodMeasurement(focalKnown = false, distanceCm = null, geometry = goodGeometry(faceWidthPx = 150.0)),
      ).distanceOrSize,
    )
  }

  @Test
  fun `centring uses eye midpoint, face centre and the edge margin`() {
    assertFalse(checks(goodMeasurement(geometry = goodGeometry(eyeMidX = 0.39))).centred)
    assertFalse(checks(goodMeasurement(geometry = goodGeometry(faceCentreY = 0.66))).centred)
    // Box reaching within 5% of the left edge.
    assertFalse(
      checks(goodMeasurement(geometry = goodGeometry(faceBox = doubleArrayOf(0.04, 0.3, 0.4, 0.35)))).centred,
    )
    assertFalse(
      checks(goodMeasurement(geometry = goodGeometry(faceBox = doubleArrayOf(0.3, 0.3, 0.4, Double.NaN)))).centred,
    )
  }

  @Test
  fun `facing gates yaw and pitch at the enter limit, never roll`() {
    assertTrue(checks(goodMeasurement(geometry = goodGeometry(yaw = 8.0, pitch = -8.0))).facing)
    assertFalse(checks(goodMeasurement(geometry = goodGeometry(yaw = 8.01))).facing)
    assertFalse(checks(goodMeasurement(geometry = goodGeometry(pitch = -9.0))).facing)
    assertFalse(checks(goodMeasurement(geometry = goodGeometry(yaw = Double.NaN))).facing)
  }

  @Test
  fun `light limits clip, crush and cheek ratio`() {
    assertFalse(checks(goodMeasurement(clip = 0.011)).light)
    assertFalse(checks(goodMeasurement(crush = 0.021)).light)
    assertFalse(checks(goodMeasurement(cheek = 2.01)).light)
    assertFalse(checks(goodMeasurement(cheek = 0.49)).light)
    assertFalse(checks(goodMeasurement(cheek = null)).light)
    assertTrue(checks(goodMeasurement(clip = 0.01, crush = 0.02, cheek = 0.5)).light)
  }

  @Test
  fun `expression is max(smileL, smileR) at most 0_3 and jawOpen at most 0_05`() {
    assertTrue(checks(goodMeasurement(smile = 0.3, jaw = 0.05)).expression)
    assertFalse(checks(goodMeasurement(smile = 0.31)).expression)
    assertFalse(checks(goodMeasurement(jaw = 0.051)).expression)
    assertFalse(checks(goodMeasurement(smile = null)).expression)
    assertFalse(checks(goodMeasurement(jaw = Double.NaN)).expression)
  }

  @Test
  fun `missing or non-finite eye scores fail, never count as zero`() {
    assertFalse(checks(goodMeasurement(blinkL = 0.51)).eyes)
    assertFalse(checks(goodMeasurement(blinkR = 0.9)).eyes)
    assertTrue(checks(goodMeasurement(blinkL = 0.5, blinkR = 0.5)).eyes)
    assertFalse(checks(goodMeasurement(blinkL = null)).eyes)
    assertFalse(checks(goodMeasurement(blinkR = Double.NaN)).eyes)
    assertFalse(checks(goodMeasurement(geometry = goodGeometry(openingL = null))).eyes)
    assertFalse(checks(goodMeasurement(geometry = goodGeometry(openingR = 0.0))).eyes)
  }

  @Test
  fun `sharpness has no absolute floor per frame but must be measurable`() {
    assertTrue(checks(goodMeasurement(sharpness = 0.001)).sharp)
    assertFalse(checks(goodMeasurement(sharpness = null)).sharp)
    assertFalse(checks(goodMeasurement(sharpness = Double.NaN)).sharp)
    assertFalse(checks(goodMeasurement(sharpness = 0.0)).sharp)
  }

  @Test
  fun `the first failure follows guidance priority`() {
    val c = checks(goodMeasurement(smile = 0.9, clip = 0.5, geometry = goodGeometry(yaw = 20.0)))
    assertEquals(FrameChecks.REASON_FACING, c.firstFailure())
    assertEquals(
      listOf("oneFace", "distanceOrSize", "centred", "facing", "light", "expression", "eyes", "sharp"),
      c.toMap(snakeCase = false).keys.toList(),
    )
    assertEquals(
      listOf("one_face", "distance_or_size", "centred", "facing", "light", "expression", "eyes", "sharp"),
      c.toMap(snakeCase = true).keys.toList(),
    )
  }
}
