package ai.facetype.capture.quality

import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The lifecycle rules, driven through the object the product uses.
 *
 * Every test here calls [PreviewSessionCoordinator] — the same instance
 * `FaceTypePreviewView` holds — with fake resources. Nothing re-implements the
 * locking, the phases or the ownership, which is what the previous harness did
 * and why it could pass while the product was wrong.
 *
 * HOW THESE OPEN THE WINDOWS THEY TEST. The interesting moment is after a
 * transition has taken its resources and its place in the queue but before it
 * has done any work. Settlement runs exactly there by design, so a
 * [FakeCapture.settleGate] parks a transition in that window and lets a later
 * one try to overtake it — or, in the reentrancy test, lets the settlement call
 * straight back into the coordinator the way a React Native Promise does.
 *
 * There is no `Thread.sleep` anywhere: every ordering is pinned with a latch,
 * so a slow machine makes the suite slower, never flakier.
 */
class PreviewSessionCoordinatorTest {

  private val log = ResourceLog()
  private val ops = FakeSessionOps(log)
  private val detached = ConcurrentLinkedQueue<Throwable>()
  private val coordinator =
    PreviewSessionCoordinator<FakeSession, FakeAnalyzer, FakeStart, FakeCapture>(
      ops,
      onDetachedError = { detached.add(it) },
    )
  private val captureIds = AtomicLong(0)

  private fun ready(): FakeAnalyzer {
    val epoch = coordinator.surfaceCreated()!!
    val start = FakeStart()
    assertTrue(coordinator.beginStart(start) is StartOutcome.Accepted)
    val claimed = coordinator.claimStart(epoch)
    assertTrue(claimed is ClaimResult.Claimed)
    val analyzer = FakeAnalyzer(log)
    val install = coordinator.installSession(epoch, FakeSession(), analyzer)
    assertTrue(install is InstallOutcome.Installed)
    assertNull((install as InstallOutcome.Installed).error)
    return analyzer
  }

  private fun accept(): FakeCapture {
    val request = FakeCapture(captureIds.incrementAndGet())
    assertTrue(coordinator.acceptCapture(request, nowNs = 0))
    return request
  }

  private fun closeRelease(): Throwable? = coordinator.close(
    PreviewPhase.RELEASED,
    settleStart = { it.settle(log) },
    settleCapture = { it.settle(log) },
  )

  private fun closeStop(): Throwable? = coordinator.close(
    PreviewPhase.READY,
    settleStart = { it.settle(log) },
    settleCapture = { it.settle(log) },
  )

  private fun daemon(body: () -> Unit): Thread =
    Thread(body).apply { isDaemon = true; start() }

  /** A thread that runs [body] and opens a latch when it returns. */
  private fun signalling(done: CountDownLatch, body: () -> Unit): Thread =
    daemon {
      try {
        body()
      } finally {
        done.countDown()
      }
    }

  // -- start ---------------------------------------------------------------

  @Test
  fun `a start before the surface exists is refused, not queued`() {
    val outcome = coordinator.beginStart(FakeStart())

    assertTrue(outcome is StartOutcome.Refused)
    assertEquals(PreviewPhase.AWAITING_SURFACE, coordinator.phase())
  }

  @Test
  fun `a session built against a stale epoch is handed back, not installed`() {
    val epoch = coordinator.surfaceCreated()!!
    coordinator.beginStart(FakeStart())
    coordinator.claimStart(epoch)
    // A surface rebuild between claiming the start and finishing the build.
    coordinator.surfaceCreated()

    val install = coordinator.installSession(epoch, FakeSession(), FakeAnalyzer(log))

    assertTrue(install is InstallOutcome.Rejected)
    assertFalse(coordinator.hasSession())
  }

  @Test
  fun `a start accepted before a close is handed back by it`() {
    coordinator.surfaceCreated()
    val start = FakeStart()
    coordinator.beginStart(start)

    closeRelease()

    assertEquals(1, start.settlements.get())
  }

  @Test
  fun `a start is refused while a close is still running`() {
    ready()
    val gate = CountDownLatch(1)
    ops.closeGate = gate
    val closer = daemon { closeStop() }
    assertTrue(ops.closeEntered.await(10, TimeUnit.SECONDS))

    assertEquals(PreviewPhase.CLOSING, coordinator.phase())
    val refused = coordinator.beginStart(FakeStart())
    assertTrue(refused is StartOutcome.Refused)

    gate.countDown()
    closer.join(10_000)
    assertEquals(PreviewPhase.READY, coordinator.phase())
  }

  @Test
  fun `a start overtaken by a host pause is rejected at install, not parked`() {
    // Every transition bumps the epoch, so a start accepted while the preview
    // was live and then overtaken by a host pause is *stale* by the time its
    // session is built. It is handed back to be closed. The park is a different
    // case — see the test below.
    val epoch = coordinator.surfaceCreated()!!
    val start = FakeStart()
    assertTrue(coordinator.beginStart(start) is StartOutcome.Accepted)
    assertTrue(coordinator.claimStart(epoch) is ClaimResult.Claimed)

    coordinator.pause { it.settle(log) }

    val built = FakeSession()
    val install = coordinator.installSession(epoch, built, FakeAnalyzer(log))

    assertTrue(
      "a start whose epoch moved on must not be installed",
      install is InstallOutcome.Rejected,
    )
    assertSame(built, (install as InstallOutcome.Rejected).session)
    assertFalse(coordinator.hasSession())
    assertEquals("there was no session to pause", 0, ops.pauses.get())
  }

