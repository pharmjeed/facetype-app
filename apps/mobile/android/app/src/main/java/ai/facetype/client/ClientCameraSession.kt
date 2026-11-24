package ai.facetype.client

import ai.facetype.BuildConfig
import ai.facetype.capture.quality.YuvNv21
import ai.facetype.capture.quality.YuvPlane
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.TotalCaptureResult
import android.os.Build
import android.os.SystemClock
import android.util.Size
import androidx.annotation.MainThread
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.Observer
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * One running client camera: CameraX front camera (Preview + ImageAnalysis on
 * the full delivered YUV stream), per-frame QA, burst selection, JPEG encoding
 * and the encrypted spool.
 *
 * THREADS. Binding happens on the main thread. Every frame, the burst, the
 * MediaPipe task and the reusable pixel buffers belong to ONE worker thread
 * ([worker]); nothing else touches them, so the burst needs no locks. Capture
 * results arrive on CameraX's camera thread and are handed over through
 * [TimestampedRing]; gyro samples through [GyroRing].
 *
 * SAME BUFFER. Each analysed image is copied once into an owned NV21 array
 * (respecting strides and the crop rectangle) and the camera buffer is released
 * immediately. Every measurement of that frame and, if the frame is accepted,
 * its JPEG are computed from that one array: the stored photograph is the
 * measured frame, rotated upright, not mirrored, at full delivered resolution.
 *
 * WHAT IS NEVER DONE. No vendor camera extension is opened (plain Camera2
 * through CameraX), no frame is written to disk unencrypted, and nothing here
 * touches BiometricPrompt, face unlock or any biometric template.
 */
@androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
internal class ClientCameraSession(context: Context, private val events: Events) {

  interface Events {
    fun frameMeasure(payload: Map<String, Any?>)
    fun burstProgress(payload: Map<String, Any?>)
    fun error(code: String, message: String)
    /** A burst ended `complete`: one success haptic (contract §5.13). */
    fun burstCompleted()
  }

  interface BurstListener {
    fun resolved(result: Map<String, Any?>)
    fun rejected(code: String, message: String)
  }

  data class BurstOptions(
    val targetFrames: Int,
    val maxDurationMs: Long,
    val minSpacingMs: Long,
    val minCoverageMs: Long,
  )

  enum class StopReason { DEACTIVATED, INTERRUPTED }

  private enum class Finish { CANCELLED, INTERRUPTED, DONE }

  private class StoredFrame(
    val id: String,
    val width: Int,
    val height: Int,
    val sha256: String,
    val bytes: Long,
    val meta: Map<String, Any?>,
    val checks: FrameChecks,
  )

  private class BurstRun(
    val selector: BurstSelector,
    val startedNs: Long,
    val listener: BurstListener,
  ) {
    val stored = LinkedHashMap<String, StoredFrame>()
    var timeout: ScheduledFuture<*>? = null
    var lastAccepted = -1
  }

  /** `ByteArrayOutputStream` whose internal buffer can be zeroed (the JPEG is a face). */
  private class WipeableByteStream(size: Int) : ByteArrayOutputStream(size) {
    fun wipe() {
      buf.fill(0)
      reset()
    }
  }

  private val appContext = context.applicationContext
  private val spool = ClientSpool.get(appContext)
  private val device = DeviceInfo(
    manufacturer = Build.MANUFACTURER ?: "",
    model = Build.MODEL ?: "",
    osVersion = Build.VERSION.RELEASE ?: "",
    osApiLevel = Build.VERSION.SDK_INT,
    appVersion = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
  )

  // ---- main thread -------------------------------------------------------
  private var generation = 0
  private var started = false
  private var provider: ProcessCameraProvider? = null
  private var preview: Preview? = null
  private var analysis: ImageAnalysis? = null
  private var camera: Camera? = null
  private var stateObserver: Observer<CameraState>? = null
  private var lastStateError: Int? = null
  private val sensorManager = appContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
  private val gyroSensor: Sensor? = sensorManager?.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
  private var gyroRegistered = false

  // ---- shared ------------------------------------------------------------
  @Volatile private var config: ClientGateConfig? = null
  @Volatile private var cameraStatic: CameraStaticInfo? = null
  @Volatile private var bound = false
  @Volatile private var lastFrameNs = 0L

