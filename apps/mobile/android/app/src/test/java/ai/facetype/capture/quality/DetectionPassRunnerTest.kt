package ai.facetype.capture.quality

import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The detection lifecycle, driven against a real executor with a real thread in
 * it and a stand-in for Play services' completion machinery.
 *
 * THE FINDING THIS FILE EXISTS FOR (Codex review `2026-08-27T11-58-19Z`). The
 * previous handle had no state of its own worth the name: a concurrent map of
 * in-flight requests, and the *analyser's* `closed` flag standing in for its
 * own. Two interleavings fell out of that, and neither one fails loudly.
 *
 *  * A `detect()` that passed the analyser's closed check, was descheduled, and
 *    registered itself in the map after `close()` had already walked it. Nobody
 *    would walk that map again. The request was never answered — the capture
 *    hung until its watchdog — and its buffer was never released.
 *  * A completion listener registered directly on the callback executor, with
 *    `close()` shutting that executor down before Play services got there. The
 *    completion was submitted to a dead queue and dropped, taking the answer
 *    and the reader-done with it.
 *
 * These tests hold the two rules that replaced them: nothing is admitted after
 * the sweep, and every completion runs somewhere.
 *
 * WHERE THE RACES ARE RACED AND WHERE THEY ARE STAGED. Two tests run 200 rounds
 * of submit-versus-close and assert exactly-once however the round interleaved;
 * neither asserts *which* way it went, because a coverage assertion on a
 * free-running race is a test that fails on an unlucky machine rather than on a
 * defect — an earlier version of one did exactly that. The interleavings that
 * matter are staged instead, deterministically: `close()` between admission and
 * hand-over, `close()` during the hand-over, and a completion arriving after the
 * executor is gone. That is also what makes them mutation-checkable — breaking
 * either half of the runner's state fails a named test rather than a lottery.
 */
class DetectionPassRunnerTest {

  private val nv21 = ByteArray(64) { 0x5A }
  private val faces = listOf(RoiRect(1, 2, 30, 40))

  /** Everything a submitted pass reported, in order, for exactly-once checks. */
  private class Log {
    val events = ConcurrentLinkedQueue<String>()
    val reported = ConcurrentLinkedQueue<List<RoiRect>>()

    fun onFaces(): (List<RoiRect>) -> Unit = {
      reported.add(it)
      events.add("faces")
    }

    fun onFailure(): () -> Unit = { events.add("failure") }

    fun onReaderDone(): () -> Unit = { events.add("reader-done") }

    /**
     * The analyser's reader-done, not a spy on it: the whole point of that
     * signal is that the owner zeroes the frame when it fires. A runner that
     * fires it early hands the next reader a wiped face, and only a callback
     * that actually wipes can show that.
     */
    fun onReaderDone(buffer: ByteArray): () -> Unit = {
      events.add("reader-done")
      buffer.fill(0)
    }

    fun count(name: String): Int = events.count { it == name }

    fun answers(): Int = count("faces") + count("failure")
  }

  /**
   * Play services, reduced to what the runner depends on: it takes a frame, it
   * hands back a completion later, and it does so on whatever executor it was
   * given rather than on one of its own choosing.
   */
  private class FakeDetector(private val refuse: Boolean = false) {
    private class Pending(val dispatcher: Executor, val onComplete: (List<RoiRect>?) -> Unit)

    private val pending = ConcurrentLinkedQueue<Pending>()
    val started = AtomicInteger(0)
    val buffers = ConcurrentLinkedQueue<ByteArray>()
    val readTags = ConcurrentLinkedQueue<Byte>()

    fun detection(): DetectionPassRunner.Detection =
      DetectionPassRunner.Detection { nv21, _, _, _, dispatcher, onComplete ->
        if (refuse) throw IllegalStateException("detector is closed")
        started.incrementAndGet()
        buffers.add(nv21)
        // Sampled at hand-over, which is the moment a real detector starts
        // reading. A zero here means the frame was declared free first.
        readTags.add(nv21[0])
        pending.add(Pending(dispatcher, onComplete))
      }

    fun pendingCount(): Int = pending.size

    /** Delivers one completion the way Play services would: through the executor. */
    fun complete(faces: List<RoiRect>?): Boolean {
      val next = pending.poll() ?: return false
      next.dispatcher.execute { next.onComplete(faces) }
      return true
    }
  }

