package ai.facetype.capture.quality

/** A half-open pixel rectangle: `left`/`top` inclusive, `right`/`bottom` exclusive. */
internal data class RoiRect(val left: Int, val top: Int, val right: Int, val bottom: Int) {
  val width: Int get() = right - left
  val height: Int get() = bottom - top
  val isEmpty: Boolean get() = width <= 0 || height <= 0
}

/**
 * Geometry that moves a detector result back onto the pixels it was computed
 * from.
 *
 * ML Kit is handed the NV21 buffer plus the number of degrees it must be
 * rotated **clockwise** to be upright, and reports every bounding box in that
 * upright frame. [PixelMetrics], on the other hand, indexes the buffer itself.
 * Skipping the inverse rotation does not fail loudly -- it silently measures
 * sharpness on a rectangle of background -- so the mapping lives here as pure
 * arithmetic with a unit test per orientation.
 */
internal object RoiMath {

  /** Width of the image ML Kit sees after the clockwise rotation is applied. */
  fun rotatedWidth(bufferWidth: Int, bufferHeight: Int, rotationDegrees: Int): Int =
    if (isQuarterTurn(rotationDegrees)) bufferHeight else bufferWidth

  /** Height of the image ML Kit sees after the clockwise rotation is applied. */
  fun rotatedHeight(bufferWidth: Int, bufferHeight: Int, rotationDegrees: Int): Int =
    if (isQuarterTurn(rotationDegrees)) bufferWidth else bufferHeight

  /**
   * Maps a rectangle expressed in the rotated (upright) frame back into buffer
   * coordinates.
   */
  fun toBufferSpace(
    rect: RoiRect,
    rotationDegrees: Int,
    bufferWidth: Int,
    bufferHeight: Int,
  ): RoiRect {
    requireSupportedRotation(rotationDegrees)
    if (rect.isEmpty) return rect
    // Map the inclusive corners; a half-open rectangle's `right`/`bottom` are
    // one past the last pixel and would land outside the image under a
    // quarter turn.
    val corners = listOf(
      pointToBufferSpace(rect.left, rect.top, rotationDegrees, bufferWidth, bufferHeight),
      pointToBufferSpace(rect.right - 1, rect.top, rotationDegrees, bufferWidth, bufferHeight),
      pointToBufferSpace(rect.left, rect.bottom - 1, rotationDegrees, bufferWidth, bufferHeight),
      pointToBufferSpace(
        rect.right - 1,
        rect.bottom - 1,
        rotationDegrees,
        bufferWidth,
        bufferHeight,
      ),
    )
    val left = corners.minOf { it.first }
    val top = corners.minOf { it.second }
    val right = corners.maxOf { it.first } + 1
    val bottom = corners.maxOf { it.second } + 1
    return RoiRect(left, top, right, bottom)
  }

  /** One point of the rotated frame, expressed in buffer coordinates. */
  fun pointToBufferSpace(
    x: Int,
    y: Int,
    rotationDegrees: Int,
    bufferWidth: Int,
    bufferHeight: Int,
  ): Pair<Int, Int> {
    requireSupportedRotation(rotationDegrees)
    return when (rotationDegrees) {
      0 -> x to y
      90 -> y to (bufferHeight - 1 - x)
      180 -> (bufferWidth - 1 - x) to (bufferHeight - 1 - y)
      else -> (bufferWidth - 1 - y) to x
    }
  }

  /** Intersects [rect] with the image, so no metric ever reads out of bounds. */
  fun clamp(rect: RoiRect, width: Int, height: Int): RoiRect = RoiRect(
    left = rect.left.coerceIn(0, width),
    top = rect.top.coerceIn(0, height),
    right = rect.right.coerceIn(0, width),
    bottom = rect.bottom.coerceIn(0, height),
  )

  /**
   * Shrinks [rect] towards its centre by [fraction] of each side.
   *
   * A detector box is a loose bound: it includes hair, ears and a margin of
   * background whose sharpness and brightness say nothing about the face. The
   * inset keeps the measurement on skin. It is a framing choice, not a
   * calibrated one, and is stated as such in the analyser's provisional
   * constants.
   */
  fun inset(rect: RoiRect, fraction: Double): RoiRect {
    require(fraction >= 0.0 && fraction < 0.5) { "inset fraction must be in [0, 0.5)" }
    val dx = (rect.width * fraction).toInt()
    val dy = (rect.height * fraction).toInt()
    return RoiRect(rect.left + dx, rect.top + dy, rect.right - dx, rect.bottom - dy)
  }

  private fun isQuarterTurn(rotationDegrees: Int): Boolean {
    requireSupportedRotation(rotationDegrees)
    return rotationDegrees == 90 || rotationDegrees == 270
  }

  private fun requireSupportedRotation(rotationDegrees: Int) {
    require(rotationDegrees == 0 || rotationDegrees == 90 || rotationDegrees == 180 ||
      rotationDegrees == 270) { "unsupported rotation $rotationDegrees" }
  }
}

/**
 * The rotation ML Kit needs, derived the way Google's own `InputImage`
 * documentation derives it.
 *
 * Two independent rotations are in play: the sensor's fixed mounting angle
 * (`CameraCharacteristics.SENSOR_ORIENTATION`, documented as the clockwise
 * angle the output has to be turned through to be upright in the device's
 * native orientation) and however the user is currently holding the device
 * (`Display.getRotation()`).
 *
 * THE SIGN. The two rotations *add* for a front camera and *subtract* for a
 * rear one. That asymmetry is the mirroring: a front sensor's readout is
 * flipped, so turning the device one way turns its image the other. An earlier
 * version of this file added a further `(360 - x)` "to compensate for
 * mirroring" — carried over from the old Firebase-era sample, where the flip
 * was handled elsewhere in the pipeline. Applied here it inverts the rotation
 * for every orientation except 0 and 180, which does not fail loudly: it hands
 * the detector an upside-down image and lets the resulting missed or misplaced
 * face look like a quality problem (Codex review of `80925da`, finding 4).
 */
internal object MlKitRotation {

  /**
   * @param sensorOrientation `CameraCharacteristics.SENSOR_ORIENTATION`, in degrees.
   * @param deviceRotationDegrees the display rotation, in degrees (0/90/180/270).
   */
  fun compensation(
    sensorOrientation: Int,
    deviceRotationDegrees: Int,
    frontFacing: Boolean,
  ): Int {
    require(sensorOrientation % 90 == 0 && sensorOrientation >= 0) {
      "sensor orientation must be a non-negative quarter turn"
    }
    require(deviceRotationDegrees % 90 == 0 && deviceRotationDegrees >= 0) {
      "device rotation must be a non-negative quarter turn"
    }
    val sensor = sensorOrientation % 360
    val device = deviceRotationDegrees % 360
    return if (frontFacing) {
      (sensor + device) % 360
    } else {
      (sensor - device + 360) % 360
    }
  }
}
