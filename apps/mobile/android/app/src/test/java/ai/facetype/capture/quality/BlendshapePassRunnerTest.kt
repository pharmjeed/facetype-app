package ai.facetype.capture.quality

import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The blendshape pass lifecycle, driven against a real executor with a real
 * thread in it.
 *
 * THE P0 THIS FILE EXISTS FOR (Codex review `2026-08-26T23-29-26Z`). The first
 * version of the handle settled every in-flight pass on `close()` by calling
 * its failure callback straight away. That callback reached the analyser, which
 * zeroed the request's pixels — while a worker could be part-way through
 * reading those same bytes. Nothing throws in that scenario. A model is handed
 * a half-zeroed face, measures it, and the number is reported as a quality
 * score. The same `close()` then released the native task after a 500 ms wait
 * whether or not a call was still inside it.
 *
 * These tests park a reader mid-read with a latch, so the window that used to
 * be a race is a state the test can stand still in and assert about.
 */
class BlendshapePassRunnerTest {

  private val nv21 = ByteArray(64) { 0x5A }

  /** Everything a submitted pass reported, in order, for exactly-once checks. */
  private class Log {
    val events = ConcurrentLinkedQueue<String>()
    val activations = ConcurrentLinkedQueue<Map<String, Float>>()

    fun onBlendshapes(): (Map<String, Float>) -> Unit = {
      activations.add(it)
      events.add("blendshapes")
    }

    fun onFailure(): () -> Unit = { events.add("failure") }

    fun onReaderDone(): () -> Unit = { events.add("reader-done") }

    fun count(name: String): Int = events.count { it == name }
  }

  @Test
  fun `close does not free the pixels of a pass a worker is reading`() {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val log = Log()
    val modelClosed = AtomicInteger(0)
    val reapers = ConcurrentLinkedQueue<Runnable>()
    val worker = Executors.newSingleThreadExecutor()
    val runner = BlendshapePassRunner(
      worker = worker,
      measure = { _, _, _, _ ->
        entered.countDown()
        release.await()
        RESTING_ACTIVATIONS
      },
      releaseModel = { modelClosed.incrementAndGet() },
      startReaper = { reapers.add(it) },
      shutdownTimeoutMs = 50,
    )

    runner.submit(nv21, 8, 8, 0, log.onBlendshapes(), log.onFailure(), log.onReaderDone())
    assertTrue("the worker never started", entered.await(AWAIT_SECONDS, TimeUnit.SECONDS))

    runner.close()

    // The request is answered -- nothing waits on a model being torn down ...
    assertEquals(1, log.count("failure"))
    // ... but the reader has not let go, so the pixels are still spoken for.
    assertEquals("close() declared a live reader's buffer free", 0, log.count("reader-done"))
    // And the native task is untouched while a thread is inside it.
    assertEquals("close() released the model under a running detect", 0, modelClosed.get())
    assertEquals("teardown must hand the wait to a reaper, not block", 1, reapers.size)

    release.countDown()
    worker.shutdown()
    assertTrue(worker.awaitTermination(AWAIT_SECONDS, TimeUnit.SECONDS))

    // Now the reader has finished, exactly once, and after its answer.
    assertEquals(1, log.count("reader-done"))
    assertEquals("the answer must not be repeated", 1, log.count("failure"))
    assertEquals("a cancelled request gets no late answer", 0, log.count("blendshapes"))

    // The reaper, run now that the worker really has terminated, releases the
    // model -- and only then.
    reapers.poll()!!.run()
    assertEquals(1, modelClosed.get())
    assertTrue(runner.isModelReleased())
  }

  @Test
  fun `a pass no worker claimed is both answered and freed by close`() {
    // The other side of the same rule: these pixels were never read, so there
    // is nobody to wait for and close() can free them immediately.
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val first = Log()
    val second = Log()
    val worker = Executors.newSingleThreadExecutor()
    val runner = BlendshapePassRunner(
      worker = worker,
      measure = { _, _, _, _ ->
        entered.countDown()
        release.await()
        RESTING_ACTIVATIONS
      },
      releaseModel = {},
      startReaper = {},
      shutdownTimeoutMs = 50,
    )

    // The first pass occupies the single worker thread; the second queues.
    runner.submit(nv21, 8, 8, 0, first.onBlendshapes(), first.onFailure(), first.onReaderDone())
    assertTrue(entered.await(AWAIT_SECONDS, TimeUnit.SECONDS))
    runner.submit(nv21, 8, 8, 0, second.onBlendshapes(), second.onFailure(), second.onReaderDone())

    runner.close()

    assertEquals(1, second.count("failure"))
    assertEquals("an unread buffer is free the moment its pass is cancelled", 1, second.count("reader-done"))
    assertEquals(0, first.count("reader-done"))

    release.countDown()
    worker.shutdown()
    assertTrue(worker.awaitTermination(AWAIT_SECONDS, TimeUnit.SECONDS))
    assertEquals(1, first.count("reader-done"))
    // The queued pass must never have read a byte after close() freed it.
    assertEquals(0, second.count("blendshapes"))
  }

