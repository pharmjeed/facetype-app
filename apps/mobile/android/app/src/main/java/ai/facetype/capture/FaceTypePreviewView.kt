package ai.facetype.capture

/*
 * FaceTypePreviewView — the ARCore/GL half of the camera preview.
 *
 * WHY A VIEW OWNS THE SESSION (design review D1/D2, message
 * 2026-08-25T21-54-44Z_53356c299477): ARCore's `Frame`/`AugmentedFace` are only
 * valid until the next `Session.update()`, and `Session.update()` needs a
 * current GL context bound to the thread that owns the camera texture.
 * `GLSurfaceView` gives us exactly one thread that satisfies both, so
 * `Session.update()` lives inside `onDrawFrame` and every `Frame`/
 * `AugmentedFace` read happens there, inside the update cycle that produced it.
 *
 * WHAT THIS CLASS NO LONGER DOES (Codex re-review of `984ab15`). It holds no
 * lifecycle rules. Phases, epochs, transition tickets, the pending start, the
 * pending capture and ownership of the Session and the analyser all live in
 * `PreviewSessionCoordinator`, which is plain JVM code the unit tests drive
 * directly. Those rules used to live here, where nothing but ARCore and a GL
 * thread can reach them — so they were tested through a harness that
 * reimplemented the same locking, which proves the harness correct and nothing
 * else. This class now builds resources, hands them over, and does what it is
 * told.
 *
 * SAME-FRAME CAPTURE. A capture request selects exactly one frame. That frame's
 * mesh is extracted into plain arrays and its camera image is copied, both
 * synchronously on the GL thread, and the two travel to the detector as one
 * `AnalysisRequest`. The request can only ever be answered by the analysis of
 * that frame — see `CaptureCoordinator`.
 *
 * NOTHING THAT CAN BLOCK RUNS UNDER THE LOCK. Building, pausing, resuming and
 * closing an ARCore `Session` all happen with the coordinator's lock released,
 * as does every Promise settlement and every `analyzer.submit` (ML Kit may
 * answer synchronously). Locked code returns the work; the caller performs it.
 * The frame itself is no longer an exception (Codex review of `989cd92`, P1-4):
 * `update()`, the trackable reads and `acquireCameraImage()` run under a
 * *lease* on the session rather than under the lock, so a host pause or a stop
 * no longer queues behind a camera frame. The teardown waits for the lease to
 * drain before it closes anything, which is the lifetime guarantee the lock was
 * providing.
 *
 * WHAT THIS FILE MUST NEVER DO: touch BiometricPrompt, the Android Keystore
 * biometric bindings, or any biometric template (FT-00 §3).
 */

import ai.facetype.capture.quality.AnalysisRequest
import ai.facetype.capture.quality.AnalysisResult
import ai.facetype.capture.quality.CaptureOutcome
import ai.facetype.capture.quality.CaptureQualityDiagnostics
import ai.facetype.capture.quality.ClaimResult
import ai.facetype.capture.quality.FaceQualityAnalyzer
import ai.facetype.capture.quality.FrameIdentity
import ai.facetype.capture.quality.FrameLease
import ai.facetype.capture.quality.GeometrySnapshot
import ai.facetype.capture.quality.InstallOutcome
import ai.facetype.capture.quality.MediaPipeBlendshapeHandle
import ai.facetype.capture.quality.MlKitFaceDetectorHandle
import ai.facetype.capture.quality.MlKitRotation
import ai.facetype.capture.quality.PreviewPhase
import ai.facetype.capture.quality.PreviewSessionCoordinator
import ai.facetype.capture.quality.SessionOps
import ai.facetype.capture.quality.StartOutcome
import ai.facetype.capture.quality.YuvNv21
import ai.facetype.capture.quality.YuvPlane
import ai.facetype.capture.rawframe.RawFrameJpeg
import ai.facetype.capture.rawframe.RawFrameStore
import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.view.Surface
import android.view.WindowManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.events.RCTEventEmitter
import com.google.ar.core.AugmentedFace
import com.google.ar.core.CameraConfig
import com.google.ar.core.CameraConfigFilter
import com.google.ar.core.Config
import com.google.ar.core.Coordinates2d
import com.google.ar.core.Frame
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.EnumSet
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

class FaceTypePreviewView(context: ThemedReactContext) : GLSurfaceView(context) {

  /** The three ARCore calls that can block, behind the coordinator's contract. */
  private object ArCoreSessionOps : SessionOps<Session> {
    override fun pause(session: Session) = session.pause()
    override fun resume(session: Session) = session.resume()
    override fun close(session: Session) = session.close()
  }

  private val coordinator =
    PreviewSessionCoordinator<Session, FaceQualityAnalyzer, Promise, PendingCapture>(
      ArCoreSessionOps,
      // A lifecycle failure that belongs to no Promise still belongs to the
      // user: an escalated close, a deferred release, a transition queued from
      // inside a settlement. Dropping these on the floor -- which the default
      // no-op did -- is how a camera stays open with nothing said about it
      // (Codex review of `45c663c`, P0-3).
      onDetachedError = { error -> reportLifecycleFailure(error) },
    )

  private val watchdog = Handler(Looper.getMainLooper())
  private val requestIds = AtomicLong(0)

  @Volatile private var surfaceWidth = 1
  @Volatile private var surfaceHeight = 1

  /**
   * Degrees the camera buffer must be rotated clockwise to be upright, or
   * [UNKNOWN_ROTATION] when it could not be derived. Unknown means capture
   * fails closed rather than measuring a possibly-sideways image: an
   * unmeasured signal is honest, a wrongly-measured one is not.
   */
  @Volatile private var detectorRotationDegrees = UNKNOWN_ROTATION

  // GL-thread-owned; never read or written from any other thread.
  private var cameraTextureId = 0
  private var program = 0
  private var quadVertices: FloatBuffer? = null
  // Reused across frames instead of reallocated: only its contents change (when
  // transformCoordinates2d reports new display geometry), never its size.
  private var quadTexCoordBuffer: FloatBuffer? = null
  private var hasTexCoords = false

  private class PendingCapture(
    val requestId: Long,
    val pose: String,
    val promise: Promise,
  )

  private class CopiedFrame(val nv21: ByteArray, val width: Int, val height: Int)

  private class PendingRawFrame(val requestId: Long, val promise: Promise)

