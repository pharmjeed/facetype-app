package ai.facetype.capture.quality

/**
 * Blur and exposure, computed from real luma bytes over the detected face
 * rectangle.
 *
 * WHAT THESE NUMBERS ARE. Two image-formation measurements, on the [0, 1]
 * scale FT-03 §3 gates against, taken from the dense luma prefix of the NV21
 * buffer [YuvNv21] produced. Nothing here infers anything about a person.
 *
 * WHAT THEY ARE NOT. Calibrated. The two constants that turn a raw statistic
 * into a [0, 1] score ([BLUR_HALF_SATURATION], and the video-range luma
 * endpoints) are provisional engineering defaults chosen so the shape of the
 * curve is right; the *position* of the curve has to be fitted against the
 * FT-03 thresholds on the physical target handset, which this host cannot do.
 * Until that happens the Android capture path still fails closed on
 * `FT-SCAN-014` for the signals it genuinely cannot measure, so a mis-scaled
 * blur score cannot admit bad geometry into the pipeline.
 */
internal object PixelMetrics {

  /**
   * Laplacian variance at which [blurScore] reads 0.5.
   *
   * **Provisional and uncalibrated.** See the class note.
   */
  const val BLUR_HALF_SATURATION: Double = 600.0

  /**
   * Nominal luma endpoints. `YUV_420_888` carries no range flag, and Android
   * camera devices conventionally emit studio-swing ("video range") luma, so
   * these are the endpoints assumed. On a full-range device the effect is
   * conservative -- legitimate highlights above 235 are counted as clipped,
   * which pushes [exposureScore] down and towards a retake, never up and
   * towards accepting a blown-out frame.
   */
  const val LUMA_BLACK_LEVEL: Int = 16
  const val LUMA_WHITE_LEVEL: Int = 235

  /**
   * Width, in samples, of the grid the Laplacian is evaluated on.
   *
   * The operator compares each sample against neighbours one grid step away
   * rather than one *pixel* away, so it measures contrast across a fixed
   * fraction of the face. Without that, the same face photographed at 640x480
   * and at 1920x1440 would produce different "sharpness" purely because a
   * pixel covers a different amount of skin.
   */
  const val BLUR_GRID_WIDTH: Int = 96

  /** Below this the region is too small for either statistic to mean anything. */
  const val MIN_ROI_SIDE: Int = 32
  private const val MIN_SAMPLES: Int = 64

  /**
   * Normalised edge energy over [roi]; 1 is sharp, 0 is featureless.
   *
   * Returns `null` -- never a made-up score -- when the region is too small or
   * too few samples survive the grid, which the caller turns into an
   * unavailable measurement and therefore `FT-SCAN-014`.
   */
  fun blurScore(luma: ByteArray, width: Int, height: Int, roi: RoiRect): Double? {
    if (!isMeasurable(luma, width, height, roi)) return null
    val step = (roi.width / BLUR_GRID_WIDTH).coerceAtLeast(1)
    var count = 0L
    var sum = 0.0
    var sumSquares = 0.0
    var y = roi.top + step
    while (y < roi.bottom - step) {
      var x = roi.left + step
      while (x < roi.right - step) {
        val centre = sample(luma, width, x, y)
        val laplacian = 4 * centre -
          sample(luma, width, x - step, y) -
          sample(luma, width, x + step, y) -
          sample(luma, width, x, y - step) -
          sample(luma, width, x, y + step)
        sum += laplacian
        sumSquares += laplacian.toDouble() * laplacian.toDouble()
        count += 1
        x += step
      }
      y += step
    }
    if (count < MIN_SAMPLES) return null
    val mean = sum / count
    val variance = (sumSquares / count) - (mean * mean)
    if (!variance.isFinite() || variance < 0.0) return null
    return variance / (variance + BLUR_HALF_SATURATION)
  }

  /**
   * Two-sided exposure quality over [roi]; 1 is well exposed.
   *
   * Two independent ways a frame can be badly exposed are combined by taking
   * the worse of them: the region's mean drifting away from mid-grey, and the
   * fraction of samples pinned at either endpoint (where the sensor has
   * already thrown the information away and no mean can reveal it).
   */
  fun exposureScore(luma: ByteArray, width: Int, height: Int, roi: RoiRect): Double? {
    if (!isMeasurable(luma, width, height, roi)) return null
    val step = (roi.width / BLUR_GRID_WIDTH).coerceAtLeast(1)
    var count = 0L
    var sum = 0.0
    var clipped = 0L
    var y = roi.top
    while (y < roi.bottom) {
      var x = roi.left
      while (x < roi.right) {
        val value = sample(luma, width, x, y)
        sum += value
        if (value <= LUMA_BLACK_LEVEL || value >= LUMA_WHITE_LEVEL) clipped += 1
        count += 1
        x += step
      }
      y += step
    }
    if (count < MIN_SAMPLES) return null
    val midpoint = (LUMA_BLACK_LEVEL + LUMA_WHITE_LEVEL) / 2.0
    val halfRange = (LUMA_WHITE_LEVEL - LUMA_BLACK_LEVEL) / 2.0
    val balance = (1.0 - Math.abs(sum / count - midpoint) / halfRange).coerceIn(0.0, 1.0)
    val unclipped = (1.0 - clipped.toDouble() / count).coerceIn(0.0, 1.0)
    return Math.min(balance, unclipped)
  }

  private fun isMeasurable(luma: ByteArray, width: Int, height: Int, roi: RoiRect): Boolean {
    if (width <= 0 || height <= 0) return false
    if (luma.size < width * height) return false
    if (roi.left < 0 || roi.top < 0 || roi.right > width || roi.bottom > height) return false
    return roi.width >= MIN_ROI_SIDE && roi.height >= MIN_ROI_SIDE
  }

  private fun sample(luma: ByteArray, width: Int, x: Int, y: Int): Int =
    luma[y * width + x].toInt() and 0xff
}