  // -- nothing is admitted after the sweep ----------------------------------

  @Test
  fun `a request that races the close sweep is answered and freed exactly once`() {
    // The registration race itself. Before the fix, a submit that lost this
    // race registered into a map nobody would walk again: no answer, no
    // reader-done, a capture hung until its watchdog.
    //
    // Which thread wins is left to the scheduler, and which side of the race a
    // round lands on is therefore not asserted here -- a coverage assertion on
    // a free-running race is a test that fails on an unlucky machine rather
    // than on a defect. The two sides are covered *deterministically* by
    // `a request submitted after close ...` and by
    // `a close that lands while the frame is being handed over ...` below.
    // What every round must hold, however it interleaved, is exactly-once.
    repeat(RACE_ROUNDS) { round ->
      val log = Log()
      val detector = FakeDetector()
      val worker = Executors.newSingleThreadExecutor()
      val runner = runner(worker, detector)
      val start = CountDownLatch(1)
      val done = CountDownLatch(2)

      // Alternated so neither order is merely the one this JVM happens to
      // start first.
      val submitting = { runner.submit(nv21, 8, 8, 0, log.onFaces(), log.onFailure(), log.onReaderDone()) }
      val closing = { runner.close() }
      if (round % 2 == 0) {
        testThread(start, done, submitting)
        testThread(start, done, closing)
      } else {
        testThread(start, done, closing)
        testThread(start, done, submitting)
      }
      start.countDown()
      assertTrue(done.await(AWAIT_SECONDS, TimeUnit.SECONDS))

      // Whatever the detector still holds, it eventually completes -- a real
      // one either answers or is dropped, and both must end the same way here.
      detector.complete(faces)
      drain(worker)

      assertEquals("round $round answered ${log.answers()} times", 1, log.answers())
      assertEquals(
        "round $round released ${log.count("reader-done")} times",
        1,
        log.count("reader-done"),
      )
    }
  }

  @Test
  fun `a request submitted after close is never admitted at all`() {
    // Not merely "answered anyway": the finding was that a request could take
    // its place among the in-flight passes after the sweep had walked past, so
    // the rule is that it is refused at the door. The seam fires only for a
    // pass that got in, which is what makes that observable.
    val log = Log()
    val detector = FakeDetector()
    val admitted = AtomicInteger(0)
    val worker = Executors.newSingleThreadExecutor()
    val runner = DetectionPassRunner(
      callbackExecutor = worker,
      detection = detector.detection(),
      releaseDetector = {},
      shutdownTimeoutMs = SHUTDOWN_MS,
      onFrameAdmitted = { admitted.incrementAndGet() },
    )
    runner.close()

    runner.submit(nv21, 8, 8, 0, log.onFaces(), log.onFailure(), log.onReaderDone())

    assertEquals("a pass took its place after the sweep had walked past", 0, admitted.get())
    assertEquals(1, log.count("failure"))
    assertEquals(1, log.count("reader-done"))
    assertEquals("nothing may be handed to a closed detector", 0, detector.started.get())
    drain(worker)
  }

  @Test
  fun `a detector that refuses the frame answers and frees the request`() {
    // `InputImage.fromByteArray` on a buffer that does not describe the frame,
    // or `process` on a detector already closed: ML Kit never took the pixels,
    // so this is the one path where answering and freeing coincide.
    val log = Log()
    val detector = FakeDetector(refuse = true)
    val worker = Executors.newSingleThreadExecutor()
    val runner = runner(worker, detector)

    runner.submit(nv21, 8, 8, 0, log.onFaces(), log.onFailure(), log.onReaderDone())

    assertEquals(1, log.count("failure"))
    assertEquals(1, log.count("reader-done"))
    drain(worker)
  }