  /**
   * The consented field-study photograph, and the one-shot request for it.
   *
   * DELIBERATELY OUTSIDE THE CAPTURE COORDINATOR. A raw frame is not evidence:
   * it never reaches a quality gate, a mesh, an observation or a score, and
   * pairing it with a specific analysed frame would suggest otherwise. It is a
   * reference photograph of the moment immediately after a pose was measured,
   * taken only when the participant asked for one to be kept. Keeping it out of
   * `PreviewSessionCoordinator` means the capture pipeline that *is* evidence
   * gained no branch, no flag and no extra state from this feature.
   *
   * The bytes never touch disk — see [RawFrameStore] — and the store is wiped
   * on host pause, on stop and on release, so a session that ends without
   * JavaScript hearing about it leaves no face behind.
   */
  private val rawFrameStore = RawFrameStore()
  private val pendingRawFrame = AtomicReference<PendingRawFrame?>(null)

  /**
   * JPEG encoding is tens of milliseconds of CPU. On the GL thread that is
   * dropped preview frames; on the analyser's thread it would delay the
   * measurement of the next pose. Its own single thread keeps it off both.
   */
  private val rawFrameEncoder: ExecutorService =
    Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "facetype-rawframe") }

  init {
    setEGLContextClientVersion(2)
    preserveEGLContextOnPause = true
    // Other RN-rendered siblings (the "preparing camera" overlay text) must
    // still be able to draw on top of this SurfaceView-backed content.
    setZOrderMediaOverlay(true)
    setRenderer(FrameRenderer())
    renderMode = RENDERMODE_CONTINUOUSLY
  }

  /**
   * [FaceTypeCaptureModule] has no reference to a specific view instance; it
   * asks [FaceTypePreviewRegistry] for whichever one is on screen right now.
   * Registering here (rather than in the view manager's create/drop) is what
   * makes that "on screen right now" instead of merely "constructed".
   */
  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    FaceTypePreviewRegistry.attach(this)
  }

  /**
   * `super.onDetachedFromWindow()` asks the GL thread to exit and blocks until
   * it has, so the teardown runs first — while there is still something to tear
   * down — and is safe against the in-flight frame because the coordinator
   * waits for that frame's lease on the session to drain before closing it.
   */
  override fun onDetachedFromWindow() {
    release()
    super.onDetachedFromWindow()
  }

  // ---------------------------------------------------------------------
  // Called from the RN bridge / UI thread (FaceTypeCaptureModule).
  // ---------------------------------------------------------------------

  fun startSession(promise: Promise) {
    when (val outcome = coordinator.beginStart(promise)) {
      is StartOutcome.Refused -> outcome.request.reject(outcome.code, outcome.message)
      is StartOutcome.Accepted -> {
        val epoch = outcome.epoch
        // `queueEvent` silently accepts work for a thread that has exited, so
        // the Promise cannot depend on this running: the watchdog and every
        // teardown path can each claim it back.
        watchdog.postDelayed({ expireStart(epoch) }, WATCHDOG_TIMEOUT_MS)
        queueEvent { processPendingStart(epoch) }
      }
    }
  }

  fun stopSession(promise: Promise) {
    val error = coordinator.close(
      PreviewPhase.READY,
      settleStart = { it.reject("FT-REC-005", "ARCore capture was stopped.") },
      settleCapture = { it.promise.reject("FT-REC-005", "ARCore capture was stopped.") },
    )
    if (error == null) {
      promise.resolve(null)
    } else {
      promise.reject("FT-REC-005", "ARCore capture could not stop cleanly.", error)
    }
  }

  fun requestCapture(pose: String, promise: Promise) {
    val requestId = requestIds.incrementAndGet()
    val request = PendingCapture(requestId, pose, promise)
    if (!coordinator.acceptCapture(request, nowNs())) {
      promise.reject("FT-REC-005", "Capture session is not running.")
      return
    }
    // The coordinator's deadlines are only evaluated when a frame is rendered.
    // If rendering stops entirely -- a surface torn down without a lifecycle
    // callback, a camera that never produces another frame -- nothing would ever
    // settle this Promise. The watchdog does not depend on the render loop.
    watchdog.postDelayed({ expireCapture(requestId) }, WATCHDOG_TIMEOUT_MS)
  }

  /**
   * Ask for the current camera frame as a JPEG, for a consented field-study
   * photograph.
   *
   * Served by the render loop from the next frame that has a camera image, and
   * bounded by the same watchdog the capture path uses, so a preview that has
   * stopped producing frames fails the request instead of hanging it.
   */
  fun requestRawFrame(promise: Promise) {
    if (coordinator.isReleased() || !coordinator.hasSession()) {
      promise.reject("FT-REC-005", "Capture session is not running.")
      return
    }
    val requestId = requestIds.incrementAndGet()
    // Only one photograph is ever in flight (the field sequence asks for one
    // per pose, after that pose's geometry has resolved). Superseding rather
    // than refusing keeps an abandoned request from blocking the next one, and
    // settles the old promise instead of leaving its caller waiting.
    pendingRawFrame.getAndSet(PendingRawFrame(requestId, promise))
      ?.promise
      ?.reject("FT-REC-005", "A newer raw-frame request replaced this one.")
    watchdog.postDelayed({ expireRawFrame(requestId) }, WATCHDOG_TIMEOUT_MS)
  }

  /**
   * The held photograph as base64, or a rejection if the slot has moved on.
   *
   * The store hands out a copy, which is wiped here as soon as it has been
   * encoded. The base64 `String` itself cannot be wiped — it crosses the React
   * Native bridge and Java strings are immutable — so it is produced only at
   * the moment of upload and never retained on either side.
   */
  fun readRawFrame(token: String, promise: Promise) {
    val bytes = rawFrameStore.read(token)
    if (bytes == null) {
      promise.reject("FT-REC-005", "That raw frame is no longer held.")
      return
    }
    try {
      promise.resolve(Base64.encodeToString(bytes, Base64.NO_WRAP))
    } finally {
      bytes.fill(0)
    }
  }

  /** Wipes one held photograph. Resolves whether or not it was still there. */
  fun discardRawFrame(token: String, promise: Promise) {
    rawFrameStore.discard(token)
    promise.resolve(null)
  }

  /** Wipes whatever is held, and fails any request still waiting for a frame. */
  fun discardAllRawFrames() {
    pendingRawFrame.getAndSet(null)
      ?.promise
      ?.reject("FT-REC-005", "The raw-frame request was cancelled.")
    rawFrameStore.discardAll()
  }

  /**
   * A host pause stops the camera, so a capture waiting for a fresh frame can
   * never be served: the coordinator settles it before it pauses anything.
   *
   * The result is not discarded. A `Session.pause()` that fails has left the
   * camera running while the app is in the background; the coordinator releases
   * the session for that reason, and JS is told rather than left with a preview
   * that silently stopped working.
   */
  fun hostPause() {
    val failure = coordinator.pause { request ->
      request.promise.reject(
        "FT-REC-005",
        "ARCore capture was interrupted by the app going away.",
      )
    }
    // The app is going to the background with, possibly, a participant's face
    // encoded in memory. The field-study protocol requires that it not survive
    // that transition, and JavaScript cannot be relied on to hear about it.
    discardAllRawFrames()
    super.onPause()
    failure?.let { reportLifecycleFailure(it) }
  }

  /** The GL thread is resumed first so it can start rendering again. */
  fun hostResume() {
    if (coordinator.isReleased()) return
    super.onResume()
    coordinator.resume()?.let { reportLifecycleFailure(it) }
  }

  /**
   * Surfaces a lifecycle failure that no Promise is waiting on.
   *
   * `emitPreviewError` hops to the UI thread, so this is safe from the GL
   * thread, the render loop's teardown and the coordinator's own drain alike.
   */
  private fun reportLifecycleFailure(error: Throwable) {
    emitPreviewError(error.message ?: "The camera preview could not change state.")
  }

  /** Tears the view down. Safe from any thread, idempotent. */
  fun release() {
    // Compare-and-clear: a superseded/dropped view's teardown must never erase
    // the registry entry of a view that replaced it.
    FaceTypePreviewRegistry.clearIfCurrent(this)
    watchdog.removeCallbacksAndMessages(null)
    // Before the encoder is shut down, so a request queued behind it is
    // settled here rather than dropped by the rejected execution below.
    discardAllRawFrames()
    rawFrameEncoder.shutdown()
    // Best-effort by nature -- a view being detached may have no JS left to
    // hear it -- but a release that could not free the camera is exactly the
    // failure worth trying to say out loud, and a bridge invalidate() reaches
    // here with the context still live.
    coordinator.close(
      PreviewPhase.RELEASED,
      settleStart = { it.reject("FT-REC-005", "The preview surface was torn down.") },
      settleCapture = { it.promise.reject("FT-REC-005", "The preview surface was torn down.") },
    )?.let { reportLifecycleFailure(it) }
  }

  // ---------------------------------------------------------------------
  // Settlement. The coordinator owns each request; whoever it hands one to
  // settles it, and every other path gets nothing.
  // ---------------------------------------------------------------------

  /** Fails one specific request, so a watchdog cannot settle a later one. */
  private fun expireCapture(requestId: Long) {
    coordinator.cancelCaptureIf { it.requestId == requestId }?.promise?.reject(
      "FT-SCAN-014",
      "No camera frame could be measured for this capture.",
    )
  }

  /** Fails one raw-frame request, so a watchdog cannot settle a later one. */
  private fun expireRawFrame(requestId: Long) {
    val pending = pendingRawFrame.get() ?: return
    if (pending.requestId != requestId) return
    if (!pendingRawFrame.compareAndSet(pending, null)) return
    pending.promise.reject("FT-SCAN-014", "No camera frame was available to photograph.")
  }

  /** Fails a start the GL thread never got to. */
  private fun expireStart(epoch: Long) {
    when (val claim = coordinator.claimStart(epoch)) {
      is ClaimResult.Claimed -> claim.request.reject("FT-REC-005", "ARCore capture did not start.")
      is ClaimResult.Stale -> claim.request.reject(
        "FT-REC-005",
        "The camera preview changed before ARCore could start.",
      )
      ClaimResult.None -> Unit
    }
  }

  /** Called from the analyser's thread when a bound frame has been measured. */
  private fun onAnalysisResult(result: AnalysisResult) {
    val outcome = coordinator.onAnalysisComplete(result)
    if (outcome !is CaptureOutcome.Deliver) return
    resolveCapture(outcome.request, outcome.result)
  }

  private fun nowNs(): Long = SystemClock.elapsedRealtimeNanos()

  // ---------------------------------------------------------------------
  // GL-thread only from here down.
  // ---------------------------------------------------------------------

  /**
   * Builds the ARCore session for the start accepted under [epoch].
   *
   * Construction and `resume()` both happen with no lock held — both can block
   * — and the result is offered to the coordinator afterwards. If the phase
   * moved on meanwhile the session is handed straight back and closed here,
   * rather than installed into a preview that no longer wants it.
   */
  private fun processPendingStart(epoch: Long) {
    val promise = when (val claim = coordinator.claimStart(epoch)) {
      is ClaimResult.Claimed -> claim.request
      is ClaimResult.Stale -> {
        claim.request.reject(
          "FT-REC-005",
          "The camera preview changed before ARCore could start.",
        )
        return
      }
      ClaimResult.None -> return
    }
    if (coordinator.hasSession()) {
      promise.resolve(null)
      return
    }

    var created: Session? = null
    val analyzer: FaceQualityAnalyzer?
    try {
      created = Session(context, EnumSet.of(Session.Feature.FRONT_CAMERA))
      // Prefer more camera-image detail (not the GPU preview resolution),
      // using only supported configurations of this same front camera.
      // Bound full-frame allocation on older handsets; never upscale pixels.
      val originalCamera = created.cameraConfig
      val preferredCamera = created.getSupportedCameraConfigs(
        CameraConfigFilter(created).setFacingDirection(CameraConfig.FacingDirection.FRONT),
      ).filter {
        it.cameraId == originalCamera.cameraId &&
          it.imageSize.width.toLong() * it.imageSize.height <= 1920L * 1080L
      }.maxByOrNull { it.imageSize.width.toLong() * it.imageSize.height }
      if (preferredCamera != null) created.cameraConfig = preferredCamera
      created.setCameraTextureName(cameraTextureId)
      val faceConfig = Config(created).apply {
          augmentedFaceMode = Config.AugmentedFaceMode.MESH3D
          updateMode = Config.UpdateMode.LATEST_CAMERA_IMAGE
          lightEstimationMode = Config.LightEstimationMode.DISABLED
      }
      try {
        created.configure(faceConfig)
      } catch (unsupported: com.google.ar.core.exceptions.UnsupportedConfigurationException) {
        // A larger image must not disable the face-tracking feature.
        created.cameraConfig = originalCamera
        created.configure(faceConfig)
      }
      created.setDisplayGeometry(displayRotation(), surfaceWidth, surfaceHeight)
      created.resume()
      analyzer = buildQualityAnalyzer()
    } catch (error: Exception) {
      created?.let { runCatching { it.close() } }
      promise.reject("FT-REC-005", "ARCore front-camera capture could not start.", error)
      return
    }

    when (val install = coordinator.installSession(epoch, created, analyzer)) {
      is InstallOutcome.Rejected -> {
        runCatching { analyzer?.close() }
        runCatching { ArCoreSessionOps.close(install.session) }
        promise.reject("FT-REC-005", "The camera preview changed before ARCore could start.")
      }
      // If the host went away while this was building, the coordinator has
      // already reconciled the session with that intent. Doing it from here was
      // three unsynchronised steps against a session nothing was tracking.
      is InstallOutcome.Installed -> {
        val parked = install.error
        if (parked != null) {
          // Installed, but it could not be put into the state the host asked
          // for -- so it has been released again. Resolving here would hand JS
          // a preview with no session behind it.
          promise.reject(
            "FT-REC-005",
            "ARCore capture could not be parked while the app was away.",
            parked,
          )
        } else {
          detectorRotationDegrees = computeDetectorRotation(created)
          promise.resolve(null)
        }
      }
    }
  }

  /**
   * Constructs the analyser.
   *
   * If the bundled detector cannot be created the analyser is absent and every
   * capture fails closed on `FT-SCAN-014`. That is the honest outcome: a device
   * that cannot run the detector cannot measure capture quality.
   *
   * The blendshape handle is allowed to be absent on its own. A device that
   * cannot create the landmarker still measures blur, exposure and the face
   * count, so a user with nobody in frame is told `FT-SCAN-005` rather than a
   * blanket "could not measure"; the capture still fails, because neutrality is
   * unknown and an unknown signal is `FT-SCAN-014`.
   */
  private fun buildQualityAnalyzer(): FaceQualityAnalyzer? = runCatching {
    FaceQualityAnalyzer(
      MlKitFaceDetectorHandle(),
      MediaPipeBlendshapeHandle.create(context),
    ) { result -> onAnalysisResult(result) }
  }.getOrNull()

  private fun displayRotation(): Int {
    val windowManager =
      context.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
    @Suppress("DEPRECATION")
    return windowManager?.defaultDisplay?.rotation ?: Surface.ROTATION_0
  }

  private fun displayRotationDegrees(): Int = when (displayRotation()) {
    Surface.ROTATION_90 -> 90
    Surface.ROTATION_180 -> 180
    Surface.ROTATION_270 -> 270
    else -> 0
  }

  /**
   * Derives the rotation the detector needs from how the sensor is mounted and
   * how the device is being held. ARCore does not expose the mounting angle,
   * but it names the camera it opened and `CameraManager` will answer for it.
   */
  private fun computeDetectorRotation(session: Session): Int = try {
    val manager = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
    val sensorOrientation = manager
      ?.getCameraCharacteristics(session.cameraConfig.cameraId)
      ?.get(CameraCharacteristics.SENSOR_ORIENTATION)
    if (sensorOrientation == null) {
      UNKNOWN_ROTATION
    } else {
      MlKitRotation.compensation(
        sensorOrientation = sensorOrientation,
        deviceRotationDegrees = displayRotationDegrees(),
        frontFacing = true,
      )
    }
  } catch (_: Exception) {
    UNKNOWN_ROTATION
  }

  /**
   * Binds this frame to the pending capture: its mesh and its pixels are taken
   * together, inside the update cycle that produced them.
   *
   * Returns the work to perform once the lease is released — submitting to the
   * detector (ML Kit can answer synchronously, so it must not run while the
   * session is pinned) or settling the request.
   */
  private fun dispatchAnalysis(
    current: Session,
    analyzer: FaceQualityAnalyzer?,
    frame: Frame,
    identity: FrameIdentity,
  ): (() -> Unit)? {
    val rotation = detectorRotationDegrees
    if (analyzer == null || rotation == UNKNOWN_ROTATION) {
      return failCapture("FT-SCAN-014", "Capture quality cannot be measured on this device.")
    }

    val faces = try {
      current.getAllTrackables(AugmentedFace::class.java)
        .filter { it.trackingState == TrackingState.TRACKING }
    } catch (error: Exception) {
      return failCapture("FT-REC-005", "ARCore could not read face geometry.")
    }
    if (faces.isEmpty()) return failCapture("FT-SCAN-005", "No face is currently tracked.")
    if (faces.size > 1) return failCapture("FT-SCAN-004", "More than one face is in the frame.")

    val geometry = try {
      extractGeometry(faces.first())
    } catch (error: Exception) {
      return failCapture("FT-REC-005", "ARCore could not resolve face geometry.")
    }

    val copied = copyCameraImage(frame)
    if (copied == null) {
      // The camera image for this frame is not available yet (ARCore hands it
      // out a frame or two after tracking starts). That is not a failure: give
      // the request its baseline back so the next frame can bind instead —
      // unless it has run out of time, in which case the rewind hands it back
      // to be failed rather than retried forever.
      val outcome = coordinator.rewindCapture(identity, nowNs())
      if (outcome !is CaptureOutcome.Fail) return null
      val request = outcome.request
      return {
        runCatching { request.promise.reject(outcome.code, outcome.message) }
        Unit
      }
    }

    val request = AnalysisRequest(
      identity = identity,
      width = copied.width,
      height = copied.height,
      rotationDegrees = rotation,
      nv21 = copied.nv21,
      geometry = geometry,
    )
    return {
      analyzer.submit(request)
      Unit
    }
  }

  /**
   * Serves a pending raw-frame request from [frame], if there is one.
   *
   * Runs on the GL thread under the frame's lease, like [dispatchAnalysis], and
   * for the same reason: `acquireCameraImage()` is only valid for the frame
   * `update()` just produced. Everything expensive — the YUV conversion and the
   * JPEG encode — is returned as deferred work so it happens on the encoder
   * thread after the lease is released.
   *
   * Returns null when there is nothing to do, or when this frame has no camera
   * image yet; in the latter case the request simply waits for the next frame,
   * bounded by its watchdog.
   */
  private fun serveRawFrame(frame: Frame): (() -> Unit)? {
    val request = pendingRawFrame.get() ?: return null

    val rotation = detectorRotationDegrees
    if (rotation == UNKNOWN_ROTATION) {
      // The same fail-closed rule the measurement path uses: an image this
      // build cannot orient is not one it should store.
      if (!pendingRawFrame.compareAndSet(request, null)) return null
      return {
        runCatching {
          request.promise.reject(
            "FT-SCAN-014",
            "The camera orientation could not be determined on this device.",
          )
        }
        Unit
      }
    }

    val copied = copyCameraImage(frame) ?: return null

    // Claim the request before anything is queued, so the watchdog and a
    // superseding request cannot also settle it. Losing the race means this
    // frame's copy belongs to nobody and must not linger.
    if (!pendingRawFrame.compareAndSet(request, null)) {
      copied.nv21.fill(0)
      return null
    }

    return {
      try {
        rawFrameEncoder.execute { encodeRawFrame(request, copied, rotation) }
      } catch (_: RejectedExecutionException) {
        // The view was released between the claim and the queue.
        copied.nv21.fill(0)
        runCatching {
          request.promise.reject("FT-REC-005", "The preview surface was torn down.")
        }
      }
      Unit
    }
  }

  /** Encoder thread. The NV21 copy is wiped however this ends. */
  private fun encodeRawFrame(request: PendingRawFrame, copied: CopiedFrame, rotation: Int) {
    val encoded = try {
      RawFrameJpeg.encode(copied.nv21, copied.width, copied.height, rotation)
    } finally {
      copied.nv21.fill(0)
    }
    if (encoded == null) {
      runCatching {
        request.promise.reject("FT-SCAN-014", "The camera frame could not be encoded.")
      }
      return
    }
    val handle = rawFrameStore.put(encoded.jpeg, encoded.width, encoded.height)
    runCatching {
      request.promise.resolve(
        Arguments.createMap().apply {
          // Metadata only. The bytes stay in the store until JavaScript has an
          // upload slot signed for exactly this length and digest.
          putString("token", handle.token)
          putInt("byteLength", handle.byteLength)
          putString("sha256", handle.sha256)
          putInt("width", handle.width)
          putInt("height", handle.height)
        },
      )
    }
  }

  /** Takes the pending capture so the caller can fail it outside the lock. */
  private fun failCapture(code: String, message: String): (() -> Unit)? {
    val request = coordinator.cancelCapture() ?: return null
    return {
      runCatching { request.promise.reject(code, message) }
      Unit
    }
  }

  /**
   * Copies the mesh out of ARCore's ownership.
   *
   * `AugmentedFace` and its buffers stop being valid at the next
   * `Session.update()`, so everything the payload needs is read into plain
   * arrays here, synchronously, and nothing ARCore owns escapes this method.
   */
  private fun extractGeometry(face: AugmentedFace): GeometrySnapshot {
    val vertices = face.meshVertices
    val vertexCount = vertices.limit() / 3
    val landmarks = FloatArray(vertexCount * 3)
    val pose = face.centerPose
    var index = 0
    while (index < vertexCount) {
      // Mesh vertices are face-local. Transform them into the same world frame
      // as headPose before converting metres to millimetres.
      val world = pose.transformPoint(
        floatArrayOf(
          vertices.get(index * 3),
          vertices.get(index * 3 + 1),
          vertices.get(index * 3 + 2),
        ),
      )
      landmarks[index * 3] = world[0] * 1000f
      landmarks[index * 3 + 1] = world[1] * 1000f
      landmarks[index * 3 + 2] = world[2] * 1000f
      index += 1
    }

    val uv = face.meshTextureCoordinates
    val textureCoordinates = FloatArray(uv.limit()) { uv.get(it) }
    val triangles = face.meshTriangleIndices
    val triangleIndices = IntArray(triangles.limit()) { triangles.get(it).toInt() and 0xffff }

    val matrix = FloatArray(16)
    pose.toMatrix(matrix, 0)
    val rowMajor = FaceGeometryMath.toRowMajorMillimeters(matrix)
    val (yaw, pitch) = FaceGeometryMath.yawPitchDegrees(rowMajor)
    return GeometrySnapshot(landmarks, textureCoordinates, triangleIndices, rowMajor, yaw, pitch)
  }

  /**
   * Copies the current camera image into a fresh NV21 array owned solely by the
   * request that will carry it.
   *
   * `acquireCameraImage()` draws from a small fixed pool of hardware buffers; an
   * image left open stops the camera producing frames. It is therefore closed in
   * a `finally` — exactly once, on every path including the exceptional ones —
   * before this method returns and before anything asynchronous starts.
   */
  private fun copyCameraImage(frame: Frame): CopiedFrame? {
    val image = try {
      frame.acquireCameraImage()
    } catch (_: Exception) {
      // NotYetAvailable / DeadlineExceeded / a camera that has gone away.
      return null
    }
    try {
      if (image.format != ImageFormat.YUV_420_888) return null
      val planes = image.planes
      if (planes.size < 3) return null

      // `cropRect` is the sub-rectangle of the stride-padded planes that
      // actually holds picture. Ignoring it feeds a column of alignment padding
      // to the detector as if it were pixels.
      val crop = image.cropRect
      val hasCrop = crop != null && crop.width() > 0 && crop.height() > 0
      val rawLeft = if (hasCrop) crop.left else 0
      val rawTop = if (hasCrop) crop.top else 0
      val rawWidth = if (hasCrop) crop.width() else image.width
      val rawHeight = if (hasCrop) crop.height() else image.height

      // 4:2:0 subsamples chroma on even coordinates, so a crop that starts or
      // ends on an odd one has no exact representation. Rounding the origin up
      // and the extent down keeps the region strictly inside the reported crop;
      // losing at most one row and column of a face is immaterial next to
      // sampling the wrong ones.
      val left = rawLeft + (rawLeft and 1)
      val top = rawTop + (rawTop and 1)
      val width = (rawWidth - (left - rawLeft)) and 1.inv()
      val height = (rawHeight - (top - rawTop)) and 1.inv()
      if (width <= 0 || height <= 0) return null

      val nv21 = ByteArray(YuvNv21.byteCount(width, height))
      YuvNv21.convert(
        y = YuvPlane(planes[0].buffer, planes[0].rowStride, planes[0].pixelStride),
        u = YuvPlane(planes[1].buffer, planes[1].rowStride, planes[1].pixelStride),
        v = YuvPlane(planes[2].buffer, planes[2].rowStride, planes[2].pixelStride),
        cropLeft = left,
        cropTop = top,
        cropWidth = width,
        cropHeight = height,
        out = nv21,
      )
      return CopiedFrame(nv21, width, height)
    } catch (_: Exception) {
      // A layout this code does not understand produces no sample rather than
      // metrics computed from misread bytes.
      return null
    } finally {
      image.close()
    }
  }

  /**
   * Builds the JS payload from one frame's evidence.
   *
   * Runs on the analyser's thread. Everything it reads is a plain array
   * extracted on the GL thread; no ARCore object is involved.
   */
  private fun resolveCapture(request: PendingCapture, result: AnalysisResult) {
    try {
      if (result.faceCount < 0) {
        request.promise.reject(
          "FT-SCAN-014",
          "Capture-quality measurement failed for this frame.",
        )
        return
      }
      if (result.faceCount == 0) {
        request.promise.reject("FT-SCAN-005", "No face is currently visible.")
        return
      }
      if (result.faceCount > 1) {
        request.promise.reject("FT-SCAN-004", "More than one face is in the frame.")
        return
      }
      val blur = result.blur
      val exposure = result.exposure
      if (blur == null || exposure == null) {
        request.promise.reject(
          "FT-SCAN-014",
          "Capture-quality measurement was incomplete for this frame.",
        )
        return
      }
      // The landmarker did not run, did not answer, or answered with
      // activations the estimator will not score. Any of those is an unknown,
      // and an unknown is FT-SCAN-014 -- never a neutral-looking default.
      val expression = result.expression
      if (expression == null) {
        request.promise.reject(
          "FT-SCAN-014",
          "Facial-expression measurement was unavailable for this frame.",
        )
        return
      }

      val geometry = result.geometry
      val landmarks = Arguments.createArray()
      geometry.landmarksMm.forEach { landmarks.pushDouble(it.toDouble()) }
      val textureCoordinates = Arguments.createArray()
      geometry.textureCoordinates.forEach { textureCoordinates.pushDouble(it.toDouble()) }
      val triangleIndices = Arguments.createArray()
      geometry.triangleIndices.forEach { triangleIndices.pushInt(it) }
      val headPose = Arguments.createArray()
      geometry.headPoseRowMajorMm.forEach { headPose.pushDouble(it.toDouble()) }
      val confidence = Arguments.createArray()
      // ARCore exposes tracking availability, not calibrated per-vertex
      // probabilities. This mesh was TRACKING when it was read, so each
      // available vertex is 1.
      repeat(geometry.vertexCount) { confidence.pushDouble(1.0) }

      val quality = Arguments.createMap().apply {
        // Measured, from the copied pixels of the same camera frame this mesh
        // was read from, over the region the detector found a face in.
        putDouble("blur", blur)
        putDouble("exposure", exposure)
        putInt("faceCount", result.faceCount)
        // Measured, from the 52 per-expression activations the landmarker read
        // off this same frame, by the same estimator iOS runs over ARKit's
        // blendshapes. Uncalibrated against this handset, like every other
        // score here (ADR-010).
        putDouble("neutrality", expression.neutrality)
        // STILL NOT measured, and still an explicit unknown rather than a
        // default. Nothing available on this platform reports what is covering
        // a face: the detector's box does not, the mesh's vertices do not, and
        // the landmark model outputs 478 coordinates whatever is in front of
        // them -- so "how much of the face came back" is a constant, and an
        // occlusion score read off it would be a fabricated pass on every
        // frame. Null causes FT-SCAN-014 in both the client and the server
        // gates. See docs/adr/ADR-009-android-capture-quality-scope.md and
        // docs/adr/ADR-010-android-neutrality-from-blendshapes.md.
        putNull("occlusion")
        putDouble("yawDeg", geometry.yawDeg)
        putDouble("pitchDeg", geometry.pitchDeg)
      }

      // Debug builds only: the six aggregate scores this gate decides on, so a
      // rejection on a real handset can be read back without a debugger. The
      // release variant of CaptureQualityDiagnostics has an empty body, so
      // this call emits nothing there. Scalars only -- never pixels, arrays,
      // activations or identifiers.
      CaptureQualityDiagnostics.logAggregate(
        blur = blur,
        exposure = exposure,
        neutrality = expression.neutrality,
        faceCount = result.faceCount,
        yawDeg = geometry.yawDeg,
        pitchDeg = geometry.pitchDeg,
      )

      request.promise.resolve(
        Arguments.createMap().apply {
          putString("observationId", "obs_arcore_${request.pose}_${System.currentTimeMillis()}")
          // What this acquisition path can and cannot measure (ADR-011). A
          // claim, not a verdict: the server resolves it against its own closed
          // (provider, profile) mapping and can refuse it, and declaring it can
          // only ever reduce what this capture is trusted for. Hard-coded
          // because it is a property of this build's dependency set, not of the
          // device or the moment -- if this app is ever able to measure
          // occlusion, this string changes with the code that measures it.
          putString("qualityProfile", "REDUCED_GEOMETRY_NO_OCCLUSION")
          // The artifact the profile name is defined by, without which the
          // declaration means nothing and resolves to UNKNOWN -- a build
          // predating qp-1.0.0 can put a familiar string under a familiar key
          // without implementing what the key means. Omitting it was why every
          // ARCore capture still died on FT-SCAN-014 with the waiver in place.
          putString("qualityProfileVersion", QUALITY_PROFILE_VERSION)
          putString("landmarkTopology", "arcore-face-mesh-468")
          putString("topologyVersion", "arcore-augmented-face-468-v1")
          putArray("landmarks", landmarks)
          putArray("landmarkConfidence", confidence)
          putArray("textureCoordinates", textureCoordinates)
          putArray("triangleIndices", triangleIndices)
          putArray("headPose", headPose)
          putMap(
            "blendshapes",
            Arguments.createMap().apply {
              // Every category the model reported, verbatim -- not only the
              // twelve the neutrality estimator reads. Canonicalization removes
              // expression deformation downstream (FT-03 s.5 step 6) and needs
              // the activations themselves, not a summary of them.
              expression.blendshapes.forEach { (name, value) ->
                putDouble(name, value.toDouble())
              }
            },
          )
          putMap("quality", quality)
          // ARCore's augmented-face mesh is documented as metric, but this
          // repository has no calibrated-device evidence proving reported
          // scale is accurate on real hardware (audit P0-02 item 3) — no
          // target-object measurement, no device-specific calibration record.
          // Claiming `true` unconditionally would assert every device's
          // millimetres are trustworthy on documentation alone. Report
          // honestly unreliable until a specific, evidenced calibrated
          // condition sets this per capture.
          putBoolean("metricScaleReliable", false)
        },
      )
    } catch (error: Exception) {
      request.promise.reject("FT-REC-005", "The capture payload could not be built.", error)
    }
  }

  private fun emitEvent(name: String, payload: WritableMap) {
    val reactContext = context as? ThemedReactContext ?: return
    val viewId = id
    UiThreadUtil.runOnUiThread {
      reactContext.getJSModule(RCTEventEmitter::class.java)?.receiveEvent(viewId, name, payload)
    }
  }

  private fun emitPreviewReady() {
    emitEvent(FaceTypePreviewViewManager.EVENT_PREVIEW_READY, Arguments.createMap())
  }

  private fun emitPreviewError(message: String) {
    emitEvent(
      FaceTypePreviewViewManager.EVENT_PREVIEW_ERROR,
      Arguments.createMap().apply { putString("message", message) },
    )
  }

  private inner class FrameRenderer : Renderer {
    /**
     * A half-built surface is worse than none: the texture and the program are
     * separate GL objects, and a failure between them used to leave the texture
     * allocated with nothing holding its name, then report readiness anyway.
     * Both are created into locals and only published together, whatever did get
     * created is deleted on the way out, and any request waiting on a preview
     * that will never exist is settled by the teardown.
     */
    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
      var texture = 0
      var linkedProgram = 0
      try {
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        texture = createOesTexture()
        linkedProgram = createProgram()
        cameraTextureId = texture
        program = linkedProgram
        quadVertices = directFloatBuffer(NDC_QUAD_COORDS)
        quadTexCoordBuffer = null
        hasTexCoords = false
        // A live Session survives EGL context loss (the Kotlin object itself is
        // untouched), but the OES texture it was bound to belonged to the old
        // context and is gone with it. Rebind it to the texture this new context
        // just created; otherwise the camera never draws again after a
        // background/foreground cycle that recreated the surface.
        coordinator.withRunningSession { session, _, _ ->
          session.setCameraTextureName(cameraTextureId)
          Unit
        }
        coordinator.surfaceCreated()
        emitPreviewReady()
      } catch (error: Exception) {
        if (linkedProgram != 0) GLES20.glDeleteProgram(linkedProgram)
        if (texture != 0) GLES20.glDeleteTextures(1, intArrayOf(texture), 0)
        cameraTextureId = 0
        program = 0
        quadVertices = null
        quadTexCoordBuffer = null
        hasTexCoords = false
        val message = error.message ?: "GL surface initialisation failed"
        // A Session bound to a surface that no longer exists cannot produce a
        // frame, and it holds the physical front camera while it fails to.
        val teardown = coordinator.close(
          PreviewPhase.FAILED,
          settleStart = { it.reject("FT-REC-005", message) },
          settleCapture = { it.promise.reject("FT-REC-005", message) },
        )
        emitPreviewError(message)
        // Two different failures: the surface could not be built, *and* the
        // session it was driving could not be released. The second one decides
        // whether the camera is still held, so it does not get folded into the
        // first.
        teardown?.let { reportLifecycleFailure(it) }
      }
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
      surfaceWidth = width
      surfaceHeight = height
      GLES20.glViewport(0, 0, width, height)
      coordinator.withRunningSession { session, _, _ ->
        session.setDisplayGeometry(displayRotation(), width, height)
        // The display rotation is half of what the detector rotation is derived
        // from, so a device turned in the user's hand invalidates it.
        detectorRotationDegrees = computeDetectorRotation(session)
        Unit
      }
    }

    override fun onDrawFrame(gl: GL10?) {
      GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
      // The frame runs under a lease on the session, not under the coordinator's
      // lock; submitting to the detector, settling a Promise and closing a
      // broken Session all run after the lease is released.
      val deferred = coordinator.withRunningSession { session, analyzer, lease ->
        renderFrame(session, analyzer, lease)
      }
      deferred?.invoke()
    }

    /**
     * Runs with the session leased — pinned, but with no lock held.
     *
     * Returns the work that must happen after the lease is released: anything
     * that settles a Promise, submits to ML Kit, or tears the session down.
     * A teardown started from in here would wait for this very lease to drain.
     */
    private fun renderFrame(
      current: Session,
      analyzer: FaceQualityAnalyzer?,
      lease: FrameLease,
    ): (() -> Unit)? {
      // The sequence advances *before* update(): a capture request that lands
      // while update() is running must not be answerable by the frame update()
      // is in the middle of producing.
      val sequence = coordinator.beginFrame()

      val frame: Frame
      try {
        frame = current.update()
      } catch (error: Exception) {
        // The frame owner holds the lease the teardown will wait on, so it
        // cannot close anything here: take the capture, and let the caller
        // settle it and close the session once the lease is gone.
        val request = coordinator.cancelCapture()
        return {
          if (request != null) {
            runCatching {
              request.promise.reject("FT-REC-005", "ARCore could not update the camera frame.")
            }
          }
          coordinator.closeDetached(PreviewPhase.READY)?.let { reportLifecycleFailure(it) }
        }
      }

      val timestampNs = frame.timestamp
      coordinator.publishFrameTimestamp(sequence, timestampNs)

      try {
        if (!hasTexCoords || frame.hasDisplayGeometryChanged()) {
          updateTextureCoordinates(frame)
        }
        drawCameraBackground()
      } catch (_: Exception) {
        // A rendering failure must not end tracking or fail a pending capture;
        // only the next frame's draw is skipped.
      }

      // A teardown has cancelled this lease and is waiting for it. The mesh
      // and the camera image are the expensive half of a frame; abandoning them
      // here is what keeps the drain short. The pending capture, if any, is
      // already owned by the transition that cancelled us.
      if (lease.isCancelled) return null

      // Independent of the capture pipeline below: a consented photograph is
      // never evidence and never gates anything, so it neither consumes nor
      // depends on the coordinator's single capture slot.
      val rawFrameWork: (() -> Unit)? = serveRawFrame(frame)

      // Explicitly `(() -> Unit)?`. Left to inference, the `Fail` branch's
      // lambda types as `() -> Result<Unit>` — `runCatching` returns a value —
      // and the `when` widens to `(() -> Any)?`, which `then` cannot take.
      val captureWork: (() -> Unit)? =
        when (val outcome = coordinator.onFrame(sequence, timestampNs, nowNs())) {
          is CaptureOutcome.Analyse -> dispatchAnalysis(current, analyzer, frame, outcome.identity)
          is CaptureOutcome.Fail -> {
            val request = outcome.request
            {
              runCatching { request.promise.reject(outcome.code, outcome.message) }
              Unit
            }
          }
          else -> null
        }
      return then(rawFrameWork, captureWork)
    }

    /** Runs both pieces of deferred work, in order, or whichever exists. */
    private fun then(first: (() -> Unit)?, second: (() -> Unit)?): (() -> Unit)? {
      val firstWork: () -> Unit = first ?: return second
      val secondWork: () -> Unit = second ?: return firstWork
      return {
        firstWork()
        secondWork()
      }
    }

    private fun updateTextureCoordinates(frame: Frame) {
      val output = FloatArray(8)
      frame.transformCoordinates2d(
        Coordinates2d.OPENGL_NORMALIZED_DEVICE_COORDINATES,
        NDC_QUAD_COORDS,
        Coordinates2d.TEXTURE_NORMALIZED,
        output,
      )
      // Update the existing direct buffer's contents in place instead of
      // allocating a new one; display geometry (and therefore this data) only
      // changes on rotation/resize.
      val buffer = quadTexCoordBuffer ?: directFloatBuffer(FloatArray(output.size)).also {
        quadTexCoordBuffer = it
      }
      buffer.position(0)
      buffer.put(output)
      buffer.position(0)
      hasTexCoords = true
    }

    private fun drawCameraBackground() {
      if (program == 0 || cameraTextureId == 0) return
      val vertices = quadVertices ?: return
      val texCoords = quadTexCoordBuffer ?: return
      GLES20.glDisable(GLES20.GL_DEPTH_TEST)
      GLES20.glDepthMask(false)
      GLES20.glUseProgram(program)

      GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
      GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, cameraTextureId)
      GLES20.glUniform1i(GLES20.glGetUniformLocation(program, "u_Texture"), 0)

      val positionAttr = GLES20.glGetAttribLocation(program, "a_Position")
      vertices.position(0)
      GLES20.glVertexAttribPointer(positionAttr, 2, GLES20.GL_FLOAT, false, 0, vertices)
      GLES20.glEnableVertexAttribArray(positionAttr)

      val texCoordAttr = GLES20.glGetAttribLocation(program, "a_TexCoord")
      texCoords.position(0)
      GLES20.glVertexAttribPointer(texCoordAttr, 2, GLES20.GL_FLOAT, false, 0, texCoords)
      GLES20.glEnableVertexAttribArray(texCoordAttr)

      GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)

      GLES20.glDisableVertexAttribArray(positionAttr)
      GLES20.glDisableVertexAttribArray(texCoordAttr)
      GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, 0)
    }
  }

  companion object {
    /** The detector rotation could not be derived; capture fails closed. */
    private const val UNKNOWN_ROTATION = -1

    /**
     * The quality-profile artifact this build implements
     * (`QUALITY_PROFILE_ARTIFACT.version`, `QUALITY_PROFILE_VERSION`).
     *
     * Sent with every capture so the client gate and the server both resolve
     * this module's `REDUCED_GEOMETRY_NO_OCCLUSION` claim against the artifact
     * that defines it. Without it the claim resolves to UNKNOWN, which waives
     * nothing, and a null `occlusion` is `FT-SCAN-014` -- which is exactly what
     * a Galaxy Tab S7 did on every otherwise valid capture. Hard-coded rather
     * than read from JavaScript: it is a property of what this Kotlin measures,
     * and `tests/contract/test_native_quality_profile_declaration.py` fails the
     * build if it drifts from the artifact.
     */
    private const val QUALITY_PROFILE_VERSION = "qp-1.0.0"

    /**
     * Backstop for a request the render loop will never look at again. Set well
     * past the coordinator's own deadlines so they report first whenever frames
     * are still arriving, and this only fires when they are not.
     */
    private const val WATCHDOG_TIMEOUT_MS = 5_000L

    /**
     * Vertex order ARCore's `transformCoordinates2d` expects for
     * `OPENGL_NORMALIZED_DEVICE_COORDINATES`: a full-screen quad drawn as a
     * `GL_TRIANGLE_STRIP`, matching Google's ARCore sample `BackgroundRenderer`.
     */
    private val NDC_QUAD_COORDS = floatArrayOf(
      -1f, -1f,
      1f, -1f,
      -1f, 1f,
      1f, 1f,
    )

    private const val VERTEX_SHADER = """
      attribute vec4 a_Position;
      attribute vec2 a_TexCoord;
      varying vec2 v_TexCoord;
      void main() {
        gl_Position = a_Position;
        v_TexCoord = a_TexCoord;
      }
    """

    private const val FRAGMENT_SHADER = """
      #extension GL_OES_EGL_image_external : require
      precision mediump float;
      varying vec2 v_TexCoord;
      uniform samplerExternalOES u_Texture;
      void main() {
        gl_FragColor = texture2D(u_Texture, v_TexCoord);
      }
    """

    private fun directFloatBuffer(data: FloatArray): FloatBuffer =
      ByteBuffer.allocateDirect(data.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply {
        put(data)
        position(0)
      }

    private fun createOesTexture(): Int {
      val textures = IntArray(1)
      GLES20.glGenTextures(1, textures, 0)
      val textureId = textures[0]
      check(textureId != 0) { "ARCore camera texture creation failed" }
      GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId)
      GLES20.glTexParameteri(
        GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
        GLES20.GL_TEXTURE_MIN_FILTER,
        GLES20.GL_LINEAR,
      )
      GLES20.glTexParameteri(
        GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
        GLES20.GL_TEXTURE_MAG_FILTER,
        GLES20.GL_LINEAR,
      )
      GLES20.glTexParameteri(
        GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
        GLES20.GL_TEXTURE_WRAP_S,
        GLES20.GL_CLAMP_TO_EDGE,
      )
      GLES20.glTexParameteri(
        GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
        GLES20.GL_TEXTURE_WRAP_T,
        GLES20.GL_CLAMP_TO_EDGE,
      )
      GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, 0)
      return textureId
    }

    private fun compileShader(type: Int, source: String): Int {
      val shader = GLES20.glCreateShader(type)
      check(shader != 0) { "glCreateShader failed for type $type" }
      GLES20.glShaderSource(shader, source)
      GLES20.glCompileShader(shader)
      val status = IntArray(1)
      GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, status, 0)
      if (status[0] == 0) {
        val log = GLES20.glGetShaderInfoLog(shader)
        GLES20.glDeleteShader(shader)
        error("Shader compilation failed: $log")
      }
      return shader
    }

    private fun createProgram(): Int {
      val vertexShader = compileShader(GLES20.GL_VERTEX_SHADER, VERTEX_SHADER)
      // A fragment shader that fails to compile used to leave the vertex shader
      // allocated for the life of the GL context.
      val fragmentShader = try {
        compileShader(GLES20.GL_FRAGMENT_SHADER, FRAGMENT_SHADER)
      } catch (error: Exception) {
        GLES20.glDeleteShader(vertexShader)
        throw error
      }
      val program = GLES20.glCreateProgram()
      if (program == 0) {
        GLES20.glDeleteShader(vertexShader)
        GLES20.glDeleteShader(fragmentShader)
        error("glCreateProgram failed")
      }
      GLES20.glAttachShader(program, vertexShader)
      GLES20.glAttachShader(program, fragmentShader)
      GLES20.glLinkProgram(program)
      val status = IntArray(1)
      GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, status, 0)
      // The shaders are attached to the program, which owns them from here;
      // deleting them now is the documented way to have them freed with it, and
      // it also covers the failure path below.
      GLES20.glDeleteShader(vertexShader)
      GLES20.glDeleteShader(fragmentShader)
      if (status[0] == 0) {
        val log = GLES20.glGetProgramInfoLog(program)
        GLES20.glDeleteProgram(program)
        error("Program link failed: $log")
      }
      return program
    }
  }
}