  @Test
  fun `a start accepted while the host is away parks its session`() {
    // Production shape: the start is accepted *in* PAUSED, so the epoch it
    // carries is the one the install is checked against and the park is
    // reachable.
    coordinator.surfaceCreated()
    coordinator.pause { it.settle(log) }
    assertEquals(PreviewPhase.PAUSED, coordinator.phase())

    val accepted = coordinator.beginStart(FakeStart())
    assertTrue(accepted is StartOutcome.Accepted)
    val epoch = (accepted as StartOutcome.Accepted).epoch
    assertTrue(coordinator.claimStart(epoch) is ClaimResult.Claimed)

    val pauseGate = CountDownLatch(1)
    ops.pauseGate = pauseGate
    val installed = AtomicReference<InstallOutcome<FakeSession>?>(null)
    val installer = daemon {
      installed.set(coordinator.installSession(epoch, FakeSession(), FakeAnalyzer(log)))
    }
    assertTrue(ops.pauseEntered.await(10, TimeUnit.SECONDS))
    assertEquals(PreviewPhase.PAUSING, coordinator.phase())

    // The host comes back while the park is still running. The intent is
    // recorded at once; the work queues behind the park.
    val resumeDone = CountDownLatch(1)
    signalling(resumeDone) { coordinator.resume() }

    pauseGate.countDown()
    installer.join(10_000)
    assertTrue(resumeDone.await(10, TimeUnit.SECONDS))

    assertNull((installed.get() as InstallOutcome.Installed).error)
    assertEquals(PreviewPhase.READY, coordinator.phase())
    assertFalse("the resume must have un-parked the session", coordinator.isSessionPaused())
    assertEquals(listOf("pause", "resume"), ops.sessionEvents())
    assertEquals(0, ops.overlaps.get())
  }

  @Test
  fun `a park that fails is reported to the caller, not answered as a success`() {
    // THE FAILURE (Codex review of `45c663c`, P0-3). `installSession` returned
    // `Installed` whatever the park did, so a start Promise resolved while the
    // session it was supposed to have produced had just been released.
    coordinator.surfaceCreated()
    coordinator.pause { it.settle(log) }
    val accepted = coordinator.beginStart(FakeStart()) as StartOutcome.Accepted
    coordinator.claimStart(accepted.epoch)
    ops.pauseThrows = true

    val install = coordinator.installSession(accepted.epoch, FakeSession(), FakeAnalyzer(log))

    assertTrue(install is InstallOutcome.Installed)
    assertNotNull(
      "a park that failed must not be reported as a start that worked",
      (install as InstallOutcome.Installed).error,
    )
    assertFalse("a session that would not park must not be kept", coordinator.hasSession())
    assertEquals(1, ops.closes.get())
  }

  // -- teardown ------------------------------------------------------------

  @Test
  fun `the capture is settled before anything that can block is called`() {
    ready()
    val capture = accept()
    val gate = CountDownLatch(1)
    ops.closeGate = gate
    val closer = daemon { closeRelease() }

    assertTrue(ops.closeEntered.await(10, TimeUnit.SECONDS))
    assertEquals("settled before the close was even entered", 1, capture.settlements.get())
    assertEquals(0, ops.closes.get())

    gate.countDown()
    closer.join(10_000)
    assertEquals(1, ops.closes.get())
  }

  @Test
  fun `a blocked close holds no lock, so other work still runs`() {
    ready()
    accept()
    val gate = CountDownLatch(1)
    ops.closeGate = gate
    val closer = daemon { closeRelease() }
    assertTrue(ops.closeEntered.await(10, TimeUnit.SECONDS))

    // Every one of these takes the coordinator's lock. If the teardown were
    // holding it across the close, none could return.
    val ranWhileBlocked = CountDownLatch(1)
    signalling(ranWhileBlocked) {
      coordinator.phase()
      coordinator.acceptCapture(FakeCapture(99), nowNs = 0)
      coordinator.withRunningSession { _, _, _ -> Unit }
      coordinator.beginStart(FakeStart())
    }

    assertTrue(
      "the coordinator's lock must be free while the close blocks",
      ranWhileBlocked.await(10, TimeUnit.SECONDS),
    )

    gate.countDown()
    closer.join(10_000)
  }

  @Test
  fun `the analyser is closed before the session, so ML Kit is always released`() {
    ready()

    closeRelease()

    assertTrue(log.indexOf("close-analyzer") >= 0)
    assertTrue(
      "analyser at ${log.indexOf("close-analyzer")}, session at ${log.indexOf("close-session")}",
      log.indexOf("close-analyzer") < log.indexOf("close-session"),
    )
  }

  @Test
  fun `a settlement that throws does not stop the resources being released`() {
    ready()
    val capture = accept()
    capture.throwOnSettle = true

    val error = closeRelease()

    assertEquals(1, capture.settlements.get())
    assertEquals(1, ops.closes.get())
    assertEquals(1, log.snapshot().count { it == "close-analyzer" })
    assertNotNull("the failure is reported, not hidden", error)
  }

  @Test
  fun `a close whose session will not release does not report the preview as usable`() {
    // THE FAILURE, and the previous version of this test codified it (Codex
    // review of `e4457d2`, P0-2). A `Session.close()` that threw was recorded
    // and then the phase landed `READY` anyway — so the preview accepted a
    // start and built a second session on top of one that may still own the
    // camera. A release nobody can vouch for is not a release.
    ready()
    ops.closeThrows = true

    val error = closeStop()

    assertNotNull(error)
    assertEquals(1, log.snapshot().count { it == "close-analyzer" })
    assertEquals(
      "a release we cannot vouch for is not a preview we can hand out",
      PreviewPhase.FAILED,
      coordinator.phase(),
    )
    assertTrue(coordinator.beginStart(FakeStart()) is StartOutcome.Refused)
    assertNull(coordinator.withRunningSession { _, _, _ -> Unit })

    // Recoverable, not bricked: a rebuilt surface is the app's own "try again",
    // and if the camera really is still held the next start fails with a real
    // ARCore error rather than a guess of ours.
    coordinator.surfaceCreated()
    assertEquals(PreviewPhase.READY, coordinator.phase())
    assertTrue(coordinator.beginStart(FakeStart()) is StartOutcome.Accepted)
  }