  @Test
  fun `a worker that lost its claim does not read the buffer`() {
    // The claim is taken before the first read, so losing it means the pass
    // never touches the pixels. Proven by mutating the buffer after close():
    // a measure() that ran would see the change.
    val readSnapshots = ConcurrentLinkedQueue<Byte>()
    val started = CountDownLatch(1)
    val hold = CountDownLatch(1)
    val blocker = Log()
    val queued = Log()
    val worker = Executors.newSingleThreadExecutor()
    val runner = BlendshapePassRunner(
      worker = worker,
      measure = { buffer, _, _, _ ->
        started.countDown()
        hold.await()
        readSnapshots.add(buffer[0])
        RESTING_ACTIVATIONS
      },
      releaseModel = {},
      startReaper = {},
      shutdownTimeoutMs = 50,
    )

    runner.submit(nv21, 8, 8, 0, blocker.onBlendshapes(), blocker.onFailure(), blocker.onReaderDone())
    assertTrue(started.await(AWAIT_SECONDS, TimeUnit.SECONDS))
    val queuedBuffer = ByteArray(64) { 0x11 }
    runner.submit(queuedBuffer, 8, 8, 0, queued.onBlendshapes(), queued.onFailure(), queued.onReaderDone())

    runner.close()
    // close() said this buffer is free, so its owner may reuse it. If the
    // queued worker still read it, it would see these bytes.
    queuedBuffer.fill(0)

    hold.countDown()
    worker.shutdown()
    assertTrue(worker.awaitTermination(AWAIT_SECONDS, TimeUnit.SECONDS))

    assertEquals("only the claiming pass ever read a buffer", 1, readSnapshots.size)
    assertEquals(0x5A.toByte(), readSnapshots.poll())
    assertEquals(0, queued.count("blendshapes"))
  }

  @Test
  fun `a pass submitted after close is answered and freed without running`() {
    val log = Log()
    val measured = AtomicInteger(0)
    val worker = Executors.newSingleThreadExecutor()
    val runner = BlendshapePassRunner(
      worker = worker,
      measure = { _, _, _, _ -> measured.incrementAndGet(); RESTING_ACTIVATIONS },
      releaseModel = {},
      startReaper = {},
      shutdownTimeoutMs = 50,
    )
    runner.close()

    runner.submit(nv21, 8, 8, 0, log.onBlendshapes(), log.onFailure(), log.onReaderDone())

    assertEquals(1, log.count("failure"))
    assertEquals(1, log.count("reader-done"))
    assertEquals("nothing may read a buffer after close", 0, measured.get())
  }

  @Test
  fun `a pass that races the close sweep is still answered and freed exactly once`() {
    // The registration race Codex asked for: submit() and close() interleaving
    // such that the sweep can run before or after the pass is registered.
    // Whichever order wins, the pass must settle once and free once.
    repeat(RACE_ROUNDS) { round ->
      val log = Log()
      val worker = Executors.newSingleThreadExecutor()
      val runner = BlendshapePassRunner(
        worker = worker,
        measure = { _, _, _, _ -> RESTING_ACTIVATIONS },
        releaseModel = {},
        startReaper = {},
        shutdownTimeoutMs = 50,
      )
      val start = CountDownLatch(1)
      val done = CountDownLatch(2)
      // testThread starts the thread it returns; both park on `start`.
      testThread(start, done) {
        runner.submit(nv21, 8, 8, 0, log.onBlendshapes(), log.onFailure(), log.onReaderDone())
      }
      testThread(start, done) { runner.close() }
      start.countDown()
      assertTrue(done.await(AWAIT_SECONDS, TimeUnit.SECONDS))
      worker.shutdown()
      assertTrue(worker.awaitTermination(AWAIT_SECONDS, TimeUnit.SECONDS))

      val answers = log.count("blendshapes") + log.count("failure")
      assertEquals("round $round answered $answers times", 1, answers)
      assertEquals(
        "round $round released ${log.count("reader-done")} times",
        1,
        log.count("reader-done"),
      )
      // Exactly-once is the guarantee; the ORDER of the two is not, and this
      // test is where that was settled. An earlier version asserted that the
      // reader-done came last and failed at round 55: a teardown thread can
      // win the right to answer, be descheduled between taking that right and
      // calling the callback, and have the worker free the buffer in between.
      // Fixing the assertion rather than the code is the right way round --
      // pinning the order would mean invoking a caller's callback while
      // holding this class's lock, and nothing needs the order. See
      // BlendshapePassRunner.submit.
    }
  }