  // ---- worker thread -----------------------------------------------------
  private val worker: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { runnable ->
    Thread(runnable, "facetype-client-camera").apply { isDaemon = true }
  }
  private var landmarker: ClientLandmarker? = null
  private var landmarkerError: String? = null
  private var detectErrorReported = false
  private var nv21: ByteArray? = null
  private var rotated: ByteArray? = null
  private var argb: IntArray? = null
  private var bitmap: Bitmap? = null
  private var burst: BurstRun? = null
  private var lastMeasureEmitNs = 0L
  private var lastProgressEmitNs = 0L
  private var captureMisses = 0
  private val results = TimestampedRing<CaptureSnapshot>()
  private val gyro = GyroRing()
  private val rate = DeliveredRate()
  private val modelSha: String? by lazy { ClientLandmarker.modelSha256(appContext) }

  private val captureCallback = object : CameraCaptureSession.CaptureCallback() {
    override fun onCaptureCompleted(
      session: CameraCaptureSession,
      request: CaptureRequest,
      result: TotalCaptureResult,
    ) {
      val snapshot = try {
        CameraInfoReader.snapshot(result)
      } catch (_: Exception) {
        null
      } ?: return
      results.put(snapshot.sensorTsNs, snapshot)
    }
  }

  private val gyroListener = object : SensorEventListener {
    override fun onSensorChanged(event: SensorEvent) {
      val x = event.values[0].toDouble()
      val y = event.values[1].toDouble()
      val z = event.values[2].toDouble()
      gyro.add(event.timestamp, Math.toDegrees(sqrt(x * x + y * y + z * z)))
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
  }

  val isStarted: Boolean get() = started

  val boundCameraId: String? get() = cameraStatic?.cameraId

  // ======================================================================
  // Binding (main thread)
  // ======================================================================

  @MainThread
  fun start(owner: LifecycleOwner, surfaceProvider: Preview.SurfaceProvider, displayRotation: Int, cfg: ClientGateConfig) {
    if (started) stop(StopReason.DEACTIVATED)
    config = cfg
    val gen = ++generation
    if (ContextCompat.checkSelfPermission(appContext, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      events.error("permission_denied", "Camera permission is not granted.")
      return
    }
    started = true
    submit { ensureLandmarker(cfg) }
    val future = ProcessCameraProvider.getInstance(appContext)
    future.addListener({
      if (gen != generation) return@addListener
      try {
        val cameraProvider = future.get()
        provider = cameraProvider
        bind(cameraProvider, owner, surfaceProvider, displayRotation, cfg)
      } catch (error: Exception) {
        started = false
        events.error("camera_unavailable", "The front camera could not be opened: ${error.message}")
      }
    }, ContextCompat.getMainExecutor(appContext))
  }

  @MainThread
  private fun bind(
    cameraProvider: ProcessCameraProvider,
    owner: LifecycleOwner,
    surfaceProvider: Preview.SurfaceProvider,
    displayRotation: Int,
    cfg: ClientGateConfig,
  ) {
    val selector = CameraSelector.DEFAULT_FRONT_CAMERA
    val info = selector.filter(cameraProvider.availableCameraInfos).firstOrNull()
    if (info == null) {
      started = false
      events.error("camera_unavailable", "This device has no front camera.")
      return
    }
    val cameraId = Camera2CameraInfo.from(info).cameraId
    val manager = appContext.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    val chars = manager.getCameraCharacteristics(cameraId)
    val static = CameraInfoReader.readStatic(cameraId, chars)
    val chosen = StreamSizeChooser.choose(CameraInfoReader.yuvSizes(chars), cfg.stream.preferredSizes, cfg.stream.minSize)
    if (chosen == null) {
      started = false
      events.error(
        "camera_unavailable",
        "The front camera offers no stream of at least ${cfg.stream.minSize.width}x${cfg.stream.minSize.height}.",
      )
      return
    }
    cameraStatic = static

    val aspect = if (abs(chosen.width.toDouble() / chosen.height - 16.0 / 9.0) < 0.02) {
      androidx.camera.core.AspectRatio.RATIO_16_9
    } else {
      androidx.camera.core.AspectRatio.RATIO_4_3
    }
    val analysisSelector = ResolutionSelector.Builder()
      .setAspectRatioStrategy(AspectRatioStrategy(aspect, AspectRatioStrategy.FALLBACK_RULE_AUTO))
      .setResolutionStrategy(
        ResolutionStrategy(Size(chosen.width, chosen.height), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER),
      )
      .setResolutionFilter { sizes, _ ->
        val exact = sizes.filter { it.width == chosen.width && it.height == chosen.height }
        exact + sizes.filterNot { it.width == chosen.width && it.height == chosen.height }
      }
      .build()
    val previewSelector = ResolutionSelector.Builder()
      .setAspectRatioStrategy(AspectRatioStrategy(aspect, AspectRatioStrategy.FALLBACK_RULE_AUTO))
      .setResolutionStrategy(
        ResolutionStrategy(Size(1920, 1080), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER),
      )
      .build()

    val analysisBuilder = ImageAnalysis.Builder()
      .setResolutionSelector(analysisSelector)
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
      .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
      .setTargetRotation(displayRotation)
    applyRequestOptions(Camera2Interop.Extender(analysisBuilder), chars, cfg)
    val newAnalysis = analysisBuilder.build()
    val newPreview = Preview.Builder()
      .setResolutionSelector(previewSelector)
      .setTargetRotation(displayRotation)
      .build()
    newPreview.setSurfaceProvider(surfaceProvider)
    newAnalysis.setAnalyzer(worker) { image -> analyze(image) }

    unbindUseCases()
    val boundCamera = try {
      cameraProvider.bindToLifecycle(owner, selector, newPreview, newAnalysis)
    } catch (error: Exception) {
      newAnalysis.clearAnalyzer()
      started = false
      events.error("camera_unavailable", "The front camera could not be configured: ${error.message}")
      return
    }
    preview = newPreview
    analysis = newAnalysis
    camera = boundCamera
    bound = true
    lastStateError = null
    val observer = Observer<CameraState> { state -> onCameraState(state) }
    stateObserver = observer
    boundCamera.cameraInfo.cameraState.observe(owner, observer)
    registerGyro()
  }

  /**
   * Request options, on the analysis use case only (CameraX merges them into
   * the one repeating request): stabilisation OFF (video and, where the lens
   * allows, optical), distortion correction ON where supported (Android cannot
   * force it elsewhere), auto-framing OFF where the app controls it, an AE
   * target range that lets exposure stretch to the preferred minimum fps, and
   * the session capture callback that supplies per-frame metadata.
   */
  private fun applyRequestOptions(
    extender: Camera2Interop.Extender<ImageAnalysis>,
    chars: CameraCharacteristics,
    cfg: ClientGateConfig,
  ) {
    if (CameraInfoReader.supportsVideoStabilizationOff(chars)) {
      extender.setCaptureRequestOption(
        CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE,
        CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_OFF,
      )
    }
    if (CameraInfoReader.supportsOisOff(chars)) {
      extender.setCaptureRequestOption(
        CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE,
        CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_OFF,
      )
    }
    if (Build.VERSION.SDK_INT >= 28) {
      CameraInfoReader.preferredDistortionMode(chars)?.let {
        extender.setCaptureRequestOption(CaptureRequest.DISTORTION_CORRECTION_MODE, it)
      }
    }
    if (Build.VERSION.SDK_INT >= 34 && CameraInfoReader.supportsAutoframingOff(chars)) {
      extender.setCaptureRequestOption(CaptureRequest.CONTROL_AUTOFRAMING, CameraMetadata.CONTROL_AUTOFRAMING_OFF)
    }
    CameraInfoReader.aeTargetRange(chars, cfg.stream.preferredMinFps)?.let {
      extender.setCaptureRequestOption(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, it)
    }
    extender.setSessionCaptureCallback(captureCallback)
  }

  @MainThread
  private fun onCameraState(state: CameraState) {
    val error = state.error
    if (error == null) {
      if (state.type == CameraState.Type.OPEN) lastStateError = null
      return
    }
    if (lastStateError == error.code) return
    lastStateError = error.code
    val code = when (error.code) {
      CameraState.ERROR_CAMERA_IN_USE,
      CameraState.ERROR_MAX_CAMERAS_IN_USE,
      CameraState.ERROR_OTHER_RECOVERABLE_ERROR,
      -> "camera_interrupted"
      else -> "camera_unavailable"
    }
    events.error(code, "Camera error ${error.code} (${error.type}).")
    submit { burst?.let { finish(it, Finish.INTERRUPTED) } }
  }

  @MainThread
  fun stop(reason: StopReason) {
    generation++
    started = false
    bound = false
    unbindUseCases()
    unregisterGyro()
    submit {
      burst?.let { finish(it, if (reason == StopReason.DEACTIVATED) Finish.CANCELLED else Finish.INTERRUPTED) }
      results.clear()
      rate.clear()
      wipeBuffers()
    }
  }

  /** Stops the camera and frees the worker; the session cannot be restarted afterwards. */
  @MainThread
  fun release() {
    stop(StopReason.DEACTIVATED)
    submit {
      landmarker?.close()
      landmarker = null
      bitmap?.recycle()
      bitmap = null
    }
    worker.shutdown()
  }

  @MainThread
  private fun unbindUseCases() {
    analysis?.clearAnalyzer()
    stateObserver?.let { observer -> camera?.cameraInfo?.cameraState?.removeObserver(observer) }
    stateObserver = null
    val useCases = listOfNotNull(preview, analysis)
    if (useCases.isNotEmpty()) {
      try {
        provider?.unbind(*useCases.toTypedArray())
      } catch (_: Exception) {
        // Already unbound by the lifecycle.
      }
    }
    preview = null
    analysis = null
    camera = null
  }

  private fun registerGyro() {
    if (gyroRegistered || gyroSensor == null || sensorManager == null) return
    gyroRegistered = sensorManager.registerListener(gyroListener, gyroSensor, SensorManager.SENSOR_DELAY_GAME)
  }

  private fun unregisterGyro() {
    if (!gyroRegistered) return
    sensorManager?.unregisterListener(gyroListener)
    gyroRegistered = false
    gyro.clear()
  }

  // ======================================================================
  // Burst API (any thread -> worker)
  // ======================================================================

  fun startBurst(options: BurstOptions, listener: BurstListener) {
    val accepted = submit {
      val cfg = config
      when {
        cfg == null -> listener.rejected("internal", "No gate config is set.")
        burst != null -> listener.rejected("burst_in_progress", "A burst is already running.")
        landmarker == null -> listener.rejected("model_unavailable", landmarkerError ?: "The face model is not loaded.")
        !bound || SystemClock.elapsedRealtimeNanos() - lastFrameNs > STREAM_STALE_NS ->
          listener.rejected("camera_unavailable", "The camera is not streaming.")
        else -> {
          val run = BurstRun(
            selector = BurstSelector(
              target = options.targetFrames,
              maxDurationMs = options.maxDurationMs,
              minSpacingMs = options.minSpacingMs,
              minCoverageMs = options.minCoverageMs,
              minRelativeOpening = cfg.eyes.minRelativeOpening,
              minRelativeSharpness = cfg.sharpness.minRelativeToBurstMax,
            ),
            startedNs = SystemClock.elapsedRealtimeNanos(),
            listener = listener,
          )
          burst = run
          run.timeout = worker.schedule(
            { if (burst === run) finish(run, Finish.DONE) },
            options.maxDurationMs,
            TimeUnit.MILLISECONDS,
          )
          emitProgress(run, force = true)
        }
      }
    }
    if (!accepted) listener.rejected("camera_unavailable", "The camera session has ended.")
  }

  fun cancelBurst(done: () -> Unit) {
    if (!submit {
        burst?.let { finish(it, Finish.CANCELLED) }
        done()
      }
    ) {
      done()
    }
  }

  // ======================================================================
  // Worker thread
  // ======================================================================

  private fun submit(task: () -> Unit): Boolean = try {
    worker.execute(task)
    true
  } catch (_: RejectedExecutionException) {
    false
  }

  private fun ensureLandmarker(cfg: ClientGateConfig) {
    if (landmarker != null) return
    ClientLandmarker.create(appContext, cfg.faces.maxFaces)
      .onSuccess {
        landmarker = it
        landmarkerError = null
      }
      .onFailure {
        landmarkerError = "The face model could not be loaded: ${it.message}"
        events.error("model_unavailable", landmarkerError!!)
      }
  }

  private class CopiedFrame(val buffer: ByteArray, val width: Int, val height: Int)

  private fun analyze(image: ImageProxy) {
    val receivedNs = SystemClock.elapsedRealtimeNanos()
    val wallMs = System.currentTimeMillis()
    val sensorTs = image.imageInfo.timestamp
    val rotation = image.imageInfo.rotationDegrees
    val copied = try {
      copyFrame(image)
    } catch (_: Exception) {
      null
    } finally {
      // The camera buffer goes back as soon as the owned copy exists.
      image.close()
    }
    val cfg = config ?: return
    val static = cameraStatic ?: return
    if (copied == null) return
    lastFrameNs = receivedNs
    rate.add(sensorTs)
    val lm = landmarker
    if (lm == null) {
      burst?.let { run -> checkTimeout(run, receivedNs) }
      return
    }
    try {
      processFrame(cfg, static, lm, copied.buffer, copied.width, copied.height, rotation, sensorTs, receivedNs, wallMs)
    } catch (error: Exception) {
      if (!detectErrorReported) {
        detectErrorReported = true
        events.error("internal", "Frame analysis failed: ${error.message}")
      }
      burst?.let { run -> checkTimeout(run, receivedNs) }
    }
  }

  /** Copies the image's visible YUV (even-aligned crop rectangle) into the reusable NV21 array. */
  private fun copyFrame(image: ImageProxy): CopiedFrame? {
    if (image.format != ImageFormat.YUV_420_888) return null
    val crop = image.cropRect
    val left = crop.left and 1.inv()
    val top = crop.top and 1.inv()
    val width = (crop.right - left) and 1.inv()
    val height = (crop.bottom - top) and 1.inv()
    if (width <= 0 || height <= 0) return null
    val needed = YuvNv21.byteCount(width, height)
    val buffer = nv21?.takeIf { it.size == needed } ?: ByteArray(needed).also {
      nv21?.fill(0)
      nv21 = it
    }
    val planes = image.planes
    YuvNv21.convert(
      YuvPlane(planes[0].buffer, planes[0].rowStride, planes[0].pixelStride),
      YuvPlane(planes[1].buffer, planes[1].rowStride, planes[1].pixelStride),
      YuvPlane(planes[2].buffer, planes[2].rowStride, planes[2].pixelStride),
      left, top, width, height, buffer,
    )
    return CopiedFrame(buffer, width, height)
  }

  private fun processFrame(
    cfg: ClientGateConfig,
    static: CameraStaticInfo,
    lm: ClientLandmarker,
    buffer: ByteArray,
    width: Int,
    height: Int,
    rotation: Int,
    sensorTs: Long,
    receivedNs: Long,
    wallMs: Long,
  ) {
    val frameId = FrameIds.newId()
    val uprightW = if (rotation % 180 == 0) width else height
    val uprightH = if (rotation % 180 == 0) height else width

    // MediaPipe (IMAGE mode) on an upright copy of this same buffer whose
    // long side is MEDIAPIPE_LONG_SIDE, never upscaled (contract §5.15).
    val small = Nv21Ops.analysisSize(uprightW, uprightH, MEDIAPIPE_LONG_SIDE)
    val pixelCount = small.width * small.height
    val pixels = argb?.takeIf { it.size == pixelCount } ?: IntArray(pixelCount).also { argb = it }
    Nv21Ops.toUprightArgbScaled(buffer, width, height, rotation, small, pixels)
    val bmp = bitmap?.takeIf { it.width == small.width && it.height == small.height }
      ?: Bitmap.createBitmap(small.width, small.height, Bitmap.Config.ARGB_8888).also {
        bitmap?.recycle()
        bitmap = it
      }
    bmp.setPixels(pixels, 0, small.width, 0, 0, small.width, small.height)
    pixels.fill(0)
    val faces = lm.detect(bmp)

    // The copy tiles the whole upright frame, so MediaPipe's normalised
    // landmarks are already normalised to the full frame. Primary face = widest.
    val converted = faces.map { face -> face.landmarks }
    val primary = converted.indices.maxByOrNull { index ->
      val lms = converted[index]
      if (lms.size < FaceLandmarkIndex.COUNT * 3) {
        -1.0
      } else {
        val ax = lms[FaceLandmarkIndex.FACE_WIDTH_A * 3] * uprightW.toDouble()
        val ay = lms[FaceLandmarkIndex.FACE_WIDTH_A * 3 + 1] * uprightH.toDouble()
        val bx = lms[FaceLandmarkIndex.FACE_WIDTH_B * 3] * uprightW.toDouble()
        val by = lms[FaceLandmarkIndex.FACE_WIDTH_B * 3 + 1] * uprightH.toDouble()
        Math.hypot(ax - bx, ay - by)
      }
    }
    val landmarks = primary?.let { converted[it] }
    val primaryFace = primary?.let { faces[it] }
    val geometry = landmarks?.let { FaceGeometryCalc.compute(it, uprightW, uprightH, primaryFace?.transform) }

    val luma = UprightLuma(buffer, width, height, rotation)
    var light = LightMetrics.Result(null, null, null)
    var sharpness: Double? = null
    if (geometry != null && landmarks != null && landmarks.size >= FaceLandmarkIndex.COUNT * 3) {
      fun point(index: Int) = Pair(
        landmarks[index * 3] * uprightW.toDouble(),
        landmarks[index * 3 + 1] * uprightH.toDouble(),
      )
      geometry.faceWidthPx?.let { faceWidth ->
        light = LightMetrics.measure(
          luma,
          point(FaceLandmarkIndex.CHEEK_LEFT),
          point(FaceLandmarkIndex.CHEEK_RIGHT),
          point(FaceLandmarkIndex.NOSE_TIP),
          faceWidth,
        )
      }
      sharpness = geometry.faceBox?.let { Sharpness.measure(luma, it) }
    }

    val blendshapes = primaryFace?.blendshapes
    fun score(name: String): Double? = blendshapes?.get(name)?.toDouble()?.takeIf { it.isFinite() }
    val smile = FrameCheckEvaluator.maxOf(score("mouthSmileLeft"), score("mouthSmileRight"))

    // A result normally arrives within a frame of its image. If this device's
    // results never match (a different timestamp base), stop waiting for them
    // rather than stalling every frame; the metadata then carries
    // capture_result_not_matched.
    val capture = results.await(sensorTs, if (captureMisses >= CAPTURE_MISS_LIMIT) 0L else CAPTURE_RESULT_WAIT_MS)
    captureMisses = if (capture == null) captureMisses + 1 else 0
    val intrinsics = IntrinsicsResolver.resolve(static, capture, width, height, rotation)
    val distance = CameraGeometry.distanceCm(intrinsics.upright?.fx, geometry?.irisDiameterPx, cfg.distance.irisMm)

    val (gyroValue, gyroReason) = gyroAt(static, sensorTs, capture?.exposureTimeNs, receivedNs)

    val measurement = FrameMeasurement(
      faces = faces.size,
      uprightWidth = uprightW,
      uprightHeight = uprightH,
      geometry = geometry,
      focalKnown = intrinsics.upright != null,
      distanceCm = distance,
      clipFrac = light.clipFrac,
      crushFrac = light.crushFrac,
      cheekRatio = light.cheekRatio,
      smile = smile,
      jawOpen = score("jawOpen"),
      blinkL = score("eyeBlinkLeft"),
      blinkR = score("eyeBlinkRight"),
      sharpness = sharpness,
      gyroDegPerS = gyroValue,
    )
    val checks = FrameCheckEvaluator.evaluate(measurement, cfg)

    if (receivedNs - lastMeasureEmitNs >= MEASURE_INTERVAL_NS) {
      lastMeasureEmitNs = receivedNs
      events.frameMeasure(measurePayload(frameId, sensorTs, measurement, checks, capture?.exposureTimeNs))
    }

    val run = burst ?: return
    // Android's counterparts of the iOS effects: a bokeh extended scene mode
    // or auto-framing reported active. Neither is ever requested; if a device
    // applies one anyway, the frame is not stored.
    val effectsActive = capture?.extendedSceneMode?.let { it != "disabled" } == true ||
      capture?.autoframing?.let { it != "off" } == true
    if (effectsActive) {
      run.selector.recordRejection(BurstSelector.REASON_EFFECTS_ACTIVE)
    } else if (checks.allPass) {
      val geo = geometry!!
      if (run.selector.spacingAllows(sensorTs) && !run.selector.isFull) {
        val record = FrameRecord(
          frameId = frameId,
          tsMonotonicNs = receivedNs,
          tsWallMs = wallMs,
          sensorTsNs = sensorTs,
          streamWidth = width,
          streamHeight = height,
          deliveredFps = rate.fps(),
          rotationDegrees = rotation,
          jpegQuality = cfg.stream.jpegQuality,
          device = device,
          camera = static,
          capture = capture,
          config = cfg,
          mediapipeModelSha256 = modelSha,
          mediapipeOptions = lm.options + mapOf(
            "analysis_long_side" to MEDIAPIPE_LONG_SIDE,
            "input_w" to small.width,
            "input_h" to small.height,
          ),
          measurement = measurement,
          landmarks = landmarks,
          blendshapes = blendshapes,
          intrinsics = intrinsics,
          checks = checks,
          gyroMissingReason = gyroReason,
        )
        val stored = storeCandidate(record, buffer, width, height, rotation, uprightW, uprightH, cfg.stream.jpegQuality)
        if (stored != null) {
          run.selector.addCandidate(
            BurstSelector.Candidate(frameId, sensorTs, sharpness!!, geo.eyeOpeningL!!, geo.eyeOpeningR!!),
          )
          run.stored[frameId] = stored
        } else {
          run.selector.recordRejection(BurstSelector.REASON_INTERNAL)
        }
      }
    } else {
      run.selector.recordRejection(checks.firstFailure() ?: FrameChecks.REASON_ONE_FACE)
    }
    emitProgress(run, force = false)
    when {
      run.selector.isComplete() -> finish(run, Finish.DONE)
      run.selector.isFull -> finish(run, Finish.DONE)
      else -> checkTimeout(run, receivedNs)
    }
  }

  private fun checkTimeout(run: BurstRun, nowNs: Long) {
    if (burst === run && nowNs - run.startedNs >= run.selector.maxDurationMs * 1_000_000L) finish(run, Finish.DONE)
  }

  /** Encodes, hashes and spools one accepted frame; null if any step failed (nothing is left behind). */
  private fun storeCandidate(
    record: FrameRecord,
    buffer: ByteArray,
    width: Int,
    height: Int,
    rotation: Int,
    uprightW: Int,
    uprightH: Int,
    quality: Int,
  ): StoredFrame? {
    val upright = rotated?.takeIf { it.size == buffer.size } ?: ByteArray(buffer.size).also {
      rotated?.fill(0)
      rotated = it
    }
    val stream = WipeableByteStream(uprightW * uprightH / 4)
    var jpeg: ByteArray? = null
    return try {
      Nv21Ops.rotate(buffer, width, height, rotation, upright)
      val encoded = YuvImage(upright, ImageFormat.NV21, uprightW, uprightH, null)
        .compressToJpeg(Rect(0, 0, uprightW, uprightH), quality, stream)
      if (!encoded) return null
      jpeg = stream.toByteArray()
      val sha = ClientGateConfig.sha256Hex(jpeg)
      spool.write(record.frameId, record.tsWallMs, jpeg)
      StoredFrame(
        id = record.frameId,
        width = uprightW,
        height = uprightH,
        sha256 = sha,
        bytes = jpeg.size.toLong(),
        meta = FrameMetaBuilder.build(record),
        checks = record.checks,
      )
    } catch (_: Exception) {
      try {
        spool.delete(record.frameId)
      } catch (_: Exception) {
      }
      null
    } finally {
      jpeg?.fill(0)
      stream.wipe()
      upright.fill(0)
    }
  }

  private fun finish(run: BurstRun, kind: Finish) {
    if (burst !== run) return
    burst = null
    run.timeout?.cancel(false)
    val elapsedMs = (SystemClock.elapsedRealtimeNanos() - run.startedNs) / 1_000_000L
    val target = run.selector.target
    val top = run.selector.topRejectReason(includeRelative = kind != Finish.CANCELLED)
    if (kind == Finish.CANCELLED) {
      for (id in run.stored.keys) deleteQuietly(id)
      run.stored.clear()
      events.burstProgress(progressPayload(0, target, elapsedMs, top))
      run.listener.resolved(
        linkedMapOf("status" to "cancelled", "topRejectReason" to top, "frames" to emptyList<Any?>()),
      )
      return
    }
    val selection = run.selector.selection()
    for (candidate in selection.discarded) {
      deleteQuietly(candidate.id)
      run.stored.remove(candidate.id)
    }
    val frames = selection.selected.mapNotNull { candidate ->
      val stored = run.stored[candidate.id] ?: return@mapNotNull null
      val meta = FrameMetaBuilder.withBurstVerdict(stored.meta, stored.checks, selection.verdicts[candidate.id])
      // The meta goes into the spool too (contract §5.12). A frame whose meta
      // cannot be stored is not returned: every returned frame can be resumed.
      try {
        spool.writeMeta(stored.id, Json.stringify(meta))
      } catch (_: Exception) {
        deleteQuietly(stored.id)
        return@mapNotNull null
      }
      linkedMapOf<String, Any?>(
        "id" to stored.id,
        "width" to stored.width,
        "height" to stored.height,
        "sha256" to stored.sha256,
        "bytes" to stored.bytes,
        "meta" to meta,
      )
    }
    val status = if (selection.complete && frames.size == selection.selected.size) "complete" else "partial"
    events.burstProgress(progressPayload(frames.size, target, elapsedMs, top))
    if (status == "complete") events.burstCompleted()
    run.listener.resolved(linkedMapOf("status" to status, "topRejectReason" to top, "frames" to frames))
  }

  private fun deleteQuietly(id: String) {
    try {
      spool.delete(id)
    } catch (_: Exception) {
    }
  }

  private fun emitProgress(run: BurstRun, force: Boolean) {
    val now = SystemClock.elapsedRealtimeNanos()
    val accepted = run.selector.acceptedCount()
    if (!force && accepted == run.lastAccepted && now - lastProgressEmitNs < MEASURE_INTERVAL_NS) return
    run.lastAccepted = accepted
    lastProgressEmitNs = now
    events.burstProgress(
      progressPayload(accepted, run.selector.target, (now - run.startedNs) / 1_000_000L, run.selector.topRejectReason()),
    )
  }

  private fun gyroAt(static: CameraStaticInfo, sensorTs: Long, exposureNs: Long?, receivedNs: Long): Pair<Double?, String?> {
    if (gyroSensor == null) return null to "no_gyroscope"
    return if (static.timestampSource == "realtime") {
      val mid = sensorTs + (exposureNs ?: 0L) / 2
      val value = gyro.nearest(mid, GYRO_MAX_GAP_NS)
      value to (if (value == null) "no_gyroscope_sample_near_exposure" else null)
    } else {
      val latest = gyro.latest()
      if (latest != null && abs(receivedNs - latest.first) <= GYRO_LATEST_MAX_AGE_NS) {
        latest.second to null
      } else {
        null to "timestamp_source_unknown_and_no_recent_sample"
      }
    }
  }

  private fun wipeBuffers() {
    nv21?.fill(0)
    rotated?.fill(0)
    argb?.fill(0)
    bitmap?.eraseColor(0)
    nv21 = null
    rotated = null
    argb = null
  }

  private fun measurePayload(
    frameId: String,
    sensorTs: Long,
    m: FrameMeasurement,
    checks: FrameChecks,
    exposureTimeNs: Long?,
  ): Map<String, Any?> {
    val g = m.geometry
    return linkedMapOf(
      "frameId" to frameId,
      "tsMs" to sensorTs / 1e6,
      "faces" to m.faces,
      "yaw" to g?.yawDeg,
      "pitch" to g?.pitchDeg,
      "roll" to g?.rollDeg,
      "interPupilPx" to g?.interPupilPx,
      "faceBox" to g?.faceBox?.toList(),
      "eyeMidX" to g?.eyeMidX,
      "faceCentreY" to g?.faceCentreY,
      "faceWidthPx" to g?.faceWidthPx,
      "distanceCm" to m.distanceCm,
      "clipFrac" to m.clipFrac,
      "crushFrac" to m.crushFrac,
      "cheekRatio" to m.cheekRatio,
      "smile" to m.smile,
      "jawOpen" to m.jawOpen,
      "blinkL" to m.blinkL,
      "blinkR" to m.blinkR,
      "sharpness" to m.sharpness,
      "gyroDegPerS" to m.gyroDegPerS,
      // Contract §5.11: guidance asks for light in front above 1/30 s.
      "exposureTimeNs" to exposureTimeNs,
      "checks" to checks.toMap(snakeCase = false),
    )
  }

  private fun progressPayload(accepted: Int, target: Int, elapsedMs: Long, top: String?): Map<String, Any?> =
    linkedMapOf("accepted" to accepted, "target" to target, "elapsedMs" to elapsedMs, "topRejectReason" to top)

  companion object {
    /** Longer upright side of the copy MediaPipe reads; the same 1280 as iOS (contract §5.15). */
    const val MEDIAPIPE_LONG_SIDE = 1280
    /** `onFrameMeasure` and `onBurstProgress` at most 15 Hz. */
    const val MEASURE_INTERVAL_NS = 1_000_000_000L / 15
    const val CAPTURE_RESULT_WAIT_MS = 40L
    const val CAPTURE_MISS_LIMIT = 10
    const val STREAM_STALE_NS = 1_500_000_000L
    const val GYRO_MAX_GAP_NS = 50_000_000L
    const val GYRO_LATEST_MAX_AGE_NS = 100_000_000L
  }
}