  @Test
  fun `a stop from inside a settlement reports the failure it cannot return`() {
    // THE FAILURE (Codex review of `e4457d2`, P0-3). A re-entrant caller is
    // answered `null` immediately — it is standing inside the drain that will
    // run its work — but the transition was still marked as owned, so nobody
    // reported its failure either. A stop that could not free the camera
    // returned success and said nothing.
    ready()
    val capture = accept()
    ops.closeThrows = true

    val done = CountDownLatch(1)
    signalling(done) {
      coordinator.pause { request ->
        request.settle(log)
        assertNull("a re-entrant caller is answered at once", closeRelease())
      }
    }

    assertTrue(done.await(10, TimeUnit.SECONDS))
    assertEquals(1, capture.settlements.get())
    assertEquals(1, ops.closes.get())
    assertEquals(
      "a re-entrant release that could not free the camera said nothing at all",
      1,
      detached.size,
    )
    assertEquals(PreviewPhase.RELEASED, coordinator.phase())
  }

  @Test
  fun `a pause whose frames never drain still releases the camera`() {
    // THE FAILURE (Codex review of `e4457d2`, P0-1). When the drain timed out,
    // the host-sync recorded the failure and returned. The Session was left
    // resumed and still owning the camera, `sessionPaused` stayed false, and
    // the phase derived to `PAUSED` from host intent — so the app went to the
    // background with the camera running and the preview saying otherwise.
    val log = ResourceLog()
    val ops = FakeSessionOps(log)
    val detached = ConcurrentLinkedQueue<Throwable>()
    val coordinator = PreviewSessionCoordinator<FakeSession, FakeAnalyzer, FakeStart, FakeCapture>(
      ops,
      frameDrainTimeoutMs = 100,
      onDetachedError = { detached.add(it) },
    )
    val epoch = coordinator.surfaceCreated()!!
    coordinator.installSession(epoch, FakeSession(), FakeAnalyzer(log))

    val inFrame = CountDownLatch(1)
    val releaseFrame = CountDownLatch(1)
    val frame = Thread {
      coordinator.withRunningSession { _, _, _ ->
        inFrame.countDown()
        releaseFrame.await(30, TimeUnit.SECONDS)
        Unit
      }
    }.apply { isDaemon = true; start() }
    assertTrue(inFrame.await(10, TimeUnit.SECONDS))

    val error = coordinator.pause { it.settle(log) }

    assertNotNull("the drain timeout is reported, not swallowed", error)
    assertEquals("nothing may be paused while a frame is inside it", 0, ops.pauses.get())
    assertFalse("the session must have been taken for release", coordinator.hasSession())
    assertEquals(1, coordinator.pendingReleases())
    assertEquals(PreviewPhase.CLOSING, coordinator.phase())

    releaseFrame.countDown()
    frame.join(10_000)

    assertEquals(
      "the camera is released, not left running behind a phase that says PAUSED",
      1,
      ops.closes.get(),
    )
    assertEquals(0, coordinator.pendingReleases())
    assertEquals(PreviewPhase.PAUSED, coordinator.phase())
  }

  @Test
  fun `a deferred release that fails leaves the preview unusable rather than startable`() {
    // THE FAILURE (Codex review of `e4457d2`, P1-4). `retireLease` stopped
    // counting the loan whatever the close did, so a release that threw still
    // returned the preview to a startable state.
    val log = ResourceLog()
    val ops = FakeSessionOps(log)
    val detached = ConcurrentLinkedQueue<Throwable>()
    val coordinator = PreviewSessionCoordinator<FakeSession, FakeAnalyzer, FakeStart, FakeCapture>(
      ops,
      frameDrainTimeoutMs = 100,
      onDetachedError = { detached.add(it) },
    )
    val epoch = coordinator.surfaceCreated()!!
    coordinator.installSession(epoch, FakeSession(), FakeAnalyzer(log))
    ops.closeThrows = true

    val inFrame = CountDownLatch(1)
    val releaseFrame = CountDownLatch(1)
    val frame = Thread {
      coordinator.withRunningSession { _, _, _ ->
        inFrame.countDown()
        releaseFrame.await(30, TimeUnit.SECONDS)
        Unit
      }
    }.apply { isDaemon = true; start() }
    assertTrue(inFrame.await(10, TimeUnit.SECONDS))

    coordinator.close(
      PreviewPhase.READY,
      settleStart = { it.settle(log) },
      settleCapture = { it.settle(log) },
    )
    assertEquals(1, coordinator.pendingReleases())

    releaseFrame.countDown()
    frame.join(10_000)

    assertEquals(0, coordinator.pendingReleases())
    assertEquals(
      "a deferred release that threw leaves the same doubt as any other",
      PreviewPhase.FAILED,
      coordinator.phase(),
    )
    assertTrue(coordinator.beginStart(FakeStart()) is StartOutcome.Refused)
    assertEquals("and it is reported, not swallowed", 1, detached.size)
  }

