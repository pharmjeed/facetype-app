package ai.facetype.capture.quality

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * These assert the *ordering and bounds* the FT-03 gate depends on -- sharper
 * scores higher, better-exposed scores higher, everything stays inside [0, 1],
 * and an unmeasurable region returns `null` rather than a number.
 *
 * They deliberately do not pin absolute values. The constants that place these
 * curves are provisional and have to be fitted on the physical handset; a test
 * that froze today's numbers would turn that calibration into a test failure
 * and invite someone to "fix" it by editing the expectation.
 */
class PixelMetricsTest {

  private val width = 200
  private val height = 200
  private val roi = RoiRect(20, 20, 180, 180)

  @Test
  fun `sharper detail scores higher than smooth detail scores higher than flat`() {
    val sharp = PixelMetrics.blurScore(checkerboard(period = 2), width, height, roi)!!
    val soft = PixelMetrics.blurScore(gradient(), width, height, roi)!!
    val flat = PixelMetrics.blurScore(uniform(128), width, height, roi)!!

    assertTrue("sharp $sharp should beat soft $soft", sharp > soft)
    assertTrue("soft $soft should beat flat $flat", soft > flat)
    assertEquals(0.0, flat, 1e-9)
    assertTrue(sharp <= 1.0)
  }

  @Test
  fun `blur is bounded to the unit interval`() {
    for (image in listOf(checkerboard(2), checkerboard(7), gradient(), uniform(0), uniform(255))) {
      val score = PixelMetrics.blurScore(image, width, height, roi)!!
      assertTrue("$score out of range", score in 0.0..1.0)
    }
  }

  @Test
  fun `mid-grey is better exposed than a dark or a bright frame`() {
    val balanced = PixelMetrics.exposureScore(uniform(126), width, height, roi)!!
    val dim = PixelMetrics.exposureScore(uniform(40), width, height, roi)!!
    val bright = PixelMetrics.exposureScore(uniform(210), width, height, roi)!!

    assertTrue("balanced $balanced should beat dim $dim", balanced > dim)
    assertTrue("balanced $balanced should beat bright $bright", balanced > bright)
    assertTrue(balanced <= 1.0)
  }

  @Test
  fun `a frame pinned at either endpoint scores zero however its mean reads`() {
    // Crushed black and blown white are the two cases where the sensor has
    // already discarded the information; no amount of mean-based balance may
    // rescue them.
    assertEquals(0.0, PixelMetrics.exposureScore(uniform(0), width, height, roi)!!, 1e-9)
    assertEquals(0.0, PixelMetrics.exposureScore(uniform(255), width, height, roi)!!, 1e-9)
    assertEquals(
      0.0,
      PixelMetrics.exposureScore(uniform(PixelMetrics.LUMA_WHITE_LEVEL), width, height, roi)!!,
      1e-9,
    )
  }

  @Test
  fun `partial clipping lowers the score in proportion`() {
    val lightlyClipped = PixelMetrics.exposureScore(clipped(fraction = 0.1), width, height, roi)!!
    val heavilyClipped = PixelMetrics.exposureScore(clipped(fraction = 0.6), width, height, roi)!!

    assertTrue(
      "$lightlyClipped should beat $heavilyClipped",
      lightlyClipped > heavilyClipped,
    )
  }

  @Test
  fun `a region too small to mean anything returns null rather than a score`() {
    val image = checkerboard(2)
    val tiny = RoiRect(10, 10, 10 + PixelMetrics.MIN_ROI_SIDE - 1, 10 + PixelMetrics.MIN_ROI_SIDE)

    assertNull(PixelMetrics.blurScore(image, width, height, tiny))
    assertNull(PixelMetrics.exposureScore(image, width, height, tiny))
  }

  @Test
  fun `a region outside the image returns null rather than reading past it`() {
    val image = checkerboard(2)
    val outside = RoiRect(width - 10, height - 10, width + 90, height + 90)

    assertNull(PixelMetrics.blurScore(image, width, height, outside))
    assertNull(PixelMetrics.exposureScore(image, width, height, outside))
  }

  @Test
  fun `a truncated buffer returns null rather than reading past its end`() {
    val truncated = ByteArray(width * height - 1)

    assertNull(PixelMetrics.blurScore(truncated, width, height, roi))
    assertNull(PixelMetrics.exposureScore(truncated, width, height, roi))
  }

  private fun uniform(value: Int) = ByteArray(width * height) { value.toByte() }

  private fun checkerboard(period: Int) = ByteArray(width * height) { index ->
    val x = index % width
    val y = index / width
    if ((x / period + y / period) % 2 == 0) 20.toByte() else 230.toByte()
  }

  private fun gradient() = ByteArray(width * height) { index ->
    (40 + (index % width) * 120 / width).toByte()
  }

  /** A well-exposed frame with [fraction] of the *measured region* blown out. */
  private fun clipped(fraction: Double) = ByteArray(width * height) { index ->
    val x = index % width
    if (x >= roi.left && x < roi.left + roi.width * fraction) 255.toByte() else 126.toByte()
  }
}
