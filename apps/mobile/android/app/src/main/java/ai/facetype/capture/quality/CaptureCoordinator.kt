package ai.facetype.capture.quality

/** The render loop's published position: how far the camera has actually got. */
internal data class FrameMark(val sequence: Long, val timestampNs: Long)

/**
 * What the caller should do about the pending capture request right now.
 *
 * The terminal outcomes carry the request itself. That is the whole point:
 * transferring ownership *is* the state transition, so the coordinator cannot
 * be in a state that says "settled" while the thing to settle is still
 * somewhere else — which is exactly what the previous split between a state
 * machine and a separate Promise slot allowed.
 */
internal sealed interface CaptureOutcome<out T> {
  /** Nothing is pending. */
  data object Idle : CaptureOutcome<Nothing>

  /** Something is pending but this frame cannot advance it. */
  data object Wait : CaptureOutcome<Nothing>

  /** Bind this frame: extract its mesh, copy its pixels, analyse both. */
  data class Analyse(val identity: FrameIdentity) : CaptureOutcome<Nothing>

  /** Take this request and fail it. */
  data class Fail<T>(val request: T, val code: String, val message: String) : CaptureOutcome<T>

  /** Take this request and answer it with this same-frame result. */
  data class Deliver<T>(val request: T, val result: AnalysisResult) : CaptureOutcome<T>
}

/**
 * Owner of the pending capture request: its state, its deadlines, and the
 * request object itself.
 *
 * WHY IT OWNS THE REQUEST (Codex re-review of `91c333b`, P0-1). The previous
 * version kept the state here and the Promise in a separate single-slot queue,
 * accepted into the first and then offered into the second. Between those two
 * calls the render thread could bind a frame, the detector could answer it, and
 * the delivery would find an empty slot and silently drop the result — after
 * which the Promise arrived to a coordinator that had already returned to
 * `Idle` and would never speak again, so the capture hung until its watchdog.
 * Two objects holding one request between them cannot be made atomic by
 * ordering their calls carefully; the request has to live in one place.
 *
 * Every terminal transition hands the request out exactly once, under the same
 * lock that changes the state, so "settled exactly once" is a property of the
 * type rather than a discipline the call sites have to keep.
 *
 * WHAT THIS REPLACED, TWO REVIEWS AGO. Analysis used to run continuously and a
 * capture was served from the newest completed measurement while the mesh came
 * from whatever frame was live — two frames presented as one. A request now
 * selects exactly one frame and can only be answered by the analysis of that
 * frame.
 *
 * WHY THE DEADLINES ARE WALL-CLOCK. They used to be measured in ARCore frame
 * timestamps, which stop advancing exactly when a request is most likely to be
 * stuck. A monotonic wall clock keeps advancing, so a request that can never be
 * served still fails closed instead of hanging.
 *
 * Every method is safe to call from any thread. Nothing calls out while holding
 * the lock, so this is a leaf in the lock order and can be called from inside
 * the view's session lock without a cycle.
 */
