package ai.facetype.client

import kotlin.math.abs

/** A rectangle `left, top, width, height` in pixels of some sensor coordinate system. */
internal data class SensorRect(val left: Double, val top: Double, val width: Double, val height: Double) {
  val centreX: Double get() = left + width / 2.0
  val centreY: Double get() = top + height / 2.0

  fun offset(dx: Double, dy: Double) = SensorRect(left + dx, top + dy, width, height)

  fun toList(): List<Double> = listOf(left, top, width, height)
}

/**
 * Pinhole intrinsics `fx, fy, cx, cy, s` in the pixel coordinates of a
 * `refWidth x refHeight` image. [skew] is null when it is not representable in
 * that image (see [CameraGeometry.toUpright]).
 */
internal data class Intrinsics(
  val fx: Double,
  val fy: Double,
  val cx: Double,
  val cy: Double,
  val skew: Double?,
  val refWidth: Int,
  val refHeight: Int,
  val source: String,
)

/**
 * Camera geometry in the delivered stream.
 *
 * Camera2 reports focal length and calibration on the SENSOR: either
 * `LENS_INTRINSIC_CALIBRATION` (pixels of the pre-correction active array) or
 * a nominal focal length in mm over the physical size of the pixel array. The
 * stream the analyser receives is a crop of that sensor (the request's crop
 * region, further reduced by `CONTROL_ZOOM_RATIO` and then centre-cropped to
 * the stream's aspect ratio) scaled to the delivered resolution. A distance
 * estimate from the iris needs the focal length in DELIVERED pixels, so every
 * step of that chain is applied here, explicitly and testably.
 */
internal object CameraGeometry {

  const val SOURCE_CALIBRATION = "calibration"
  const val SOURCE_NOMINAL = "nominal"

  /**
   * Nominal sensor intrinsics in pixel-array coordinates: `f_mm` times pixels
   * per mm of the full pixel array; principal point at the active array centre;
   * zero skew. Null when any input is missing or not positive.
   */
  fun nominalSensorIntrinsics(
    focalLengthMm: Double?,
    physicalSizeMm: DoubleArray?,
    pixelArray: PixelSize?,
    activeArray: SensorRect?,
  ): Intrinsics? {
    if (focalLengthMm == null || physicalSizeMm == null || pixelArray == null || activeArray == null) return null
    if (physicalSizeMm.size != 2 || focalLengthMm <= 0 || physicalSizeMm[0] <= 0 || physicalSizeMm[1] <= 0) return null
    val fx = focalLengthMm * pixelArray.width / physicalSizeMm[0]
    val fy = focalLengthMm * pixelArray.height / physicalSizeMm[1]
    return Intrinsics(
      fx, fy, activeArray.centreX, activeArray.centreY, 0.0,
      pixelArray.width, pixelArray.height, SOURCE_NOMINAL,
    )
  }

  /**
   * Calibrated sensor intrinsics in pixel-array coordinates from
   * `LENS_INTRINSIC_CALIBRATION = [fx, fy, cx, cy, s]`, whose origin is the
   * top-left of the pre-correction active array. Null when absent or zero
   * (some devices publish an all-zero placeholder).
   */
  fun calibratedSensorIntrinsics(
    calibration: FloatArray?,
    preCorrectionArray: SensorRect?,
    pixelArray: PixelSize?,
  ): Intrinsics? {
    if (calibration == null || calibration.size < 5 || preCorrectionArray == null || pixelArray == null) return null
    val values = calibration.map { it.toDouble() }
    if (values.any { !it.isFinite() } || values[0] <= 0 || values[1] <= 0) return null
    return Intrinsics(
      fx = values[0],
      fy = values[1],
      cx = values[2] + preCorrectionArray.left,
      cy = values[3] + preCorrectionArray.top,
      skew = values[4],
      refWidth = pixelArray.width,
      refHeight = pixelArray.height,
      source = SOURCE_CALIBRATION,
    )
  }

  /**
   * The sensor region the stream actually shows, in pixel-array coordinates.
   *
   * @param cropRegion `SCALER_CROP_REGION` as reported, in the coordinates of
   *   [cropFrame] (pre-correction array when distortion correction is off,
   *   active array when it is on).
   * @param zoomRatio `CONTROL_ZOOM_RATIO` (API 30+), or null/1 for none. A ratio
   *   other than 1 shrinks the field of view about the frame centre.
   */
  fun streamRegion(
    cropRegion: SensorRect,
    cropFrame: SensorRect,
    zoomRatio: Double?,
    streamWidth: Int,
    streamHeight: Int,
  ): SensorRect {
    require(streamWidth > 0 && streamHeight > 0) { "stream size must be positive" }
    var region = cropRegion.offset(cropFrame.left, cropFrame.top)
    if (zoomRatio != null && zoomRatio.isFinite() && zoomRatio > 0 && abs(zoomRatio - 1.0) > 1e-6) {
      val cx = cropFrame.left + cropFrame.width / 2.0
      val cy = cropFrame.top + cropFrame.height / 2.0
      region = SensorRect(
        cx + (region.left - cx) / zoomRatio,
        cy + (region.top - cy) / zoomRatio,
        region.width / zoomRatio,
        region.height / zoomRatio,
      )
    }
    // Camera2: "cropping to a smaller region if necessary to maintain the
    // stream's aspect ratio" -- a centred crop of the region.
    val streamAspect = streamWidth.toDouble() / streamHeight
    val regionAspect = region.width / region.height
    return if (regionAspect > streamAspect) {
      val width = region.height * streamAspect
      SensorRect(region.centreX - width / 2.0, region.top, width, region.height)
    } else {
      val height = region.width / streamAspect
      SensorRect(region.left, region.centreY - height / 2.0, region.width, height)
    }
  }

