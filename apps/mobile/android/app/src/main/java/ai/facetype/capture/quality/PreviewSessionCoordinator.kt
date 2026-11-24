package ai.facetype.capture.quality

import java.util.ArrayDeque
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Where the preview is in its life. Derived, never stored. */
internal enum class PreviewPhase {
  /** Constructed; the GL surface has not been created yet. */
  AWAITING_SURFACE,

  /** A surface exists, the host is here, nothing is in flight. */
  READY,

  /** A pause is running. Its `Session.pause()` may block. */
  PAUSING,

  /** The host is away. No frames, no captures. */
  PAUSED,

  /** A resume is running. Its `Session.resume()` may block. */
  RESUMING,

  /** A teardown is running, or resources it could not release are still out. */
  CLOSING,

  /** The surface could not be built. Recoverable only by a new surface. */
  FAILED,

  /** Torn down. Terminal. */
  RELEASED,
}

/** The camera session, reduced to the three calls that can block. */
internal interface SessionOps<S : Any> {
  fun pause(session: S)
  fun resume(session: S)
  fun close(session: S)
}

/** Anything the coordinator closes alongside a session. */
internal interface ResourceHandle {
  fun close()
}

/**
 * A frame's hold on the session, and the way to ask it to stop early.
 *
 * A native `Session.update()` cannot be interrupted, but the rest of a frame
 * can: a teardown cancels every live lease before it waits for them, so a frame
 * that has not yet reached its expensive work abandons it instead of making the
 * teardown wait out a full camera-image copy.
 */
internal class FrameLease {
  @Volatile private var cancelled = false

  val isCancelled: Boolean get() = cancelled

  internal fun cancel() {
    cancelled = true
  }
}

/** The answer to "is the start I accepted earlier still the one to run?". */
internal sealed interface ClaimResult<out T> {
  data class Claimed<T>(val request: T) : ClaimResult<T>
  data class Stale<T>(val request: T) : ClaimResult<T>
  data object None : ClaimResult<Nothing>
}

/** The answer to "may I start a session, and under which epoch?". */
internal sealed interface StartOutcome<out T> {
  data class Accepted(val epoch: Long) : StartOutcome<Nothing>
  data class Refused<T>(val request: T, val code: String, val message: String) : StartOutcome<T>
}

/** The answer to "may I install the session I just built?". */
internal sealed interface InstallOutcome<out S> {
  /**
   * Accepted, and reconciled with the host's current intent.
   *
   * [error] is non-null when the session was installed but could *not* be put
   * into the state the host asked for — a park that failed, say. The session has
   * been released in that case, so a caller holding a start Promise must reject
   * it rather than reporting success (Codex review of `45c663c`, P0-3: this used
   * to answer `Installed` unconditionally and drop the park's failure).
   */
  data class Installed(val error: Throwable?) : InstallOutcome<Nothing>

  /** The phase or the epoch moved on; the caller must close what it built. */
  data class Rejected<S>(val session: S) : InstallOutcome<S>
}