internal class CaptureCoordinator<T>(
  private val requestTimeoutNs: Long = REQUEST_TIMEOUT_NS,
  private val analysisTimeoutNs: Long = ANALYSIS_TIMEOUT_NS,
) {

  private sealed interface State<out T> {
    data object Idle : State<Nothing>

    /** Accepted; waiting for a frame strictly newer than the baseline. */
    data class AwaitingFrame<T>(
      val request: T,
      val generation: Long,
      val baseline: FrameMark,
      val deadlineNs: Long,
    ) : State<T>

    /** One frame is bound and its analysis is in flight. */
    data class Analysing<T>(
      val request: T,
      val identity: FrameIdentity,
      val baseline: FrameMark,
      val requestDeadlineNs: Long,
      val analysisDeadlineNs: Long,
    ) : State<T>
  }

  private val lock = Any()
  private var state: State<T> = State.Idle
  private var nextFrameId: Long = 1

  /**
   * Takes ownership of a newly accepted capture request.
   *
   * [baseline] is the render loop's published position at the moment the
   * request arrived. The frame that eventually serves it must be strictly past
   * that position in *both* sequence and timestamp — which is what stops a
   * request landing between `Session.update()` and this check from being
   * answered by the frame `update()` was in the middle of producing, and what
   * stops ARCore re-reporting an unchanged frame from counting as a new one.
   *
   * @return false if a request was already pending; the caller still owns
   *   [request] and must settle it itself.
   */
  fun accept(request: T, generation: Long, baseline: FrameMark, nowNs: Long): Boolean {
    synchronized(lock) {
      if (state !is State.Idle) return false
      state = State.AwaitingFrame(request, generation, baseline, nowNs + requestTimeoutNs)
      return true
    }
  }

  /** Called once per rendered frame, on the thread that owns the session. */
  fun onFrame(
    generation: Long,
    sequence: Long,
    frameTimestampNs: Long,
    nowNs: Long,
  ): CaptureOutcome<T> {
    synchronized(lock) {
      when (val current = state) {
        is State.Idle -> return CaptureOutcome.Idle

        is State.AwaitingFrame -> {
          if (generation != current.generation) return take(current.request, SESSION_CHANGED)
          // The deadline is checked *before* the frame is considered, not only
          // on frames that turn out to be unusable. Checking it afterwards let
          // a camera that produces fresh frames but never a usable image rebind
          // on every one of them, past the request's own deadline, until the
          // watchdog eventually swept it up (Codex review of `989cd92`, P1-3).
          if (nowNs >= current.deadlineNs) return take(current.request, REQUEST_TIMED_OUT)
          if (sequence <= current.baseline.sequence) return CaptureOutcome.Wait
          if (frameTimestampNs <= current.baseline.timestampNs) return CaptureOutcome.Wait
          val identity = FrameIdentity(generation, nextFrameId++, frameTimestampNs)
          state = State.Analysing(
            request = current.request,
            identity = identity,
            baseline = current.baseline,
            requestDeadlineNs = current.deadlineNs,
            analysisDeadlineNs = minOf(current.deadlineNs, nowNs + analysisTimeoutNs),
          )
          return CaptureOutcome.Analyse(identity)
        }

        is State.Analysing -> {
          if (generation != current.identity.generation) {
            return take(current.request, SESSION_CHANGED)
          }
          return expiredOr(
            current.request,
            nowNs,
            current.analysisDeadlineNs,
            ANALYSIS_TIMED_OUT,
          )
        }
      }
    }
  }

  /**
   * Called when an analysis finishes, on whatever thread ran it.
   *
   * A result for any frame other than the one currently bound is dropped: it
   * belongs to a request that has already been settled, or to a session that
   * has ended, and publishing it would answer a capture with evidence nobody
   * asked for.
   */
  fun onAnalysisComplete(result: AnalysisResult): CaptureOutcome<T> {
    synchronized(lock) {
      val current = state as? State.Analysing ?: return CaptureOutcome.Idle
      if (current.identity != result.identity) return CaptureOutcome.Idle
      state = State.Idle
      return CaptureOutcome.Deliver(current.request, result)
    }
  }

  /**
   * Un-binds a frame whose pixels turned out not to be available, returning the
   * request to waiting with its original baseline and deadline.
   *
   * ARCore hands out the camera image a frame or two after tracking starts, so
   * "no image yet" is an ordinary early-frame condition, not a failure. The
   * request keeps its own deadline, and that deadline is enforced here as well
   * as at every bind: "keeps its deadline" was only true of the stored number,
   * not of anything that read it, so an image that never arrived was retried
   * indefinitely.
   *
   * @return [CaptureOutcome.Fail] if the request has run out of time — the
   *   caller owns it and must settle it — and [CaptureOutcome.Wait] if it is
   *   back in the queue for the next frame.
   */
  fun rewind(identity: FrameIdentity, nowNs: Long): CaptureOutcome<T> {
    synchronized(lock) {
      val current = state as? State.Analysing ?: return CaptureOutcome.Idle
      if (current.identity != identity) return CaptureOutcome.Idle
      if (nowNs >= current.requestDeadlineNs) {
        return take(current.request, REQUEST_TIMED_OUT)
      }
      state = State.AwaitingFrame(
        request = current.request,
        generation = identity.generation,
        baseline = current.baseline,
        deadlineNs = current.requestDeadlineNs,
      )
      return CaptureOutcome.Wait
    }
  }

  /**
   * Takes the pending request, if any, so the caller can settle it.
   *
   * This is how teardown, a host pause and an unanalysable frame all settle a
   * capture: whichever of them gets a non-null answer owns it, and every other
   * path — including a detector callback already on its way — gets nothing.
   */
  fun cancel(): T? {
    synchronized(lock) {
      val request = pendingRequest() ?: return null
      state = State.Idle
      return request
    }
  }

  /**
   * Takes the pending request only if it satisfies [predicate].
   *
   * A timeout scheduled for one request must not settle a different one that
   * happens to be pending when it fires. Testing and taking under the same lock
   * is what makes "settle exactly the request I was scheduled for" true rather
   * than probable.
   */
  fun cancelIf(predicate: (T) -> Boolean): T? {
    synchronized(lock) {
      val request = pendingRequest() ?: return null
      if (!predicate(request)) return null
      state = State.Idle
      return request
    }
  }

  fun isPending(): Boolean = synchronized(lock) { state !is State.Idle }

  private fun pendingRequest(): T? = when (val current = state) {
    is State.Idle -> null
    is State.AwaitingFrame -> current.request
    is State.Analysing -> current.request
  }

  private fun take(request: T, failure: Failure): CaptureOutcome<T> {
    state = State.Idle
    return CaptureOutcome.Fail(request, failure.code, failure.message)
  }

  private fun expiredOr(
    request: T,
    nowNs: Long,
    deadlineNs: Long,
    onExpiry: Failure = REQUEST_TIMED_OUT,
  ): CaptureOutcome<T> {
    if (nowNs < deadlineNs) return CaptureOutcome.Wait
    return take(request, onExpiry)
  }

  private data class Failure(val code: String, val message: String)

  companion object {
    /** How long a request may wait for a frame it can be bound to. */
    const val REQUEST_TIMEOUT_NS: Long = 3_000_000_000L

    /** How long the detector has, once a frame is bound, before giving up. */
    const val ANALYSIS_TIMEOUT_NS: Long = 2_000_000_000L

    private val REQUEST_TIMED_OUT = Failure(
      "FT-SCAN-014",
      "No camera frame could be measured for this capture.",
    )

    private val ANALYSIS_TIMED_OUT = Failure(
      "FT-SCAN-014",
      "Capture-quality measurement did not complete for this frame.",
    )

    private val SESSION_CHANGED = Failure(
      "FT-REC-005",
      "The capture session restarted before this capture completed.",
    )
  }
}
