package ai.facetype.capture.quality

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The lifecycle protocol behind [MediaPipeBlendshapeHandle], with no Android in
 * it, so every race it exists to prevent can be driven from a JVM test.
 *
 * THE BUG THIS WAS WRITTEN TO FIX (Codex review `2026-08-26T23-29-26Z`, P0).
 * The first version settled every in-flight pass on `close()` by calling its
 * failure callback immediately. That callback reached the analyser, which
 * zeroed the request's NV21 buffer — while a worker could be part-way through
 * reading those same bytes into an image. The result is not a crash: it is a
 * half-zeroed face handed to a model, measured, and reported as a quality
 * score. It also closed the native task 500 ms later whether or not a `detect`
 * call was still inside it, which is a use-after-free waiting for a slow frame.
 *
 * THE INVARIANT, and it is two facts rather than one:
 *
 *  1. **Settling the capture and releasing the pixels are different events.**
 *     A teardown may answer a request early — nothing should wait on a model
 *     that is being torn down — but it may not take the buffer away from a
 *     reader that is still reading it. So `close()` does the first
 *     unconditionally and the second only for a pass no worker has claimed.
 *  2. **A pass belongs to whoever claims it first, and only the claimer
 *     touches the buffer.** The worker claims *before* its first read; a
 *     `close()` that gets there first claims a pass that has therefore never
 *     been read, and can release it safely. The worker that loses the claim
 *     returns without reading a byte.
 *
 * The native task is closed only once the executor has actually terminated. If
 * that takes longer than teardown can wait, teardown returns and a daemon
 * reaper finishes the wait — a leaked task is a bounded cost, and closing one
 * out from under a thread inside it is not.
 */
