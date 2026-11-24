package ai.facetype.client

import kotlin.math.roundToLong

/** Device and build identity stamped on every frame. */
internal data class DeviceInfo(
  val manufacturer: String,
  val model: String,
  val osVersion: String,
  val osApiLevel: Int,
  val appVersion: String,
)

/**
 * Static facts about the bound front camera, read once from
 * `CameraCharacteristics`. A field is null when the device does not publish it.
 */
internal data class CameraStaticInfo(
  val cameraId: String,
  val sensorOrientation: Int?,
  val focalLengthsMm: List<Double>,
  val physicalSizeMm: DoubleArray?,
  val pixelArray: PixelSize?,
  val activeArray: SensorRect?,
  val preCorrectionArray: SensorRect?,
  val intrinsicCalibration: FloatArray?,
  val lensDistortion: FloatArray?,
  /** Available distortion-correction modes by name; null when the key is absent (API < 28 or unsupported). */
  val distortionModes: List<String>?,
  /** `realtime` or `unknown` (`SENSOR_INFO_TIMESTAMP_SOURCE`). */
  val timestampSource: String?,
  val logicalMultiCamera: Boolean,
  val physicalCameraIds: List<String>,
)

/**
 * Per-frame camera state from the `TotalCaptureResult` whose
 * `SENSOR_TIMESTAMP` equals the analysed image's timestamp. Enumerations are
 * already mapped to lower-case names by the Android layer. A field is null
 * when the result does not carry the key.
 */
internal data class CaptureSnapshot(
  val sensorTsNs: Long,
  val exposureTimeNs: Long?,
  val iso: Int?,
  val frameDurationNs: Long?,
  val focusMode: String?,
  val focusState: String?,
  val focusDistanceDiopter: Double?,
  val awbMode: String?,
  val awbState: String?,
  /** `COLOR_CORRECTION_GAINS` as `{red, green, blue}` (green = mean of the two green channels). */
  val awbGains: Map<String, Double>?,
  val cropRegion: SensorRect?,
  val zoomRatio: Double?,
  val focalLengthMm: Double?,
  val distortionCorrection: String?,
  val videoStabilization: String?,
  val opticalStabilization: String?,
  val sceneMode: String?,
  val extendedSceneMode: String?,
  val autoframing: String?,
  val intrinsicCalibration: FloatArray?,
  val lensDistortion: FloatArray?,
  val activePhysicalCameraId: String?,
)

/** Intrinsics in the stored (upright) JPEG's pixels, or why there are none. */
internal data class ResolvedIntrinsics(
  val upright: Intrinsics?,
  val missingReason: String?,
  /** The sensor region the stream shows, pixel-array coordinates. */
  val streamRegion: SensorRect?,
)

internal object IntrinsicsResolver {

  /**
   * Calibration from the frame's own capture result first, then from the
   * static characteristics, then the nominal pinhole from the focal length and
   * the sensor's physical size. Null (with a reason) when none is available,
   * in which case no distance is estimated.
   */
  fun resolve(
    camera: CameraStaticInfo,
    capture: CaptureSnapshot?,
    streamWidth: Int,
    streamHeight: Int,
    rotation: Int,
  ): ResolvedIntrinsics {
    val pixelArray = camera.pixelArray
    val activeArray = camera.activeArray
      ?: return ResolvedIntrinsics(null, "active_array_unknown", null)
    val preCorrection = camera.preCorrectionArray ?: activeArray
    val correctionOn = capture?.distortionCorrection == "fast" || capture?.distortionCorrection == "high_quality"
    val cropFrame = if (correctionOn) activeArray else preCorrection
    val crop = capture?.cropRegion ?: SensorRect(0.0, 0.0, cropFrame.width, cropFrame.height)
    val region = CameraGeometry.streamRegion(crop, cropFrame, capture?.zoomRatio, streamWidth, streamHeight)

    val sensor = CameraGeometry.calibratedSensorIntrinsics(
      capture?.intrinsicCalibration ?: camera.intrinsicCalibration, preCorrection, pixelArray,
    ) ?: CameraGeometry.nominalSensorIntrinsics(
      capture?.focalLengthMm ?: camera.focalLengthsMm.firstOrNull(),
      camera.physicalSizeMm,
      pixelArray,
      activeArray,
    ) ?: return ResolvedIntrinsics(null, "focal_length_or_sensor_size_unknown", region)

    val stream = CameraGeometry.toStream(sensor, region, streamWidth, streamHeight)
    return ResolvedIntrinsics(CameraGeometry.toUpright(stream, rotation), null, region)
  }
}

