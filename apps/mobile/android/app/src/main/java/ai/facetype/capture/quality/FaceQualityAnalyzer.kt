package ai.facetype.capture.quality

import java.util.Arrays

/**
 * The face detector, reduced to the two things this package needs from it.
 *
 * ML Kit is an Android library with a native model behind it; expressing the
 * dependency as this interface keeps [FaceQualityAnalyzer] — where the
 * ownership and lifecycle rules live — plain JVM code that `testDebugUnitTest`
 * can drive deterministically, including the failure, never-answers and
 * answers-after-close paths a real detector will not reproduce on demand.
 */
internal interface FaceDetectorHandle {
  /**
   * Detects faces in an NV21 buffer.
   *
   * The buffer belongs to the caller of [detect] until exactly one of
   * [onFaces] / [onFailure] has been invoked, on any thread. Implementations
   * must not read it afterwards, and must guarantee that exactly one callback
   * fires even if the detector is closed mid-flight — a request that is never
   * answered is a capture that never settles.
   *
   * Bounding boxes are in the frame the image occupies *after*
   * [rotationDegrees] is applied.
   */
  fun detect(
    nv21: ByteArray,
    width: Int,
    height: Int,
    rotationDegrees: Int,
    onFaces: (List<RoiRect>) -> Unit,
    onFailure: () -> Unit,
    /**
     * Invoked exactly once, when this implementation will never read [nv21]
     * again, and never before an [onFaces] it produced.
     *
     * SEPARATE FROM THE ANSWER ON PURPOSE (Codex review `2026-08-26T23-29-26Z`).
     * A teardown can answer a request early — nothing should wait on a detector
     * being closed — while the detector's own thread is still reading the
     * pixels it was handed. Folding the two events together is what let a
     * `close()` zero the buffer under a live reader, which does not crash: it
     * measures a half-zeroed face and reports the number as a quality score.
     *
     * THE ORDER IS PROMISED AGAINST [onFaces] AND NOT AGAINST [onFailure], and
     * the asymmetry is the guarantee this caller actually needs. [onFaces] is
     * where a second reader takes the buffer on, so a reader-done arriving
     * first would let the ownership count reach zero mid-hand-over; it cannot,
     * because both come from the same completion, on one thread, in that
     * order. An [onFailure] produced by a teardown on *another* thread can be
     * overtaken by the real completion's reader-done, and nothing depends on
     * that order: a failed answer hands the buffer to nobody. Pinning it would
     * mean invoking a caller's callback while holding the implementation's
     * lock, which is a worse trade than the promise is worth.
     */
    onReaderDone: () -> Unit,
  )

  /**
   * Releases the detector, having settled every in-flight request first.
   *
   * Blocking here is correct: returning while a callback is still pending
   * would leave a capture Promise with nothing left alive to settle it.
   */
  fun close()
}

/**
 * The per-expression activation source, reduced the same way.
 *
 * Separate from [FaceDetectorHandle] because it is a separate model answering a
 * separate question, and because keeping it behind an interface is what lets
 * the analyser's sequencing — including "the landmarker never answered" and
 * "the landmarker answered after close()" — be driven from a plain JVM test.
 *
 * The buffer-ownership contract is identical: the caller's array is readable
 * until exactly one callback has fired, on any thread, and exactly one always
 * fires.
 */
internal interface FaceBlendshapeHandle {
  fun blendshapes(
    nv21: ByteArray,
    width: Int,
    height: Int,
    rotationDegrees: Int,
    onBlendshapes: (Map<String, Float>) -> Unit,
    onFailure: () -> Unit,
    /**
     * Invoked exactly once, when this implementation will never read [nv21]
     * again.
     *
     * Unlike [FaceDetectorHandle.detect]'s, this carries no ordering promise
     * relative to the answer: a teardown can answer the request on one thread
     * while the reading thread is still finishing. Nothing here needs the
     * order -- the answer holds no reference to the buffer, and this is the
     * last reader, so there is no hand-over to get wrong.
     */
    onReaderDone: () -> Unit,
  )

  fun close()
}

/**
 * Who may still be reading one request's pixels.
 *
 * WHY A COUNT RATHER THAN A FLAG. Two models read the same buffer, one after
 * the other, and the hand-over between them overlaps: the detector announces
 * its faces (which is what starts the blendshape pass) before it announces that
 * it has finished reading. A single "released" flag set by whichever finished
 * first would free the buffer in the middle of that overlap.
 *
 * WHY IT IS NOT THE SAME THING AS SETTLING THE CAPTURE. A teardown answers the
 * request immediately; the pixels are freed later, by whichever reader is last
 * to let go. If a reader never lets go — a native call that never returns after
 * its detector was closed — the buffer is simply never zeroed. That is a worse
 * privacy posture than zeroing it, and a far better one than corrupting a read
 * in flight, so it is the deliberate choice rather than the accident.
 */
