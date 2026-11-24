package ai.facetype.capture.quality

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The frame conversion that feeds the landmarker.
 *
 * THE BUG CLASS THIS COVERS. Two libraries in the same capture path disagree
 * about which way ninety degrees turns: ML Kit's `InputImage` takes a clockwise
 * rotation, MediaPipe's `ImageProcessingOptions` does not. Getting that wrong
 * does not throw and does not produce a wrong number — it produces a sideways
 * image, in which the landmarker finds no face, so every capture abstains with
 * `FT-SCAN-014` and looks exactly like a device that cannot measure quality.
 * A silent, total, plausible failure is the worst kind to leave untested, so
 * the conversion rotates the frame itself and these tests hold it to
 * [RoiMath] — the mapping that was already reviewed and already has a test per
 * orientation.
 */
class Nv21ArgbTest {

  private val width = 8
  private val height = 6

  @Test
  fun `the upright mapping is exactly the inverse of the ROI mapping`() {
    // If these two ever disagree, the detector's face rectangle and the
    // landmarker's image are describing different pictures.
    for (rotation in listOf(0, 90, 180, 270)) {
      val uprightWidth = Nv21Argb.uprightWidth(width, height, rotation)
      val uprightHeight = Nv21Argb.uprightHeight(width, height, rotation)
      for (uprightY in 0 until uprightHeight) {
        for (uprightX in 0 until uprightWidth) {
          val (bufferX, bufferY) =
            RoiMath.pointToBufferSpace(uprightX, uprightY, rotation, width, height)
          val index = Nv21Argb.uprightIndex(
            bufferX,
            bufferY,
            rotation,
            width,
            height,
            uprightWidth,
          )
          assertEquals(
            "rotation $rotation: upright ($uprightX,$uprightY) -> buffer " +
              "($bufferX,$bufferY) -> index $index",
            uprightY * uprightWidth + uprightX,
            index,
          )
        }
      }
    }
  }

  @Test
  fun `every upright pixel is written exactly once`() {
    // A mapping that collided would leave holes filled with whatever the array
    // was initialised to -- black bars a face detector reads as real structure.
    for (rotation in listOf(0, 90, 180, 270)) {
      val uprightWidth = Nv21Argb.uprightWidth(width, height, rotation)
      val uprightHeight = Nv21Argb.uprightHeight(width, height, rotation)
      val hits = IntArray(uprightWidth * uprightHeight)
      for (y in 0 until height) {
        for (x in 0 until width) {
          hits[Nv21Argb.uprightIndex(x, y, rotation, width, height, uprightWidth)] += 1
        }
      }
      assertTrue(
        "rotation $rotation left ${hits.count { it != 1 }} pixels unwritten or doubled",
        hits.all { it == 1 },
      )
    }
  }

  @Test
  fun `a quarter turn transposes the image dimensions`() {
    assertEquals(width, Nv21Argb.uprightWidth(width, height, 0))
    assertEquals(height, Nv21Argb.uprightHeight(width, height, 0))
    assertEquals(height, Nv21Argb.uprightWidth(width, height, 90))
    assertEquals(width, Nv21Argb.uprightHeight(width, height, 90))
    assertEquals(height, Nv21Argb.uprightWidth(width, height, 270))
    assertEquals(width, Nv21Argb.uprightHeight(width, height, 270))
  }

  @Test
  fun `grey converts to grey and the alpha channel is opaque`() {
    // Neutral chroma must not tint the image: a conversion with the U and V
    // terms crossed produces a colour cast the landmarker silently does worse
    // on, which is the same silent-degradation failure as a wrong rotation.
    val nv21 = ByteArray(YuvNv21.byteCount(width, height))
    val level = 130
    for (index in 0 until width * height) nv21[index] = level.toByte()
    for (index in width * height until nv21.size) nv21[index] = 128.toByte()

    val pixels = IntArray(width * height)
    Nv21Argb.toUprightArgb(nv21, width, height, 0, pixels)

    for (pixel in pixels) {
      assertEquals(0xFF, (pixel ushr 24) and 0xFF)
      assertEquals(level, (pixel ushr 16) and 0xFF)
      assertEquals(level, (pixel ushr 8) and 0xFF)
      assertEquals(level, pixel and 0xFF)
    }
  }

