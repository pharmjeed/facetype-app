package ai.facetype.capture.quality

import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Fakes for the three things a JVM cannot have: an ARCore session, an ML Kit
 * analyser, and a React Native Promise.
 *
 * WHAT THESE ARE NOT (Codex re-review of `984ab15`). They are not a second
 * implementation of the lifecycle. The previous test harness re-created the
 * view's locking, phases and ownership, which meant the suite proved the
 * *harness* correct; the class the product actually runs was never exercised.
 * Everything below is a resource or a callback. The rules under test live in
 * [PreviewSessionCoordinator], and the tests call it directly — the same object
 * `FaceTypePreviewView` calls.
 */
internal class FakeSession(val label: String = "session")

/** Records who was called and in what order, across every fake. */
internal class ResourceLog {
  val events = ConcurrentLinkedQueue<String>()

  fun record(event: String) {
    events.add(event)
  }

  fun snapshot(): List<String> = events.toList()

  fun indexOf(event: String): Int = snapshot().indexOf(event)
}

/**
 * A session whose `pause`/`resume`/`close` can be made to block or throw, and
 * which counts anyone who enters it while somebody else is already inside.
 *
 * Blocking is the point: ARCore's `close()` does, and every rule about what may
 * happen while it is running is unobservable unless a test can hold it open.
 *
 * [overlaps] is the direct instrument for the defect Codex found in `989cd92`
 * (P0-1): a `pause()` borrowed the session while a `close()` detached and
 * closed the same object, so two operations were inside ARCore at once. A
 * counter is better evidence than an ordering assertion, because it registers
 * the overlap no matter which of the two got there first.
 */
internal class FakeSessionOps(
  private val log: ResourceLog = ResourceLog(),
) : SessionOps<FakeSession> {

  val pauses = AtomicInteger(0)
  val resumes = AtomicInteger(0)
  val closes = AtomicInteger(0)

  /** How many operations were ever inside this session simultaneously. */
  val overlaps = AtomicInteger(0)
  private val inside = AtomicInteger(0)

  /** Opens when a call has been entered, whether or not it has finished. */
  val closeEntered = CountDownLatch(1)
  val pauseEntered = CountDownLatch(1)
  val resumeEntered = CountDownLatch(1)

  @Volatile var closeGate: CountDownLatch? = null
  @Volatile var pauseGate: CountDownLatch? = null
  @Volatile var resumeGate: CountDownLatch? = null
  @Volatile var closeThrows: Boolean = false
  @Volatile var pauseThrows: Boolean = false
  @Volatile var resumeThrows: Boolean = false

  fun log(): ResourceLog = log

  /** Just the session calls, in order, with the resource-close noise removed. */
  fun sessionEvents(): List<String> =
    log.snapshot().filter { it == "pause" || it == "resume" || it == "close-session" }

  override fun pause(session: FakeSession) {
    pauseEntered.countDown()
    enter()
    try {
      pauseGate?.await(AWAIT_SECONDS, TimeUnit.SECONDS)
      pauses.incrementAndGet()
      log.record("pause")
      if (pauseThrows) throw IllegalStateException("session pause failed")
    } finally {
      leave()
    }
  }

  override fun resume(session: FakeSession) {
    resumeEntered.countDown()
    enter()
    try {
      resumeGate?.await(AWAIT_SECONDS, TimeUnit.SECONDS)
      resumes.incrementAndGet()
      log.record("resume")
      if (resumeThrows) throw IllegalStateException("session resume failed")
    } finally {
      leave()
    }
  }

  override fun close(session: FakeSession) {
    closeEntered.countDown()
    enter()
    try {
      closeGate?.await(AWAIT_SECONDS, TimeUnit.SECONDS)
      closes.incrementAndGet()
      log.record("close-session")
      if (closeThrows) throw IllegalStateException("session close failed")
    } finally {
      leave()
    }
  }

  private fun enter() {
    if (inside.incrementAndGet() > 1) overlaps.incrementAndGet()
  }

  private fun leave() {
    inside.decrementAndGet()
  }

  companion object {
    const val AWAIT_SECONDS = 30L
  }
}