/**
 * The preview's state, its resources, and one strictly ordered queue of
 * operations on the camera session.
 *
 * WHY THIS EXISTS AS A SEPARATE CLASS (Codex re-review of `984ab15`). The rules
 * below had been living in `FaceTypePreviewView`, where nothing but ARCore and
 * a GL thread can exercise them, so they were tested through a harness that
 * *reimplemented* the same locking. A harness that reimplements the thing under
 * test proves the harness correct. `FaceTypePreviewView` now holds no lifecycle
 * logic at all: it builds resources, hands them here, and does what it is told.
 *
 * ONE QUEUE, ONE DRAINER, NO TICKETS (Codex review of `45c663c`, P0-1). Ordering
 * went through three designs before this one:
 *
 * 1. A second monitor around phase two. Not FIFO: a transition could take its
 *    resources under the state lock, be preempted, and be overtaken.
 * 2. A ticket turnstile. FIFO, but *fatally* so — a transition settled its
 *    Promises before claiming its turn, and a React Native settlement re-enters
 *    the bridge, so a settlement that synchronously called `stopSession()`
 *    deadlocked: the new transition waited for a ticket held by the very stack
 *    frame that was running the callback. `awaitTurn` also sat outside the
 *    `finally`, so an interrupt abandoned a ticket and wedged every transition
 *    behind it forever.
 * 3. This. Phase one appends a fully-formed transition to a queue under the
 *    state lock — position and resource ownership decided together — and
 *    exactly one thread drains it. **Nothing ever waits for the queue while
 *    holding a place in it.** A callback that enqueues from inside the drain is
 *    appended and picked up by the same loop when the current transition
 *    finishes; it cannot block, so it cannot deadlock. There are no tickets to
 *    abandon.
 *
 * THE PHASE IS DERIVED, NEVER STORED. What is stored is what is actually true:
 * whether a surface exists, whether a release was asked for, whether the surface
 * build failed, whether the host is away, what is in flight, and how many
 * resources are still out on loan. [phaseLocked] computes the phase from those.
 * Storing the phase is how a failed `Session.pause()` came to land `PAUSED` with
 * the camera still running (Codex review of `45c663c`, P0-2).
 *
 * HOST INTENT OUTLIVES RESOURCES. `hostAway` is set by [pause]/[resume] the
 * moment they are called and is never cleared by anything happening to the
 * session. A host pause that arrived before a close used to become a no-op and
 * then have the close land `READY`, losing the fact that the app was in the
 * background. Now every transition ends with the phase the *intent* implies, and
 * a `SYNC_HOST` transition's only job is to make the session match.
 *
 * FAIL CLOSED. A `Session.pause()` that throws leaves a camera running while the
 * app is away; a `Session.resume()` that throws leaves a session that will throw
 * on every frame. Neither is something to carry on from, so both escalate to
 * releasing the session. The next start builds a fresh one.
 *
 * THE FRAME IS NOT A CRITICAL SECTION. [withRunningSession] pins the session
 * under the lock, releases it, and runs the native work with nothing held. A
 * transition cancels the live leases and waits for them before it touches
 * ARCore; if they do not drain in time it **defers** the release to whichever
 * frame finishes last, and the preview stays `CLOSING` — not startable, not
 * renderable — until that has actually happened.
 */