  @Test
  fun `a preview is not startable while a deferred release is still running`() {
    // Counting the loan only around the *deferred* branch left a window: if the
    // frames drained between the timeout and the hand-off, the release ran
    // immediately and uncounted, and the preview looked usable while a
    // `Session.close()` was still in progress.
    val log = ResourceLog()
    val ops = FakeSessionOps(log)
    val coordinator = PreviewSessionCoordinator<FakeSession, FakeAnalyzer, FakeStart, FakeCapture>(
      ops,
      frameDrainTimeoutMs = 100,
    )
    val epoch = coordinator.surfaceCreated()!!
    coordinator.installSession(epoch, FakeSession(), FakeAnalyzer(log))

    val inFrame = CountDownLatch(1)
    val releaseFrame = CountDownLatch(1)
    val frame = Thread {
      coordinator.withRunningSession { _, _, _ ->
        inFrame.countDown()
        releaseFrame.await(30, TimeUnit.SECONDS)
        Unit
      }
    }.apply { isDaemon = true; start() }
    assertTrue(inFrame.await(10, TimeUnit.SECONDS))

    coordinator.close(
      PreviewPhase.READY,
      settleStart = { it.settle(log) },
      settleCapture = { it.settle(log) },
    )

    val gate = CountDownLatch(1)
    ops.closeGate = gate
    releaseFrame.countDown()
    assertTrue(ops.closeEntered.await(10, TimeUnit.SECONDS))

    assertEquals(1, coordinator.pendingReleases())
    assertEquals(PreviewPhase.CLOSING, coordinator.phase())
    assertTrue(
      "the old camera is still being released; the preview is not free to hand out",
      coordinator.beginStart(FakeStart()) is StartOutcome.Refused,
    )

    gate.countDown()
    frame.join(10_000)

    assertEquals(0, coordinator.pendingReleases())
    assertEquals(PreviewPhase.READY, coordinator.phase())
    assertTrue(coordinator.beginStart(FakeStart()) is StartOutcome.Accepted)
  }

  @Test
  fun `a release cannot be downgraded to a stop that began alongside it`() {
    ready()
    closeRelease()

    closeStop()

    assertEquals(PreviewPhase.RELEASED, coordinator.phase())
    assertTrue(coordinator.isReleased())
  }

  // -- the queue: ordered, and never waiting on itself ---------------------

  @Test
  fun `a settlement that tears the preview down from inside the callback does not deadlock`() {
    // THE FAILURE (Codex review of `45c663c`, P0-1). A React Native Promise
    // settlement re-enters the bridge and can call straight back into the view.
    // Under the ticket turnstile the re-entrant transition waited for a ticket
    // held by the very stack frame that was running the callback — a
    // self-deadlock on one thread, with the camera left open behind it.
    ready()
    val capture = accept()
    val reentered = AtomicBoolean(false)
    val done = CountDownLatch(1)

    signalling(done) {
      coordinator.close(
        PreviewPhase.READY,
        settleStart = { it.settle(log) },
        settleCapture = { request ->
          request.settle(log)
          reentered.set(true)
          closeRelease()
        },
      )
    }

    assertTrue("a re-entrant settlement deadlocked the queue", done.await(10, TimeUnit.SECONDS))
    assertTrue(reentered.get())
    assertEquals(1, capture.settlements.get())
    assertEquals("the re-entrant release still lands", PreviewPhase.RELEASED, coordinator.phase())
    assertEquals(1, ops.closes.get())
  }

  @Test
  fun `interrupting a waiting caller does not wedge the queue`() {
    // THE FAILURE (Codex review of `45c663c`, P0-1). The turnstile's wait sat
    // outside the `finally`, so an interrupt abandoned a ticket and every
    // transition issued afterwards waited on it forever.
    ready()
    val gate = CountDownLatch(1)
    ops.closeGate = gate
    val drainer = daemon { closeStop() }
    assertTrue(ops.closeEntered.await(10, TimeUnit.SECONDS))

    val waiterError = AtomicReference<Throwable?>(null)
    val waiterDone = CountDownLatch(1)
    signalling(waiterDone) {
      // Already interrupted, so the wait gives up the moment it starts. The
      // transition is queued either way.
      Thread.currentThread().interrupt()
      waiterError.set(closeStop())
    }
    assertTrue(waiterDone.await(10, TimeUnit.SECONDS))
    assertTrue(waiterError.get() is InterruptedException)

    gate.countDown()
    drainer.join(10_000)

    // The queue must still be usable by everyone else.
    val laterDone = CountDownLatch(1)
    signalling(laterDone) { closeRelease() }
    assertTrue(
      "an abandoned wait wedged every transition behind it",
      laterDone.await(10, TimeUnit.SECONDS),
    )
    assertEquals(PreviewPhase.RELEASED, coordinator.phase())
  }

  @Test
  fun `an interrupted waiter does not consume the report slot of a failure yet to come`() {
    // THE FAILURE (Codex review of `667da95`). `reportIfUnowned` claimed the
    // one-shot report slot *before* reading the error. An interrupted waiter
    // disowns its transition while that transition is still queued — so before
    // anything can have gone wrong with it — and therefore burned the slot with
    // nothing to say. When the close later threw, its failure had nowhere left
    // to go and the camera stopped working in silence.
    //
    // The existing interruption test only proved the queue was not wedged, and
    // its transition never failed, so it could not see this.
    ready()
    val capture = accept()
    val settleGate = CountDownLatch(1)
    capture.settleGate = settleGate

    // The drainer parks in the pause's capture settlement, so the queue is held
    // open and nothing behind it has run yet. A pause does not take the
    // session, which leaves it for the release to own — and to fail on.
    val pauseDone = CountDownLatch(1)
    signalling(pauseDone) { coordinator.pause { it.settle(log) } }
    assertTrue(capture.settleEntered.await(10, TimeUnit.SECONDS))

    ops.closeThrows = true
    val waiterError = AtomicReference<Throwable?>(null)
    val waiterDone = CountDownLatch(1)
    signalling(waiterDone) {
      // Already interrupted, so the wait gives up the moment it starts — while
      // the transition it queued has not been touched.
      Thread.currentThread().interrupt()
      waiterError.set(closeRelease())
    }
    assertTrue(waiterDone.await(10, TimeUnit.SECONDS))
    assertTrue(waiterError.get() is InterruptedException)

    settleGate.countDown()
    assertTrue(pauseDone.await(10, TimeUnit.SECONDS))

    assertEquals(1, ops.closes.get())
    assertEquals(
      "the interrupted waiter consumed the report slot before there was anything to report",
      1,
      detached.size,
    )
    // And the landing: a release that could not prove it freed the camera is
    // still RELEASED, which outranks the uncertainty rather than being softened
    // by it. Terminal is the more restrictive answer, not the weaker one.
    assertEquals(PreviewPhase.RELEASED, coordinator.phase())
    assertTrue(coordinator.beginStart(FakeStart()) is StartOutcome.Refused)
  }