/** An analyser-shaped resource, so close ordering can be observed. */
internal class FakeAnalyzer(private val log: ResourceLog) : ResourceHandle {
  val closes = AtomicInteger(0)

  override fun close() {
    closes.incrementAndGet()
    log.record("close-analyzer")
  }
}

/** A start request: a Promise-shaped thing that records how it was settled. */
internal class FakeStart(val id: Int = 1) {
  val settlements = AtomicInteger(0)

  @Volatile var throwOnSettle = false

  fun settle(log: ResourceLog) {
    settlements.incrementAndGet()
    log.record("settle-start")
    if (throwOnSettle) throw IllegalStateException("start settled twice")
  }
}

/**
 * A capture request, likewise — and the only lever a test has on the window
 * between a transition taking its ticket and reaching its turn.
 *
 * Settlement happens before the turnstile by design (a Promise must never wait
 * behind another transition's blocking ARCore call), so a settlement that
 * blocks on [settleGate] parks a transition in exactly the pre-turn window that
 * Codex's review of `eac5854` found unguarded. Every earlier test started the
 * second thread only after the first was already *inside* the resource
 * section, which is precisely why the window stayed hidden.
 */
internal class FakeCapture(val id: Long) {
  val settlements = AtomicInteger(0)

  /** Opens when a settlement has been entered but not yet finished. */
  val settleEntered = CountDownLatch(1)

  @Volatile var throwOnSettle = false
  @Volatile var settleGate: CountDownLatch? = null

  fun settle(log: ResourceLog) {
    settleEntered.countDown()
    settleGate?.await(FakeSessionOps.AWAIT_SECONDS, TimeUnit.SECONDS)
    settlements.incrementAndGet()
    log.record("settle-capture")
    if (throwOnSettle) throw IllegalStateException("capture settled twice")
  }
}

/** A mesh whose `yawDeg` is the frame tag, so a result names its frame. */
internal fun taggedGeometry(tag: Int) = GeometrySnapshot(
  landmarksMm = FloatArray(9) { it.toFloat() },
  textureCoordinates = FloatArray(6),
  triangleIndices = IntArray(3),
  headPoseRowMajorMm = floatArrayOf(
    1f, 0f, 0f, 0f,
    0f, 1f, 0f, 0f,
    0f, 0f, 1f, 0f,
    0f, 0f, 0f, 1f,
  ),
  yawDeg = tag.toDouble(),
  pitchDeg = 0.0,
)

internal const val FIXTURE_IMAGE_WIDTH = 160
internal const val FIXTURE_IMAGE_HEIGHT = 160

/**
 * A camera image whose first byte is the frame tag and whose remaining luma is
 * a measurable checkerboard, so the same buffer proves both which frame it came
 * from and that real pixels were measured.
 */
internal fun taggedImage(tag: Int): ByteArray {
  val nv21 = ByteArray(YuvNv21.byteCount(FIXTURE_IMAGE_WIDTH, FIXTURE_IMAGE_HEIGHT))
  for (index in nv21.indices) {
    nv21[index] = if ((index / 3) % 2 == 0) 60.toByte() else 190.toByte()
  }
  nv21[0] = tag.toByte()
  return nv21
}

internal fun analysisRequest(identity: FrameIdentity, tag: Int) = AnalysisRequest(
  identity = identity,
  width = FIXTURE_IMAGE_WIDTH,
  height = FIXTURE_IMAGE_HEIGHT,
  rotationDegrees = 0,
  nv21 = taggedImage(tag),
  geometry = taggedGeometry(tag),
)

