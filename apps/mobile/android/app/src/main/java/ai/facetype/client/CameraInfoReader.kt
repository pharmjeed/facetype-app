package ai.facetype.client

import android.annotation.SuppressLint
import android.graphics.ImageFormat
import android.graphics.Rect
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureResult
import android.os.Build
import android.util.Range

/**
 * Reads Camera2 characteristics and per-frame capture results into the plain
 * [CameraStaticInfo] / [CaptureSnapshot] types, mapping every enumeration to a
 * lower-case name from the framework's own constants. API-level guards live
 * here and nowhere else; a key the device does not publish becomes null and
 * [FrameMetaBuilder] gives it a missing reason.
 */
@SuppressLint("InlinedApi") // constants are compile-time ints; reads are API-guarded below
internal object CameraInfoReader {

  fun readStatic(cameraId: String, chars: CameraCharacteristics): CameraStaticInfo {
    val physical = chars.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
    val pixelArray = chars.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE)
    val active = chars.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)
    val preCorrection = if (Build.VERSION.SDK_INT >= 28) {
      chars.get(CameraCharacteristics.SENSOR_INFO_PRE_CORRECTION_ACTIVE_ARRAY_SIZE)
    } else {
      null
    }
    val calibration = chars.get(CameraCharacteristics.LENS_INTRINSIC_CALIBRATION)
    val distortion = if (Build.VERSION.SDK_INT >= 28) chars.get(CameraCharacteristics.LENS_DISTORTION) else null
    val distortionModes = if (Build.VERSION.SDK_INT >= 28) {
      chars.get(CameraCharacteristics.DISTORTION_CORRECTION_AVAILABLE_MODES)
        ?.takeIf { it.isNotEmpty() }
        ?.map { distortionName(it) }
    } else {
      null
    }
    val capabilities = chars.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: IntArray(0)
    val logical = Build.VERSION.SDK_INT >= 28 &&
      capabilities.contains(CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA)
    val physicalIds = if (Build.VERSION.SDK_INT >= 28) chars.physicalCameraIds.toList() else emptyList()
    val timestampSource = when (chars.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE)) {
      CameraMetadata.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME -> "realtime"
      CameraMetadata.SENSOR_INFO_TIMESTAMP_SOURCE_UNKNOWN -> "unknown"
      else -> null
    }
    return CameraStaticInfo(
      cameraId = cameraId,
      sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION),
      focalLengthsMm = chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
        ?.map { it.toDouble() } ?: emptyList(),
      physicalSizeMm = physical?.let { doubleArrayOf(it.width.toDouble(), it.height.toDouble()) },
      pixelArray = pixelArray?.let { PixelSize(it.width, it.height) },
      activeArray = active?.let { rect(it) },
      preCorrectionArray = preCorrection?.let { rect(it) },
      intrinsicCalibration = calibration?.takeIf { it.size >= 5 && it[0] > 0f },
      lensDistortion = distortion?.takeIf { it.isNotEmpty() },
      distortionModes = distortionModes,
      timestampSource = timestampSource,
      logicalMultiCamera = logical,
      physicalCameraIds = physicalIds,
    )
  }

  /** YUV_420_888 output sizes, largest first. */
  fun yuvSizes(chars: CameraCharacteristics): List<PixelSize> {
    val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return emptyList()
    return (map.getOutputSizes(ImageFormat.YUV_420_888) ?: emptyArray())
      .map { PixelSize(it.width, it.height) }
      .sortedByDescending { it.area }
  }

  /** `on` when a non-OFF distortion-correction mode exists, `off` when only OFF, else `unsupported`. */
  fun distortionCorrectionCapability(info: CameraStaticInfo): String {
    val modes = info.distortionModes ?: return "unsupported"
    return if (modes.any { it != "off" }) "on" else "off"
  }

  fun hasIntrinsicCalibration(info: CameraStaticInfo): Boolean = info.intrinsicCalibration != null

  fun snapshot(result: CaptureResult): CaptureSnapshot? {
    val timestamp = result.get(CaptureResult.SENSOR_TIMESTAMP) ?: return null
    return CaptureSnapshot(
      sensorTsNs = timestamp,
      exposureTimeNs = result.get(CaptureResult.SENSOR_EXPOSURE_TIME),
      iso = result.get(CaptureResult.SENSOR_SENSITIVITY),
      frameDurationNs = result.get(CaptureResult.SENSOR_FRAME_DURATION),
      focusMode = result.get(CaptureResult.CONTROL_AF_MODE)?.let { afModeName(it) },
      focusState = result.get(CaptureResult.CONTROL_AF_STATE)?.let { afStateName(it) },
      focusDistanceDiopter = result.get(CaptureResult.LENS_FOCUS_DISTANCE)?.toDouble(),
      awbMode = result.get(CaptureResult.CONTROL_AWB_MODE)?.let { awbModeName(it) },
      awbState = result.get(CaptureResult.CONTROL_AWB_STATE)?.let { awbStateName(it) },
      awbGains = result.get(CaptureResult.COLOR_CORRECTION_GAINS)?.let { gains ->
        linkedMapOf(
          "red" to gains.red.toDouble(),
          "green" to (gains.greenEven.toDouble() + gains.greenOdd.toDouble()) / 2.0,
          "blue" to gains.blue.toDouble(),
        )
      },
      cropRegion = result.get(CaptureResult.SCALER_CROP_REGION)?.let { rect(it) },
      zoomRatio = if (Build.VERSION.SDK_INT >= 30) result.get(CaptureResult.CONTROL_ZOOM_RATIO)?.toDouble() else null,
      focalLengthMm = result.get(CaptureResult.LENS_FOCAL_LENGTH)?.toDouble(),
      distortionCorrection = if (Build.VERSION.SDK_INT >= 28) {
        result.get(CaptureResult.DISTORTION_CORRECTION_MODE)?.let { distortionName(it) }
      } else {
        null
      },
      videoStabilization = result.get(CaptureResult.CONTROL_VIDEO_STABILIZATION_MODE)?.let { videoStabName(it) },
      opticalStabilization = result.get(CaptureResult.LENS_OPTICAL_STABILIZATION_MODE)?.let {
        if (it == CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_ON) "on" else "off"
      },
      sceneMode = result.get(CaptureResult.CONTROL_SCENE_MODE)?.let { sceneModeName(it) },
      extendedSceneMode = if (Build.VERSION.SDK_INT >= 30) {
        result.get(CaptureResult.CONTROL_EXTENDED_SCENE_MODE)?.let { extendedSceneName(it) }
      } else {
        null
      },
      autoframing = if (Build.VERSION.SDK_INT >= 34) result.get(CaptureResult.CONTROL_AUTOFRAMING)?.let { autoframingName(it) } else null,
      intrinsicCalibration = if (Build.VERSION.SDK_INT >= 28) {
        result.get(CaptureResult.LENS_INTRINSIC_CALIBRATION)?.takeIf { it.size >= 5 && it[0] > 0f }
      } else {
        null
      },
      lensDistortion = if (Build.VERSION.SDK_INT >= 28) result.get(CaptureResult.LENS_DISTORTION)?.takeIf { it.isNotEmpty() } else null,
      activePhysicalCameraId = if (Build.VERSION.SDK_INT >= 29) result.get(CaptureResult.LOGICAL_MULTI_CAMERA_ACTIVE_PHYSICAL_ID) else null,
    )
  }

  /** The AE target range to request: max 30, lowest min not below [minFps]; null to leave the device default. */
  fun aeTargetRange(chars: CameraCharacteristics, minFps: Double): Range<Int>? {
    val ranges = chars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES) ?: return null
    return ranges
      .filter { it.upper == 30 && it.lower >= minFps }
      .minByOrNull { it.lower }
  }

  fun supportsOisOff(chars: CameraCharacteristics): Boolean =
    chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION)
      ?.contains(CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_OFF) == true

  fun supportsVideoStabilizationOff(chars: CameraCharacteristics): Boolean =
    chars.get(CameraCharacteristics.CONTROL_AVAILABLE_VIDEO_STABILIZATION_MODES)
      ?.contains(CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_OFF) == true

  /** HIGH_QUALITY, else FAST, else null (correction unavailable: stays OFF). */
  fun preferredDistortionMode(chars: CameraCharacteristics): Int? {
    if (Build.VERSION.SDK_INT < 28) return null
    val modes = chars.get(CameraCharacteristics.DISTORTION_CORRECTION_AVAILABLE_MODES) ?: return null
    return when {
      modes.contains(CameraMetadata.DISTORTION_CORRECTION_MODE_HIGH_QUALITY) ->
        CameraMetadata.DISTORTION_CORRECTION_MODE_HIGH_QUALITY
      modes.contains(CameraMetadata.DISTORTION_CORRECTION_MODE_FAST) -> CameraMetadata.DISTORTION_CORRECTION_MODE_FAST
      else -> null
    }
  }

  fun supportsAutoframingOff(chars: CameraCharacteristics): Boolean =
    Build.VERSION.SDK_INT >= 34 && chars.get(CameraCharacteristics.CONTROL_AUTOFRAMING_AVAILABLE) == true

  private fun rect(r: Rect) =
    SensorRect(r.left.toDouble(), r.top.toDouble(), r.width().toDouble(), r.height().toDouble())

  private fun distortionName(mode: Int): String = when (mode) {
    CameraMetadata.DISTORTION_CORRECTION_MODE_OFF -> "off"
    CameraMetadata.DISTORTION_CORRECTION_MODE_FAST -> "fast"
    CameraMetadata.DISTORTION_CORRECTION_MODE_HIGH_QUALITY -> "high_quality"
    else -> "mode_$mode"
  }

  private fun afModeName(mode: Int): String = when (mode) {
    CameraMetadata.CONTROL_AF_MODE_OFF -> "off"
    CameraMetadata.CONTROL_AF_MODE_AUTO -> "auto"
    CameraMetadata.CONTROL_AF_MODE_MACRO -> "macro"
    CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO -> "continuous_video"
    CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE -> "continuous_picture"
    CameraMetadata.CONTROL_AF_MODE_EDOF -> "edof"
    else -> "mode_$mode"
  }

  private fun afStateName(state: Int): String = when (state) {
    CameraMetadata.CONTROL_AF_STATE_INACTIVE -> "inactive"
    CameraMetadata.CONTROL_AF_STATE_PASSIVE_SCAN -> "passive_scan"
    CameraMetadata.CONTROL_AF_STATE_PASSIVE_FOCUSED -> "passive_focused"
    CameraMetadata.CONTROL_AF_STATE_ACTIVE_SCAN -> "active_scan"
    CameraMetadata.CONTROL_AF_STATE_FOCUSED_LOCKED -> "focused_locked"
    CameraMetadata.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED -> "not_focused_locked"
    CameraMetadata.CONTROL_AF_STATE_PASSIVE_UNFOCUSED -> "passive_unfocused"
    else -> "state_$state"
  }

  private fun awbModeName(mode: Int): String = when (mode) {
    CameraMetadata.CONTROL_AWB_MODE_OFF -> "off"
    CameraMetadata.CONTROL_AWB_MODE_AUTO -> "auto"
    CameraMetadata.CONTROL_AWB_MODE_INCANDESCENT -> "incandescent"
    CameraMetadata.CONTROL_AWB_MODE_FLUORESCENT -> "fluorescent"
    CameraMetadata.CONTROL_AWB_MODE_WARM_FLUORESCENT -> "warm_fluorescent"
    CameraMetadata.CONTROL_AWB_MODE_DAYLIGHT -> "daylight"
    CameraMetadata.CONTROL_AWB_MODE_CLOUDY_DAYLIGHT -> "cloudy_daylight"
    CameraMetadata.CONTROL_AWB_MODE_TWILIGHT -> "twilight"
    CameraMetadata.CONTROL_AWB_MODE_SHADE -> "shade"
    else -> "mode_$mode"
  }

  private fun awbStateName(state: Int): String = when (state) {
    CameraMetadata.CONTROL_AWB_STATE_INACTIVE -> "inactive"
    CameraMetadata.CONTROL_AWB_STATE_SEARCHING -> "searching"
    CameraMetadata.CONTROL_AWB_STATE_CONVERGED -> "converged"
    CameraMetadata.CONTROL_AWB_STATE_LOCKED -> "locked"
    else -> "state_$state"
  }

  private fun videoStabName(mode: Int): String = when (mode) {
    CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_OFF -> "off"
    CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_ON -> "on"
    CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_PREVIEW_STABILIZATION -> "preview_stabilization"
    else -> "mode_$mode"
  }

  private fun sceneModeName(mode: Int): String = when (mode) {
    CameraMetadata.CONTROL_SCENE_MODE_DISABLED -> "disabled"
    CameraMetadata.CONTROL_SCENE_MODE_FACE_PRIORITY -> "face_priority"
    CameraMetadata.CONTROL_SCENE_MODE_HDR -> "hdr"
    CameraMetadata.CONTROL_SCENE_MODE_PORTRAIT -> "portrait"
    CameraMetadata.CONTROL_SCENE_MODE_NIGHT -> "night"
    else -> "mode_$mode"
  }

  private fun extendedSceneName(mode: Int): String = when (mode) {
    CameraMetadata.CONTROL_EXTENDED_SCENE_MODE_DISABLED -> "disabled"
    CameraMetadata.CONTROL_EXTENDED_SCENE_MODE_BOKEH_STILL_CAPTURE -> "bokeh_still_capture"
    CameraMetadata.CONTROL_EXTENDED_SCENE_MODE_BOKEH_CONTINUOUS -> "bokeh_continuous"
    else -> "mode_$mode"
  }

  private fun autoframingName(mode: Int): String = when (mode) {
    CameraMetadata.CONTROL_AUTOFRAMING_OFF -> "off"
    CameraMetadata.CONTROL_AUTOFRAMING_ON -> "on"
    else -> "mode_$mode"
  }
}
