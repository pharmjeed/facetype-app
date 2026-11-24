package ai.facetype.client

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Upright, non-mirrored read access to the luma of an NV21 buffer in sensor
 * orientation.
 *
 * [rotation] is the clockwise turn that makes the buffer upright (CameraX
 * `ImageInfo.rotationDegrees`). Coordinates outside the frame are clamped to
 * the nearest edge pixel.
 */
internal class UprightLuma(
  private val nv21: ByteArray,
  val bufferWidth: Int,
  val bufferHeight: Int,
  val rotation: Int,
) {
  init {
    require(bufferWidth > 0 && bufferHeight > 0) { "buffer size must be positive" }
    require(rotation == 0 || rotation == 90 || rotation == 180 || rotation == 270) { "unsupported rotation $rotation" }
    require(nv21.size >= bufferWidth * bufferHeight) { "luma plane is shorter than the frame" }
  }

  val width: Int = if (rotation % 180 == 0) bufferWidth else bufferHeight
  val height: Int = if (rotation % 180 == 0) bufferHeight else bufferWidth

  fun at(x: Int, y: Int): Int {
    val ux = x.coerceIn(0, width - 1)
    val uy = y.coerceIn(0, height - 1)
    return nv21[bufferIndex(ux, uy)].toInt() and 0xff
  }

  /** Buffer index of upright pixel ([ux], [uy]); the inverse of [Nv21Ops.uprightIndex]. */
  fun bufferIndex(ux: Int, uy: Int): Int = when (rotation) {
    0 -> uy * bufferWidth + ux
    90 -> (bufferHeight - 1 - ux) * bufferWidth + uy
    180 -> (bufferHeight - 1 - uy) * bufferWidth + (bufferWidth - 1 - ux)
    else -> ux * bufferWidth + (bufferWidth - 1 - uy)
  }
}

/**
 * Exposure measurements on the cheeks and the nose (`capture-spec-v2` §1 row
 * 11; definitions fixed cross-platform in `docs/client-native-interface.md`
 * §5.4, identical to the iOS implementation).
 *
 * Three square patches of side 0.15 x the 234-454 face width, centred on
 * landmarks 205, 425 and 4, read on a grid of about 24 samples per side.
 * Clip and crush are the fractions of samples with luma >= 250 / <= 5, pooled
 * over the three patches; the cheek ratio is mean luma(205) / mean luma(425).
 * In the upright, non-mirrored frame landmark 205 is the subject's right
 * cheek, on the image's left (the contract calls it the "left" patch). There
 * is deliberately no mean-brightness rule (it rejects dark skin first).
 */
internal object LightMetrics {
  /** Luma at or above this is counted as clipped. */
  const val CLIP_LUMA_MIN = 250
  /** Luma at or below this is counted as crushed. */
  const val CRUSH_LUMA_MAX = 5
  /** Patch side, as a fraction of the 234-454 face width. */
  const val PATCH_SIDE_FRAC = 0.15
  /** Grid samples per patch side, about. */
  const val SAMPLES_PER_SIDE = 24
  /** Fewer samples than this and a patch is not measurable. */
  const val MIN_SAMPLES = 16

  data class Result(val clipFrac: Double?, val crushFrac: Double?, val cheekRatio: Double?)

  private class Patch {
    var count = 0
    var sum = 0.0
    var clipped = 0
    var crushed = 0
  }

  /** Centres are upright delivered-frame pixel coordinates `(x, y)`. */
  fun measure(
    luma: UprightLuma,
    cheek205: Pair<Double, Double>,
    cheek425: Pair<Double, Double>,
    nose4: Pair<Double, Double>,
    faceWidthPx: Double,
  ): Result {
    if (!faceWidthPx.isFinite() || faceWidthPx <= 0) return Result(null, null, null)
    val half = PATCH_SIDE_FRAC / 2.0 * faceWidthPx
    val left = patch(luma, cheek205, half) ?: return Result(null, null, null)
    val right = patch(luma, cheek425, half) ?: return Result(null, null, null)
    val nose = patch(luma, nose4, half) ?: return Result(null, null, null)
    val total = (left.count + right.count + nose.count).toDouble()
    val rightMean = right.sum / right.count
    val ratio = if (rightMean > 0) (left.sum / left.count) / rightMean else Double.NaN
    return Result(
      clipFrac = (left.clipped + right.clipped + nose.clipped) / total,
      crushFrac = (left.crushed + right.crushed + nose.crushed) / total,
      cheekRatio = if (ratio.isFinite()) ratio else null,
    )
  }