/** A [FaceDetectorHandle] whose completion the test drives by hand. */
internal class ScriptedDetector(
  /** Answer inline, on the submitting thread, the way ML Kit may. */
  private val synchronousFailure: Boolean = false,
) : FaceDetectorHandle {
  val observedTags = ConcurrentLinkedQueue<Int>()
  val observedBuffers = ConcurrentLinkedQueue<ByteArray>()

  @Volatile var closed = false
    private set

  /**
   * One outstanding detection, holding all three of its callbacks.
   *
   * The reader-done is kept separate from the answer for the same reason the
   * real handle keeps them separate: `close()` answers a request without being
   * able to promise ML Kit has stopped reading, and a double that folded the
   * two together would make that race untestable.
   */
  private class Outstanding(
    val onFaces: (List<RoiRect>) -> Unit,
    val onFailure: () -> Unit,
    val onReaderDone: () -> Unit,
  ) {
    val answered = java.util.concurrent.atomic.AtomicBoolean(false)
    val released = java.util.concurrent.atomic.AtomicBoolean(false)

    fun answer(action: () -> Unit) {
      if (answered.compareAndSet(false, true)) action()
    }

    fun release() {
      if (released.compareAndSet(false, true)) onReaderDone()
    }
  }

  private val outstanding = ConcurrentLinkedQueue<Outstanding>()

  override fun detect(
    nv21: ByteArray,
    width: Int,
    height: Int,
    rotationDegrees: Int,
    onFaces: (List<RoiRect>) -> Unit,
    onFailure: () -> Unit,
    onReaderDone: () -> Unit,
  ) {
    observedTags.add(nv21[0].toInt())
    observedBuffers.add(nv21)
    if (synchronousFailure) {
      // Nothing ever took the buffer, so it is free immediately.
      onFailure()
      onReaderDone()
      return
    }
    outstanding.add(Outstanding(onFaces, onFailure, onReaderDone))
  }

  override fun close() {
    closed = true
    // The real handle answers everything in flight before returning -- and
    // deliberately does NOT declare their buffers free, because it cannot know
    // whether ML Kit is still reading. A double that released them here would
    // hide exactly the race that behaviour exists to prevent.
    for (pending in outstanding) {
      pending.answer(pending.onFailure)
    }
  }

  fun pendingCount(): Int = outstanding.count { !it.answered.get() }

  /** Requests still holding the caller's buffer, answered or not. */
  fun unreleasedCount(): Int = outstanding.count { !it.released.get() }

  fun completeWithOneFace(): Boolean =
    complete(listOf(RoiRect(0, 0, FIXTURE_IMAGE_WIDTH, FIXTURE_IMAGE_HEIGHT)))

  fun complete(faces: List<RoiRect>): Boolean {
    val pending = outstanding.poll() ?: return false
    pending.answer { pending.onFaces(faces) }
    pending.release()
    return true
  }

  fun fail(): Boolean {
    val pending = outstanding.poll() ?: return false
    pending.answer(pending.onFailure)
    pending.release()
    return true
  }

  /**
   * The listener ML Kit finally runs for a request `close()` already answered.
   *
   * This is the only thing that proves the detector has stopped reading, so it
   * is the only thing that frees the caller's buffer on that path.
   */
  fun releaseWithoutAnswering(): Boolean {
    val pending = outstanding.poll() ?: return false
    pending.release()
    return true
  }
}

/**
 * Activations that score as a face at rest, plus one category the estimator
 * does not read.
 *
 * The extra key is deliberate: the wire payload has to carry every category the
 * model reported, not only the twelve neutrality is computed from, because
 * canonicalization removes expression deformation downstream from the
 * activations themselves.
 */
internal val RESTING_ACTIVATIONS: Map<String, Float> =
  Neutrality.EXPRESSIVE_ACTIVATIONS.associateWith { 0f } + mapOf("eyeBlinkLeft" to 0.4f)

/** [RESTING_ACTIVATIONS] with one activation raised to [value]. */
internal fun activationsWith(key: String, value: Float): Map<String, Float> =
  RESTING_ACTIVATIONS + mapOf(key to value)

/**
 * A [FaceBlendshapeHandle] whose completion the test drives by hand.
 *
 * Answers inline by default, because most of the analyser's tests are about the
 * detector stage and would otherwise have to step a second model they do not
 * care about. The tests that *are* about the sequencing pass `deferred = true`
 * and settle each pass themselves.
 */