  @Test
  fun `a request that races the sweep is answered even if the detector never completes`() {
    // The same interleaving with the one assumption removed that was hiding
    // how bad the defect was: ML Kit does not promise to run a completion
    // listener for a task in flight when the detector is closed. That is what
    // made registering after the sweep fatal rather than untidy -- a pass no
    // sweep saw, and no completion answers, is a capture that hangs until its
    // watchdog. So this round delivers no completion at all, and the capture
    // must still have been answered by somebody.
    repeat(RACE_ROUNDS) { round ->
      val log = Log()
      val detector = FakeDetector()
      val worker = Executors.newSingleThreadExecutor()
      val runner = runner(worker, detector)
      val start = CountDownLatch(1)
      val done = CountDownLatch(2)

      // The frame is this round's own, and the reader-done really does zero it,
      // so a release that happens before the hand-over is visible as a wiped
      // face arriving at the detector rather than as a flag nobody reads.
      val frame = ByteArray(64) { 0x5A }
      val submitting = { runner.submit(frame, 8, 8, 0, log.onFaces(), log.onFailure(), log.onReaderDone(frame)) }
      val closing = { runner.close() }
      if (round % 2 == 0) {
        testThread(start, done, submitting)
        testThread(start, done, closing)
      } else {
        testThread(start, done, closing)
        testThread(start, done, submitting)
      }
      start.countDown()
      assertTrue(done.await(AWAIT_SECONDS, TimeUnit.SECONDS))
      drain(worker)

      assertEquals(
        "round $round left the capture unanswered: ${log.events.toList()}",
        1,
        log.answers(),
      )
      // And the pixels follow the rule addendum 24 set: freed exactly when no
      // detector was ever given them, held otherwise.
      val expectedReleases = if (detector.pendingCount() == 0) 1 else 0
      assertEquals(
        "round $round released ${log.count("reader-done")} times with " +
          "${detector.pendingCount()} passes still inside the detector",
        expectedReleases,
        log.count("reader-done"),
      )
      // The one that does not fail loudly: a detector handed a frame the
      // teardown had already declared free reads zeroes, measures them, and
      // reports the number as a quality score.
      for (tag in detector.readTags) {
        assertEquals("round $round handed the detector a wiped frame", 0x5A.toByte(), tag)
      }
    }
  }

  @Test
  fun `a close between admission and hand-over never lets a wiped frame reach the detector`() {
    // The narrowest window in the class, entered on purpose because two threads
    // racing for it reach it about as often as never. Inside it the pass has
    // been admitted and no detector has the frame, so the sweep is entitled to
    // free the pixels -- and must therefore also make sure they are never
    // handed on afterwards. Get that wrong and ML Kit is given a wiped face,
    // measures it, and the number is reported as a quality score: no throw, no
    // hang, just a quality verdict about zeroes.
    val frame = ByteArray(64) { 0x5A }
    val log = Log()
    val detector = FakeDetector()
    val worker = Executors.newSingleThreadExecutor()
    lateinit var runner: DetectionPassRunner
    runner = DetectionPassRunner(
      callbackExecutor = worker,
      detection = detector.detection(),
      releaseDetector = {},
      shutdownTimeoutMs = SHUTDOWN_MS,
      onFrameAdmitted = { runner.close() },
    )

    runner.submit(frame, 8, 8, 0, log.onFaces(), log.onFailure(), log.onReaderDone(frame))

    assertEquals("the capture was left unanswered", 1, log.answers())
    assertEquals("nobody had these pixels, so they had to be freed", 1, log.count("reader-done"))
    assertEquals(
      "a frame the teardown had already declared free reached the detector",
      0,
      detector.started.get(),
    )
    assertTrue(frame.all { it == 0.toByte() })
    drain(worker)
  }

  @Test
  fun `a close that lands while the frame is being handed over still answers it`() {
    // The dangerous window, made deterministic rather than raced for: the pass
    // has been admitted and marked as ML Kit's, and `close()` runs before the
    // completion listener has even been registered. This is the round the
    // free-running race above can only reach by luck.
    val log = Log()
    val worker = Executors.newSingleThreadExecutor()
    val released = AtomicInteger(0)
    lateinit var runner: DetectionPassRunner
    val pending = ConcurrentLinkedQueue<Pair<Executor, (List<RoiRect>?) -> Unit>>()
    runner = DetectionPassRunner(
      callbackExecutor = worker,
      detection = { _, _, _, _, dispatcher, onComplete ->
        // Play services has the frame; the teardown arrives now.
        runner.close()
        pending.add(dispatcher to onComplete)
      },
      releaseDetector = { released.incrementAndGet() },
      shutdownTimeoutMs = SHUTDOWN_MS,
    )

    runner.submit(nv21, 8, 8, 0, log.onFaces(), log.onFailure(), log.onReaderDone())

    assertEquals("the capture was left waiting on a detector that is gone", 1, log.answers())
    assertEquals(1, log.count("failure"))
    assertEquals("close() freed pixels ML Kit had been handed", 0, log.count("reader-done"))
    assertEquals(1, released.get())

    // The completion finally arrives, on an executor that is already shut down.
    val (dispatcher, onComplete) = pending.poll()!!
    dispatcher.execute { onComplete(faces) }
    drain(worker)

    assertEquals("the only evidence ML Kit stopped reading was dropped", 1, log.count("reader-done"))
    assertEquals("a settled request must not be answered twice", 1, log.answers())
  }