/** Everything one stored frame's [FrameMetaBuilder] output is made from. */
internal data class FrameRecord(
  val frameId: String,
  val tsMonotonicNs: Long,
  val tsWallMs: Long,
  val sensorTsNs: Long,
  val streamWidth: Int,
  val streamHeight: Int,
  val deliveredFps: Double?,
  val rotationDegrees: Int,
  val jpegQuality: Int,
  val device: DeviceInfo,
  val camera: CameraStaticInfo,
  val capture: CaptureSnapshot?,
  val config: ClientGateConfig,
  val mediapipeModelSha256: String?,
  val mediapipeOptions: Map<String, Any?>,
  val measurement: FrameMeasurement,
  val landmarks: FloatArray?,
  val blendshapes: Map<String, Float>?,
  val intrinsics: ResolvedIntrinsics,
  val checks: FrameChecks,
  val gyroMissingReason: String?,
)

/**
 * Builds the FrameMeta JSON object (`docs/client-native-interface.md` §4).
 *
 * Every listed key is always present. A value that cannot be read is `null`
 * with a sibling `<key>_missing_reason`; a non-finite number is never written
 * (it becomes null with reason `non_finite`). The only key beyond the §4 list
 * is `awb_gains`, which §5.10 allows; value shapes follow the iOS
 * implementation so both platforms store the same thing (`stabilization_state`
 * and `hdr_state` strings, `distance_method` "iris_<mm>mm", `intrinsics` an
 * object or null, `checks` the eight snake_case booleans).
 */
internal object FrameMetaBuilder {
  const val PROTOCOL_VERSION = "capture-spec-v2"
  const val PIXEL_FORMAT = "YUV_420_888"
  const val ENCODER = "android.graphics.YuvImage.compressToJpeg(NV21)"
  const val NOT_APPLICABLE_ANDROID = "not_applicable_android"
  const val NOT_REPORTED = "not_reported_by_device"
  const val NO_CAPTURE_RESULT = "capture_result_not_matched"
  const val NO_FACE = "no_face_measured"
  const val LANDMARK_DECIMALS = 6