  private fun patch(luma: UprightLuma, centre: Pair<Double, Double>, half: Double): Patch? {
    val (cx, cy) = centre
    if (!cx.isFinite() || !cy.isFinite()) return null
    val x0 = max(0, floor(cx - half).toInt())
    val x1 = min(luma.width - 1, ceil(cx + half).toInt())
    val y0 = max(0, floor(cy - half).toInt())
    val y1 = min(luma.height - 1, ceil(cy + half).toInt())
    if (x1 <= x0 || y1 <= y0) return null
    val step = max(1, (x1 - x0) / SAMPLES_PER_SIDE)
    val out = Patch()
    var y = y0
    while (y <= y1) {
      var x = x0
      while (x <= x1) {
        val value = luma.at(x, y)
        out.count++
        out.sum += value
        if (value >= CLIP_LUMA_MIN) out.clipped++
        if (value <= CRUSH_LUMA_MAX) out.crushed++
        x += step
      }
      y += step
    }
    return if (out.count >= MIN_SAMPLES) out else null
  }
}

/**
 * Contrast-normalised Laplacian energy of the central face region
 * (`docs/client-native-interface.md` §5.3, identical to the iOS
 * implementation): the central half of the landmark face box (box centre
 * +/- a quarter of its width and height), read on a grid about 128 samples
 * wide so the value does not depend on stream size, 4-neighbour Laplacian at
 * the grid step, `var(laplacian) / var(intensity)`.
 *
 * The ratio is invariant to an affine change of intensity, so it compares
 * frames under different exposure. The burst rule is relative to the
 * sharpest candidate (A7.78-B); there is no absolute floor.
 */
internal object Sharpness {
  const val GRID_SAMPLES = 128
  const val MIN_SAMPLES = 64

  /**
   * @param faceBox normalised upright `[x, y, w, h]` of the landmark bounding box.
   * @return the sharpness, or null if the region is not measurable.
   */
  fun measure(luma: UprightLuma, faceBox: DoubleArray): Double? {
    if (faceBox.size != 4 || faceBox.any { !it.isFinite() }) return null
    val width = luma.width
    val height = luma.height
    val centreX = (faceBox[0] + faceBox[2] / 2) * width
    val centreY = (faceBox[1] + faceBox[3] / 2) * height
    val halfW = faceBox[2] * width / 4
    val halfH = faceBox[3] * height / 4
    val x0 = max(0, (centreX - halfW).toInt())
    val x1 = min(width - 1, (centreX + halfW).toInt())
    val y0 = max(0, (centreY - halfH).toInt())
    val y1 = min(height - 1, (centreY + halfH).toInt())
    if (x1 <= x0 || y1 <= y0) return null
    val step = max(1, (x1 - x0) / GRID_SAMPLES)
    var count = 0.0
    var lapSum = 0.0
    var lapSquares = 0.0
    var sum = 0.0
    var squares = 0.0
    var y = y0 + step
    while (y < y1 - step) {
      var x = x0 + step
      while (x < x1 - step) {
        val c = luma.at(x, y).toDouble()
        val laplacian = 4 * c - luma.at(x - step, y) - luma.at(x + step, y) - luma.at(x, y - step) - luma.at(x, y + step)
        lapSum += laplacian
        lapSquares += laplacian * laplacian
        sum += c
        squares += c * c
        count += 1
        x += step
      }
      y += step
    }
    if (count < MIN_SAMPLES) return null
    val lapVariance = lapSquares / count - (lapSum / count) * (lapSum / count)
    val variance = squares / count - (sum / count) * (sum / count)
    if (variance <= 1e-9 || lapVariance < 0) return null
    val result = lapVariance / variance
    return if (result.isFinite()) result else null
  }
}

/** NV21 conversions: upright rotation for the stored JPEG, and the downscaled upright ARGB copy MediaPipe reads. */
internal object Nv21Ops {

  fun byteCount(width: Int, height: Int): Int = width * height + 2 * ((width / 2) * (height / 2))

  /** Upright index of buffer pixel ([x], [y]) for a clockwise [rotation]. */
  fun uprightIndex(x: Int, y: Int, rotation: Int, bufferWidth: Int, bufferHeight: Int, uprightWidth: Int): Int =
    when (rotation) {
      0 -> y * uprightWidth + x
      90 -> x * uprightWidth + (bufferHeight - 1 - y)
      180 -> (bufferHeight - 1 - y) * uprightWidth + (bufferWidth - 1 - x)
      270 -> (bufferWidth - 1 - x) * uprightWidth + y
      else -> throw IllegalArgumentException("unsupported rotation $rotation")
    }

