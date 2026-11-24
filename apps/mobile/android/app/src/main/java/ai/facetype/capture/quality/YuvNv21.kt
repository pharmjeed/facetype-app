package ai.facetype.capture.quality

import java.nio.ByteBuffer

/**
 * One `YUV_420_888` plane, described exactly the way `android.media.Image.Plane`
 * describes it: a buffer whose *current* `position()` is the first valid byte
 * and whose `limit()` is one past the last, plus the two strides that say how
 * the pixels are laid out inside it.
 *
 * Reproducing those three facts as plain fields (instead of taking an
 * `Image.Plane`) is what lets [YuvNv21] be exercised by a plain JVM unit test:
 * `java.nio.ByteBuffer` is JDK, `android.media.Image` is not.
 */
internal class YuvPlane(
  val buffer: ByteBuffer,
  val rowStride: Int,
  val pixelStride: Int,
) {
  /**
   * `Image.Plane.getBuffer()` documents a buffer positioned at the first
   * valid byte. Android's own implementation happens to hand back position 0
   * today, but a caller that has already read from the buffer -- or a vendor
   * HAL that does not -- would silently shift every pixel if this offset were
   * assumed away.
   */
  val base: Int get() = buffer.position()

  val bound: Int get() = buffer.limit()
}

/**
 * Copies a `YUV_420_888` image into a compact, self-owned NV21 byte array.
 *
 * WHY A COPY AT ALL. ARCore's `Frame.acquireCameraImage()` hands out an
 * `android.media.Image` backed by a small, fixed pool of hardware buffers; the
 * frame stops being produced as soon as that pool is exhausted, so the image
 * has to be closed within the same GL frame that acquired it. Everything the
 * quality analyser needs is therefore copied out synchronously here, and the
 * ARCore-owned `Image`/`ByteBuffer`s are never handed to another thread
 * (Codex M2 requirement E).
 *
 * WHY NV21. It is one of the two byte layouts ML Kit's `InputImage.fromByteArray`
 * accepts, and its luma plane is a dense `width * height` prefix -- which is
 * exactly the buffer [PixelMetrics] wants, at no extra copy.
 *
 * Every read is bounds-checked against the plane's own `limit()`, and every
 * geometric precondition is a `require`, so a device that reports a layout
 * this code does not understand fails closed (no sample is published, capture
 * reports `FT-SCAN-014`) instead of publishing metrics computed from garbage.
 */
internal object YuvNv21 {

  /** Bytes an NV21 image of these dimensions occupies. */
  fun byteCount(width: Int, height: Int): Int {
    require(width > 0 && height > 0) { "image dimensions must be positive" }
    require(width % 2 == 0 && height % 2 == 0) { "4:2:0 requires even dimensions" }
    return width * height + 2 * ((width / 2) * (height / 2))
  }

  /**
   * Writes the `cropWidth x cropHeight` region at (`cropLeft`, `cropTop`) of
   * the supplied planes into [out] as NV21.
   *
   * The crop rectangle is `Image.getCropRect()`: the sub-rectangle of the
   * padded, stride-aligned planes that actually holds picture. Ignoring it is
   * how a 1920-wide buffer holding a 1912-wide image ends up with a column of
   * alignment padding fed to a face detector as if it were pixels.
   */
  fun convert(
    y: YuvPlane,
    u: YuvPlane,
    v: YuvPlane,
    cropLeft: Int,
    cropTop: Int,
    cropWidth: Int,
    cropHeight: Int,
    out: ByteArray,
  ) {
    require(cropLeft >= 0 && cropTop >= 0) { "crop origin must be non-negative" }
    // An odd origin would put the luma and chroma grids out of phase: chroma
    // is subsampled on even coordinates, so a crop that starts on an odd
    // column has no exact 4:2:0 representation.
    require(cropLeft % 2 == 0 && cropTop % 2 == 0) { "crop origin must be even" }
    val needed = byteCount(cropWidth, cropHeight)
    require(out.size >= needed) { "destination holds ${out.size} bytes, needs $needed" }
    require(y.pixelStride >= 1 && u.pixelStride >= 1 && v.pixelStride >= 1) {
      "pixel stride must be at least one byte"
    }

    var destination = 0
    for (row in 0 until cropHeight) {
      val rowStart = y.base + (cropTop + row) * y.rowStride + cropLeft * y.pixelStride
      if (y.pixelStride == 1) {
        // Dense row: one bulk copy instead of `cropWidth` absolute gets.
        requireReadable(y, rowStart, cropWidth)
        val cursor = y.buffer.duplicate()
        cursor.position(rowStart)
        cursor.get(out, destination, cropWidth)
      } else {
        for (column in 0 until cropWidth) {
          out[destination + column] = read(y, rowStart + column * y.pixelStride)
        }
      }
      destination += cropWidth
    }

    val chromaWidth = cropWidth / 2
    val chromaHeight = cropHeight / 2
    val chromaLeft = cropLeft / 2
    val chromaTop = cropTop / 2
    for (row in 0 until chromaHeight) {
      val uRow = u.base + (chromaTop + row) * u.rowStride + chromaLeft * u.pixelStride
      val vRow = v.base + (chromaTop + row) * v.rowStride + chromaLeft * v.pixelStride
      for (column in 0 until chromaWidth) {
        // NV21 interleaves Cr (V) first, then Cb (U). Swapping them is not a
        // crash, it is a colour-shifted image a face detector quietly does
        // worse on, so the order is asserted by test rather than by comment.
        out[destination] = read(v, vRow + column * v.pixelStride)
        out[destination + 1] = read(u, uRow + column * u.pixelStride)
        destination += 2
      }
    }
  }

  private fun read(plane: YuvPlane, index: Int): Byte {
    require(index >= plane.base && index < plane.bound) {
      "plane read at $index is outside [${plane.base}, ${plane.bound})"
    }
    return plane.buffer.get(index)
  }

  private fun requireReadable(plane: YuvPlane, index: Int, length: Int) {
    require(index >= plane.base && index + length <= plane.bound) {
      "plane read of $length bytes at $index is outside [${plane.base}, ${plane.bound})"
    }
  }
}