  // -- every completion runs somewhere --------------------------------------

  @Test
  fun `a completion that arrives after the executor is shut down still runs`() {
    // The second half of the finding. The listener used to be registered on the
    // callback executor directly, so a completion that Play services delivered
    // after `close()` was submitted to a dead queue and silently discarded --
    // and with it the reader-done that is the only thing that frees the frame.
    val log = Log()
    val detector = FakeDetector()
    val worker = Executors.newSingleThreadExecutor()
    val runner = runner(worker, detector)

    runner.submit(nv21, 8, 8, 0, log.onFaces(), log.onFailure(), log.onReaderDone())
    assertEquals(1, detector.pendingCount())

    runner.close()

    // Answered by the teardown; the pixels are still ML Kit's, so they are not
    // declared free yet.
    assertEquals(1, log.count("failure"))
    assertEquals(
      "close() declared a buffer free that ML Kit was handed",
      0,
      log.count("reader-done"),
    )
    assertTrue(worker.isShutdown)

    // Play services finally completes, long after the executor died.
    assertTrue(detector.complete(faces))
    drain(worker)

    assertEquals("the completion was dropped with the executor", 1, log.count("reader-done"))
    assertEquals("a settled request must not be answered twice", 1, log.answers())
    assertEquals(0, log.count("faces"))
  }

  @Test
  fun `a completion the executor rejects runs inline rather than vanishing`() {
    // The same rule with the failure made explicit rather than timed: an
    // executor that refuses work must not be able to swallow a completion.
    val log = Log()
    val detector = FakeDetector()
    val rejections = AtomicInteger(0)
    val worker = object : ExecutorService by Executors.newSingleThreadExecutor() {
      override fun execute(command: Runnable) {
        rejections.incrementAndGet()
        throw java.util.concurrent.RejectedExecutionException("queue is gone")
      }
    }
    val runner = runner(worker, detector)

    runner.submit(nv21, 8, 8, 0, log.onFaces(), log.onFailure(), log.onReaderDone())
    assertTrue(detector.complete(faces))

    assertTrue("the executor was never asked", rejections.get() > 0)
    assertEquals(1, log.count("faces"))
    assertEquals(1, log.count("reader-done"))
    assertEquals(faces, log.reported.single())
    runner.close()
  }

  // -- the ordinary paths ---------------------------------------------------

  @Test
  fun `an ordinary detection answers on the executor, then frees the buffer`() {
    val log = Log()
    val detector = FakeDetector()
    val worker = Executors.newSingleThreadExecutor()
    val runner = runner(worker, detector)

    runner.submit(nv21, 8, 8, 0, log.onFaces(), log.onFailure(), log.onReaderDone())
    assertTrue(detector.complete(faces))
    drain(worker)

    assertEquals(listOf("faces", "reader-done"), log.events.toList())
    assertEquals(faces, log.reported.single())
    // The buffer is the caller's, untouched: zeroing it is the analyser's job,
    // keyed on the reader-done this reports.
    assertTrue(nv21.all { it == 0x5A.toByte() })
  }

  @Test
  fun `the reader-done never precedes the faces that hand the buffer on`() {
    // The one ordering the analyser depends on: its second model takes the
    // buffer over from inside `onFaces`, so a reader-done arriving first would
    // let the ownership count reach zero mid-hand-over and wipe the frame the
    // landmarker is about to read.
    repeat(RACE_ROUNDS) { round ->
      val log = Log()
      val detector = FakeDetector()
      val worker = Executors.newSingleThreadExecutor()
      val runner = runner(worker, detector)
      runner.submit(nv21, 8, 8, 0, log.onFaces(), log.onFailure(), log.onReaderDone())

      val start = CountDownLatch(1)
      val done = CountDownLatch(2)
      testThread(start, done) { detector.complete(faces) }
      testThread(start, done) { runner.close() }
      start.countDown()
      assertTrue(done.await(AWAIT_SECONDS, TimeUnit.SECONDS))
      detector.complete(faces)
      drain(worker)

      val events = log.events.toList()
      if (events.contains("faces")) {
        assertEquals(
          "round $round released the buffer before handing it on: $events",
          listOf("faces", "reader-done"),
          events,
        )
      }
      assertEquals("round $round answered ${log.answers()} times", 1, log.answers())
      assertEquals(1, log.count("reader-done"))
    }
  }

