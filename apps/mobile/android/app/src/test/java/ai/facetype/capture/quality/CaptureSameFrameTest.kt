package ai.facetype.capture.quality

import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The same-frame contract, exercised through the real coordinator and the real
 * analyser.
 *
 * THE BUG THESE REPRODUCE. The implementation once analysed frames continuously
 * and answered a capture from whichever analysis had most recently completed,
 * while reading the face mesh from the frame that happened to be live at that
 * moment. With a detector slower than the frame rate — which is every detector
 * — those are different frames: the mesh said "the user was here" and the
 * metrics said "and it was sharp", about two instants up to half a second apart.
 *
 * Each frame below stamps one tag into both the mesh and the camera image, so
 * every test can simply ask: did the answer come from one frame?
 */
class CaptureSameFrameTest {

  private val log = ResourceLog()
  private val ops = FakeSessionOps(log)
  private val coordinator =
    PreviewSessionCoordinator<FakeSession, FaceQualityAnalyzer, FakeStart, FakeCapture>(ops)
  private val detector = ScriptedDetector()
  private val delivered = ConcurrentLinkedQueue<String>()
  private val analyzer = FaceQualityAnalyzer(detector, ScriptedBlendshapes()) { result ->
    val outcome = coordinator.onAnalysisComplete(result)
    if (outcome is CaptureOutcome.Deliver) {
      delivered.add("${outcome.request.id}:${outcome.result.geometry.yawDeg.toInt()}")
    }
  }
  private val captureIds = AtomicLong(0)

  /**
   * ARCore's frame timestamp and the monotonic wall clock, kept apart on
   * purpose: a stuck camera stops advancing the first while the second keeps
   * running, and that difference is what makes a stuck request fail closed.
   */
  private var frameTs = 0L
  private var nowNs = 0L

  private fun install() {
    val epoch = coordinator.surfaceCreated()!!
    coordinator.installSession(epoch, FakeSession(), analyzer)
  }

  private fun requestCapture(): FakeCapture? {
    val request = FakeCapture(captureIds.incrementAndGet())
    return if (coordinator.acceptCapture(request, nowNs)) request else null
  }

  /**
   * One rendered frame, driven exactly the way `FaceTypePreviewView` drives it:
   * open the frame under the lock, publish the timestamp `update()` produced,
   * ask the coordinator what to do, and do it *outside* the lock.
   */
  private fun renderFrame(
    tag: Int,
    imageAvailable: Boolean = true,
    duplicate: Boolean = false,
    wallStepNs: Long = FRAME_INTERVAL_NS,
  ) {
    val deferred = coordinator.withRunningSession { _, _, _ ->
      val sequence = coordinator.beginFrame()
      // A duplicate is ARCore re-reporting the frame it already gave us: the
      // wall clock still moves, the frame does not.
      if (!duplicate) frameTs += FRAME_INTERVAL_NS
      nowNs += wallStepNs
      coordinator.publishFrameTimestamp(sequence, frameTs)
      when (val outcome = coordinator.onFrame(sequence, frameTs, nowNs)) {
        is CaptureOutcome.Analyse -> {
          if (!imageAvailable) {
            // The rewind enforces the request's deadline too, so a camera that
            // never produces an image is failed rather than retried forever.
            val rewound = coordinator.rewindCapture(outcome.identity, nowNs)
            if (rewound is CaptureOutcome.Fail) {
              val request = rewound.request
              val settle: () -> Unit = { request.settle(log) }
              settle
            } else {
              null
            }
          } else {
            val request = analysisRequest(outcome.identity, tag)
            val submit: () -> Unit = { analyzer.submit(request) }
            submit
          }
        }
        is CaptureOutcome.Fail -> {
          val request = outcome.request
          val settle: () -> Unit = { request.settle(log) }
          settle
        }
        else -> null
      }
    }
    deferred?.invoke()
  }

  @Test
  fun `the delivered mesh comes from the frame whose pixels were measured`() {
    install()
    requestCapture()

    renderFrame(tag = 11)
    val analysed = detector.observedTags.single()

    // Four more frames go by while the detector is still working. Under the old
    // design these would have replaced the geometry the capture was answered
    // with.
    renderFrame(tag = 12)
    renderFrame(tag = 13)
    renderFrame(tag = 14)
    renderFrame(tag = 15)

    detector.completeWithOneFace()

    assertEquals(listOf("1:$analysed"), delivered.toList())
    assertEquals(11, analysed)
  }

  @Test
  fun `a slow detector never lets a later frame overtake the bound one`() {
    install()
    for (round in 1..10) {
      val tag = round * 10
      requestCapture()
      renderFrame(tag = tag)
      repeat(3) { renderFrame(tag = tag + it + 1) }
      detector.completeWithOneFace()
    }

    assertEquals(
      (1..10).map { "$it:${it * 10}" },
      delivered.toList(),
    )
  }

  @Test
  fun `only one frame is ever analysed per request`() {
    install()
    requestCapture()

    repeat(6) { renderFrame(tag = it + 1) }

    // Continuous sampling would have queued six detections. Capture-driven
    // analysis binds exactly one frame and then waits for it.
    assertEquals(1, detector.observedTags.size)
    assertEquals(1, detector.pendingCount())
  }

  @Test
  fun `no frame is analysed while nothing is pending`() {
    install()

    repeat(5) { renderFrame(tag = it + 1) }

    assertTrue(detector.observedTags.isEmpty())
  }