  @Test
  fun `a measure that throws still frees the buffer and fails the pass`() {
    val log = Log()
    val worker = Executors.newSingleThreadExecutor()
    val runner = BlendshapePassRunner(
      worker = worker,
      measure = { _, _, _, _ -> throw IllegalStateException("model exploded") },
      releaseModel = {},
      startReaper = {},
      shutdownTimeoutMs = AWAIT_SECONDS * 1_000,
    )

    runner.submit(nv21, 8, 8, 0, log.onBlendshapes(), log.onFailure(), log.onReaderDone())
    runner.close()

    assertEquals(1, log.count("failure"))
    assertEquals("a throwing read still lets go of the buffer", 1, log.count("reader-done"))
    assertEquals(0, log.count("blendshapes"))
  }

  @Test
  fun `an ordinary pass answers, frees, and closes the model inline`() {
    val log = Log()
    val answered = CountDownLatch(1)
    val modelClosed = AtomicInteger(0)
    val reaped = AtomicInteger(0)
    val worker = Executors.newSingleThreadExecutor()
    val runner = BlendshapePassRunner(
      worker = worker,
      measure = { _, _, _, _ -> RESTING_ACTIVATIONS },
      releaseModel = { modelClosed.incrementAndGet() },
      startReaper = { reaped.incrementAndGet() },
      shutdownTimeoutMs = AWAIT_SECONDS * 1_000,
    )

    runner.submit(
      nv21,
      8,
      8,
      0,
      { activations -> log.onBlendshapes()(activations); answered.countDown() },
      log.onFailure(),
      log.onReaderDone(),
    )
    // Let the pass finish before tearing down. Closing immediately after
    // submitting is a *cancellation*, which the tests above cover; this one is
    // about the ordinary completion path.
    assertTrue("the pass never completed", answered.await(AWAIT_SECONDS, TimeUnit.SECONDS))

    runner.close()

    assertEquals(1, log.count("blendshapes"))
    assertEquals(1, log.count("reader-done"))
    assertEquals(RESTING_ACTIVATIONS, log.activations.single())
    assertEquals("nothing was still running, so no reaper was needed", 0, reaped.get())
    assertEquals(1, modelClosed.get())
    assertTrue(runner.isModelReleased())
  }

  @Test
  fun `closing before the worker starts cancels the pass without reading it`() {
    // The mirror of the test above, and the reason it needed a latch: a close()
    // that lands between submit() and the worker picking the task up cancels
    // the pass outright, and nothing ever looks at the pixels.
    val log = Log()
    val measured = AtomicInteger(0)
    val worker = Executors.newSingleThreadExecutor()
    val runner = BlendshapePassRunner(
      worker = worker,
      measure = { _, _, _, _ -> measured.incrementAndGet(); RESTING_ACTIVATIONS },
      releaseModel = {},
      startReaper = {},
      shutdownTimeoutMs = AWAIT_SECONDS * 1_000,
    )

    runner.submit(nv21, 8, 8, 0, log.onBlendshapes(), log.onFailure(), log.onReaderDone())
    runner.close()
    worker.shutdown()
    assertTrue(worker.awaitTermination(AWAIT_SECONDS, TimeUnit.SECONDS))

    // Whoever won, the pass settled once and freed once.
    assertEquals(1, log.count("blendshapes") + log.count("failure"))
    assertEquals(1, log.count("reader-done"))
    // And if close() won the claim, measure() never ran at all.
    if (log.count("failure") == 1) assertEquals(0, measured.get())
  }

  @Test
  fun `close is idempotent and releases the model once`() {
    val modelClosed = AtomicInteger(0)
    val worker = Executors.newSingleThreadExecutor()
    val runner = BlendshapePassRunner(
      worker = worker,
      measure = { _, _, _, _ -> RESTING_ACTIVATIONS },
      releaseModel = { modelClosed.incrementAndGet() },
      startReaper = {},
      shutdownTimeoutMs = AWAIT_SECONDS * 1_000,
    )

    runner.close()
    runner.close()
    runner.close()

    assertEquals(1, modelClosed.get())
  }

  @Test
  fun `the buffer handed in is never modified by the runner itself`() {
    // Zeroing is the caller's job, keyed on the reader-done. A runner that
    // wiped the buffer would be making that decision on the caller's behalf,
    // which is the whole defect this design removes.
    val original = nv21.copyOf()
    val log = Log()
    val worker = Executors.newSingleThreadExecutor()
    val runner = BlendshapePassRunner(
      worker = worker,
      measure = { _, _, _, _ -> RESTING_ACTIVATIONS },
      releaseModel = {},
      startReaper = {},
      shutdownTimeoutMs = AWAIT_SECONDS * 1_000,
    )

    runner.submit(nv21, 8, 8, 0, log.onBlendshapes(), log.onFailure(), log.onReaderDone())
    runner.close()

    assertArrayEquals(original, nv21)
    assertFalse(nv21.all { it == 0.toByte() })
  }

  private companion object {
    const val AWAIT_SECONDS = 5L
    const val RACE_ROUNDS = 200
  }
}