  fun build(record: FrameRecord): LinkedHashMap<String, Any?> {
    val meta = LinkedHashMap<String, Any?>()
    val capture = record.capture
    val camera = record.camera
    val m = record.measurement
    val g = m.geometry
    fun captureReason(): String = if (capture == null) NO_CAPTURE_RESULT else NOT_REPORTED

    meta["frame_id"] = record.frameId
    meta["ts_monotonic_ns"] = record.tsMonotonicNs
    meta["ts_wall_ms"] = record.tsWallMs
    meta["sensor_ts_ns"] = record.sensorTsNs
    meta["stream_w"] = record.streamWidth
    meta["stream_h"] = record.streamHeight
    meta.putValue("delivered_fps", record.deliveredFps, "insufficient_frames")
    meta.putValue("orientation_deg", camera.sensorOrientation, NOT_REPORTED)
    meta["mirrored"] = false
    meta["rotation_applied_deg"] = record.rotationDegrees
    meta["lens_facing"] = "front"
    val physicalId = when {
      !camera.logicalMultiCamera -> camera.cameraId
      capture?.activePhysicalCameraId != null -> capture.activePhysicalCameraId
      else -> null
    }
    meta.putValue(
      "physical_camera_id",
      physicalId,
      if (record.device.osApiLevel < 29) "logical_camera_active_id_requires_api_29" else captureReason(),
    )
    meta["device_manufacturer"] = record.device.manufacturer
    meta["device_model"] = record.device.model
    meta["os_version"] = "Android ${record.device.osVersion} (API ${record.device.osApiLevel})"
    meta["app_version"] = record.device.appVersion
    meta["protocol_version"] = PROTOCOL_VERSION
    meta["gate_config_hash"] = record.config.hash
    meta.putValue("mediapipe_model_sha256", record.mediapipeModelSha256, "model_asset_unreadable")
    meta["mediapipe_options"] = record.mediapipeOptions

    meta.putValue("exposure_time_ns", capture?.exposureTimeNs, captureReason())
    meta.putValue("iso", capture?.iso, captureReason())
    meta.putValue("frame_duration_ns", capture?.frameDurationNs, captureReason())
    meta.putValue("focus_mode", capture?.focusMode, captureReason())
    meta.putValue("focus_state", capture?.focusState, captureReason())
    meta.putValue("focus_distance_diopter", capture?.focusDistanceDiopter, captureReason())
    meta.putValue("awb_mode", capture?.awbMode, captureReason())
    meta.putValue("awb_state", capture?.awbState, captureReason())
    meta.putValue("awb_gains", capture?.awbGains, captureReason())
    meta["pixel_format"] = PIXEL_FORMAT
    meta["encoder"] = ENCODER
    meta["jpeg_quality"] = record.jpegQuality
    meta.putValue(
      "focal_length_mm",
      capture?.focalLengthMm ?: camera.focalLengthsMm.firstOrNull(),
      NOT_REPORTED,
    )
    meta.putValue("sensor_size_mm", camera.physicalSizeMm?.toList(), NOT_REPORTED)
    meta.putValue("pixel_array", camera.pixelArray?.toList(), NOT_REPORTED)
    meta.putValue("active_array", camera.activeArray?.toList(), NOT_REPORTED)
    meta.putValue("crop_region", capture?.cropRegion?.toList(), captureReason())
    meta.putValue(
      "zoom_ratio",
      capture?.zoomRatio,
      if (record.device.osApiLevel < 30) "requires_api_30" else captureReason(),
    )
    meta.putValue(
      "intrinsics",
      record.intrinsics.upright?.let { intrinsicsObject(it) },
      record.intrinsics.missingReason ?: NOT_REPORTED,
    )
    meta["distortion"] = distortionObject(record, capture)
    meta.putValue("stabilization_state", stabilizationName(capture), captureReason())
    meta.putValue("hdr_state", capture?.sceneMode?.let { if (it == "hdr") "on" else "off" }, captureReason())
    meta["effects"] = effectsObject(record, capture)

    val faceReason = if (g == null) NO_FACE else NOT_REPORTED
    val poseReason = if (g == null) NO_FACE else "no_facial_transformation_matrix"
    meta.putValue("yaw", g?.yawDeg, poseReason)
    meta.putValue("pitch", g?.pitchDeg, poseReason)
    meta.putValue("roll", g?.rollDeg, poseReason)
    meta.putValue("inter_pupil_px", g?.interPupilPx, faceReason)
    meta.putValue("face_width_px", g?.faceWidthPx, faceReason)
    meta.putValue("face_box", g?.faceBox?.toList(), faceReason)
    meta.putValue(
      "landmarks_478",
      record.landmarks?.let { roundedLandmarks(it) },
      if (record.landmarks == null) NO_FACE else "non_finite",
    )
    meta.putValue(
      "distance_estimate_cm",
      m.distanceCm,
      when {
        record.intrinsics.upright == null -> "focal_length_unknown"
        g?.irisDiameterPx == null -> "iris_not_measured"
        else -> NOT_REPORTED
      },
    )
    meta["distance_method"] = distanceMethod(record.config.distance.irisMm)
    meta.putValue("blendshapes", record.blendshapes?.mapValues { it.value.toDouble() }, "no_blendshapes")
    meta.putValue("sharpness", m.sharpness, if (g == null) NO_FACE else "face_crop_not_measurable")
    val patchReason = if (g == null) NO_FACE else "cheek_or_nose_patch_not_measurable"
    meta.putValue("clip_frac", m.clipFrac, patchReason)
    meta.putValue("crush_frac", m.crushFrac, patchReason)
    meta.putValue("cheek_ratio", m.cheekRatio, if (g == null) NO_FACE else "cheek_patch_not_measurable")
    meta.putValue("gyro_deg_s", m.gyroDegPerS, record.gyroMissingReason ?: "no_gyroscope_sample")
    meta["checks"] = record.checks.toMap(snakeCase = true)
    return meta
  }

  /** `"iris_11.7mm"`: the same string the iOS implementation writes. */
  fun distanceMethod(irisMm: Double): String = "iris_${irisMm}mm"

