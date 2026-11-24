package ai.facetype.capture.quality

/**
 * Turns the copied NV21 frame into the upright ARGB pixels MediaPipe accepts.
 *
 * WHY A CONVERSION AT ALL. ARCore hands out `YUV_420_888`, which [YuvNv21]
 * copies to NV21 because that is one of the two layouts ML Kit's
 * `InputImage.fromByteArray` takes. MediaPipe's vision tasks do not take it:
 * the graph reads an `MPImage` through an RGB(A) extractor, and NV21 is not one
 * of the conversions that extractor performs. Handing it one anyway would fail
 * at the boundary, which is a fail-closed abstention rather than a wrong number
 * — but it is an abstention on every single frame, so the conversion is real
 * work that has to happen somewhere.
 *
 * WHY IT ROTATES HERE INSTEAD OF ASKING MEDIAPIPE TO. `ImageProcessingOptions`
 * has a rotation input, and its sign convention is not the one ML Kit's
 * `InputImage` uses. Two libraries in the same function disagreeing about which
 * way "90 degrees" turns is precisely the class of bug the ROI mapping in
 * [RoiMath] exists to prevent, and it would not fail loudly: the landmarker
 * would simply not find a face in a sideways image, and every capture would
 * abstain in a way indistinguishable from a genuinely unmeasurable frame.
 * Producing an already-upright bitmap removes the second convention entirely.
 *
 * The rotation here is the inverse of [RoiMath.pointToBufferSpace], and
 * `Nv21ArgbTest` asserts that against `RoiMath` itself for every supported
 * rotation, so the two cannot drift.
 */
internal object Nv21Argb {

  /**
   * Converts [nv21] into upright ARGB pixels, lends them to [read], and zeroes
   * them before returning.
   *
   * WHY THE LIFETIME IS A FUNCTION RATHER THAN A CONVENTION (Codex review
   * `2026-08-27T11-58-19Z`). The `IntArray` this allocates is a second,
   * full-resolution copy of the user's face — four bytes per pixel, where the
   * NV21 buffer it came from is one and a half. That NV21 buffer is zeroised
   * the moment its last reader lets go ([FaceQualityAnalyzer]'s ownership
   * count); the ARGB copy was simply dropped on the floor for the collector,
   * so the frame the app had just promised not to keep stayed legible in the
   * heap for an unbounded time — and in any heap dump taken during it. Callers
   * do not get to remember the wipe: they get the pixels for the duration of a
   * call and never hold the reference afterwards.
   *
   * WHY IT IS THE *WHOLE* READ THAT IS SCOPED, not just the conversion. The
   * bitmap MediaPipe is handed is built from these pixels, and zeroing them
   * while the model has that bitmap open is the same defect as zeroing the
   * NV21 buffer under a live reader: it does not throw, it measures a
   * half-zeroed face and reports the number as a quality score. So the wipe is
   * in a `finally` around [read] — after the last thing that can be looking at
   * the array, on the answer path, the abstention path and the throwing path
   * alike.
   *
   * `Nv21ArgbTest` pins both halves: readable throughout the read, zero
   * immediately after it, however the read ended.
   */
  fun <T> withUprightArgb(
    nv21: ByteArray,
    width: Int,
    height: Int,
    rotationDegrees: Int,
    read: (pixels: IntArray, uprightWidth: Int, uprightHeight: Int) -> T,
  ): T {
    val uprightWidth = Nv21Argb.uprightWidth(width, height, rotationDegrees)
    val uprightHeight = Nv21Argb.uprightHeight(width, height, rotationDegrees)
    val pixels = IntArray(uprightWidth * uprightHeight)
    try {
      toUprightArgb(nv21, width, height, rotationDegrees, pixels)
      return read(pixels, uprightWidth, uprightHeight)
    } finally {
      pixels.fill(0)
    }
  }

  /** Width of the upright image [toUprightArgb] writes. */
  fun uprightWidth(bufferWidth: Int, bufferHeight: Int, rotationDegrees: Int): Int =
    RoiMath.rotatedWidth(bufferWidth, bufferHeight, rotationDegrees)

