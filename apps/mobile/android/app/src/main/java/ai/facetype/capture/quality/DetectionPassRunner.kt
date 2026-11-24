package ai.facetype.capture.quality

import java.util.concurrent.Executor
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit

/**
 * The lifecycle protocol behind [MlKitFaceDetectorHandle], with no Android in
 * it, so every race it exists to prevent can be driven from a JVM test.
 *
 * THE BUG THIS WAS WRITTEN TO FIX (Codex review `2026-08-27T11-58-19Z`). The
 * first version kept its in-flight set and its `closed` state in two different
 * places -- a `ConcurrentHashMap` here and the analyser's own flag there -- and
 * checked neither at the moment it mattered. Two interleavings followed from
 * that, both silent:
 *
 *  * **A request registered after the sweep.** `close()` walked the map and
 *    settled what it found; a `detect()` that had passed the analyser's closed
 *    check a moment earlier then added its own entry to the map nobody would
 *    ever walk again. Nothing answered that request and nothing ever would.
 *  * **A callback pinned on a shut-down executor.** `addOnCompleteListener` was
 *    handed the executor directly. If `close()` shut it down between the
 *    listener being registered and ML Kit completing, Google Play services
 *    submitted the completion to a dead queue: the listener never ran, so the
 *    answer never came *and* the reader-done that frees the frame's pixels
 *    never came either.
 *
 * Both end the same way -- a capture Promise that hangs until its watchdog, and
 * a copy of the user's face left in the heap because the code that zeroes it is
 * keyed on a signal that was dropped.
 *
 * THE PROTOCOL, which is one lock and three facts per pass:
 *
 *  1. **Registration and closing are decided under the same lock.** A pass is
 *     admitted only if the runner is open at the instant it is added to
 *     [inFlight], and [close] marks the runner shut and takes the set in the
 *     same critical section. There is no window in which a pass exists but no
 *     sweep will ever see it.
 *  2. **`handedOver` says whether ML Kit ever received the buffer.** It is set
 *     under the lock, and only while the runner is open, so a sweep that reads
 *     it `false` knows it is permanently false: those pixels were never read
 *     and can be freed on the spot. A pass ML Kit *did* receive is answered but
 *     keeps its buffer -- ML Kit offers no way to ask whether it is still
 *     reading, and zeroing pixels under a live reader does not throw, it
 *     measures a half-zeroed face and reports the number as a quality score.
 *     The same gate is what stops the mirror image of that: because the flag is
 *     only set while the runner is open, a frame the sweep has just declared
 *     free can never be handed on afterwards. Drop the check and keep the
 *     assignment and nothing breaks loudly -- ML Kit is simply given a wiped
 *     face and asked how good it is.
 *  3. **Completions are dispatched through [dispatcher], never through the raw
 *     executor.** It queues while the runner is open -- inside the lock, so a
 *     queued task is always submitted before [close] shuts the executor down,
 *     and `shutdown()` runs what was already submitted -- and otherwise runs
 *     the completion inline on ML Kit's own thread. Either way the completion
 *     runs, which is what makes the reader-done exactly-once rather than
 *     at-most-once.
 *
 * `settled` and `released` are the exactly-once guards for the two events, and
 * they are separate because the events are: a teardown answers a capture
 * immediately, while the pixels are freed later by whoever was actually reading
 * them.
 *
 * THE ONE GAP THAT REMAINS, stated rather than papered over: if ML Kit accepts
 * a frame and then never completes its task at all -- which its contract
 * permits for a detector closed mid-flight -- no completion runs, and that
 * buffer is never zeroed. It is reclaimed by the collector like any other
 * array. That is a weaker privacy posture than zeroing it, and a much better
 * one than zeroing a buffer a model is reading. Every interleaving of this
 * class's *own* operations delivers the reader-done exactly once.
 */