  @Test
  fun `chroma moves the expected channel`() {
    // NV21 stores Cr (V) first, then Cb (U) -- the order YuvNv21.convert writes.
    // Reading them the other way round is not a crash; it swaps red and blue.
    val pixels = IntArray(width * height)

    val redward = greyFrame(luma = 128, v = 220, u = 128)
    Nv21Argb.toUprightArgb(redward, width, height, 0, pixels)
    val red = pixels[0]
    assertTrue("V above neutral must raise red", (red ushr 16 and 0xFF) > 128)
    assertTrue("V above neutral must not raise blue", (red and 0xFF) <= 128)

    val blueward = greyFrame(luma = 128, v = 128, u = 220)
    Nv21Argb.toUprightArgb(blueward, width, height, 0, pixels)
    val blue = pixels[0]
    assertTrue("U above neutral must raise blue", (blue and 0xFF) > 128)
    assertTrue("U above neutral must not raise red", (blue ushr 16 and 0xFF) <= 128)
  }

  @Test
  fun `luma is clamped rather than wrapped`() {
    // An unclamped conversion overflows into the neighbouring channel and
    // produces bright artefacts exactly where a face is over- or under-exposed.
    val pixels = IntArray(width * height)
    for (luma in listOf(0, 255)) {
      for (chroma in listOf(0, 255)) {
        Nv21Argb.toUprightArgb(greyFrame(luma, chroma, chroma), width, height, 0, pixels)
        for (pixel in pixels) {
          for (shift in listOf(16, 8, 0)) {
            val channel = (pixel ushr shift) and 0xFF
            assertTrue("luma=$luma chroma=$chroma produced $channel", channel in 0..255)
          }
        }
      }
    }
  }

  @Test
  fun `the content really is rotated, not merely resized`() {
    // One bright pixel in a dark frame, followed through each quarter turn.
    val nv21 = ByteArray(YuvNv21.byteCount(width, height))
    for (index in width * height until nv21.size) nv21[index] = 128.toByte()
    val markerX = 1
    val markerY = 0
    nv21[markerY * width + markerX] = 255.toByte()

    for (rotation in listOf(0, 90, 180, 270)) {
      val uprightWidth = Nv21Argb.uprightWidth(width, height, rotation)
      val uprightHeight = Nv21Argb.uprightHeight(width, height, rotation)
      val pixels = IntArray(uprightWidth * uprightHeight)
      Nv21Argb.toUprightArgb(nv21, width, height, rotation, pixels)

      val bright = pixels.indices.filter { (pixels[it] ushr 16 and 0xFF) > 200 }
      assertEquals("rotation $rotation lost or duplicated the marker", 1, bright.size)
      // And it landed where RoiMath says the buffer point maps to.
      val expected =
        Nv21Argb.uprightIndex(markerX, markerY, rotation, width, height, uprightWidth)
      assertEquals("rotation $rotation put the marker in the wrong place", expected, bright[0])
    }
  }

  @Test
  fun `a destination too small is refused rather than half-written`() {
    val nv21 = ByteArray(YuvNv21.byteCount(width, height))
    val tooSmall = IntArray(width * height - 1)
    val failure = runCatching {
      Nv21Argb.toUprightArgb(nv21, width, height, 0, tooSmall)
    }.exceptionOrNull()
    assertTrue(failure is IllegalArgumentException)
  }

  @Test
  fun `a truncated source buffer is refused`() {
    val short = ByteArray(YuvNv21.byteCount(width, height) - 1)
    val failure = runCatching {
      Nv21Argb.toUprightArgb(short, width, height, 0, IntArray(width * height))
    }.exceptionOrNull()
    assertTrue(failure is IllegalArgumentException)
  }

  // -- the lifetime of the converted copy -----------------------------------
  //
  // Codex review `2026-08-27T11-58-19Z`. The conversion produces a second,
  // larger copy of the user's face: four bytes per pixel against NV21's one and
  // a half. The NV21 buffer is zeroised the moment its last reader lets go; the
  // ARGB copy was handed to `Bitmap.createBitmap` and then dropped for the
  // collector, so a frame the app had finished with stayed legible in the heap
  // for an unbounded time. These four tests are that wipe, and the equally
  // important half of it: that the wipe does not happen while the model is
  // reading.