  @Test
  fun `the frame a request arrives during cannot answer it`() {
    install()
    renderFrame(tag = 1)
    renderFrame(tag = 2)
    val mark = coordinator.frameMark()
    requestCapture()

    renderFrame(tag = 3)

    assertEquals(3, detector.observedTags.single())
    assertTrue(coordinator.frameMark().timestampNs > mark.timestampNs)
  }

  @Test
  fun `a frame ARCore re-reports with a duplicate timestamp is not bound`() {
    install()
    renderFrame(tag = 1)
    requestCapture()

    renderFrame(tag = 2, duplicate = true)

    assertTrue(
      "a re-reported frame carries the pixels the request already rejected",
      detector.observedTags.isEmpty(),
    )

    renderFrame(tag = 3)
    assertEquals(3, detector.observedTags.single())
  }

  @Test
  fun `a frame whose camera image is not ready yet defers instead of failing`() {
    install()
    val capture = requestCapture()!!

    // ARCore hands out the camera image a frame or two after tracking starts.
    renderFrame(tag = 1, imageAvailable = false)
    renderFrame(tag = 2, imageAvailable = false)
    assertEquals(0, capture.settlements.get())
    assertTrue(detector.observedTags.isEmpty())

    renderFrame(tag = 3)
    detector.completeWithOneFace()

    assertEquals(listOf("1:3"), delivered.toList())
  }

  @Test
  fun `a request that waits past its deadline fails closed`() {
    install()
    val capture = requestCapture()!!
    renderFrame(tag = 1, duplicate = true)
    assertEquals(0, capture.settlements.get())

    nowNs += CaptureCoordinator.REQUEST_TIMEOUT_NS
    renderFrame(tag = 2, duplicate = true)

    assertEquals(1, capture.settlements.get())
    assertFalse(coordinator.isCapturePending())
  }

  @Test
  fun `an answer that arrives after its request gave up is dropped`() {
    install()
    val capture = requestCapture()!!
    renderFrame(tag = 1)
    nowNs += CaptureCoordinator.ANALYSIS_TIMEOUT_NS
    renderFrame(tag = 2, duplicate = true)
    assertEquals(1, capture.settlements.get())

    // The detector finally answers. There is nothing left to answer.
    detector.completeWithOneFace()

    assertTrue(delivered.isEmpty())
    assertEquals(1, capture.settlements.get())
  }

  @Test
  fun `a request that outlived its deadline is not bound to a fresh frame`() {
    // THE FAILURE (Codex review of `989cd92`, P1-3). The deadline was only
    // consulted on frames that were *not* fresh. A frame that was newer in both
    // sequence and timestamp went straight to binding, however long the request
    // had been waiting, so its own 3s budget meant nothing and only the 5s
    // watchdog ever ended it.
    install()
    val capture = requestCapture()!!
    nowNs += CaptureCoordinator.REQUEST_TIMEOUT_NS

    renderFrame(tag = 7)

    assertEquals(1, capture.settlements.get())
    assertTrue(
      "a request past its deadline must not be bound to a frame",
      detector.observedTags.isEmpty(),
    )
    assertFalse(coordinator.isCapturePending())
  }

  @Test
  fun `a camera that never yields an image fails the request at its own deadline`() {
    // The same defect from the other side: every frame is fresh and every
    // frame's image is missing, so the request was rewound and rebound
    // indefinitely.
    install()
    val capture = requestCapture()!!

    repeat(4) {
      renderFrame(tag = it + 1, imageAvailable = false, wallStepNs = ONE_SECOND_NS)
    }

    assertEquals(1, capture.settlements.get())
    assertFalse(coordinator.isCapturePending())
    assertTrue(detector.observedTags.isEmpty())
  }

  @Test
  fun `a second request is refused while one is pending`() {
    install()
    assertTrue(requestCapture() != null)

    assertNull(requestCapture())
  }

  @Test
  fun `a detector that answers synchronously is not submitted under the lock`() {
    // ML Kit may invoke its failure callback on the submitting thread. If the
    // submit happened inside the coordinator's lock, that callback would
    // re-enter the coordinator while it was held.
    val syncDetector = ScriptedDetector(synchronousFailure = true)
    val results = ConcurrentLinkedQueue<AnalysisResult>()
    val syncAnalyzer = FaceQualityAnalyzer(syncDetector, ScriptedBlendshapes()) { result ->
      // Re-entering the coordinator from the callback is exactly what a
      // synchronous answer does in production.
      coordinator.onAnalysisComplete(result)
      results.add(result)
    }
    val epoch = coordinator.surfaceCreated()!!
    coordinator.installSession(epoch, FakeSession(), syncAnalyzer)
    val capture = FakeCapture(1)
    assertTrue(coordinator.acceptCapture(capture, nowNs))

    val deferred = coordinator.withRunningSession { _, _, _ ->
      val sequence = coordinator.beginFrame()
      frameTs += FRAME_INTERVAL_NS
      nowNs += FRAME_INTERVAL_NS
      coordinator.publishFrameTimestamp(sequence, frameTs)
      when (val outcome = coordinator.onFrame(sequence, frameTs, nowNs)) {
        is CaptureOutcome.Analyse -> {
          val request = analysisRequest(outcome.identity, 1)
          val submit: () -> Unit = { syncAnalyzer.submit(request) }
          submit
        }
        else -> null
      }
    }
    assertTrue("the frame must hand the submit out, not perform it", deferred != null)
    deferred!!.invoke()

    assertEquals(1, results.size)
    assertFalse(coordinator.isCapturePending())
  }

  companion object {
    private const val FRAME_INTERVAL_NS = 16_000_000L
    private const val ONE_SECOND_NS = 1_000_000_000L
  }
}