internal class DetectionPassRunner(
  private val callbackExecutor: ExecutorService,
  private val detection: Detection,
  /** Releases the detector. Called at most once, by [close]. */
  private val releaseDetector: () -> Unit,
  private val shutdownTimeoutMs: Long = SHUTDOWN_TIMEOUT_MS,
  /**
   * Runs between admitting a pass and marking it as ML Kit's. A test seam, in
   * the same sense as [BlendshapePassRunner]'s reaper hook.
   *
   * The window it opens is the one that decides whether a teardown may free a
   * frame: inside it the pass exists and no detector has it, so a `close()`
   * landing here frees pixels that a moment later would have been handed over.
   * Two threads racing reach it about as often as never -- it is a handful of
   * instructions wide -- so `DetectionPassRunnerTest` enters it on purpose
   * rather than hoping to. In production it is empty and costs one call to a
   * no-op lambda per capture.
   */
  private val onFrameAdmitted: () -> Unit = {},
) {

  /**
   * Hands one frame to the detector.
   *
   * Implementations must arrange for [onComplete] to be invoked on
   * [dispatcher], with the faces or null, and must throw if the frame was not
   * accepted -- a throw is how the runner learns that nothing is reading those
   * pixels.
   */
  fun interface Detection {
    fun start(
      nv21: ByteArray,
      width: Int,
      height: Int,
      rotationDegrees: Int,
      dispatcher: Executor,
      onComplete: (List<RoiRect>?) -> Unit,
    )
  }

  /**
   * One submitted detection.
   *
   * Every field is guarded by the runner's [lock]. They are plain booleans
   * rather than atomics on purpose: `handedOver` and `closed` have to be read
   * and written together to mean anything, and an atomic per field would only
   * make each one individually consistent while the pair stayed racy.
   */
  private class Pass(
    val onFaces: (List<RoiRect>) -> Unit,
    val onFailure: () -> Unit,
    val onReaderDone: () -> Unit,
  ) {
    var settled = false
    var released = false
    var handedOver = false
  }

  private val lock = Any()

  /** Guarded by [lock]. */
  private val inFlight = LinkedHashSet<Pass>()

  /** Guarded by [lock]. */
  private var closed = false

  /** Guarded by [lock]. */
  private var detectorReleased = false

  /**
   * Where ML Kit's completions are delivered.
   *
   * The inline fallback is the whole point: a completion that cannot be queued
   * still has to run, because it carries both the answer and the only evidence
   * this process will ever get that ML Kit has stopped reading the frame.
   * Running it on the caller's thread is sound -- the handle's contract already
   * says callbacks arrive on any thread -- and the alternative is the silence
   * this class was written to remove.
   */
  private val dispatcher = Executor { command ->
    val queued = synchronized(lock) {
      if (closed) false else runCatching { callbackExecutor.execute(command) }.isSuccess
    }
    if (!queued) command.run()
  }

  /**
   * Submits one detection over [nv21].
   *
   * The caller keeps [nv21] readable until `onReaderDone` fires. Exactly one
   * answer callback is guaranteed, even if [close] runs in between; so is
   * exactly one `onReaderDone`, unless ML Kit accepted the frame and then never
   * completed at all (see the class header).
   *
   * `onReaderDone` always follows the answer for the same pass, because
   * [FaceQualityAnalyzer] starts its second model from inside the answer and
   * that hand-over must not be able to run out of readers in between.
   */
  fun submit(
    nv21: ByteArray,
    width: Int,
    height: Int,
    rotationDegrees: Int,
    onFaces: (List<RoiRect>) -> Unit,
    onFailure: () -> Unit,
    onReaderDone: () -> Unit,
  ) {
    val pass = Pass(onFaces, onFailure, onReaderDone)
    val admitted = synchronized(lock) {
      if (closed) false else inFlight.add(pass)
    }
    if (!admitted) {
      // The sweep has already run, so this pass will never be seen by one.
      // Nothing has read the buffer, so it can be answered and freed here.
      standDown(pass)
      return
    }
    onFrameAdmitted()
    val handedOver = synchronized(lock) {
      if (closed) false else { pass.handedOver = true; true }
    }
    if (!handedOver) {
      // close() swept between admission and hand-over. It answered this pass
      // and freed its pixels -- both no-ops here -- and the detector never saw
      // the frame.
      standDown(pass)
      return
    }
    val started = runCatching {
      detection.start(nv21, width, height, rotationDegrees, dispatcher) { faces ->
        complete(pass, faces)
      }
    }
    if (started.isFailure) {
      // The detector refused the frame -- it is closed, or the image could not
      // be built from these bytes. Either way it never took the buffer, so this
      // pass is one nobody is reading.
      synchronized(lock) { pass.handedOver = false }
      standDown(pass)
    }
  }

  /**
   * Releases the detector, having answered every in-flight request first.
   *
   * Safe to call more than once and from any thread. No caller callback is
   * invoked while the lock is held, and the lock is not held across the wait,
   * so a completion landing during the close can still take it.
   */
  fun close() {
    val swept = synchronized(lock) {
      closed = true
      val snapshot = inFlight.map { it to it.handedOver }
      inFlight.clear()
      snapshot
    }
    releaseDetectorOnce()
    for ((pass, handedOver) in swept) {
      // Answering is unconditional: nothing should wait on a detector that is
      // going away. Freeing is not -- a pass ML Kit received is being read, and
      // only its own completion can say when that stopped.
      settle(pass) { pass.onFailure() }
      if (!handedOver) releasePixels(pass)
    }
    // Only after the sweep: an executor shut down first would discard the
    // completions it had not started, and each of those carries a reader-done.
    // Every task the dispatcher queued was submitted before `closed` was
    // published above, and `shutdown()` runs what was already submitted.
    runCatching { callbackExecutor.shutdown() }
    // Bounded: a completion that started before the sweep is allowed to finish,
    // but a detector that hangs must not hang the teardown with it.
    runCatching { callbackExecutor.awaitTermination(shutdownTimeoutMs, TimeUnit.MILLISECONDS) }
  }

  /** True once the detector has been released. */
  fun isDetectorReleased(): Boolean = synchronized(lock) { detectorReleased }

  /** ML Kit answered. The answer first, then the pixels it has stopped reading. */
  private fun complete(pass: Pass, faces: List<RoiRect>?) {
    synchronized(lock) { inFlight.remove(pass) }
    settle(pass) { if (faces == null) pass.onFailure() else pass.onFaces(faces) }
    releasePixels(pass)
  }

  /**
   * Stands down a pass the detector never received: answer it, free it.
   *
   * This is the one path where settling and releasing legitimately coincide,
   * and it is legitimate only because `handedOver` is false, which -- being
   * written under the lock and only while open -- can no longer become true.
   */
  private fun standDown(pass: Pass) {
    synchronized(lock) { inFlight.remove(pass) }
    settle(pass) { pass.onFailure() }
    releasePixels(pass)
  }

  private fun settle(pass: Pass, answer: () -> Unit) {
    val mine = synchronized(lock) {
      if (pass.settled) false else { pass.settled = true; true }
    }
    if (mine) runCatching { answer() }
  }

  private fun releasePixels(pass: Pass) {
    val mine = synchronized(lock) {
      if (pass.released) false else { pass.released = true; true }
    }
    if (mine) runCatching { pass.onReaderDone() }
  }

  private fun releaseDetectorOnce() {
    val mine = synchronized(lock) {
      if (detectorReleased) false else { detectorReleased = true; true }
    }
    if (mine) runCatching { releaseDetector() }
  }

  companion object {
    /** How long teardown waits for a completion that has already started. */
    const val SHUTDOWN_TIMEOUT_MS: Long = 500L
  }
}
