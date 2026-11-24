package ai.facetype.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FrameMetaTest {

  /** Every key `docs/client-native-interface.md` §4 lists. */
  private val contractKeys = listOf(
    "frame_id", "ts_monotonic_ns", "ts_wall_ms", "sensor_ts_ns", "stream_w", "stream_h", "delivered_fps",
    "orientation_deg", "mirrored", "rotation_applied_deg", "lens_facing", "physical_camera_id",
    "device_manufacturer", "device_model", "os_version", "app_version", "protocol_version", "gate_config_hash",
    "mediapipe_model_sha256", "mediapipe_options", "exposure_time_ns", "iso", "frame_duration_ns", "focus_mode",
    "focus_state", "focus_distance_diopter", "awb_mode", "awb_state", "pixel_format", "encoder", "jpeg_quality",
    "focal_length_mm", "sensor_size_mm", "pixel_array", "active_array", "crop_region", "zoom_ratio", "intrinsics",
    "distortion", "stabilization_state", "hdr_state", "effects", "yaw", "pitch", "roll", "inter_pupil_px",
    "face_width_px", "face_box", "landmarks_478", "distance_estimate_cm", "distance_method", "blendshapes",
    "sharpness", "clip_frac", "crush_frac", "cheek_ratio", "gyro_deg_s", "checks",
  )

  private val static = CameraStaticInfo(
    cameraId = "1",
    sensorOrientation = 270,
    focalLengthsMm = listOf(3.6),
    physicalSizeMm = doubleArrayOf(5.6, 4.2),
    pixelArray = PixelSize(4000, 3000),
    activeArray = SensorRect(0.0, 0.0, 4000.0, 3000.0),
    preCorrectionArray = SensorRect(0.0, 0.0, 4000.0, 3000.0),
    intrinsicCalibration = null,
    lensDistortion = null,
    distortionModes = listOf("off", "fast"),
    timestampSource = "realtime",
    logicalMultiCamera = false,
    physicalCameraIds = emptyList(),
  )

  private val capture = CaptureSnapshot(
    sensorTsNs = 123_456_789L,
    exposureTimeNs = 16_000_000L,
    iso = 400,
    frameDurationNs = 33_333_333L,
    focusMode = "continuous_video",
    focusState = "passive_focused",
    focusDistanceDiopter = 2.1,
    awbMode = "auto",
    awbState = "converged",
    awbGains = linkedMapOf("red" to 1.9, "green" to 1.0, "blue" to 1.6),
    cropRegion = SensorRect(0.0, 0.0, 4000.0, 3000.0),
    zoomRatio = 1.0,
    focalLengthMm = 3.6,
    distortionCorrection = "fast",
    videoStabilization = "off",
    opticalStabilization = "off",
    sceneMode = "disabled",
    extendedSceneMode = "disabled",
    autoframing = null,
    intrinsicCalibration = null,
    lensDistortion = floatArrayOf(0.01f, -0.02f, 0f, 0f, 0f),
    activePhysicalCameraId = null,
  )

  private fun record(capture: CaptureSnapshot?, api: Int = 33, geometry: FaceGeometry? = ClientFixtures.goodGeometry()): FrameRecord {
    val measurement = ClientFixtures.goodMeasurement(geometry = geometry)
    val intrinsics = IntrinsicsResolver.resolve(static, capture, 1920, 1080, 270)
    return FrameRecord(
      frameId = "0b8f9a52-1d6e-4c3b-9a1e-2f4d5c6b7a80",
      tsMonotonicNs = 10L,
      tsWallMs = 1_795_000_000_000L,
      sensorTsNs = 123_456_789L,
      streamWidth = 1920,
      streamHeight = 1080,
      deliveredFps = null,
      rotationDegrees = 270,
      jpegQuality = 95,
      device = DeviceInfo("Samsung", "SM-T875", "14", api, "2.0.0 (1)"),
      camera = static,
      capture = capture,
      config = ClientFixtures.config,
      mediapipeModelSha256 = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff",
      mediapipeOptions = mapOf("running_mode" to "IMAGE", "num_faces" to 2),
      measurement = measurement,
      landmarks = if (geometry == null) null else FloatArray(478 * 3) { (it % 1000) / 1000f + 0.0000004f },
      blendshapes = mapOf("_neutral" to 0.9f, "mouthSmileLeft" to 0.1f),
      intrinsics = intrinsics,
      checks = FrameCheckEvaluator.evaluate(measurement, ClientFixtures.config),
      gyroMissingReason = null,
    )
  }

  @Test
  fun `every contract key is present and the result is valid JSON`() {
    val meta = FrameMetaBuilder.build(record(capture))
    for (key in contractKeys) assertTrue("missing $key", meta.containsKey(key))
    assertEquals(false, meta["mirrored"])
    assertEquals("front", meta["lens_facing"])
    assertEquals(ClientFixtures.config.hash, meta["gate_config_hash"])
    assertEquals("capture-spec-v2", meta["protocol_version"])
    assertEquals(95, meta["jpeg_quality"])
    assertEquals("1", meta["physical_camera_id"])
    val json = Json.stringify(meta)
    val back = Json.parse(json) as Map<*, *>
    assertEquals(meta.keys, back.keys)
  }

  @Test
  fun `no key beyond the contract list except awb_gains and missing-reason siblings`() {
    for (meta in listOf(
      FrameMetaBuilder.build(record(capture)),
      FrameMetaBuilder.build(record(null)),
      FrameMetaBuilder.build(record(capture, geometry = null)),
    )) {
      val extra = meta.keys.filterNot { it in contractKeys || it == "awb_gains" || it.endsWith("_missing_reason") }
      assertEquals(emptyList<String>(), extra)
      for (key in meta.keys.filter { it.endsWith("_missing_reason") }) {
        assertTrue(key, meta.containsKey(key.removeSuffix("_missing_reason")))
      }
    }
    val checks = FrameMetaBuilder.build(record(capture))["checks"] as Map<*, *>
    assertEquals(
      listOf("one_face", "distance_or_size", "centred", "facing", "light", "expression", "eyes", "sharp"),
      checks.keys.toList(),
    )
  }

  @Test
  fun `value shapes match the iOS implementation`() {
    val meta = FrameMetaBuilder.build(record(capture))
    assertEquals("iris_11.7mm", meta["distance_method"])
    assertEquals("off", meta["stabilization_state"])
    assertEquals("off", meta["hdr_state"])
    assertEquals("Android 14 (API 33)", meta["os_version"])
    assertEquals(linkedMapOf("red" to 1.9, "green" to 1.0, "blue" to 1.6), meta["awb_gains"])
    val ois = FrameMetaBuilder.build(record(capture.copy(opticalStabilization = "on")))
    assertEquals("off+optical", ois["stabilization_state"])
    // No focal length: intrinsics is null with a reason, and distance_method is still recorded.
    val noFocal = FrameMetaBuilder.build(
      record(capture.copy(focalLengthMm = null)).copy(
        camera = static.copy(focalLengthsMm = emptyList()),
        intrinsics = IntrinsicsResolver.resolve(static.copy(focalLengthsMm = emptyList()), capture.copy(focalLengthMm = null), 1920, 1080, 270),
      ),
    )
    assertNull(noFocal["intrinsics"])
    assertEquals("focal_length_or_sensor_size_unknown", noFocal["intrinsics_missing_reason"])
    assertEquals("iris_11.7mm", noFocal["distance_method"])
  }

  @Test
  fun `a value that cannot be read is null with a sibling missing reason`() {
    val meta = FrameMetaBuilder.build(record(capture))
    assertNull(meta["delivered_fps"])
    assertEquals("insufficient_frames", meta["delivered_fps_missing_reason"])
    val noResult = FrameMetaBuilder.build(record(null))
    assertNull(noResult["exposure_time_ns"])
    assertEquals("capture_result_not_matched", noResult["exposure_time_ns_missing_reason"])
    assertEquals("capture_result_not_matched", noResult["crop_region_missing_reason"])
    // On API 29 the reader never fills the API-30/34 keys.
    val old = FrameMetaBuilder.build(record(capture.copy(extendedSceneMode = null, autoframing = null), api = 29))
    assertEquals("requires_api_30", (old["effects"] as Map<*, *>)["portrait_missing_reason"])
    assertEquals("requires_api_34", (old["effects"] as Map<*, *>)["center_stage_missing_reason"])
    // No key is ever null without a reason.
    fun checkReasons(map: Map<*, *>, path: String) {
      for ((key, value) in map) {
        val name = key as String
        if (name.endsWith("_missing_reason") || name == "burst_relative") continue
        if (value == null) assertTrue("$path$name has no reason", map.containsKey(name + "_missing_reason"))
        if (value is Map<*, *> && name != "mediapipe_options" && name != "blendshapes") checkReasons(value, "$path$name.")
      }
    }
    checkReasons(noResult, "")
    checkReasons(FrameMetaBuilder.build(record(capture, geometry = null)), "")
  }

  @Test
  fun `effects Android cannot report are null with not_applicable_android`() {
    val effects = FrameMetaBuilder.build(record(capture))["effects"] as Map<*, *>
    assertNull(effects["studio_light"])
    assertEquals("not_applicable_android", effects["studio_light_missing_reason"])
    assertNull(effects["reactions"])
    assertEquals("not_applicable_android", effects["reactions_missing_reason"])
    assertEquals(false, effects["portrait"])
  }

  @Test
  fun `intrinsics are in upright JPEG pixels with their source`() {
    val k = FrameMetaBuilder.build(record(capture))["intrinsics"] as Map<*, *>
    assertEquals("nominal", k["source"])
    assertEquals(1080, k["ref_w"])
    assertEquals(1920, k["ref_h"])
    assertEquals(3.6 * 3000 / 4.2 * 0.48, k["fx"] as Double, 1e-6)
    val distortion = FrameMetaBuilder.build(record(capture))["distortion"] as Map<*, *>
    assertEquals("fast", distortion["correction_state"])
    assertEquals(5, (distortion["coeffs"] as List<*>).size)
  }

  @Test
  fun `landmarks are flat, rounded to six decimals, and never filled in`() {
    val meta = FrameMetaBuilder.build(record(capture))
    val lm = meta["landmarks_478"] as List<*>
    assertEquals(478 * 3, lm.size)
    assertEquals(0.001, lm[1] as Double, 1e-12)
    val noFace = FrameMetaBuilder.build(record(capture, geometry = null))
    assertNull(noFace["landmarks_478"])
    assertEquals("no_face_measured", noFace["landmarks_478_missing_reason"])
    assertEquals("no_face_measured", noFace["face_width_px_missing_reason"])
  }

  @Test
  fun `non-finite numbers are written as null with reason non_finite`() {
    val map = LinkedHashMap<String, Any?>()
    map.putValue("x", Double.NaN, "unused")
    map.putValue("y", 1.5, "unused")
    map.putValue("z", null, "why")
    assertNull(map["x"])
    assertEquals("non_finite", map["x_missing_reason"])
    assertEquals(1.5, map["y"])
    assertFalse(map.containsKey("y_missing_reason"))
    assertEquals("why", map["z_missing_reason"])
  }

  @Test
  fun `the burst verdict is folded into the final checks`() {
    val base = record(capture)
    val meta = FrameMetaBuilder.build(base)
    val verdict = BurstSelector.RelativeVerdict(
      eyesPass = false, sharpPass = true, medianOpeningL = 0.3, medianOpeningR = 0.31, maxSharpness = 1.2,
    )
    val final = FrameMetaBuilder.withBurstVerdict(meta, base.checks, verdict)
    val checks = final["checks"] as Map<*, *>
    assertEquals(false, checks["eyes"])
    assertEquals(true, checks["sharp"])
    assertEquals(8, checks.size)
    // The original map is not modified.
    assertEquals(true, (meta["checks"] as Map<*, *>)["eyes"])
  }
}