internal class PreviewSessionCoordinator<S : Any, A : ResourceHandle, P : Any, C : Any>(
  private val ops: SessionOps<S>,
  requestTimeoutNs: Long = CaptureCoordinator.REQUEST_TIMEOUT_NS,
  analysisTimeoutNs: Long = CaptureCoordinator.ANALYSIS_TIMEOUT_NS,
  private val frameDrainTimeoutMs: Long = FRAME_DRAIN_TIMEOUT_MS,
  /**
   * Where a failure that belongs to no caller goes.
   *
   * A transition enqueued from inside a settlement callback, an escalated close
   * and a deferred release all complete after their originator has been
   * answered. Dropping their failures is what let a camera stay open with
   * nothing said about it; the production view wires this to the preview-error
   * event.
   */
  private val onDetachedError: (Throwable) -> Unit = {},
) {

  private enum class Kind { CLOSE, SYNC_HOST }

  /** What a transition leaves permanently true when it lands. */
  private enum class Landing { USABLE, FAILED, RELEASED }

  private enum class Role { DRAIN, REENTRANT, WAIT }

  private class Transition<S : Any, A : ResourceHandle, P : Any, C : Any>(
    val kind: Kind,
    val landing: Landing,
    val working: PreviewPhase,
    val start: P?,
    val capture: C?,
    /** Privately owned by this transition. Non-null only for a close. */
    val session: S?,
    val analyzer: A?,
    val settleStart: ((P) -> Unit)?,
    val settleCapture: ((C) -> Unit)?,
    /**
     * False when nobody will ever read [error], so it must be reported instead.
     *
     * Mutable because whether anyone can read it is not known at creation: a
     * caller that turns out to be re-entrant, or one whose wait is interrupted,
     * has no way to receive the failure and must hand it over (Codex review of
     * `e4457d2`, P0-3 — a re-entrant stop reported success while its close
     * failure was lost).
     */
    @Volatile var owned: Boolean,
  ) {
    val completed = CountDownLatch(1)
    val reported = AtomicBoolean(false)

    @Volatile var error: Throwable? = null

    fun record(failure: Throwable?) {
      if (failure != null && error == null) error = failure
    }
  }

  /** Resources a teardown could not close because a frame was still using them. */
  private class DeferredRelease<S : Any, A : ResourceHandle>(val session: S?, val analyzer: A?)

  private val lock = ReentrantLock()
  private val framesDrained = lock.newCondition()
  private val captures = CaptureCoordinator<C>(requestTimeoutNs, analysisTimeoutNs)

  // -- what is actually true; the phase is computed from these ------------
  private var hasSurface: Boolean = false
  private var surfaceFailed: Boolean = false
  private var releaseRequested: Boolean = false

  /**
   * A `Session.close()` threw, so whether the camera was released is unknown.
   *
   * Reporting `READY` after that is a claim the preview cannot back: it would
   * accept a start and build a second session while the first may still own the
   * device (Codex review of `e4457d2`, P0-2/P1-4).
   */
  private var releaseUncertain: Boolean = false
  private var hostAway: Boolean = false
  private var workingPhase: PreviewPhase? = null
  private var pendingReleases: Int = 0

  private var epoch: Long = 0
  private var pendingStart: P? = null
  private var session: S? = null
  private var analyzer: A? = null
  private var sessionPaused: Boolean = false
  private var frameSequence: Long = 0
  private var frameMark: FrameMark = FrameMark(0, 0)
  private val liveLeases = mutableListOf<FrameLease>()
  private val deferredReleases = ArrayDeque<DeferredRelease<S, A>>()

  private val queue = ArrayDeque<Transition<S, A, P, C>>()
  private var drainingThread: Thread? = null

  // -----------------------------------------------------------------------
  // Observation
  // -----------------------------------------------------------------------

  fun phase(): PreviewPhase = lock.withLock { phaseLocked() }

  fun epoch(): Long = lock.withLock { epoch }

  fun isReleased(): Boolean = lock.withLock { releaseRequested }

  fun hasSession(): Boolean = lock.withLock { session != null }

  fun isSessionPaused(): Boolean = lock.withLock { sessionPaused }

  fun isHostAway(): Boolean = lock.withLock { hostAway }

  fun isCapturePending(): Boolean = captures.isPending()

  fun framesInFlight(): Int = lock.withLock { liveLeases.size }

  fun pendingReleases(): Int = lock.withLock { pendingReleases }

  /** The render loop's published position. Read under the lock by [acceptCapture]. */
  fun frameMark(): FrameMark = lock.withLock { frameMark }

  private fun phaseLocked(): PreviewPhase = when {
    workingPhase != null -> workingPhase!!
    // Resources a teardown could not release are still out on loan to a frame.
    // Until they are actually gone the preview is still closing, whatever the
    // transition that gave up on them reported.
    pendingReleases > 0 -> PreviewPhase.CLOSING
    releaseRequested -> PreviewPhase.RELEASED
    // A camera we could not prove we released is not a camera to hand out.
    releaseUncertain -> PreviewPhase.FAILED
    surfaceFailed -> PreviewPhase.FAILED
    !hasSurface -> PreviewPhase.AWAITING_SURFACE
    hostAway -> PreviewPhase.PAUSED
    else -> PreviewPhase.READY
  }

  private fun inTransitionLocked(): Boolean =
    workingPhase != null || pendingReleases > 0 || queue.isNotEmpty()

  // -----------------------------------------------------------------------
  // Surface
  // -----------------------------------------------------------------------

  /**
   * A GL surface now exists.
   *
   * A surface can be built more than once — an EGL context loss across a
   * background/foreground cycle destroys and rebuilds it — so this clears a
   * previous surface failure. It can never revive a released preview.
   */
  fun surfaceCreated(): Long? {
    lock.withLock {
      if (releaseRequested) return null
      hasSurface = true
      surfaceFailed = false
      // A rebuilt surface is the app's own "try again". If the old camera is
      // genuinely still held, the next start fails with a real ARCore error
      // rather than a guess of ours — which is better than being permanently
      // unusable on the strength of one close that threw.
      releaseUncertain = false
      epoch += 1
      return epoch
    }
  }

  // -----------------------------------------------------------------------
  // Start
  // -----------------------------------------------------------------------

  /** Takes ownership of a start request, if the preview can serve one. */
  fun beginStart(request: P): StartOutcome<P> {
    lock.withLock {
      val phase = phaseLocked()
      val refusal = when {
        releaseRequested -> "The camera preview has been torn down."
        inTransitionLocked() -> "The camera preview is still changing state."
        phase != PreviewPhase.READY && phase != PreviewPhase.PAUSED ->
          "Camera preview is not available."
        pendingStart != null -> "ARCore capture is still starting."
        else -> null
      }
      if (refusal != null) return StartOutcome.Refused(request, "FT-REC-005", refusal)
      pendingStart = request
      return StartOutcome.Accepted(epoch)
    }
  }

  /**
   * Claims the pending start, but only if [epoch] is still the current one.
   *
   * A stale claim hands the request back rather than parking it: returning "no"
   * while still holding the Promise is how a caller ends up waiting on
   * something nobody owns.
   */
  fun claimStart(epoch: Long): ClaimResult<P> {
    lock.withLock {
      val request = takePendingStartLocked() ?: return ClaimResult.None
      val phase = phaseLocked()
      val usable = !releaseRequested && !inTransitionLocked() &&
        (phase == PreviewPhase.READY || phase == PreviewPhase.PAUSED)
      if (!usable || epoch != this.epoch) return ClaimResult.Stale(request)
      return ClaimResult.Claimed(request)
    }
  }

  /** Takes the pending start so a caller can cancel it (a stop supersedes it). */
  fun cancelStart(): P? = lock.withLock { takePendingStartLocked() }

  /**
   * Installs a session the caller built *outside* the lock, and reconciles it
   * with the host's current intent.
   *
   * TWO DISTINCT OUTCOMES, and only one of them is the park. Every transition
   * bumps the epoch, so a start accepted while the preview was live and then
   * *overtaken* by a host pause is rejected here — its epoch is stale — and the
   * caller closes what it built. The park is the other case: the host was
   * already away when the start was accepted, so the epoch still matches and
   * there is a real session to put to sleep.
   *
   * A park that fails takes the session with it, and the failure is returned so
   * the caller can reject the start rather than reporting a success it did not
   * get.
   */
  fun installSession(
    epoch: Long,
    session: S,
    analyzer: A?,
  ): InstallOutcome<S> {
    val transition = lock.withLock {
      val phase = phaseLocked()
      val usable = !releaseRequested && !inTransitionLocked() &&
        (phase == PreviewPhase.READY || phase == PreviewPhase.PAUSED)
      if (!usable || epoch != this.epoch || this.session != null) {
        return InstallOutcome.Rejected(session)
      }
      this.session = session
      this.analyzer = analyzer
      sessionPaused = false
      if (!hostAway) return InstallOutcome.Installed(null)
      enqueueLocked(syncHostLocked(settleCapture = null, owned = true))
    }
    return InstallOutcome.Installed(submit(transition))
  }

  // -----------------------------------------------------------------------
  // Frames and captures
  // -----------------------------------------------------------------------

  /**
   * Leases the live session to [block], which runs with **no lock held**.
   *
   * The session is pinned: the lease is registered under the lock, the lock is
   * released, the native work runs, and the lease is retired in a `finally`. A
   * transition cancels every live lease and waits for them before it calls into
   * ARCore, so the session cannot be released underneath a frame — and if a
   * lease outlives the wait, the resources are deferred to it rather than
   * destroyed.
   *
   * Frames run only in `READY`, which now also means: no transition in flight,
   * no resources still out on loan, and the host is here.
   */
  fun <R : Any> withRunningSession(block: (S, A?, FrameLease) -> R?): R? {
    val lease = FrameLease()
    val pinned: S
    val leasedAnalyzer: A?
    lock.withLock {
      if (phaseLocked() != PreviewPhase.READY) return null
      pinned = session ?: return null
      leasedAnalyzer = analyzer
      liveLeases.add(lease)
    }
    try {
      return block(pinned, leasedAnalyzer, lease)
    } finally {
      retireLease(lease)
    }
  }

  private fun retireLease(lease: FrameLease) {
    val orphaned = lock.withLock {
      liveLeases.remove(lease)
      if (liveLeases.isNotEmpty()) return@withLock emptyList()
      framesDrained.signalAll()
      // The frame that turns the lights out closes whatever a teardown could
      // not close while it was still running.
      val pending = deferredReleases.toList()
      deferredReleases.clear()
      pending
    }
    if (orphaned.isEmpty()) return
    // Only when these have actually been released is the preview closed, and
    // `release` is what stops counting them.
    orphaned.forEach { deferred -> release(deferred) }
  }

  /**
   * Opens a frame: advances the sequence and republishes the mark with the
   * *previous* timestamp.
   *
   * A capture request that lands while `update()` is running must not be
   * answerable by the frame `update()` is in the middle of producing, so the
   * sequence moves before the timestamp is known.
   */
  fun beginFrame(): Long {
    lock.withLock {
      frameSequence += 1
      frameMark = FrameMark(frameSequence, frameMark.timestampNs)
      return frameSequence
    }
  }

  /** Publishes the timestamp `update()` produced for [sequence]. */
  fun publishFrameTimestamp(sequence: Long, timestampNs: Long) {
    lock.withLock { frameMark = FrameMark(sequence, timestampNs) }
  }

  /**
   * Takes ownership of a capture request, against the session running *now*.
   *
   * The phase check, the baseline read and the accept are one critical section:
   * a stop landing between them would leave the request bound to an epoch no
   * session belongs to.
   */
  fun acceptCapture(request: C, nowNs: Long): Boolean {
    lock.withLock {
      if (phaseLocked() != PreviewPhase.READY || session == null) return false
      return captures.accept(request, epoch, frameMark, nowNs)
    }
  }

  fun onFrame(sequence: Long, frameTimestampNs: Long, nowNs: Long): CaptureOutcome<C> =
    lock.withLock { captures.onFrame(epoch, sequence, frameTimestampNs, nowNs) }

  /**
   * Un-binds a frame whose pixels were not available, enforcing the request's
   * own deadline: a camera that produces a mesh but never a usable image would
   * otherwise be rebound on every frame forever.
   */
  fun rewindCapture(identity: FrameIdentity, nowNs: Long): CaptureOutcome<C> =
    captures.rewind(identity, nowNs)

  fun onAnalysisComplete(result: AnalysisResult): CaptureOutcome<C> =
    captures.onAnalysisComplete(result)

  fun cancelCapture(): C? = captures.cancel()

  fun cancelCaptureIf(predicate: (C) -> Boolean): C? = captures.cancelIf(predicate)

  // -----------------------------------------------------------------------
  // Host intent
  // -----------------------------------------------------------------------

  /**
   * The host went away.
   *
   * The intent is recorded immediately and unconditionally; the queued
   * transition only makes the *session* match it. That separation is what stops
   * a close that happens to run afterwards from landing `READY` and losing the
   * fact that the app is in the background.
   *
   * @return the failure from this call's own reconciliation, if any. A call
   *   made from inside a settlement callback cannot wait for its own work, so it
   *   returns `null` and reports through `onDetachedError`.
   */
  fun pause(settleCapture: (C) -> Unit): Throwable? {
    val transition = lock.withLock {
      if (releaseRequested) return null
      hostAway = true
      enqueueLocked(syncHostLocked(settleCapture, owned = true))
    }
    return submit(transition)
  }

  /** The host came back. Symmetric with [pause]. */
  fun resume(): Throwable? {
    val transition = lock.withLock {
      if (releaseRequested) return null
      hostAway = false
      enqueueLocked(syncHostLocked(settleCapture = null, owned = true))
    }
    return submit(transition)
  }

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------

  /**
   * Tears the session down.
   *
   * [finalPhase] is `READY` for a stop that leaves the preview usable — the
   * phase it actually lands on is whatever the host's intent implies — `FAILED`
   * for a surface that could not be built, and `RELEASED` for a permanent
   * teardown. A release can never be downgraded.
   */
  fun close(
    finalPhase: PreviewPhase,
    settleStart: (P) -> Unit,
    settleCapture: (C) -> Unit,
  ): Throwable? {
    val transition = lock.withLock {
      enqueueLocked(
        closeLocked(
          landing = landingFor(finalPhase),
          takeCapture = true,
          takeStart = true,
          settleStart = settleStart,
          settleCapture = settleCapture,
          owned = true,
        ),
      )
    }
    return submit(transition)
  }

  /**
   * Detaches the session without settling anything — the caller has already
   * taken the capture and will settle it itself.
   *
   * This is the path a `Session.update()` failure takes: the frame owner
   * discovers the session is broken while it holds a lease, so it hands the
   * work back and this runs once the lease is released.
   */
  fun closeDetached(finalPhase: PreviewPhase): Throwable? {
    val transition = lock.withLock {
      enqueueLocked(
        closeLocked(
          landing = landingFor(finalPhase),
          takeCapture = false,
          takeStart = false,
          settleStart = null,
          settleCapture = null,
          owned = true,
        ),
      )
    }
    return submit(transition)
  }

  private fun landingFor(finalPhase: PreviewPhase): Landing = when (finalPhase) {
    PreviewPhase.RELEASED -> Landing.RELEASED
    PreviewPhase.FAILED -> Landing.FAILED
    else -> Landing.USABLE
  }

  // -----------------------------------------------------------------------
  // Phase one: build a transition and put it in the queue, under the lock
  // -----------------------------------------------------------------------

  private fun syncHostLocked(
    settleCapture: ((C) -> Unit)?,
    owned: Boolean,
  ): Transition<S, A, P, C> = Transition(
    kind = Kind.SYNC_HOST,
    landing = Landing.USABLE,
    working = if (hostAway) PreviewPhase.PAUSING else PreviewPhase.RESUMING,
    start = null,
    // A host that has gone away can never be served a capture waiting for a
    // fresh frame, so the pause takes it. A resume has nothing to take.
    capture = if (hostAway) captures.cancel() else null,
    session = null,
    analyzer = null,
    settleStart = null,
    settleCapture = settleCapture,
    owned = owned,
  )

  private fun closeLocked(
    landing: Landing,
    takeCapture: Boolean,
    takeStart: Boolean,
    settleStart: ((P) -> Unit)?,
    settleCapture: ((C) -> Unit)?,
    owned: Boolean,
  ): Transition<S, A, P, C> {
    val ownedSession = session
    val ownedAnalyzer = analyzer
    session = null
    analyzer = null
    sessionPaused = false
    return Transition(
      kind = Kind.CLOSE,
      landing = landing,
      working = PreviewPhase.CLOSING,
      start = if (takeStart) takePendingStartLocked() else null,
      capture = if (takeCapture) captures.cancel() else null,
      session = ownedSession,
      analyzer = ownedAnalyzer,
      settleStart = settleStart,
      settleCapture = settleCapture,
      owned = owned,
    )
  }

  /**
   * Appends a transition and makes its intent visible immediately.
   *
   * The queue position and the resource ownership are decided in the same
   * critical section, which is the whole ordering guarantee: whatever the
   * scheduler does afterwards, an operation issued earlier is performed earlier.
   */
  private fun enqueueLocked(transition: Transition<S, A, P, C>): Transition<S, A, P, C> {
    if (transition.landing == Landing.RELEASED) releaseRequested = true
    epoch += 1
    workingPhase = transition.working
    // Every frame in flight is about to be waited on. Asking them to stop is
    // not required for safety — the drain is — but it is what keeps the wait
    // short enough that the drain almost never times out.
    liveLeases.forEach { it.cancel() }
    queue.addLast(transition)
    return transition
  }

  // -----------------------------------------------------------------------
  // Phase two: one drainer, never re-entered
  // -----------------------------------------------------------------------

  /**
   * Hands [transition] to whoever is running the queue, and returns its failure
   * if this caller is in a position to wait for it.
   *
   * The three roles are the whole reentrancy story. A caller that finds the
   * queue idle becomes the drainer. A caller on a thread that is *already*
   * draining — which is what a Promise settlement calling `stopSession()` looks
   * like — must never wait, because it would be waiting for itself; its
   * transition is already queued and the loop it is standing in will run it.
   * Any other thread waits on its own transition only, holding nothing.
   */
  private fun submit(transition: Transition<S, A, P, C>): Throwable? {
    val role = lock.withLock {
      when {
        drainingThread == null -> {
          drainingThread = Thread.currentThread()
          Role.DRAIN
        }
        drainingThread === Thread.currentThread() -> Role.REENTRANT
        else -> Role.WAIT
      }
    }
    return when (role) {
      Role.DRAIN -> {
        drainQueue()
        transition.error
      }
      Role.REENTRANT -> {
        // This caller is standing inside the drain that will run its
        // transition, so it can never be told how that went. Hand the failure
        // over now, while the loop that will produce it has not reached it yet.
        transition.owned = false
        null
      }
      Role.WAIT -> {
        try {
          transition.completed.await()
        } catch (interrupted: InterruptedException) {
          Thread.currentThread().interrupt()
          transition.owned = false
          reportIfUnowned(transition)
          return interrupted
        }
        transition.error
      }
    }
  }

  /**
   * Reports a transition's failure when nobody is left to be told about it.
   *
   * Exactly once: the drainer and an interrupted waiter can both reach this,
   * and a failure said twice is noise while a failure said never is a camera
   * that stopped working in silence.
   */
  private fun reportIfUnowned(transition: Transition<S, A, P, C>) {
    if (transition.owned) return
    // The failure is read *before* the slot is claimed. Claiming it first meant
    // an interrupted waiter — which disowns its transition while that
    // transition is still queued, and therefore before anything can have gone
    // wrong with it — consumed the one report with nothing to say, and the
    // close failure that arrived afterwards had nowhere left to go (Codex
    // review of `667da95`).
    val failure = transition.error ?: return
    if (!transition.reported.compareAndSet(false, true)) return
    report(failure)
  }

  /**
   * Runs the queue to empty.
   *
   * Ownership of the queue is released in the *same* critical section that finds
   * it empty, so a transition enqueued by another thread can never be stranded
   * with nobody to run it. Nothing escapes the loop: a transition that somehow
   * throws still completes, so no waiter is left holding a latch that will
   * never open.
   */
  private fun drainQueue() {
    while (true) {
      val next = lock.withLock {
        val head = queue.pollFirst()
        if (head == null) {
          drainingThread = null
          workingPhase = null
        }
        head
      } ?: return
      val escaped = runCatching { executeTransition(next) }.exceptionOrNull()
      next.record(escaped)
      lock.withLock { land(next) }
      next.completed.countDown()
      reportIfUnowned(next)
    }
  }

  private fun land(transition: Transition<S, A, P, C>) {
    when (transition.landing) {
      Landing.RELEASED -> releaseRequested = true
      Landing.FAILED -> surfaceFailed = true
      Landing.USABLE -> Unit
    }
  }

  private fun executeTransition(transition: Transition<S, A, P, C>) {
    // Settlements first: a Promise must never wait behind a blocking ARCore
    // call. They run inside the drain, so a settlement that re-enters this
    // class enqueues and returns rather than deadlocking.
    transition.start?.let { request ->
      transition.record(attempt { transition.settleStart?.invoke(request) })
    }
    transition.capture?.let { request ->
      transition.record(attempt { transition.settleCapture?.invoke(request) })
    }
    when (transition.kind) {
      Kind.CLOSE -> executeClose(transition)
      Kind.SYNC_HOST -> executeSyncHost(transition)
    }
  }

  private fun executeClose(transition: Transition<S, A, P, C>) {
    val holdsResources = transition.session != null || transition.analyzer != null
    if (!holdsResources) return
    if (awaitFramesDrained()) {
      transition.record(attempt { transition.analyzer?.close() })
      transition.session?.let { current ->
        val failure = attempt { ops.close(current) }
        // A close that threw proves nothing about the camera. Saying READY
        // afterwards would accept a start and build a second session on top of
        // one that may still own the device.
        if (failure != null) lock.withLock { releaseUncertain = true }
        transition.record(failure)
      }
      return
    }
    // Never destroy resources a frame is still calling into. Hand them to
    // whichever frame turns the lights out, and keep the preview closed — not
    // startable, not renderable — until that has happened.
    transition.record(frameDrainFailure())
    deferRelease(DeferredRelease(transition.session, transition.analyzer))
  }

  /**
   * Makes the session match the host's current intent, whatever that is by the
   * time this runs.
   *
   * Re-read here rather than captured at enqueue time: a close issued in between
   * may have taken the session, and a later pause or resume may have changed
   * what the host wants. A transition that finds nothing to do does nothing —
   * the intent it was queued for is already recorded, and the phase comes from
   * that, not from this.
   */
  private fun executeSyncHost(transition: Transition<S, A, P, C>) {
    val target = lock.withLock {
      val current = session ?: return
      when {
        hostAway && !sessionPaused -> current to true
        !hostAway && sessionPaused -> current to false
        else -> return
      }
    }
    val (current, shouldPause) = target
    // A drain that times out is not a reason to walk away: the session is still
    // resumed, still owns the camera, and the host has already gone (Codex
    // review of `e4457d2`, P0-1 -- this used to record the failure and return,
    // leaving a live camera behind a phase that said PAUSED).
    val failure = if (awaitFramesDrained()) {
      attempt { if (shouldPause) ops.pause(current) else ops.resume(current) }
    } else {
      frameDrainFailure()
    }
    if (failure == null) {
      lock.withLock { if (session === current) sessionPaused = shouldPause }
      return
    }
    transition.record(failure)
    // FAIL CLOSED, both ways. A session that will not pause is holding the
    // camera while the app is away; a session that will not resume will throw
    // on every frame; a session we could not even reach is both. None is a
    // state to keep, so release it -- through the close path, which defers to
    // the last frame out when the frames are what is in the way -- and let the
    // next start build a fresh one.
    lock.withLock {
      if (session === current) {
        enqueueLocked(
          closeLocked(
            landing = Landing.USABLE,
            takeCapture = false,
            takeStart = false,
            settleStart = null,
            settleCapture = null,
            owned = false,
          ),
        )
      }
    }
  }

  // -----------------------------------------------------------------------
  // Frames, drains and deferred releases
  // -----------------------------------------------------------------------

  /**
   * Waits for every live frame to let go of the session.
   *
   * Bounded, and the timeout does not mean "carry on regardless": the caller
   * defers the release instead. Waiting forever would hang the host thread that
   * asked for a stop; releasing anyway would destroy a session a frame is still
   * calling into.
   */
  private fun awaitFramesDrained(): Boolean {
    lock.withLock {
      var remaining = TimeUnit.MILLISECONDS.toNanos(frameDrainTimeoutMs)
      while (liveLeases.isNotEmpty() && remaining > 0) {
        remaining = try {
          framesDrained.awaitNanos(remaining)
        } catch (interrupted: InterruptedException) {
          Thread.currentThread().interrupt()
          return false
        }
      }
      return liveLeases.isEmpty()
    }
  }

  private fun deferRelease(deferred: DeferredRelease<S, A>) {
    // Counted before the branch, not inside it. The frames may have drained
    // between the timeout and this call, and the immediate release that follows
    // is just as much a window in which the preview must not look usable as the
    // deferred one is.
    val releaseNow = lock.withLock {
      pendingReleases += 1
      if (liveLeases.isEmpty()) return@withLock true
      deferredReleases.add(deferred)
      false
    }
    if (releaseNow) release(deferred)
  }

  /**
   * Releases one loan and stops counting it -- but only claims it worked if it
   * did.
   *
   * A session close that throws here leaves exactly the same doubt as one in a
   * transition, so it leaves the same mark: the preview does not return to a
   * startable phase on the strength of a release nobody can vouch for.
   */
  private fun release(deferred: DeferredRelease<S, A>) {
    val analyzerFailure = attempt { deferred.analyzer?.close() }
    val sessionFailure = deferred.session?.let { current -> attempt { ops.close(current) } }
    lock.withLock {
      if (sessionFailure != null) releaseUncertain = true
      pendingReleases -= 1
    }
    analyzerFailure?.let(::report)
    sessionFailure?.let(::report)
  }

  private fun report(failure: Throwable) {
    runCatching { onDetachedError(failure) }
  }

  private fun frameDrainFailure() = IllegalStateException(
    "A camera frame did not finish within ${frameDrainTimeoutMs}ms; " +
      "the session will be released by the frame that does.",
  )

  private inline fun attempt(block: () -> Unit): Throwable? = try {
    block()
    null
  } catch (error: Throwable) {
    error
  }

  private fun takePendingStartLocked(): P? {
    val request = pendingStart
    pendingStart = null
    return request
  }

  companion object {
    /** How long a teardown waits for the render loop to let go of the session. */
    const val FRAME_DRAIN_TIMEOUT_MS: Long = 5_000
  }
}