  /**
   * Writes [src] (NV21, [width] x [height], sensor orientation) into [dst] as
   * an upright NV21 image. No mirroring: the stored frame shows the subject's
   * real left on the image right, exactly as another camera would.
   */
  fun rotate(src: ByteArray, width: Int, height: Int, rotation: Int, dst: ByteArray) {
    require(width % 2 == 0 && height % 2 == 0) { "4:2:0 requires even dimensions" }
    val needed = byteCount(width, height)
    require(src.size >= needed && dst.size >= needed) { "buffers are smaller than the frame" }
    if (rotation == 0) {
      System.arraycopy(src, 0, dst, 0, needed)
      return
    }
    val uprightWidth = if (rotation % 180 == 0) width else height
    for (y in 0 until height) {
      val row = y * width
      for (x in 0 until width) {
        dst[uprightIndex(x, y, rotation, width, height, uprightWidth)] = src[row + x]
      }
    }
    val chromaWidth = width / 2
    val chromaHeight = height / 2
    val uprightChromaWidth = uprightWidth / 2
    val srcBase = width * height
    for (cy in 0 until chromaHeight) {
      for (cx in 0 until chromaWidth) {
        val source = srcBase + cy * width + cx * 2
        val target = srcBase + 2 * uprightIndex(cx, cy, rotation, chromaWidth, chromaHeight, uprightChromaWidth)
        dst[target] = src[source]
        dst[target + 1] = src[source + 1]
      }
    }
  }

  /**
   * Upright size of the copy MediaPipe reads (contract §5.15): the long side
   * becomes [maxLongSide] with the aspect ratio kept, each side rounded to the
   * nearest pixel; a frame already that small is used at its own size (never
   * upscaled). The same rule as iOS `downscaledCopy(of:)`.
   */
  fun analysisSize(uprightWidth: Int, uprightHeight: Int, maxLongSide: Int): PixelSize {
    require(uprightWidth > 0 && uprightHeight > 0 && maxLongSide > 0) { "sizes must be positive" }
    val longSide = max(uprightWidth, uprightHeight)
    if (longSide <= maxLongSide) return PixelSize(uprightWidth, uprightHeight)
    val scale = maxLongSide.toDouble() / longSide
    return PixelSize(
      max(1, Math.round(uprightWidth * scale).toInt()),
      max(1, Math.round(uprightHeight * scale).toInt()),
    )
  }

  /**
   * Upright ARGB_8888 pixels of [src] at [outUpright] (from [analysisSize]),
   * for the landmarker.
   *
   * Area resampling: output pixel i along an axis covers buffer pixels
   * `[i * size / outSize, (i + 1) * size / outSize)` (at least one), whose luma
   * is averaged; the chroma is that of the box centre. Full-range BT.601, the
   * inverse of what JPEG/JFIF and camera YUV use. The boxes tile the whole
   * frame, so a normalised coordinate on the output is the same normalised
   * coordinate on the full upright frame (no re-scaling of landmarks).
   */
  fun toUprightArgbScaled(src: ByteArray, width: Int, height: Int, rotation: Int, outUpright: PixelSize, out: IntArray): PixelSize {
    require(rotation == 0 || rotation == 90 || rotation == 180 || rotation == 270) { "unsupported rotation $rotation" }
    val uprightW = if (rotation % 180 == 0) width else height
    val uprightH = if (rotation % 180 == 0) height else width
    require(outUpright.width in 1..uprightW && outUpright.height in 1..uprightH) { "the copy is never larger than the frame" }
    require(src.size >= byteCount(width, height)) { "buffer is smaller than the frame" }
    // Output size in buffer (sensor) orientation.
    val ow = if (rotation % 180 == 0) outUpright.width else outUpright.height
    val oh = if (rotation % 180 == 0) outUpright.height else outUpright.width
    require(out.size >= ow * oh) { "output holds ${out.size} pixels, needs ${ow * oh}" }
    val xEdge = IntArray(ow + 1) { i -> (i.toLong() * width / ow).toInt() }
    val yEdge = IntArray(oh + 1) { i -> (i.toLong() * height / oh).toInt() }
    val chromaBase = width * height
    for (oy in 0 until oh) {
      val y0 = yEdge[oy]
      val y1 = max(y0 + 1, yEdge[oy + 1])
      for (ox in 0 until ow) {
        val x0 = xEdge[ox]
        val x1 = max(x0 + 1, xEdge[ox + 1])
        var sum = 0
        for (y in y0 until y1) {
          val row = y * width
          for (x in x0 until x1) sum += src[row + x].toInt() and 0xff
        }
        val n = (y1 - y0) * (x1 - x0)
        val luma = (sum + n / 2) / n
        val cx = (x0 + x1 - 1) / 2
        val cy = (y0 + y1 - 1) / 2
        val chroma = chromaBase + (cy / 2) * width + (cx / 2) * 2
        val v = (src[chroma].toInt() and 0xff) - 128
        val u = (src[chroma + 1].toInt() and 0xff) - 128
        val r = luma + ((91881 * v) shr 16)
        val g = luma - ((22554 * u + 46802 * v) shr 16)
        val b2 = luma + ((116130 * u) shr 16)
        out[uprightIndex(ox, oy, rotation, ow, oh, outUpright.width)] =
          (0xFF shl 24) or (clamp(r) shl 16) or (clamp(g) shl 8) or clamp(b2)
      }
    }
    return outUpright
  }

  private fun clamp(value: Int): Int = if (value < 0) 0 else if (value > 255) 255 else value
}
