package ai.facetype.capture.quality

import java.util.concurrent.ConcurrentLinkedQueue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The second measurement stage: when it runs, when it does not, and what a
 * frame it could not measure is allowed to report.
 *
 * WHAT CHANGED, AND WHAT DID NOT. Before this, Android reported `neutrality`
 * as `null` by ADR-009, because the only evidence available was a smile
 * probability over the mouth. It now measures it from the landmarker's
 * blendshape head — the same evidence class, and the same estimator, as iOS
 * (ADR-010). `occlusion` did **not** change and is not measured here at all:
 * these tests exist partly to pin that down, because "we added the missing
 * signals" is the summary someone will write from the commit title, and only
 * one of the two was actually addable.
 *
 * The tests below are ordered as the risk is: first that the old path really
 * did fail, then that the new path measures, then — the ones that matter most —
 * that every way the new path can fail produces an abstention rather than a
 * number.
 */
class ExpressionMeasurementTest {

  // -- The old path, and why it had to fail ---------------------------------

  @Test
  fun `a device with no landmarker measures everything else and still abstains`() {
    // This is the pre-ADR-010 Android path exactly: blur, exposure and the face
    // count are real, and expression is absent. It has to stay reachable,
    // because a device that cannot create the landmarker still lands here.
    val detector = ScriptedDetector()
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, null) { results.add(it) }

    analyzer.submit(analysisRequest(FrameIdentity(1, 1, 1_000), tag = 7))
    detector.completeWithOneFace()