internal class ScriptedBlendshapes(
  private val deferred: Boolean = false,
  /** What an inline pass answers with; null answers inline with a failure. */
  private val inlineAnswer: Map<String, Float>? = RESTING_ACTIVATIONS,
) : FaceBlendshapeHandle {
  val observedTags = ConcurrentLinkedQueue<Int>()
  val observedBuffers = ConcurrentLinkedQueue<ByteArray>()

  @Volatile var closed = false
    private set

  /**
   * One outstanding pass, with the same two independent flags
   * [BlendshapePassRunner] uses: one for the answer, one for the pixels.
   */
  private class Pass(
    val onBlendshapes: (Map<String, Float>) -> Unit,
    val onFailure: () -> Unit,
    val onReaderDone: () -> Unit,
  ) {
    val answered = java.util.concurrent.atomic.AtomicBoolean(false)
    val claimed = java.util.concurrent.atomic.AtomicBoolean(false)
    val released = java.util.concurrent.atomic.AtomicBoolean(false)

    fun answer(action: () -> Unit) {
      if (answered.compareAndSet(false, true)) action()
    }

    fun release() {
      if (released.compareAndSet(false, true)) onReaderDone()
    }
  }

  private val outstanding = ConcurrentLinkedQueue<Pass>()

  override fun blendshapes(
    nv21: ByteArray,
    width: Int,
    height: Int,
    rotationDegrees: Int,
    onBlendshapes: (Map<String, Float>) -> Unit,
    onFailure: () -> Unit,
    onReaderDone: () -> Unit,
  ) {
    observedTags.add(nv21[0].toInt())
    observedBuffers.add(nv21)
    if (closed) {
      onFailure()
      onReaderDone()
      return
    }
    if (deferred) {
      outstanding.add(Pass(onBlendshapes, onFailure, onReaderDone))
      return
    }
    if (inlineAnswer == null) onFailure() else onBlendshapes(inlineAnswer)
    onReaderDone()
  }

  override fun close() {
    closed = true
    // What the real runner does: answer everything, but free only the passes no
    // worker has claimed. A claimed pass is being read right now, and its own
    // reader releases it.
    for (pass in outstanding) {
      pass.answer(pass.onFailure)
      if (pass.claimed.compareAndSet(false, true)) pass.release()
    }
  }

  fun pendingCount(): Int = outstanding.count { !it.answered.get() }

  /** Passes still holding the caller's buffer. */
  fun unreleasedCount(): Int = outstanding.count { !it.released.get() }

  /**
   * Simulates the worker claiming a pass and starting to read the buffer.
   *
   * Between this and [finishReading] the pass is mid-conversion: a `close()`
   * arriving now must answer the request and leave the pixels alone.
   */
  fun beginReading(): Boolean {
    val pass = outstanding.firstOrNull { !it.claimed.get() } ?: return false
    return pass.claimed.compareAndSet(false, true)
  }

  /** Finishes a pass the worker claimed with [beginReading]. */
  fun finishReading(activations: Map<String, Float>? = RESTING_ACTIVATIONS): Boolean {
    val pass = outstanding.firstOrNull { it.claimed.get() && !it.released.get() } ?: return false
    outstanding.remove(pass)
    pass.answer { if (activations == null) pass.onFailure() else pass.onBlendshapes(activations) }
    pass.release()
    return true
  }

  fun complete(activations: Map<String, Float> = RESTING_ACTIVATIONS): Boolean {
    val pass = outstanding.poll() ?: return false
    pass.claimed.set(true)
    pass.answer { pass.onBlendshapes(activations) }
    pass.release()
    return true
  }

  fun fail(): Boolean {
    val pass = outstanding.poll() ?: return false
    pass.claimed.set(true)
    pass.answer(pass.onFailure)
    pass.release()
    return true
  }
}

/** Starts a daemon thread that waits on [start] and counts down [done]. */
internal fun testThread(start: CountDownLatch, done: CountDownLatch, body: () -> Unit): Thread {
  val worker = Thread {
    start.await()
    try {
      body()
    } finally {
      done.countDown()
    }
  }
  worker.isDaemon = true
  worker.start()
  return worker
}