  /** Sensor intrinsics (pixel-array coordinates) re-expressed in the delivered stream's buffer pixels. */
  fun toStream(sensor: Intrinsics, region: SensorRect, streamWidth: Int, streamHeight: Int): Intrinsics {
    val scaleX = streamWidth / region.width
    val scaleY = streamHeight / region.height
    return Intrinsics(
      fx = sensor.fx * scaleX,
      fy = sensor.fy * scaleY,
      cx = (sensor.cx - region.left) * scaleX,
      cy = (sensor.cy - region.top) * scaleY,
      skew = sensor.skew?.let { it * scaleX },
      refWidth = streamWidth,
      refHeight = streamHeight,
      source = sensor.source,
    )
  }

  /**
   * Stream intrinsics re-expressed in the upright image the JPEG stores, for a
   * clockwise [rotation]. A 90/270 turn swaps the axes; a non-zero skew then
   * lands in the lower-left of K and is not representable as `s`, so it
   * becomes null (zero skew stays zero).
   */
  fun toUpright(stream: Intrinsics, rotation: Int): Intrinsics {
    val w = stream.refWidth.toDouble()
    val h = stream.refHeight.toDouble()
    return when (rotation) {
      0 -> stream
      180 -> stream.copy(cx = w - stream.cx, cy = h - stream.cy)
      90 -> Intrinsics(
        fx = stream.fy, fy = stream.fx, cx = h - stream.cy, cy = stream.cx,
        skew = uprightSkew(stream.skew), refWidth = stream.refHeight, refHeight = stream.refWidth,
        source = stream.source,
      )
      270 -> Intrinsics(
        fx = stream.fy, fy = stream.fx, cx = stream.cy, cy = w - stream.cx,
        skew = uprightSkew(stream.skew), refWidth = stream.refHeight, refHeight = stream.refWidth,
        source = stream.source,
      )
      else -> throw IllegalArgumentException("unsupported rotation $rotation")
    }
  }

  private fun uprightSkew(skew: Double?): Double? = when {
    skew == null -> null
    abs(skew) < 1e-9 -> 0.0
    else -> null
  }

  /**
   * Camera distance in cm from the iris: `f_px * iris_mm / iris_px / 10`.
   *
   * An ESTIMATE (spec §3): the 11.7 mm iris is a population constant and the
   * landmark regression has its own error. Null for any non-finite or
   * non-positive input; never a default.
   */
  fun distanceCm(focalPx: Double?, irisDiameterPx: Double?, irisMm: Double): Double? {
    if (focalPx == null || irisDiameterPx == null) return null
    if (!focalPx.isFinite() || !irisDiameterPx.isFinite() || focalPx <= 0 || irisDiameterPx <= 0 || irisMm <= 0) {
      return null
    }
    val cm = focalPx * irisMm / irisDiameterPx / 10.0
    return if (cm.isFinite()) cm else null
  }
}

/**
 * Picks the analysis stream size (`capture-spec-v2` §2): the first of the
 * config's preferred sizes the camera lists, else the largest listed size of
 * the first preferred size's aspect ratio that is at least the floor, else the
 * largest listed size of any aspect at least the floor, else null (the phone is
 * below the minimum and is told so).
 */
internal object StreamSizeChooser {
  fun choose(supported: List<PixelSize>, preferred: List<PixelSize>, minSize: PixelSize): PixelSize? {
    val listed = supported.map { it.landscape() }.distinct()
    for (size in preferred) {
      val wanted = size.landscape()
      if (wanted in listed) return wanted
    }
    val floor = minSize.landscape()
    val eligible = listed.filter { it.width >= floor.width && it.height >= floor.height }
      .sortedByDescending { it.area }
    if (eligible.isEmpty()) return null
    val aspect = preferred.firstOrNull()?.landscape()?.let { it.width.toDouble() / it.height }
    if (aspect != null) {
      eligible.firstOrNull { abs(it.width.toDouble() / it.height - aspect) < 0.01 }?.let { return it }
    }
    return eligible.first()
  }
}