    val result = results.single()
    assertEquals(1, result.faceCount)
    assertNotNull("blur is still measured without a landmarker", result.blur)
    assertNotNull("exposure is still measured without a landmarker", result.exposure)
    assertNull("no landmarker means no expression evidence", result.expression)
    assertFalse(
      "an unmeasured neutrality is FT-SCAN-014, never a servable frame",
      result.isUsable(),
    )
  }

  @Test
  fun `the face-count evidence survives a missing landmarker`() {
    // Why the handle is allowed to be absent on its own rather than taking the
    // whole analyser down with it: "nobody is in frame" is a more useful thing
    // to tell a user than "we could not measure", and it is still true.
    val detector = ScriptedDetector()
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, null) { results.add(it) }

    analyzer.submit(analysisRequest(FrameIdentity(1, 1, 1_000), tag = 1))
    detector.complete(emptyList())

    val result = results.single()
    assertEquals(0, result.faceCount)
    assertTrue("no face is itself the evidence FT-SCAN-005 needs", result.isUsable())
  }

  // -- The new path ---------------------------------------------------------

  @Test
  fun `one face is measured for expression and scored`() {
    val detector = ScriptedDetector()
    val blendshapes = ScriptedBlendshapes(deferred = true)
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, blendshapes) { results.add(it) }

    analyzer.submit(analysisRequest(FrameIdentity(1, 1, 1_000), tag = 3))
    detector.completeWithOneFace()

    // Nothing is published until the second stage answers: a result that went
    // out at detector time would be a result with no expression in it.
    assertTrue(results.isEmpty())
    assertEquals(1, blendshapes.pendingCount())

    blendshapes.complete(RESTING_ACTIVATIONS)

    val result = results.single()
    val expression = result.expression
    assertNotNull(expression)
    assertEquals(1.0, expression!!.neutrality, 1e-9)
    assertTrue(result.isUsable())
  }

  @Test
  fun `the payload carries every category the model reported`() {
    // Not only the twelve the estimator reads: canonicalization removes
    // expression deformation downstream from the activations themselves
    // (FT-03 s.5 step 6), so trimming the map here would throw that away.
    val detector = ScriptedDetector()
    val blendshapes = ScriptedBlendshapes(deferred = true)
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, blendshapes) { results.add(it) }

    analyzer.submit(analysisRequest(FrameIdentity(1, 1, 1_000), tag = 3))
    detector.completeWithOneFace()
    val reported = RESTING_ACTIVATIONS + mapOf("noseSneerRight" to 0.25f)
    blendshapes.complete(reported)

    assertEquals(reported, results.single().expression!!.blendshapes)
  }

  @Test
  fun `both stages read the same frame's pixels`() {
    // The whole point of FrameIdentity, applied to the second model: a
    // neutrality score measured from a different frame than the mesh would be
    // the same two-frames-presented-as-one bug in a new place.
    val detector = ScriptedDetector()
    val blendshapes = ScriptedBlendshapes(deferred = true)
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, blendshapes) { results.add(it) }

    val request = analysisRequest(FrameIdentity(1, 42, 9_000), tag = 21)
    analyzer.submit(request)
    detector.completeWithOneFace()
    blendshapes.complete()

    assertSame(request.nv21, detector.observedBuffers.single())
    assertSame(request.nv21, blendshapes.observedBuffers.single())
    assertEquals(request.identity, results.single().identity)
    assertSame(request.geometry, results.single().geometry)
  }

  @Test
  fun `the buffer outlives the detector and is released by the expression pass`() {
    // The ownership rule extended to two readers: the buffer belongs to the
    // request until the LAST stage that needs it is done, and zeroing it when
    // the detector answered would hand the landmarker a wiped image.
    val detector = ScriptedDetector()
    val blendshapes = ScriptedBlendshapes(deferred = true)
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, blendshapes) { results.add(it) }

    val request = analysisRequest(FrameIdentity(1, 1, 1_000), tag = 33)
    analyzer.submit(request)
    detector.completeWithOneFace()

    assertEquals(
      "the expression pass still has to read these pixels",
      33,
      request.nv21[0].toInt(),
    )

    blendshapes.complete()

    assertTrue(
      "copied camera pixels do not outlive the measurement that needed them",
      request.nv21.all { it == 0.toByte() },
    )
  }

  @Test
  fun `the expression pass is skipped when the count already answers the frame`() {
    val detector = ScriptedDetector()
    val blendshapes = ScriptedBlendshapes(deferred = true)
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, blendshapes) { results.add(it) }

    analyzer.submit(analysisRequest(FrameIdentity(1, 1, 1_000), tag = 1))
    detector.complete(listOf(RoiRect(0, 0, 40, 40), RoiRect(60, 60, 100, 100)))

    assertEquals("two faces is already the answer", 0, blendshapes.pendingCount())
    val result = results.single()
    assertEquals(2, result.faceCount)
    assertNull(result.expression)
  }

  // -- Every way the new path can fail --------------------------------------

  @Test
  fun `a landmarker that fails abstains and does not default`() {
    val detector = ScriptedDetector()
    val blendshapes = ScriptedBlendshapes(deferred = true)
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, blendshapes) { results.add(it) }

    val request = analysisRequest(FrameIdentity(1, 1, 1_000), tag = 4)
    analyzer.submit(request)
    detector.completeWithOneFace()
    blendshapes.fail()

    val result = results.single()
    assertNotNull("the pixel metrics still stand", result.blur)
    assertNull(result.expression)
    assertFalse(result.isUsable())
    assertTrue(request.nv21.all { it == 0.toByte() })
  }

  @Test
  fun `activations the estimator will not score are dropped whole`() {
    // The pairing rule: a payload must never carry a neutrality computed from
    // blendshapes it did not also report, nor blendshapes with a score the
    // estimator refused to produce. Dropping the sample is what makes the
    // second half of that true.
    val detector = ScriptedDetector()
    val blendshapes = ScriptedBlendshapes(deferred = true)
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, blendshapes) { results.add(it) }

    analyzer.submit(analysisRequest(FrameIdentity(1, 1, 1_000), tag = 4))
    detector.completeWithOneFace()
    // A model that is not the model this estimator was written against.
    blendshapes.complete(mapOf("jawOpen" to 0.1f, "someOtherCategory" to 0.2f))

    val result = results.single()
    assertNull(
      "unscorable activations must not travel with no score attached",
      result.expression,
    )
    assertFalse(result.isUsable())
  }

  @Test
  fun `closing the analyser settles an expression pass still in flight`() {
    // A capture waiting on a stage that will never answer is a capture that
    // hangs until its watchdog. close() has to settle both stages, in that
    // order, because closing the detector is what starts the last expression
    // pass.
    val detector = ScriptedDetector()
    val blendshapes = ScriptedBlendshapes(deferred = true)
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, blendshapes) { results.add(it) }

    analyzer.submit(analysisRequest(FrameIdentity(1, 1, 1_000), tag = 5))
    detector.completeWithOneFace()
    assertEquals(1, blendshapes.pendingCount())

    analyzer.close()

    assertTrue(detector.closed)
    assertTrue(blendshapes.closed)
    val result = results.single()
    assertNull(result.expression)
    assertFalse(result.isUsable())
  }

  // -- Settling and releasing are different events --------------------------
  //
  // Codex review `2026-08-26T23-29-26Z`, P0. The first version of this code
  // zeroed the request's pixels in the same step that answered it, so a
  // teardown that answered a request early also took the buffer away from a
  // model still reading it. That does not throw and does not hang: it feeds a
  // half-zeroed face to a model and reports the number as a quality score. The
  // three tests below are the boundary that must not move again.

  @Test
  fun `close does not zero pixels a reader is still holding`() {
    val detector = ScriptedDetector()
    val blendshapes = ScriptedBlendshapes(deferred = true)
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, blendshapes) { results.add(it) }

    val request = analysisRequest(FrameIdentity(1, 1, 1_000), tag = 91)
    analyzer.submit(request)
    detector.completeWithOneFace()
    // The worker has claimed the pass and is part-way through the conversion.
    assertTrue(blendshapes.beginReading())

    analyzer.close()

    // Answered -- nothing waits on a model being torn down ...
    val result = results.single()
    assertNull(result.expression)
    assertFalse(result.isUsable())
    // ... but the bytes the reader is reading are untouched.
    assertEquals(
      "close() zeroed the buffer under a live reader",
      91,
      request.nv21[0].toInt(),
    )
    assertFalse(request.nv21.all { it == 0.toByte() })
    assertEquals(1, blendshapes.unreleasedCount())

    // Only when the reader lets go are the pixels freed -- and the answer is
    // not repeated, because the request was already settled.
    assertTrue(blendshapes.finishReading())

    assertTrue(request.nv21.all { it == 0.toByte() })
    assertEquals("the capture must be answered exactly once", 1, results.size)
  }

  @Test
  fun `a detection settled by close keeps its pixels until the detector lets go`() {
    // The same rule one stage earlier. ML Kit gives no way to know whether a
    // request it has not answered is still being read, so close() answers it
    // and leaves the buffer alone; only the real completion listener frees it.
    val detector = ScriptedDetector()
    val blendshapes = ScriptedBlendshapes(deferred = true)
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, blendshapes) { results.add(it) }

    val request = analysisRequest(FrameIdentity(1, 1, 1_000), tag = 6)
    analyzer.submit(request)
    analyzer.close()

    val result = results.single()
    assertEquals("the detector reported a failure, not a count", -1, result.faceCount)
    assertNull(result.expression)
    assertFalse(result.isUsable())
    assertEquals(
      "the detector may still be reading these bytes",
      6,
      request.nv21[0].toInt(),
    )
    assertEquals(1, detector.unreleasedCount())

    // ML Kit's listener finally runs, long after the request was answered.
    assertTrue(detector.releaseWithoutAnswering())

    assertTrue(request.nv21.all { it == 0.toByte() })
    assertEquals(1, results.size)
  }

  @Test
  fun `a request submitted after close is answered and its buffer released`() {
    // Nothing ever took this buffer, so there is no reader to wait for and the
    // pixels are freed immediately. This is the one path where settling and
    // releasing legitimately coincide.
    val detector = ScriptedDetector()
    val blendshapes = ScriptedBlendshapes(deferred = true)
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, blendshapes) { results.add(it) }
    analyzer.close()

    val request = analysisRequest(FrameIdentity(1, 1, 1_000), tag = 8)
    analyzer.submit(request)

    val result = results.single()
    assertEquals(-1, result.faceCount)
    assertFalse(result.isUsable())
    assertTrue(
      "a request nothing will ever measure still must not leave pixels behind",
      request.nv21.all { it == 0.toByte() },
    )
  }

  @Test
  fun `the hand-over between the two readers never frees the buffer in between`() {
    // The reason ownership is a count rather than a flag: the detector
    // announces its faces -- which is what starts the expression pass -- before
    // it announces that it has stopped reading. A single released flag set by
    // whichever finished first would free the buffer inside that overlap.
    val detector = ScriptedDetector()
    val blendshapes = ScriptedBlendshapes(deferred = true)
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val analyzer = FaceQualityAnalyzer(detector, blendshapes) { results.add(it) }

    val request = analysisRequest(FrameIdentity(1, 1, 1_000), tag = 77)
    analyzer.submit(request)
    // complete() delivers the faces and then the reader-done, in that order --
    // the same order the real handle guarantees.
    detector.completeWithOneFace()

    assertEquals(
      "the expression pass took the buffer on before the detector let go",
      77,
      request.nv21[0].toInt(),
    )
    assertEquals(1, blendshapes.pendingCount())

    blendshapes.complete()

    assertTrue(request.nv21.all { it == 0.toByte() })
  }
}