private class PixelOwnership(private val nv21: ByteArray) {
  /** Starts at one: the handle [FaceQualityAnalyzer.submit] hands the buffer to. */
  private val readers = java.util.concurrent.atomic.AtomicInteger(1)

  /**
   * Records that a second reader is taking the buffer on.
   *
   * Only ever called while the first reader still holds it, from inside its own
   * answer callback, so the count cannot pass through zero in between.
   */
  fun handOff() {
    readers.incrementAndGet()
  }

  /** Records that one reader is done. The last one out zeroes the pixels. */
  fun readerDone() {
    if (readers.decrementAndGet() == 0) Arrays.fill(nv21, 0.toByte())
  }
}

/**
 * Runs the bundled on-device models over one frame's copied pixels and reports
 * the result attached to that frame's identity.
 *
 * THE OWNERSHIP RULE, and why it is the whole design. The previous version
 * leased one shared scratch array to whichever frame was being sampled. A
 * detector that had not answered yet still held that array, and both the
 * stuck-detector timeout and `invalidate()` would zero it or hand it to the
 * next frame — while ML Kit was reading it (Codex review of `80925da`, finding
 * 2). Sharing a mutable buffer with an asynchronous reader has no safe
 * protocol short of not doing it, so: **one buffer per request, allocated by
 * the caller, read by exactly one measurement, zeroised by that measurement's
 * own completion, never reused.** Analysis is capture-driven — at most one
 * request per pose — so the allocation is immaterial and the race is gone
 * rather than guarded.
 *
 * TWO MODELS, ONE BUFFER, IN SEQUENCE. The detector answers "how many faces,
 * and where", and only then — and only for exactly one face — does the
 * blendshape pass run over the same bytes. Sequential rather than concurrent is
 * the point: it keeps a single reader on the buffer at any moment, and it means
 * the expensive pass is skipped entirely on the frames (no face, several faces)
 * whose answer is already decided.
 *
 * SETTLING AND RELEASING ARE DIFFERENT EVENTS (Codex review
 * `2026-08-26T23-29-26Z`, P0). The first version zeroed the buffer in the same
 * step that answered the request, which meant a `close()` answering a request
 * early also took the pixels away from a model still reading them. That does
 * not fail loudly — it measures a half-zeroed face and reports the number as a
 * quality score. The answer now goes out as soon as it is known, and the pixels
 * are freed separately by [PixelOwnership], on the last reader to let go.
 *
 * The analyser holds no camera state of its own. Freshness, generations and
 * timeouts belong to [CaptureCoordinator]; what happens here is measurement.
 */