  @Test
  fun `the converted pixels are wiped once the read returns`() {
    val nv21 = greyFrame(luma = 200, v = 128, u = 128)
    var borrowed: IntArray? = null

    val answer = Nv21Argb.withUprightArgb(nv21, width, height, 90) { pixels, w, h ->
      borrowed = pixels
      assertEquals(Nv21Argb.uprightWidth(width, height, 90), w)
      assertEquals(Nv21Argb.uprightHeight(width, height, 90), h)
      assertTrue("the read was handed a blank image", pixels.any { it != 0 })
      "measured"
    }

    assertEquals("the read's own value must reach the caller", "measured", answer)
    assertTrue(
      "the converted copy of the face outlived the measurement that needed it",
      borrowed!!.all { it == 0 },
    )
  }

  @Test
  fun `a read that abstains still wipes the converted pixels`() {
    // The path a frame with no face in it takes: a null answer is the common
    // outcome, not the exceptional one, and it must release as much as success.
    val nv21 = greyFrame(luma = 200, v = 128, u = 128)
    var borrowed: IntArray? = null

    val answer: String? = Nv21Argb.withUprightArgb(nv21, width, height, 0) { pixels, _, _ ->
      borrowed = pixels
      null
    }

    assertNull(answer)
    assertTrue(borrowed!!.all { it == 0 })
  }

  @Test
  fun `a read that throws still wipes the converted pixels`() {
    // A model that throws mid-detect must not be the one way a face survives in
    // the heap, which is exactly what a wipe written after the call site would
    // have done.
    val nv21 = greyFrame(luma = 200, v = 128, u = 128)
    var borrowed: IntArray? = null

    val failure = runCatching {
      Nv21Argb.withUprightArgb(nv21, width, height, 180) { pixels, _, _ ->
        borrowed = pixels
        assertTrue(pixels.any { it != 0 })
        throw IllegalStateException("model exploded")
      }
    }.exceptionOrNull()

    assertTrue("the failure must still reach the caller", failure is IllegalStateException)
    assertTrue(
      "a throwing read left the converted face behind",
      borrowed!!.all { it == 0 },
    )
  }

  @Test
  fun `the pixels stay readable for as long as the reader holds them`() {
    // The other half of the rule, and the one a naive fix breaks: wiping the
    // array while the model still has a bitmap built from it does not throw --
    // it measures a half-zeroed face and reports the number as a quality score.
    // The reader here is parked on a latch on another thread, so "during the
    // read" is a state this test can stand still in and assert about.
    val nv21 = greyFrame(luma = 200, v = 128, u = 128)
    val reading = CountDownLatch(1)
    val release = CountDownLatch(1)
    val borrowed = AtomicReference<IntArray>()
    val sawZeroes = AtomicBoolean(false)
    val reader = Thread {
      Nv21Argb.withUprightArgb(nv21, width, height, 0) { pixels, _, _ ->
        borrowed.set(pixels)
        reading.countDown()
        release.await()
        sawZeroes.set(pixels.all { it == 0 })
      }
    }
    reader.start()

    assertTrue("the reader never started", reading.await(AWAIT_SECONDS, TimeUnit.SECONDS))
    assertTrue(
      "the pixels were wiped while the model was reading them",
      borrowed.get().any { it != 0 },
    )

    release.countDown()
    reader.join(AWAIT_SECONDS * 1_000)

    assertFalse("the reader was handed a wiped image", sawZeroes.get())
    assertTrue(borrowed.get().all { it == 0 })
  }

  /** A frame of uniform [luma] with uniform chroma. */
  private fun greyFrame(luma: Int, v: Int, u: Int): ByteArray {
    val nv21 = ByteArray(YuvNv21.byteCount(width, height))
    for (index in 0 until width * height) nv21[index] = luma.toByte()
    var index = width * height
    while (index < nv21.size) {
      nv21[index] = v.toByte()
      nv21[index + 1] = u.toByte()
      index += 2
    }
    return nv21
  }

  private companion object {
    const val AWAIT_SECONDS = 5L
  }
}