internal class BlendshapePassRunner(
  private val worker: ExecutorService,
  /** Reads the buffer. Returns null if this frame yielded no activations. */
  private val measure: (ByteArray, Int, Int, Int) -> Map<String, Float>?,
  /** Releases the model. Called exactly once, only after [worker] terminates. */
  private val releaseModel: () -> Unit,
  /** Starts the reaper. Overridden in tests to make the hand-off observable. */
  private val startReaper: (Runnable) -> Unit = { runnable ->
    Thread(runnable, "facetype-blendshapes-reaper").apply { isDaemon = true }.start()
  },
  private val shutdownTimeoutMs: Long = SHUTDOWN_TIMEOUT_MS,
  private val reaperPollMs: Long = REAPER_POLL_MS,
) {

  /**
   * One submitted pass.
   *
   * Two independent flags, because the two events they guard are independent.
   * [settled] guards the answer — exactly one of the callbacks, ever. [claimed]
   * guards the pixels — whoever sets it is the only party that may read them,
   * and is the only party that may declare them free.
   */
  private class Pass(
    val onFailure: () -> Unit,
    val onReaderDone: () -> Unit,
  ) {
    val settled = AtomicBoolean(false)
    val claimed = AtomicBoolean(false)
  }

  private val inFlight = ConcurrentHashMap.newKeySet<Pass>()

  @Volatile private var closed = false

  @Volatile private var modelReleased = false

  /**
   * Submits one pass over [nv21].
   *
   * The caller keeps [nv21] readable until `onReaderDone` fires. Exactly one
   * answer callback and exactly one `onReaderDone` are guaranteed, even if
   * [close] runs in between.
   *
   * NO ORDERING IS PROMISED BETWEEN THE TWO, and the contract says so rather
   * than pretending otherwise. A teardown answers the request on one thread
   * while the worker frees the buffer on another, and pinning an order across
   * that would mean invoking a caller's callback while holding this class's
   * lock -- a worse trade than the guarantee is worth. Nothing needs the order:
   * the answer carries no reference to the buffer, and no second reader takes
   * the pixels on after a blendshape pass. Where an order *is* needed --
   * [FaceDetectorHandle.detect], whose answer starts the pass that takes the
   * buffer over -- it comes free, because both callbacks are made from one
   * listener on one thread.
   */
  fun submit(
    nv21: ByteArray,
    width: Int,
    height: Int,
    rotationDegrees: Int,
    onBlendshapes: (Map<String, Float>) -> Unit,
    onFailure: () -> Unit,
    onReaderDone: () -> Unit,
  ) {
    val pass = Pass(onFailure, onReaderDone)
    if (closed) {
      // Never registered and never read: this pass can be finished here.
      cancel(pass)
      return
    }
    inFlight.add(pass)
    val accepted = runCatching {
      worker.execute { run(pass, nv21, width, height, rotationDegrees, onBlendshapes) }
    }
    if (accepted.isFailure) {
      // Shut down between the check and the submit. Nothing ran, so nothing
      // read the buffer -- but close() may already have finished this pass.
      inFlight.remove(pass)
      cancel(pass)
      return
    }
    if (closed) {
      // close() swept before `execute` registered this pass, so its sweep never
      // saw it. Repeating the sweep here is what closes that window -- and it
      // has to be the *whole* sweep, answer included. An earlier version
      // released the pixels here without answering, which left the capture
      // waiting on a pass whose worker had already stood down; the race test
      // found it in six rounds.
      cancel(pass)
    }
  }

  private fun run(
    pass: Pass,
    nv21: ByteArray,
    width: Int,
    height: Int,
    rotationDegrees: Int,
    onBlendshapes: (Map<String, Float>) -> Unit,
  ) {
    // The claim is the first thing this thread does, before it looks at a
    // single byte. Losing it means close() has already declared these pixels
    // free, and reading them now is exactly the race this guards.
    if (!pass.claimed.compareAndSet(false, true)) return
    // Deliberately still registered. A claim says "these pixels are mine", not
    // "this request needs no answer": a close() arriving while this read is in
    // flight must still be able to answer the capture, and it can only do that
    // for a pass it can still see. Deregistration happens when the pass is
    // completely finished, below.
    try {
      val activations = runCatching { measure(nv21, width, height, rotationDegrees) }.getOrNull()
      settle(pass) { if (activations == null) pass.onFailure() else onBlendshapes(activations) }
    } finally {
      // In `finally` on purpose: the buffer is released when this thread stops
      // reading it, whether the read succeeded, threw, or produced an answer
      // nobody wanted because the request was already cancelled.
      runCatching { pass.onReaderDone() }
      inFlight.remove(pass)
    }
  }

  /**
   * Releases the model once nothing can be inside it.
   *
   * Answers every pending request first — a torn-down model will not produce
   * an answer, and a capture waiting for one that will never come is a capture
   * that hangs until its watchdog. But a pass a worker has claimed keeps its
   * buffer: that worker is reading it, and it will say so itself.
   */
  fun close() {
    closed = true
    runCatching { worker.shutdown() }
    for (pass in inFlight) {
      cancel(pass)
    }
    val terminated = runCatching {
      worker.awaitTermination(shutdownTimeoutMs, TimeUnit.MILLISECONDS)
    }.getOrDefault(false)
    if (terminated) {
      releaseModelOnce()
      return
    }
    // A pass is still inside the model. Closing it now would free native state
    // under a thread executing in it, so teardown returns and the wait
    // continues on a daemon thread that cannot hold up process exit.
    startReaper(
      Runnable {
        val finished = runCatching {
          while (!worker.awaitTermination(reaperPollMs, TimeUnit.MILLISECONDS)) Unit
          true
        }.getOrDefault(false)
        // Only on a real termination. If the wait was interrupted we do not
        // know the worker has left the model, and leaking it is the cheaper
        // of the two mistakes available here.
        if (finished) releaseModelOnce()
      },
    )
  }

  /** True once the model has been released; the reaper makes this observable. */
  fun isModelReleased(): Boolean = modelReleased

  private fun settle(pass: Pass, answer: () -> Unit) {
    if (pass.settled.compareAndSet(false, true)) runCatching { answer() }
  }

  /**
   * Stands a pass down: answer it, and free its pixels if nobody took them.
   *
   * The two halves are unconditional and conditional respectively, and that
   * asymmetry is the whole invariant. Answering is always safe -- a second
   * answer is swallowed by [settle]. Freeing is safe only if no worker ever
   * claimed the buffer, because a claimed pass is being read right now and its
   * own reader will say when it is done.
   */
  private fun cancel(pass: Pass) {
    settle(pass) { pass.onFailure() }
    if (pass.claimed.compareAndSet(false, true)) {
      inFlight.remove(pass)
      runCatching { pass.onReaderDone() }
    }
  }

  private fun releaseModelOnce() {
    synchronized(this) {
      if (modelReleased) return
      modelReleased = true
    }
    runCatching { releaseModel() }
  }

  companion object {
    /** How long teardown waits inline before handing over to the reaper. */
    const val SHUTDOWN_TIMEOUT_MS: Long = 500L

    /** How often the reaper re-checks a worker still inside the model. */
    const val REAPER_POLL_MS: Long = 250L
  }
}
