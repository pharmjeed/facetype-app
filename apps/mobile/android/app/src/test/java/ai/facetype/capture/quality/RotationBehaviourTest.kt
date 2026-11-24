package ai.facetype.capture.quality

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Rotation, exercised on pixels.
 *
 * THE BUG THESE REPRODUCE. Two independent things can be wrong here and
 * neither fails loudly. The compensation angle can be inverted, in which case
 * the detector is handed an upside-down image and simply finds fewer faces —
 * which looks like a quality problem. And the inverse mapping can be wrong, in
 * which case sharpness gets measured on a rectangle of background and reported
 * as the face's. Both were previously covered by asserting four constants
 * against a formula copied from the same source as the implementation, which
 * proves only that the copy was faithful.
 *
 * So: the mapping is checked by rotating a real image and asking whether the
 * region comes back, and the compensation is checked by its *sign* — the
 * property that was actually wrong — rather than by its arithmetic.
 */
class RotationBehaviourTest {

  private val width = 160
  private val height = 120

  /**
   * A well-exposed block in an otherwise crushed-black buffer.
   *
   * The contrast is chosen so the two regions score *differently* under
   * [PixelMetrics.exposureScore]: mid-grey reads near 1, and the black
   * surround is pinned at the sensor floor and reads 0. A merely bright block
   * would have left both regions plausible and the assertion vacuous.
   */
  private val block = RoiRect(40, 30, 104, 78)

  @Test
  fun `a detector box on the rotated image maps back onto the pixels it covered`() {
    val buffer = imageWithBrightBlock()

    for (rotation in listOf(0, 90, 180, 270)) {
      val rotatedWidth = RoiMath.rotatedWidth(width, height, rotation)
      val rotatedHeight = RoiMath.rotatedHeight(width, height, rotation)
      val rotated = rotateClockwise(buffer, rotation)

      // What ML Kit would report: the bounds of the bright region in the image
      // it was actually given.
      val seen = boundsOfBrightPixels(rotated, rotatedWidth, rotatedHeight)

      val recovered = RoiMath.toBufferSpace(seen, rotation, width, height)

      assertEquals("rotation $rotation", block, recovered)
    }
  }

  @Test
  fun `measuring through the mapped region reads the bright block, not the background`() {
    // The failure this catches is silent: a wrong mapping still produces a
    // number, just one about the wrong pixels.
    val buffer = imageWithBrightBlock()

    for (rotation in listOf(0, 90, 180, 270)) {
      val rotatedWidth = RoiMath.rotatedWidth(width, height, rotation)
      val rotatedHeight = RoiMath.rotatedHeight(width, height, rotation)
      val seen = boundsOfBrightPixels(rotateClockwise(buffer, rotation), rotatedWidth, rotatedHeight)
      val roi = RoiMath.clamp(
        RoiMath.toBufferSpace(seen, rotation, width, height),
        width,
        height,
      )

      val inside = PixelMetrics.exposureScore(buffer, width, height, roi)!!
      val whole = PixelMetrics.exposureScore(buffer, width, height, RoiRect(0, 0, width, height))!!

      assertTrue(
        "rotation $rotation: region reads $inside, whole frame reads $whole",
        inside > whole,
      )
    }
  }

  @Test
  fun `turning the device turns a front camera's image the same way, not the opposite`() {
    // This is the property that was inverted. A front sensor's readout is
    // mirrored, so the device rotation *adds* to the sensor's mounting angle;
    // for a rear camera it subtracts. Asserting the sign relationship checks the
    // thing that was wrong, rather than re-deriving four constants from the
    // same formula the implementation uses.
    for (sensor in listOf(0, 90, 180, 270)) {
      val front0 = MlKitRotation.compensation(sensor, 0, frontFacing = true)
      val back0 = MlKitRotation.compensation(sensor, 0, frontFacing = false)
      for (device in listOf(90, 180, 270)) {
        assertEquals(
          "front sensor=$sensor device=$device",
          (front0 + device) % 360,
          MlKitRotation.compensation(sensor, device, frontFacing = true),
        )
        assertEquals(
          "rear sensor=$sensor device=$device",
          (back0 - device + 360) % 360,
          MlKitRotation.compensation(sensor, device, frontFacing = false),
        )
      }
    }
  }

  @Test
  fun `an unrotated device needs exactly the sensor's own mounting angle`() {
    // SENSOR_ORIENTATION is documented as the clockwise angle the output has to
    // be turned through to be upright in the device's native orientation, so
    // with the device in that orientation the two must agree.
    for (sensor in listOf(0, 90, 180, 270)) {
      assertEquals(sensor, MlKitRotation.compensation(sensor, 0, frontFacing = true))
      assertEquals(sensor, MlKitRotation.compensation(sensor, 0, frontFacing = false))
    }
  }

  @Test
  fun `compensation is always a quarter turn in range`() {
    for (sensor in listOf(0, 90, 180, 270)) {
      for (device in listOf(0, 90, 180, 270)) {
        for (front in listOf(true, false)) {
          val value = MlKitRotation.compensation(sensor, device, front)
          assertTrue("$sensor/$device/$front -> $value", value in listOf(0, 90, 180, 270))
        }
      }
    }
  }

  private fun imageWithBrightBlock(): ByteArray = ByteArray(width * height) { index ->
    val x = index % width
    val y = index / width
    if (x >= block.left && x < block.right && y >= block.top && y < block.bottom) {
      126.toByte()
    } else {
      5.toByte()
    }
  }

  /** Rotates the luma plane clockwise, the way ML Kit rotates its input. */
  private fun rotateClockwise(source: ByteArray, rotationDegrees: Int): ByteArray {
    val out = ByteArray(width * height)
    val rotatedWidth = RoiMath.rotatedWidth(width, height, rotationDegrees)
    for (y in 0 until height) {
      for (x in 0 until width) {
        val (rx, ry) = when (rotationDegrees) {
          0 -> x to y
          90 -> (height - 1 - y) to x
          180 -> (width - 1 - x) to (height - 1 - y)
          else -> y to (width - 1 - x)
        }
        out[ry * rotatedWidth + rx] = source[y * width + x]
      }
    }
    return out
  }

  private fun boundsOfBrightPixels(image: ByteArray, imageWidth: Int, imageHeight: Int): RoiRect {
    var left = imageWidth
    var top = imageHeight
    var right = 0
    var bottom = 0
    for (y in 0 until imageHeight) {
      for (x in 0 until imageWidth) {
        if ((image[y * imageWidth + x].toInt() and 0xff) > 64) {
          if (x < left) left = x
          if (y < top) top = y
          if (x >= right) right = x + 1
          if (y >= bottom) bottom = y + 1
        }
      }
    }
    return RoiRect(left, top, right, bottom)
  }
}
