package ai.facetype.capture.quality

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Getting the rotation wrong does not crash: it measures sharpness on a
 * rectangle of background and reports it as the face's. Every orientation is
 * therefore checked by round-tripping a known pixel rather than by asserting
 * a recorded rectangle.
 */
class RoiMathTest {

  private val bufferWidth = 640
  private val bufferHeight = 480

  @Test
  fun `an upright image needs no remapping`() {
    val rect = RoiRect(10, 20, 110, 220)

    assertEquals(rect, RoiMath.toBufferSpace(rect, 0, bufferWidth, bufferHeight))
  }

  @Test
  fun `a quarter turn swaps the reported image dimensions`() {
    assertEquals(480, RoiMath.rotatedWidth(bufferWidth, bufferHeight, 90))
    assertEquals(640, RoiMath.rotatedHeight(bufferWidth, bufferHeight, 90))
    assertEquals(480, RoiMath.rotatedWidth(bufferWidth, bufferHeight, 270))
    assertEquals(640, RoiMath.rotatedHeight(bufferWidth, bufferHeight, 270))
    assertEquals(640, RoiMath.rotatedWidth(bufferWidth, bufferHeight, 180))
    assertEquals(480, RoiMath.rotatedHeight(bufferWidth, bufferHeight, 180))
  }

  @Test
  fun `every rotation maps a rotated-frame point back to the pixel it came from`() {
    for (rotation in listOf(0, 90, 180, 270)) {
      for (x in listOf(0, 1, 317, bufferWidth - 1)) {
        for (y in listOf(0, 1, 200, bufferHeight - 1)) {
          val rotated = forwardRotate(x, y, rotation)
          val back = RoiMath.pointToBufferSpace(
            rotated.first,
            rotated.second,
            rotation,
            bufferWidth,
            bufferHeight,
          )
          assertEquals("rotation $rotation x", x, back.first)
          assertEquals("rotation $rotation y", y, back.second)
        }
      }
    }
  }

  @Test
  fun `a rectangle maps back to exactly the pixels it covered`() {
    val source = RoiRect(100, 60, 260, 300)
    for (rotation in listOf(0, 90, 180, 270)) {
      val topLeft = forwardRotate(source.left, source.top, rotation)
      val bottomRight = forwardRotate(source.right - 1, source.bottom - 1, rotation)
      val inRotatedFrame = RoiRect(
        left = minOf(topLeft.first, bottomRight.first),
        top = minOf(topLeft.second, bottomRight.second),
        right = maxOf(topLeft.first, bottomRight.first) + 1,
        bottom = maxOf(topLeft.second, bottomRight.second) + 1,
      )

      val mapped = RoiMath.toBufferSpace(inRotatedFrame, rotation, bufferWidth, bufferHeight)

      assertEquals("rotation $rotation", source, mapped)
    }
  }

  @Test
  fun `clamping keeps a box that overhangs the frame inside it`() {
    val overhanging = RoiRect(-40, -10, bufferWidth + 90, bufferHeight + 5)

    val clamped = RoiMath.clamp(overhanging, bufferWidth, bufferHeight)

    assertEquals(RoiRect(0, 0, bufferWidth, bufferHeight), clamped)
  }

  @Test
  fun `insetting shrinks towards the centre and stays non-empty`() {
    val rect = RoiRect(100, 100, 300, 200)

    val inset = RoiMath.inset(rect, 0.10)

    assertEquals(RoiRect(120, 110, 280, 190), inset)
    assertTrue(!inset.isEmpty)
  }

  @Test
  fun `an unsupported rotation is rejected rather than guessed`() {
    val rejected = try {
      RoiMath.toBufferSpace(RoiRect(0, 0, 10, 10), 45, bufferWidth, bufferHeight)
      false
    } catch (_: IllegalArgumentException) {
      true
    }
    assertTrue(rejected)
  }

  // The rotation *compensation* -- how many degrees the buffer must be turned
  // and in which direction -- is exercised on real pixels in
  // RotationBehaviourTest, which checks the sign relationship that was wrong
  // rather than re-deriving constants from the formula under test.

  /** Rotates a buffer pixel clockwise by [rotationDegrees], the way ML Kit does. */
  private fun forwardRotate(x: Int, y: Int, rotationDegrees: Int): Pair<Int, Int> =
    when (rotationDegrees) {
      0 -> x to y
      90 -> (bufferHeight - 1 - y) to x
      180 -> (bufferWidth - 1 - x) to (bufferHeight - 1 - y)
      else -> y to (bufferWidth - 1 - x)
    }
}