  @Test
  fun `a stop with nothing left to release cannot outrank the close holding the camera`() {
    ready()
    val capture = accept()
    val settleGate = CountDownLatch(1)
    capture.settleGate = settleGate

    // T1 owns the resources and is parked in its settlement, which runs before
    // any work by design.
    val firstDone = CountDownLatch(1)
    signalling(firstDone) { closeStop() }
    assertTrue(capture.settleEntered.await(10, TimeUnit.SECONDS))
    assertEquals("T1 has not reached ARCore yet", 0, ops.closes.get())

    // T2 has nothing left to release.
    val secondDone = CountDownLatch(1)
    signalling(secondDone) { closeStop() }

    assertFalse(
      "a transition issued later overtook one that already held the camera",
      secondDone.await(1, TimeUnit.SECONDS),
    )
    assertEquals(PreviewPhase.CLOSING, coordinator.phase())
    assertTrue(
      "no start may be accepted while the old camera is still open",
      coordinator.beginStart(FakeStart()) is StartOutcome.Refused,
    )

    settleGate.countDown()
    assertTrue(firstDone.await(10, TimeUnit.SECONDS))
    assertTrue(secondDone.await(10, TimeUnit.SECONDS))

    assertEquals(PreviewPhase.READY, coordinator.phase())
    assertEquals("only the one session that existed was closed", 1, ops.closes.get())
    assertEquals(1, log.snapshot().count { it == "close-analyzer" })
    assertEquals(0, ops.overlaps.get())
  }

  @Test
  fun `a close issued after a pause cannot reach the session first`() {
    ready()
    val capture = accept()
    val settleGate = CountDownLatch(1)
    capture.settleGate = settleGate

    val pauseDone = CountDownLatch(1)
    signalling(pauseDone) { coordinator.pause { it.settle(log) } }
    assertTrue(capture.settleEntered.await(10, TimeUnit.SECONDS))

    val closeDone = CountDownLatch(1)
    signalling(closeDone) { closeStop() }

    assertFalse(
      "the close reached the session before the pause that was issued first",
      ops.closeEntered.await(1, TimeUnit.SECONDS),
    )

    settleGate.countDown()
    assertTrue(pauseDone.await(10, TimeUnit.SECONDS))
    assertTrue(closeDone.await(10, TimeUnit.SECONDS))

    // The pause runs first and finds the session already taken, so it does
    // nothing to it. What must never happen — the pause landing on ARCore
    // *after* the close — cannot.
    assertEquals(listOf("close-session"), ops.sessionEvents())
    assertEquals(0, ops.pauses.get())
    assertEquals(0, ops.overlaps.get())
  }

  @Test
  fun `a pause issued after a close does not pause the session the close took`() {
    ready()
    val gate = CountDownLatch(1)
    ops.closeGate = gate
    val closer = daemon { closeStop() }
    assertTrue(ops.closeEntered.await(10, TimeUnit.SECONDS))

    val pauseDone = CountDownLatch(1)
    signalling(pauseDone) { coordinator.pause { it.settle(log) } }

    gate.countDown()
    closer.join(10_000)
    assertTrue(pauseDone.await(10, TimeUnit.SECONDS))

    assertEquals("there was nothing left to pause", 0, ops.pauses.get())
    assertEquals(listOf("close-session"), ops.sessionEvents())
    assertEquals(PreviewPhase.PAUSED, coordinator.phase())
  }

  @Test
  fun `a close cannot enter the session while a pause is still inside it`() {
    ready()
    val pauseGate = CountDownLatch(1)
    ops.pauseGate = pauseGate
    val pauser = daemon { coordinator.pause { it.settle(log) } }
    assertTrue(ops.pauseEntered.await(10, TimeUnit.SECONDS))

    val closer = daemon { closeStop() }

    assertFalse(
      "a close entered the session while a pause was still inside it",
      ops.closeEntered.await(1, TimeUnit.SECONDS),
    )

    pauseGate.countDown()
    pauser.join(10_000)
    closer.join(10_000)

    assertEquals(0, ops.overlaps.get())
    assertEquals(listOf("pause", "close-session"), ops.sessionEvents())
  }

  // -- host intent ---------------------------------------------------------

  @Test
  fun `a host pause is not forgotten by a close that runs after it`() {
    // THE FAILURE (Codex review of `45c663c`, P1-2). The pause became a no-op
    // once a close had detached the session, and the close then landed READY —
    // so the preview reported the host as present while the app was in the
    // background, and started rendering again on the next session.
    ready()
    val capture = accept()
    val settleGate = CountDownLatch(1)
    capture.settleGate = settleGate

    val pauseDone = CountDownLatch(1)
    signalling(pauseDone) { coordinator.pause { it.settle(log) } }
    assertTrue(capture.settleEntered.await(10, TimeUnit.SECONDS))

    val closeDone = CountDownLatch(1)
    signalling(closeDone) { closeStop() }

    settleGate.countDown()
    assertTrue(pauseDone.await(10, TimeUnit.SECONDS))
    assertTrue(closeDone.await(10, TimeUnit.SECONDS))

    assertTrue("the app is still in the background", coordinator.isHostAway())
    assertEquals(
      "a stop must not report the host as present",
      PreviewPhase.PAUSED,
      coordinator.phase(),
    )
    assertNull(coordinator.withRunningSession { _, _, _ -> Unit })
  }