  /** Height of the upright image [toUprightArgb] writes. */
  fun uprightHeight(bufferWidth: Int, bufferHeight: Int, rotationDegrees: Int): Int =
    RoiMath.rotatedHeight(bufferWidth, bufferHeight, rotationDegrees)

  /**
   * Writes [nv21] into [out] as upright, opaque ARGB_8888 pixels.
   *
   * [out] is indexed row-major over the *upright* frame, so its length must be
   * `uprightWidth * uprightHeight`. [rotationDegrees] is the clockwise turn the
   * buffer needs to be upright — the same quantity, from the same source
   * ([MlKitRotation.compensation]), that the detector is given.
   */
  fun toUprightArgb(
    nv21: ByteArray,
    width: Int,
    height: Int,
    rotationDegrees: Int,
    out: IntArray,
  ) {
    require(width > 0 && height > 0) { "image dimensions must be positive" }
    require(width % 2 == 0 && height % 2 == 0) { "4:2:0 requires even dimensions" }
    require(nv21.size >= YuvNv21.byteCount(width, height)) {
      "buffer holds ${nv21.size} bytes, needs ${YuvNv21.byteCount(width, height)}"
    }
    val uprightWidth = uprightWidth(width, height, rotationDegrees)
    val uprightHeight = uprightHeight(width, height, rotationDegrees)
    require(out.size >= uprightWidth * uprightHeight) {
      "destination holds ${out.size} pixels, needs ${uprightWidth * uprightHeight}"
    }

    val chromaBase = width * height
    for (row in 0 until height) {
      val lumaRow = row * width
      // 4:2:0: one interleaved V,U pair per 2x2 luma block.
      val chromaRow = chromaBase + (row / 2) * width
      for (column in 0 until width) {
        val y = nv21[lumaRow + column].toInt() and 0xFF
        val chroma = chromaRow + (column / 2) * 2
        // NV21 is Cr (V) first, then Cb (U) -- the order YuvNv21.convert writes.
        val v = (nv21[chroma].toInt() and 0xFF) - 128
        val u = (nv21[chroma + 1].toInt() and 0xFF) - 128
        // Full-range BT.601, in 16-bit fixed point: 1.402, 0.344136, 0.714136,
        // 1.772. This is the inverse of the matrix Android's own YuvImage uses
        // for NV21, so a face that looked right to the detector looks the same
        // to the landmarker.
        val r = y + ((91881 * v) shr 16)
        val g = y - ((22554 * u + 46802 * v) shr 16)
        val b = y + ((116130 * u) shr 16)
        val pixel = 0xFF000000.toInt() or
          (clampByte(r) shl 16) or
          (clampByte(g) shl 8) or
          clampByte(b)
        out[uprightIndex(column, row, rotationDegrees, width, height, uprightWidth)] = pixel
      }
    }
  }

  /**
   * Where buffer pixel ([x], [y]) lands in the upright frame.
   *
   * The exact inverse of [RoiMath.pointToBufferSpace]. It is written as an
   * index rather than a point so the conversion loop allocates nothing per
   * pixel; a `Pair` here would be one allocation per pixel of every captured
   * frame.
   */
  fun uprightIndex(
    x: Int,
    y: Int,
    rotationDegrees: Int,
    bufferWidth: Int,
    bufferHeight: Int,
    uprightWidth: Int,
  ): Int {
    return when (rotationDegrees) {
      0 -> y * uprightWidth + x
      90 -> x * uprightWidth + (bufferHeight - 1 - y)
      180 -> (bufferHeight - 1 - y) * uprightWidth + (bufferWidth - 1 - x)
      270 -> (bufferWidth - 1 - x) * uprightWidth + y
      else -> throw IllegalArgumentException("unsupported rotation $rotationDegrees")
    }
  }

  private fun clampByte(value: Int): Int = when {
    value < 0 -> 0
    value > 255 -> 255
    else -> value
  }
}