  @Test
  fun `a failed detection is an answer, not silence`() {
    val log = Log()
    val detector = FakeDetector()
    val worker = Executors.newSingleThreadExecutor()
    val runner = runner(worker, detector)

    runner.submit(nv21, 8, 8, 0, log.onFaces(), log.onFailure(), log.onReaderDone())
    assertTrue(detector.complete(null))
    drain(worker)

    assertEquals(listOf("failure", "reader-done"), log.events.toList())
    runner.close()
  }

  @Test
  fun `several requests in flight are all settled by one close`() {
    val logs = List(4) { Log() }
    val detector = FakeDetector()
    val worker = Executors.newSingleThreadExecutor()
    val runner = runner(worker, detector)
    for (log in logs) {
      runner.submit(nv21, 8, 8, 0, log.onFaces(), log.onFailure(), log.onReaderDone())
    }

    runner.close()

    for (log in logs) assertEquals(1, log.count("failure"))
    // Each one is still ML Kit's until its own completion says otherwise.
    for (log in logs) assertEquals(0, log.count("reader-done"))
    while (detector.complete(null)) Unit
    drain(worker)
    for (log in logs) {
      assertEquals(1, log.count("reader-done"))
      assertEquals(1, log.answers())
    }
  }

  @Test
  fun `close is idempotent and releases the detector once`() {
    val released = AtomicInteger(0)
    val detector = FakeDetector()
    val worker = Executors.newSingleThreadExecutor()
    val runner = DetectionPassRunner(
      callbackExecutor = worker,
      detection = detector.detection(),
      releaseDetector = { released.incrementAndGet() },
      shutdownTimeoutMs = SHUTDOWN_MS,
    )

    assertFalse(runner.isDetectorReleased())
    runner.close()
    runner.close()
    runner.close()

    assertEquals(1, released.get())
    assertTrue(runner.isDetectorReleased())
  }

  @Test
  fun `concurrent closes release the detector once and settle every request`() {
    repeat(RACE_ROUNDS / 4) { round ->
      val released = AtomicInteger(0)
      val log = Log()
      val detector = FakeDetector()
      val worker = Executors.newSingleThreadExecutor()
      val runner = DetectionPassRunner(
        callbackExecutor = worker,
        detection = detector.detection(),
        releaseDetector = { released.incrementAndGet() },
        shutdownTimeoutMs = SHUTDOWN_MS,
      )
      runner.submit(nv21, 8, 8, 0, log.onFaces(), log.onFailure(), log.onReaderDone())

      val start = CountDownLatch(1)
      val done = CountDownLatch(3)
      repeat(3) { testThread(start, done) { runner.close() } }
      start.countDown()
      assertTrue(done.await(AWAIT_SECONDS, TimeUnit.SECONDS))
      detector.complete(faces)
      drain(worker)

      assertEquals("round $round released the detector ${released.get()} times", 1, released.get())
      assertEquals(1, log.answers())
      assertEquals(1, log.count("reader-done"))
    }
  }

  private fun runner(worker: ExecutorService, detector: FakeDetector) = DetectionPassRunner(
    callbackExecutor = worker,
    detection = detector.detection(),
    releaseDetector = {},
    shutdownTimeoutMs = SHUTDOWN_MS,
  )

  /** Lets whatever the executor still holds run before the assertions. */
  private fun drain(worker: ExecutorService) {
    worker.shutdown()
    assertTrue(worker.awaitTermination(AWAIT_SECONDS, TimeUnit.SECONDS))
  }

  private companion object {
    const val AWAIT_SECONDS = 5L
    const val RACE_ROUNDS = 200
    const val SHUTDOWN_MS = 50L
  }
}