  @Test
  fun `a pause settles the capture before it blocks pausing the session`() {
    ready()
    val capture = accept()
    val gate = CountDownLatch(1)
    ops.pauseGate = gate
    val pauser = daemon { coordinator.pause { it.settle(log) } }

    assertTrue(ops.pauseEntered.await(10, TimeUnit.SECONDS))
    assertEquals(1, capture.settlements.get())
    assertEquals(0, ops.pauses.get())

    gate.countDown()
    pauser.join(10_000)
    assertEquals(PreviewPhase.PAUSED, coordinator.phase())
  }

  @Test
  fun `no frame runs while a pause is blocking`() {
    ready()
    val gate = CountDownLatch(1)
    ops.pauseGate = gate
    val pauser = daemon { coordinator.pause { it.settle(log) } }
    assertTrue(ops.pauseEntered.await(10, TimeUnit.SECONDS))

    assertEquals(PreviewPhase.PAUSING, coordinator.phase())
    assertNull(coordinator.withRunningSession { _, _, _ -> Unit })
    assertFalse(coordinator.acceptCapture(FakeCapture(50), nowNs = 0))

    gate.countDown()
    pauser.join(10_000)
  }

  @Test
  fun `a resume blocks frames until it lands and then restores them`() {
    ready()
    coordinator.pause { it.settle(log) }
    val gate = CountDownLatch(1)
    ops.resumeGate = gate
    val resumer = daemon { coordinator.resume() }
    assertTrue(ops.resumeEntered.await(10, TimeUnit.SECONDS))

    assertEquals(PreviewPhase.RESUMING, coordinator.phase())
    assertNull(coordinator.withRunningSession { _, _, _ -> Unit })

    gate.countDown()
    resumer.join(10_000)
    assertEquals(PreviewPhase.READY, coordinator.phase())
    assertNotNull(coordinator.withRunningSession { _, _, _ -> Unit })
    assertEquals(1, ops.resumes.get())
  }

  @Test
  fun `a session is paused only once and resumed only if it was paused`() {
    ready()
    coordinator.pause { it.settle(log) }
    coordinator.pause { it.settle(log) }
    assertEquals(1, ops.pauses.get())

    coordinator.resume()
    coordinator.resume()
    assertEquals(1, ops.resumes.get())
  }

  @Test
  fun `a close during a pause still releases the session`() {
    ready()
    val gate = CountDownLatch(1)
    ops.pauseGate = gate
    val pauser = daemon { coordinator.pause { it.settle(log) } }
    assertTrue(ops.pauseEntered.await(10, TimeUnit.SECONDS))

    val closer = daemon { closeRelease() }
    gate.countDown()
    pauser.join(10_000)
    closer.join(10_000)

    assertEquals(1, ops.closes.get())
    assertEquals(PreviewPhase.RELEASED, coordinator.phase())
  }

  @Test
  fun `a host resume that arrives during a pause is honoured, not dropped`() {
    // `PAUSING` is not `PAUSED`, so a resume landing inside a pause used to be
    // discarded — and the preview stayed dark with nothing left to wake it.
    ready()
    val pauseGate = CountDownLatch(1)
    ops.pauseGate = pauseGate
    val pauser = daemon { coordinator.pause { it.settle(log) } }
    assertTrue(ops.pauseEntered.await(10, TimeUnit.SECONDS))

    val resumeDone = CountDownLatch(1)
    signalling(resumeDone) { coordinator.resume() }

    pauseGate.countDown()
    pauser.join(10_000)
    assertTrue(resumeDone.await(10, TimeUnit.SECONDS))

    assertEquals(PreviewPhase.READY, coordinator.phase())
    assertEquals(listOf("pause", "resume"), ops.sessionEvents())
    assertFalse(coordinator.isSessionPaused())
  }

  @Test
  fun `a host pause that arrives during a resume is honoured, not lost`() {
    // The mirror image: a pause dropped because a resume happened to be running
    // leaves the camera live while the app is in the background.
    ready()
    coordinator.pause { it.settle(log) }
    val resumeGate = CountDownLatch(1)
    ops.resumeGate = resumeGate
    val resumer = daemon { coordinator.resume() }
    assertTrue(ops.resumeEntered.await(10, TimeUnit.SECONDS))

    val pauseDone = CountDownLatch(1)
    signalling(pauseDone) { coordinator.pause { it.settle(log) } }

    resumeGate.countDown()
    resumer.join(10_000)
    assertTrue(pauseDone.await(10, TimeUnit.SECONDS))

    assertEquals(PreviewPhase.PAUSED, coordinator.phase())
    assertTrue("the camera must not be left running", coordinator.isSessionPaused())
    assertEquals(listOf("pause", "resume", "pause"), ops.sessionEvents())
  }

  @Test
  fun `a pause that fails releases the session rather than pretending it is asleep`() {
    // THE FAILURE (Codex review of `45c663c`, P0-2). The phase was stored, not
    // derived, so a `Session.pause()` that threw still landed `PAUSED` — with
    // the camera running and `sessionPaused` claiming otherwise.
    ready()
    ops.pauseThrows = true

    val error = coordinator.pause { it.settle(log) }

    assertNotNull("the failure is reported, not hidden", error)
    assertEquals("the host is away, and the phase says so", PreviewPhase.PAUSED, coordinator.phase())
    assertFalse("a session that failed to pause is not asleep", coordinator.isSessionPaused())
    assertFalse(
      "a camera that would not pause must not be left holding the device",
      coordinator.hasSession(),
    )
    assertEquals(1, ops.closes.get())
    assertNull(coordinator.withRunningSession { _, _, _ -> Unit })
  }