internal class FaceQualityAnalyzer(
  private val detector: FaceDetectorHandle,
  /**
   * Null when this device could not create the landmarker at all.
   *
   * Not an oversight to be defended against: it is the honest statement that
   * expression is unmeasurable here, and it produces `FT-SCAN-014` while
   * leaving the face-count evidence — which is more useful to a user than a
   * blanket "could not measure" — intact.
   */
  private val blendshapes: FaceBlendshapeHandle?,
  private val onResult: (AnalysisResult) -> Unit,
) : ResourceHandle {

  private val lock = Any()
  private var closed = false

  /**
   * Measures [request] and reports the result exactly once.
   *
   * A model failure still produces a result — one whose metrics are `null` for
   * a single detected face, which is `FT-SCAN-014` — rather than silence,
   * because silence is what leaves a capture waiting for its timeout.
   *
   * THE CLOSED CHECK BELOW IS A SHORT CUT, NOT THE GUARANTEE (Codex review
   * `2026-08-27T11-58-19Z`). It is not held across [detector], so a `close()`
   * can land between it and the `detect` call and the check will have been
   * true and stale. The handle is what answers that: each one owns its own
   * lifecycle state, decides admission under its own lock, and answers a
   * request it can no longer measure rather than accepting one nothing will
   * settle. Reading this check as the thing that keeps requests out of a closed
   * detector is how the race it used to hide gets rebuilt.
   */
  fun submit(request: AnalysisRequest) {
    val pixels = PixelOwnership(request.nv21)
    synchronized(lock) {
      if (closed) {
        // Nothing will ever measure this. Answer it now so the request fails
        // closed immediately instead of waiting out its deadline, and free the
        // pixels here because no model was ever handed them.
        publish(unmeasured(request))
        pixels.readerDone()
        return
      }
    }
    detector.detect(
      request.nv21,
      request.width,
      request.height,
      request.rotationDegrees,
      onFaces = { faces -> onDetected(request, pixels, faces) },
      onFailure = { onDetected(request, pixels, null) },
      onReaderDone = { pixels.readerDone() },
    )
  }

  /**
   * Releases both models once each has settled everything in flight.
   *
   * Safe to call more than once and from any thread; it holds no lock across
   * either call, so a callback landing during the close can still run.
   *
   * The order is load-bearing. Closing the detector settles its in-flight
   * requests, and one of those callbacks can start a blendshape pass on its way
   * out; closing the blendshape handle second is what guarantees that pass is
   * settled too. The other order leaves a capture with nothing alive to answer
   * it.
   */
  override fun close() {
    synchronized(lock) {
      if (closed) return
      closed = true
    }
    detector.close()
    blendshapes?.close()
  }

  private fun onDetected(
    request: AnalysisRequest,
    pixels: PixelOwnership,
    faces: List<RoiRect>?,
  ) {
    if (faces == null) {
      publish(unmeasured(request))
      return
    }
    if (faces.size != 1) {
      // Zero or several faces is itself the answer (FT-SCAN-005/FT-SCAN-004);
      // there is no single face region to measure sharpness on, and no single
      // face to read expression from, so every other signal stays explicitly
      // unknown.
      publish(AnalysisResult(request.identity, request.geometry, faces.size, null, null))
      return
    }
    val roi = try {
      RoiMath.clamp(
        RoiMath.inset(
          RoiMath.toBufferSpace(
            faces[0],
            request.rotationDegrees,
            request.width,
            request.height,
          ),
          FACE_ROI_INSET,
        ),
        request.width,
        request.height,
      )
    } catch (_: IllegalArgumentException) {
      publish(AnalysisResult(request.identity, request.geometry, 1, null, null))
      return
    }
    val blur = PixelMetrics.blurScore(request.nv21, request.width, request.height, roi)
    val exposure = PixelMetrics.exposureScore(request.nv21, request.width, request.height, roi)

    val handle = blendshapes
    if (handle == null || blur == null || exposure == null) {
      // Either there is nothing to measure expression with, or this frame has
      // already failed: a face region the pixel metrics could not read is
      // FT-SCAN-014 whatever the landmarker would have said, so the second
      // model is not run for an answer nobody will use.
      publish(AnalysisResult(request.identity, request.geometry, 1, blur, exposure))
      return
    }
    // Taken on *before* the pass starts, and while the detector still holds the
    // buffer -- this call runs inside the detector's own answer callback, which
    // its contract puts before its reader-done. The count therefore never
    // passes through zero during the hand-over.
    pixels.handOff()
    handle.blendshapes(
      request.nv21,
      request.width,
      request.height,
      request.rotationDegrees,
      onBlendshapes = { activations ->
        publish(measured(request, blur, exposure, activations))
      },
      onFailure = {
        publish(AnalysisResult(request.identity, request.geometry, 1, blur, exposure))
      },
      onReaderDone = { pixels.readerDone() },
    )
  }

  /**
   * Builds the single-face result, abstaining from the score but not from the
   * activations it could not score.
   *
   * [Neutrality.score] returning null means these activations are not the ones
   * this estimator was written against. That is exactly when *not* reporting a
   * number matters, so the sample is dropped whole: a payload never carries
   * blendshapes without the neutrality read from them, nor the reverse.
   */
  private fun measured(
    request: AnalysisRequest,
    blur: Double,
    exposure: Double,
    activations: Map<String, Float>,
  ): AnalysisResult {
    val neutrality = Neutrality.score(activations)
    return AnalysisResult(
      identity = request.identity,
      geometry = request.geometry,
      faceCount = 1,
      blur = blur,
      exposure = exposure,
      expression = neutrality?.let { ExpressionSample(activations, it) },
    )
  }

  /**
   * Answers the capture, exactly once per request.
   *
   * Deliberately says nothing about the pixels. Whoever is still reading them
   * frees them, through [PixelOwnership], which may be well after this.
   */
  private fun publish(result: AnalysisResult) {
    onResult(result)
  }

  private fun unmeasured(request: AnalysisRequest) = AnalysisResult(
    identity = request.identity,
    geometry = request.geometry,
    faceCount = -1,
    blur = null,
    exposure = null,
  )

  companion object {
    /** Fraction trimmed from each side of the detector box before measuring. */
    const val FACE_ROI_INSET: Double = 0.10
  }
}
