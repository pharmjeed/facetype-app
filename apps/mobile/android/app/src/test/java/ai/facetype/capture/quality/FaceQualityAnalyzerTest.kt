package ai.facetype.capture.quality

import java.util.concurrent.ConcurrentLinkedQueue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Who owns the copied camera pixels, and for how long.
 *
 * THE BUG THESE REPRODUCE. The previous analyser leased one shared scratch
 * array to whichever frame was being sampled, and both the stuck-detector
 * timeout and `invalidate()` would zero it or hand it to the next frame while
 * ML Kit was still reading it. The detector would then measure a half-zeroed
 * buffer, or two frames' pixels spliced together, and report the result as a
 * quality score. Nothing crashed; the numbers were just wrong.
 *
 * The rule now is that a buffer belongs to exactly one request and is released
 * only by that request's own completion, so the tests below are about
 * *identity* and *contents over time* rather than about the absence of a
 * particular API call.
 */
class FaceQualityAnalyzerTest {

  private val width = FIXTURE_IMAGE_WIDTH
  private val height = FIXTURE_IMAGE_HEIGHT

  @Test
  fun `a buffer a detector still holds is never zeroed or handed to another request`() {
    val detector = ScriptedDetector()
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, ScriptedBlendshapes()) { results.add(it) }

    val first = request(frameId = 1, tag = 41)
    analyzer.submit(first)
    val second = request(frameId = 2, tag = 42)
    analyzer.submit(second)

    val handed = detector.observedBuffers.toList()
    assertEquals(2, handed.size)
    assertNotEquals("two requests must never share one buffer", handed[0], handed[1])
    assertSame(first.nv21, handed[0])
    assertSame(second.nv21, handed[1])
    // Neither has been answered, so neither may have been wiped.
    assertEquals(41, first.nv21[0].toInt())
    assertEquals(42, second.nv21[0].toInt())

    detector.completeWithOneFace()

    assertTrue("its own completion releases it", first.nv21.all { it == 0.toByte() })
    assertEquals("a buffer nobody answered for is untouched", 42, second.nv21[0].toInt())

    detector.completeWithOneFace()
    assertTrue(second.nv21.all { it == 0.toByte() })
    assertEquals(2, results.size)
  }

  @Test
  fun `a failed detection still releases its own buffer`() {
    val detector = ScriptedDetector()
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, ScriptedBlendshapes()) { results.add(it) }
    val pending = request(frameId = 1, tag = 9)
    analyzer.submit(pending)

    detector.fail()

    assertTrue(pending.nv21.all { it == 0.toByte() })
    assertEquals(1, results.size)
  }

  @Test
  fun `a result carries the identity and the mesh of the request it answered`() {
    val detector = ScriptedDetector()
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, ScriptedBlendshapes()) { results.add(it) }
    val pending = request(frameId = 77, tag = 5)

    analyzer.submit(pending)
    detector.completeWithOneFace()

    val result = results.single()
    assertEquals(pending.identity, result.identity)
    assertSame(pending.geometry, result.geometry)
  }

  @Test
  fun `one detected face is measured over its own region`() {
    val detector = ScriptedDetector()
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, ScriptedBlendshapes()) { results.add(it) }
    analyzer.submit(request(frameId = 1, tag = 1))

    detector.complete(listOf(RoiRect(0, 0, width, height)))

    val result = results.single()
    assertEquals(1, result.faceCount)
    assertNotNull(result.blur)
    assertNotNull(result.exposure)
    assertTrue(result.isUsable())
  }

  @Test
  fun `zero or several faces report the count with no invented metrics`() {
    val detector = ScriptedDetector()
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, ScriptedBlendshapes()) { results.add(it) }

    analyzer.submit(request(frameId = 1, tag = 1))
    detector.complete(emptyList())
    results.poll()!!.let {
      assertEquals(0, it.faceCount)
      assertNull(it.blur)
      assertNull(it.exposure)
      // "No face" is itself the evidence FT-SCAN-005 needs.
      assertTrue(it.isUsable())
    }

    analyzer.submit(request(frameId = 2, tag = 2))
    detector.complete(listOf(RoiRect(0, 0, 40, 40), RoiRect(60, 60, 100, 100)))
    results.poll()!!.let {
      assertEquals(2, it.faceCount)
      assertNull(it.blur)
      assertNull(it.exposure)
    }
  }

  @Test
  fun `a face region too small to measure stays explicitly unknown`() {
    val detector = ScriptedDetector()
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, ScriptedBlendshapes()) { results.add(it) }
    analyzer.submit(request(frameId = 1, tag = 1))

    detector.complete(listOf(RoiRect(0, 0, 8, 8)))

    val result = results.single()
    assertEquals(1, result.faceCount)
    assertNull(result.blur)
    assertNull(result.exposure)
    // One face with no measurement is not servable: it becomes FT-SCAN-014.
    assertFalse(result.isUsable())
  }

  @Test
  fun `a blurred frame scores lower than a sharp one over the same region`() {
    // End-to-end through the analyser rather than straight into PixelMetrics:
    // this is what proves the ROI reaches the metrics at all.
    val sharp = measure { index -> if ((index / 2) % 2 == 0) 20 else 230 }
    val flat = measure { 128 }

    assertTrue("sharp $sharp should beat flat $flat", sharp > flat)
    assertEquals(0.0, flat, 1e-9)
  }

  private fun measure(luma: (Int) -> Int): Double {
    val detector = ScriptedDetector()
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, ScriptedBlendshapes()) { results.add(it) }
    val nv21 = ByteArray(YuvNv21.byteCount(width, height)) { luma(it).toByte() }
    analyzer.submit(
      AnalysisRequest(
        identity = FrameIdentity(1, 1, 1_000L),
        width = width,
        height = height,
        rotationDegrees = 0,
        nv21 = nv21,
        geometry = taggedGeometry(0),
      ),
    )
    detector.complete(listOf(RoiRect(0, 0, width, height)))
    return results.single().blur!!
  }

  private fun request(frameId: Long, tag: Int) = AnalysisRequest(
    identity = FrameIdentity(generation = 1, frameId = frameId, frameTimestampNs = frameId * 1_000),
    width = width,
    height = height,
    rotationDegrees = 0,
    nv21 = taggedImage(tag),
    geometry = taggedGeometry(tag),
  )
}