  /**
   * Final checks of a returned frame: the per-frame checks with the burst-
   * relative eye and sharpness rules folded in (every returned frame passes
   * them, and its stored checks say so explicitly).
   */
  fun withBurstVerdict(
    meta: Map<String, Any?>,
    checks: FrameChecks,
    verdict: BurstSelector.RelativeVerdict?,
  ): LinkedHashMap<String, Any?> {
    val out = LinkedHashMap(meta)
    val final = checks.copy(
      eyes = checks.eyes && (verdict?.eyesPass ?: false),
      sharp = checks.sharp && (verdict?.sharpPass ?: false),
    )
    out["checks"] = final.toMap(snakeCase = true)
    return out
  }

  /** Video stabilisation mode name; `+optical` appended when OIS is on. */
  private fun stabilizationName(capture: CaptureSnapshot?): String? {
    val video = capture?.videoStabilization ?: return null
    return if (capture.opticalStabilization == "on") "$video+optical" else video
  }

  private fun intrinsicsObject(k: Intrinsics): Map<String, Any?> {
    val out = linkedMapOf<String, Any?>()
    out.putValue("fx", k.fx, NOT_REPORTED)
    out.putValue("fy", k.fy, NOT_REPORTED)
    out.putValue("cx", k.cx, NOT_REPORTED)
    out.putValue("cy", k.cy, NOT_REPORTED)
    out.putValue("s", k.skew, "skew_not_representable_after_rotation")
    out["ref_w"] = k.refWidth
    out["ref_h"] = k.refHeight
    out["source"] = k.source
    return out
  }

  private fun distortionObject(record: FrameRecord, capture: CaptureSnapshot?): Map<String, Any?> {
    val out = linkedMapOf<String, Any?>()
    val coeffs = capture?.lensDistortion ?: record.camera.lensDistortion
    out.putValue(
      "coeffs",
      coeffs?.map { it.toDouble() },
      if (record.device.osApiLevel < 28) "requires_api_28" else NOT_REPORTED,
    )
    val state = when {
      record.camera.distortionModes == null -> "unsupported"
      capture?.distortionCorrection != null -> capture.distortionCorrection
      else -> null
    }
    out.putValue("correction_state", state, NO_CAPTURE_RESULT)
    return out
  }

  private fun effectsObject(record: FrameRecord, capture: CaptureSnapshot?): Map<String, Any?> {
    val out = linkedMapOf<String, Any?>()
    val api = record.device.osApiLevel
    // Android's nearest equivalents: extended scene mode BOKEH (API 30) for
    // Portrait, CONTROL_AUTOFRAMING (API 34) for Center Stage. Studio Light
    // and Reactions have no Camera2 counterpart.
    out.putValue(
      "portrait",
      capture?.extendedSceneMode?.let { it != "disabled" },
      if (api < 30) "requires_api_30" else if (capture == null) NO_CAPTURE_RESULT else NOT_REPORTED,
    )
    out.putValue("studio_light", null, NOT_APPLICABLE_ANDROID)
    out.putValue(
      "center_stage",
      capture?.autoframing?.let { it != "off" },
      if (api < 34) "requires_api_34" else if (capture == null) NO_CAPTURE_RESULT else NOT_REPORTED,
    )
    out.putValue("reactions", null, NOT_APPLICABLE_ANDROID)
    return out
  }

  /** Six decimals (0.004 px at 3840 px); null if any coordinate is not finite, never a filled-in 0. */
  private fun roundedLandmarks(landmarks: FloatArray): List<Double>? {
    val factor = Math.pow(10.0, LANDMARK_DECIMALS.toDouble())
    val out = ArrayList<Double>(landmarks.size)
    for (value in landmarks) {
      val v = value.toDouble()
      if (!v.isFinite()) return null
      out.add((v * factor).roundToLong() / factor)
    }
    return out
  }
}

/**
 * `map[key] = value`, or `map[key] = null` plus `map["<key>_missing_reason"]`.
 * Non-finite numbers are written as null with reason `non_finite`.
 */
internal fun MutableMap<String, Any?>.putValue(key: String, value: Any?, missingReason: String) {
  val nonFinite = (value is Double && !value.isFinite()) || (value is Float && !value.isFinite())
  if (value == null || nonFinite) {
    this[key] = null
    this[key + "_missing_reason"] = if (nonFinite) "non_finite" else missingReason
  } else {
    this[key] = value
  }
}