  @Test
  fun `a resume that fails releases the session rather than pretending it is awake`() {
    ready()
    coordinator.pause { it.settle(log) }
    assertTrue(coordinator.isSessionPaused())
    ops.resumeThrows = true

    val error = coordinator.resume()

    assertNotNull(error)
    assertFalse("a session that would not resume must not be kept", coordinator.hasSession())
    assertEquals(1, ops.closes.get())
    assertNull(
      "a preview with no session must not render, whatever the phase says",
      coordinator.withRunningSession { _, _, _ -> Unit },
    )
  }

  // -- the frame is not a critical section, and outlives nothing ------------

  @Test
  fun `a frame does not hold the coordinator lock while it runs`() {
    ready()
    val inFrame = CountDownLatch(1)
    val observed = CountDownLatch(1)
    val phaseSeen = AtomicReference<PreviewPhase?>(null)
    val accepted = AtomicBoolean(false)
    daemon {
      inFrame.await(10, TimeUnit.SECONDS)
      phaseSeen.set(coordinator.phase())
      accepted.set(coordinator.acceptCapture(FakeCapture(99), nowNs = 0))
      observed.countDown()
    }

    val ran = coordinator.withRunningSession { _, _, _ ->
      inFrame.countDown()
      assertTrue(
        "another thread was blocked by the frame it was not supposed to block on",
        observed.await(5, TimeUnit.SECONDS),
      )
      Unit
    }

    assertNotNull(ran)
    assertEquals(PreviewPhase.READY, phaseSeen.get())
    assertTrue(accepted.get())
  }

  @Test
  fun `a teardown waits for the frame to let go before closing the session`() {
    ready()
    val inFrame = CountDownLatch(1)
    val releaseFrame = CountDownLatch(1)
    val frame = daemon {
      coordinator.withRunningSession { _, _, _ ->
        inFrame.countDown()
        releaseFrame.await(30, TimeUnit.SECONDS)
        Unit
      }
    }
    assertTrue(inFrame.await(10, TimeUnit.SECONDS))

    val closer = daemon { closeRelease() }
    assertFalse(
      "the session was closed underneath a frame still using it",
      ops.closeEntered.await(1, TimeUnit.SECONDS),
    )

    releaseFrame.countDown()
    frame.join(10_000)
    closer.join(10_000)

    assertEquals(1, ops.closes.get())
    assertEquals(PreviewPhase.RELEASED, coordinator.phase())
  }

  @Test
  fun `a teardown cancels the frames it is waiting for`() {
    ready()
    val inFrame = CountDownLatch(1)
    val cancelled = AtomicBoolean(false)
    val frameDone = CountDownLatch(1)
    signalling(frameDone) {
      coordinator.withRunningSession { _, _, lease ->
        inFrame.countDown()
        // Poll the way the render loop does: between the cheap half of the
        // frame and the expensive half.
        while (!lease.isCancelled) Thread.yield()
        cancelled.set(true)
        Unit
      }
    }
    assertTrue(inFrame.await(10, TimeUnit.SECONDS))

    closeRelease()

    assertTrue(frameDone.await(10, TimeUnit.SECONDS))
    assertTrue("a frame a teardown is waiting on must be told to stop", cancelled.get())
    assertEquals(1, ops.closes.get())
  }

  @Test
  fun `a settlement that throws still drains the frames before the session is closed`() {
    ready()
    val capture = accept()
    capture.throwOnSettle = true
    val inFrame = CountDownLatch(1)
    val releaseFrame = CountDownLatch(1)
    val frame = daemon {
      coordinator.withRunningSession { _, _, _ ->
        inFrame.countDown()
        releaseFrame.await(30, TimeUnit.SECONDS)
        Unit
      }
    }
    assertTrue(inFrame.await(10, TimeUnit.SECONDS))

    val closeDone = CountDownLatch(1)
    signalling(closeDone) { closeRelease() }

    assertFalse(
      "a settlement that threw skipped the drain and closed over a live frame",
      ops.closeEntered.await(1, TimeUnit.SECONDS),
    )

    releaseFrame.countDown()
    frame.join(10_000)
    assertTrue(closeDone.await(10, TimeUnit.SECONDS))
    assertEquals(1, ops.closes.get())
    assertEquals(1, capture.settlements.get())
  }

  @Test
  fun `a preview whose resources are still out on loan is not usable again yet`() {
    // THE FAILURE (Codex review of `45c663c`, P1-1). When the drain timed out
    // the transition deferred the release — correctly — and then landed `READY`
    // anyway. A start was accepted, and a second Session was built while the
    // first still owned the camera.
    val log = ResourceLog()
    val ops = FakeSessionOps(log)
    val detached = ConcurrentLinkedQueue<Throwable>()
    val coordinator = PreviewSessionCoordinator<FakeSession, FakeAnalyzer, FakeStart, FakeCapture>(
      ops,
      frameDrainTimeoutMs = 100,
      onDetachedError = { detached.add(it) },
    )
    val epoch = coordinator.surfaceCreated()!!
    coordinator.installSession(epoch, FakeSession(), FakeAnalyzer(log))

    val inFrame = CountDownLatch(1)
    val releaseFrame = CountDownLatch(1)
    val frame = Thread {
      coordinator.withRunningSession { _, _, _ ->
        inFrame.countDown()
        releaseFrame.await(30, TimeUnit.SECONDS)
        Unit
      }
    }.apply { isDaemon = true; start() }
    assertTrue(inFrame.await(10, TimeUnit.SECONDS))

    val error = coordinator.close(
      PreviewPhase.READY,
      settleStart = { it.settle(log) },
      settleCapture = { it.settle(log) },
    )

    assertNotNull("a drain that timed out is reported, not swallowed", error)
    assertEquals("nothing may be destroyed while a frame is inside it", 0, ops.closes.get())
    assertEquals(1, coordinator.pendingReleases())
    assertEquals(
      "the preview is still closing until the old camera is really gone",
      PreviewPhase.CLOSING,
      coordinator.phase(),
    )
    assertTrue(
      "no start may be accepted while the old Session still owns the camera",
      coordinator.beginStart(FakeStart()) is StartOutcome.Refused,
    )
    assertNull(coordinator.withRunningSession { _, _, _ -> Unit })

    releaseFrame.countDown()
    frame.join(10_000)

    assertEquals("the last frame out closes what the teardown could not", 1, ops.closes.get())
    assertEquals(1, log.snapshot().count { it == "close-analyzer" })
    assertEquals(0, coordinator.pendingReleases())
    assertEquals(PreviewPhase.READY, coordinator.phase())
    assertTrue(coordinator.beginStart(FakeStart()) is StartOutcome.Accepted)
  }

  // -- captures ------------------------------------------------------------

  @Test
  fun `a capture is refused unless a session is running`() {
    assertFalse(coordinator.acceptCapture(FakeCapture(1), nowNs = 0))
    coordinator.surfaceCreated()
    assertFalse(
      "a surface without a session is not enough",
      coordinator.acceptCapture(FakeCapture(2), nowNs = 0),
    )
    ready()
    assertTrue(coordinator.acceptCapture(FakeCapture(3), nowNs = 0))
  }

  @Test
  fun `a capture accepted before a stop is settled by it, not carried into a restart`() {
    ready()
    val capture = accept()

    closeStop()

    assertEquals(1, capture.settlements.get())
    assertFalse(coordinator.isCapturePending())
  }

  @Test
  fun `only one caller can take a capture, whichever path reaches it first`() {
    ready()
    val capture = accept()

    val takers = listOf(
      coordinator.cancelCapture(),
      coordinator.cancelCapture(),
      coordinator.cancelCaptureIf { true },
    ).filterNotNull()

    assertEquals(listOf(capture), takers)
  }

  @Test
  fun `a watchdog settles only the request it was scheduled for`() {
    ready()
    val capture = accept()

    assertNull(coordinator.cancelCaptureIf { it.id == capture.id + 1 })
    assertTrue(coordinator.isCapturePending())
    assertSame(capture, coordinator.cancelCaptureIf { it.id == capture.id })
  }

  // -- races ---------------------------------------------------------------

  @Test
  fun `every accepted capture settles exactly once under concurrent lifecycle churn`() {
    repeat(RACE_ROUNDS) { round ->
      val log = ResourceLog()
      val ops = FakeSessionOps(log)
      val coordinator =
        PreviewSessionCoordinator<FakeSession, FakeAnalyzer, FakeStart, FakeCapture>(ops)
      val epoch = coordinator.surfaceCreated()!!
      coordinator.installSession(epoch, FakeSession(), FakeAnalyzer(log))

      val accepted = AtomicInteger(0)
      val settled = AtomicInteger(0)
      val doubles = AtomicInteger(0)
      val ids = AtomicLong(0)
      val firstAccept = CountDownLatch(1)
      val settle: (FakeCapture) -> Unit = { request ->
        if (request.settlements.incrementAndGet() == 1) settled.incrementAndGet()
        else doubles.incrementAndGet()
      }

      val start = CountDownLatch(1)
      val done = CountDownLatch(4)

      val renderer = testThread(start, done) {
        repeat(40) {
          coordinator.withRunningSession { _, _, _ ->
            val frame = coordinator.beginFrame()
            coordinator.publishFrameTimestamp(frame, frame * 1_000)
            coordinator.onFrame(frame, frame * 1_000, nowNs = 0)
          }?.let { outcome ->
            if (outcome is CaptureOutcome.Fail) settle(outcome.request)
          }
          Thread.yield()
        }
      }
      val requester = testThread(start, done) {
        repeat(10) {
          val request = FakeCapture(ids.incrementAndGet())
          if (coordinator.acceptCapture(request, nowNs = 0)) {
            accepted.incrementAndGet()
            firstAccept.countDown()
          }
          Thread.yield()
        }
      }
      val restarter = testThread(start, done) {
        // Waits on the same barrier as the closer: a stop that lands before
        // anything was accepted would leave the round proving nothing.
        firstAccept.await(30, TimeUnit.SECONDS)
        repeat(5) {
          coordinator.close(PreviewPhase.READY, { it.settle(log) }, settle)
          val next = coordinator.surfaceCreated()
          if (next != null) coordinator.installSession(next, FakeSession(), FakeAnalyzer(log))
          Thread.yield()
        }
      }
      val closer = testThread(start, done) {
        firstAccept.await(30, TimeUnit.SECONDS)
        Thread.yield()
        coordinator.close(PreviewPhase.RELEASED, { it.settle(log) }, settle)
      }

      start.countDown()
      assertTrue("round $round deadlocked", done.await(60, TimeUnit.SECONDS))
      for (worker in listOf(renderer, requester, restarter, closer)) worker.join(10_000)
      coordinator.cancelCapture()?.let(settle)

      assertEquals("round $round settled a request twice", 0, doubles.get())
      assertTrue("round $round accepted nothing", accepted.get() > 0)
      assertEquals(
        "round $round: ${accepted.get()} accepted but ${settled.get()} settled",
        accepted.get(),
        settled.get(),
      )
      assertFalse("round $round left a request pending", coordinator.isCapturePending())
      assertEquals("round $round left a frame in flight", 0, coordinator.framesInFlight())
      assertEquals("round $round left resources on loan", 0, coordinator.pendingReleases())
      assertEquals("round $round overlapped two operations", 0, ops.overlaps.get())
    }
  }

  companion object {
    private const val RACE_ROUNDS = 12
  }
}
