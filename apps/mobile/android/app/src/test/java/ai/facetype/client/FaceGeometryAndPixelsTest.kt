package ai.facetype.client

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FaceGeometryAndPixelsTest {

  // ---- pose ---------------------------------------------------------------

  @Test
  fun `pose is recovered from the transformation matrix, scale removed`() {
    for ((yaw, pitch, roll) in listOf(Triple(0.0, 0.0, 0.0), Triple(7.5, -4.0, 2.0), Triple(-20.0, 11.0, -15.0))) {
      val m = FaceGeometryCalc.transformFromPose(yaw, pitch, roll, scale = 3.7)
      val pose = FaceGeometryCalc.poseDegrees(m)!!
      assertEquals(yaw, pose[0], 1e-4)
      assertEquals(pitch, pose[1], 1e-4)
      assertEquals(roll, pose[2], 1e-4)
    }
    assertNull(FaceGeometryCalc.poseDegrees(FloatArray(16)))
    assertNull(FaceGeometryCalc.poseDegrees(FloatArray(9)))
  }

  @Test
  fun `a hand-written column-major MediaPipe matrix gives the known rotation`() {
    val c = Math.cos(Math.toRadians(30.0)).toFloat()
    val sn = Math.sin(Math.toRadians(30.0)).toFloat()
    // Ry(30 deg), translation (1.5, -2, -45): element (r, c) at data[c * 4 + r].
    val yaw30 = floatArrayOf(
      c, 0f, -sn, 0f, // column 0
      0f, 1f, 0f, 0f, // column 1
      sn, 0f, c, 0f, // column 2
      1.5f, -2f, -45f, 1f, // column 3: translation
    )
    val pose = FaceGeometryCalc.poseDegrees(yaw30)!!
    assertEquals(30.0, pose[0], 1e-4)
    assertEquals(0.0, pose[1], 1e-4)
    assertEquals(0.0, pose[2], 1e-4)
    // Rx(10 deg): positive pitch.
    val c10 = Math.cos(Math.toRadians(10.0)).toFloat()
    val s10 = Math.sin(Math.toRadians(10.0)).toFloat()
    val pitch10 = floatArrayOf(1f, 0f, 0f, 0f, 0f, c10, s10, 0f, 0f, -s10, c10, 0f, 0f, 0f, -50f, 1f)
    assertEquals(10.0, FaceGeometryCalc.poseDegrees(pitch10)!![1], 1e-4)
    // The same matrix row-major (translation in the bottom row) is refused.
    val rowMajor = FloatArray(16) { i -> yaw30[(i % 4) * 4 + i / 4] }
    assertNull(FaceGeometryCalc.poseDegrees(rowMajor))
  }

  // ---- landmark geometry ----------------------------------------------------

  private fun syntheticLandmarks(): FloatArray {
    val lm = FloatArray(FaceLandmarkIndex.COUNT * 3)
    // Every point at the face centre unless set below.
    for (i in 0 until FaceLandmarkIndex.COUNT) {
      lm[i * 3] = 0.5f
      lm[i * 3 + 1] = 0.5f
    }
    fun set(i: Int, x: Double, y: Double) {
      lm[i * 3] = x.toFloat()
      lm[i * 3 + 1] = y.toFloat()
    }
    // Frame 1000 x 2000 px. Face width 234..454: 0.3..0.7 of 1000 px = 400 px.
    set(FaceLandmarkIndex.FACE_WIDTH_A, 0.3, 0.5)
    set(FaceLandmarkIndex.FACE_WIDTH_B, 0.7, 0.5)
    // Box extremes.
    set(10, 0.5, 0.35)
    set(152, 0.5, 0.65)
    // Iris centres 180 px apart, at y = 0.45.
    set(FaceLandmarkIndex.RIGHT_IRIS_CENTRE, 0.41, 0.45)
    set(FaceLandmarkIndex.LEFT_IRIS_CENTRE, 0.59, 0.45)
    // Iris contours: 12 px diameter on both axes.
    for ((centre, contour) in listOf(
      0.41 to FaceLandmarkIndex.RIGHT_IRIS_CONTOUR,
      0.59 to FaceLandmarkIndex.LEFT_IRIS_CONTOUR,
    )) {
      set(contour[0], centre + 0.006, 0.45)
      set(contour[1], centre, 0.45 - 0.003)
      set(contour[2], centre - 0.006, 0.45)
      set(contour[3], centre, 0.45 + 0.003)
    }
    // Right eye 60 px wide, lids 18 px apart -> opening 0.3.
    set(FaceLandmarkIndex.RIGHT_EYE_OUTER, 0.38, 0.45)
    set(FaceLandmarkIndex.RIGHT_EYE_INNER, 0.44, 0.45)
    set(FaceLandmarkIndex.RIGHT_EYE_UPPER, 0.41, 0.4455)
    set(FaceLandmarkIndex.RIGHT_EYE_LOWER, 0.41, 0.4545)
    // Left eye 60 px wide, lids 12 px apart -> opening 0.2.
    set(FaceLandmarkIndex.LEFT_EYE_INNER, 0.56, 0.45)
    set(FaceLandmarkIndex.LEFT_EYE_OUTER, 0.62, 0.45)
    set(FaceLandmarkIndex.LEFT_EYE_UPPER, 0.59, 0.447)
    set(FaceLandmarkIndex.LEFT_EYE_LOWER, 0.59, 0.453)
    return lm
  }

  @Test
  fun `pixel quantities are in delivered pixels of the upright frame`() {
    val g = FaceGeometryCalc.compute(syntheticLandmarks(), 1000, 2000, FaceGeometryCalc.transformFromPose(3.0, -2.0, 1.0))
    assertEquals(400.0, g.faceWidthPx!!, 1e-3)
    assertEquals(180.0, g.interPupilPx!!, 1e-3)
    assertEquals(12.0, g.irisDiameterPx!!, 1e-3)
    assertEquals(0.5, g.eyeMidX!!, 1e-6)
    assertEquals(0.5, g.faceCentreY!!, 1e-6)
    assertArrayEquals(doubleArrayOf(0.3, 0.35, 0.4, 0.3), g.faceBox!!, 1e-6)
    assertArrayEquals(doubleArrayOf(300.0, 700.0, 700.0, 1300.0), g.faceBoxPx!!, 1e-3)
    assertEquals(0.3, g.eyeOpeningR!!, 1e-3)
    assertEquals(0.2, g.eyeOpeningL!!, 1e-3)
    assertEquals(3.0, g.yawDeg!!, 1e-4)
  }

  @Test
  fun `non-finite or short landmark lists measure nothing`() {
    val lm = syntheticLandmarks()
    lm[5] = Float.NaN
    val g = FaceGeometryCalc.compute(lm, 1000, 2000, null)
    assertNull(g.faceWidthPx)
    assertNull(g.faceBox)
    assertNull(g.yawDeg)
    assertNull(FaceGeometryCalc.compute(FloatArray(468 * 3), 1000, 2000, null).interPupilPx)
  }

  // ---- upright mapping and NV21 -------------------------------------------

  private fun nv21(width: Int, height: Int): ByteArray {
    val out = ByteArray(Nv21Ops.byteCount(width, height))
    for (i in 0 until width * height) out[i] = ((i * 7 + i / width * 3) and 0xff).toByte()
    for (i in width * height until out.size) out[i] = ((i * 11) and 0xff).toByte()
    return out
  }

  @Test
  fun `upright luma reads are the inverse of the rotation the JPEG gets`() {
    val w = 8
    val h = 6
    val src = nv21(w, h)
    for (rotation in listOf(0, 90, 180, 270)) {
      val upright = ByteArray(src.size)
      Nv21Ops.rotate(src, w, h, rotation, upright)
      val luma = UprightLuma(src, w, h, rotation)
      val uw = luma.width
      for (y in 0 until luma.height) for (x in 0 until uw) {
        assertEquals("rotation $rotation at $x,$y", upright[y * uw + x].toInt() and 0xff, luma.at(x, y))
      }
    }
  }

  @Test
  fun `rotating four quarter turns returns the original NV21 frame, chroma included`() {
    val w = 8
    val h = 6
    val src = nv21(w, h)
    val a = ByteArray(src.size)
    val b = ByteArray(src.size)
    Nv21Ops.rotate(src, w, h, 90, a) // 6 x 8
    Nv21Ops.rotate(a, h, w, 90, b) // 8 x 6, 180 total
    val c = ByteArray(src.size)
    Nv21Ops.rotate(src, w, h, 180, c)
    assertArrayEquals(c, b)
    val d = ByteArray(src.size)
    Nv21Ops.rotate(b, w, h, 180, d)
    assertArrayEquals(src, d)
    // V,U pairs move together (NV21 order is preserved).
    val chroma90 = ByteArray(src.size)
    Nv21Ops.rotate(src, w, h, 90, chroma90)
    val base = w * h
    // Buffer chroma (cx=0, cy=0) lands at upright chroma column (chromaHeight-1-0)=2, row 0.
    assertEquals(src[base], chroma90[base + 2 * 2])
    assertEquals(src[base + 1], chroma90[base + 2 * 2 + 1])
  }

  @Test
  fun `the MediaPipe copy is upright, downscaled, and maps back to the full frame`() {
    val w = 16
    val h = 8
    val src = ByteArray(Nv21Ops.byteCount(w, h)) { 0 }
    // A bright luma pixel block at buffer (12..13, 2..3); chroma neutral.
    for (i in w * h until src.size) src[i] = 128.toByte()
    for (y in 2..3) for (x in 12..13) src[y * w + x] = 200.toByte()
    val small = Nv21Ops.analysisSize(h, w, 8) // upright 8 x 16 -> long side 8
    assertEquals(PixelSize(4, 8), small)
    val out = IntArray(small.width * small.height)
    val size = Nv21Ops.toUprightArgbScaled(src, w, h, 90, small, out)
    assertEquals(small, size)
    // Buffer block (6,1) in the downscaled 8x4 buffer -> upright (4-1-1, 6) = (2, 6).
    val pixel = out[6 * size.width + 2]
    assertEquals(200, (pixel shr 16) and 0xff)
    assertEquals(200, (pixel shr 8) and 0xff)
    assertEquals(200, pixel and 0xff)
    assertEquals(0, out[0] and 0xff)
  }

  @Test
  fun `the analysis copy has a 1280 px long side on every stream size, never upscaled`() {
    val long = ClientCameraSession.MEDIAPIPE_LONG_SIDE
    assertEquals(1280, long)
    // Upright portrait sizes the preferred streams deliver; the iOS rule
    // (scale = 1280 / long side, each side rounded) gives the same numbers.
    assertEquals(PixelSize(720, 1280), Nv21Ops.analysisSize(2160, 3840, long))
    assertEquals(PixelSize(720, 1280), Nv21Ops.analysisSize(1080, 1920, long))
    assertEquals(PixelSize(720, 1280), Nv21Ops.analysisSize(720, 1280, long))
    assertEquals(PixelSize(960, 1280), Nv21Ops.analysisSize(3000, 4000, long))
    assertEquals(PixelSize(1280, 720), Nv21Ops.analysisSize(1920, 1080, long))
    // Smaller than the limit: used as delivered, not enlarged.
    assertEquals(PixelSize(480, 640), Nv21Ops.analysisSize(480, 640, long))
    // A non-integer ratio (1920 -> 1280 is 2/3) still tiles the whole frame:
    // a uniform frame stays uniform and every output pixel is written.
    val w = 1920
    val h = 1080
    val src = ByteArray(Nv21Ops.byteCount(w, h)) { 90 }
    for (i in w * h until src.size) src[i] = 128.toByte()
    val small = Nv21Ops.analysisSize(h, w, long)
    val out = IntArray(small.width * small.height)
    Nv21Ops.toUprightArgbScaled(src, w, h, 90, small, out)
    for (pixel in out) assertEquals(0xFF5A5A5A.toInt(), pixel)
  }

  @Test
  fun `a feature keeps its normalised position in the 1280 copy`() {
    // A bright 30 x 30 square centred at upright (0.25, 0.75) of a 1080 x 1920
    // upright frame (buffer 1920 x 1080, rotation 90) is found at the same
    // normalised place in the 720 x 1280 copy: no landmark re-scaling needed.
    val w = 1920
    val h = 1080
    val src = ByteArray(Nv21Ops.byteCount(w, h))
    for (i in w * h until src.size) src[i] = 128.toByte()
    val uprightW = h
    val uprightH = w
    val ux0 = (0.25 * uprightW).toInt() - 15
    val uy0 = (0.75 * uprightH).toInt() - 15
    for (uy in uy0 until uy0 + 30) for (ux in ux0 until ux0 + 30) {
      // Inverse of rotation 90: upright (ux, uy) <- buffer (x = uy, y = h - 1 - ux).
      src[(h - 1 - ux) * w + uy] = 250.toByte()
    }
    val small = Nv21Ops.analysisSize(uprightW, uprightH, ClientCameraSession.MEDIAPIPE_LONG_SIDE)
    val out = IntArray(small.width * small.height)
    Nv21Ops.toUprightArgbScaled(src, w, h, 90, small, out)
    var sx = 0.0
    var sy = 0.0
    var n = 0
    for (y in 0 until small.height) for (x in 0 until small.width) {
      if ((out[y * small.width + x] and 0xff) > 100) {
        sx += x + 0.5
        sy += y + 0.5
        n += 1
      }
    }
    assertTrue(n > 0)
    assertEquals(0.25, sx / n / small.width, 0.002)
    assertEquals(0.75, sy / n / small.height, 0.002)
  }

  // ---- light ----------------------------------------------------------------

  @Test
  fun `clip and crush count pinned samples and the cheek ratio is 205 over 425`() {
    val w = 200
    val h = 200
    val buffer = ByteArray(Nv21Ops.byteCount(w, h))
    for (y in 0 until h) for (x in 0 until w) {
      buffer[y * w + x] = (if (x < 100) 100 else 200).toByte()
    }
    // Two clipped samples on the nose patch's grid (step 1 for a 15 px patch).
    buffer[100 * w + 98] = 255.toByte()
    buffer[100 * w + 99] = 252.toByte()
    val luma = UprightLuma(buffer, w, h, 0)
    // Face width 100 px -> patch side 15 px; centred on .5, inclusive bounds give 16 x 16 samples.
    val result = LightMetrics.measure(luma, 40.5 to 100.5, 160.5 to 100.5, 99.5 to 100.5, 100.0)
    // 205 sits on the image left (mean 100), 425 on the image right (mean 200).
    assertEquals(0.5, result.cheekRatio!!, 1e-9)
    assertEquals(2.0 / (3 * 16 * 16), result.clipFrac!!, 1e-12)
    assertEquals(0.0, result.crushFrac!!, 0.0)
    val dark = ByteArray(Nv21Ops.byteCount(w, h)) { 3 }
    val crushed = LightMetrics.measure(UprightLuma(dark, w, h, 0), 40.5 to 100.5, 160.5 to 100.5, 99.5 to 100.5, 100.0)
    assertEquals(1.0, crushed.crushFrac!!, 0.0)
    assertEquals(1.0, crushed.cheekRatio!!, 0.0)
    // A patch with too few samples, or no face width, measures nothing.
    assertNull(LightMetrics.measure(luma, 40.5 to 100.5, 160.5 to 100.5, 99.5 to 100.5, 6.0).clipFrac)
    assertNull(LightMetrics.measure(luma, 40.5 to 100.5, 160.5 to 100.5, 99.5 to 100.5, Double.NaN).cheekRatio)
  }

  // ---- sharpness ------------------------------------------------------------

  private fun pattern(size: Int): ByteArray {
    val out = ByteArray(Nv21Ops.byteCount(size, size))
    for (y in 0 until size) for (x in 0 until size) {
      out[y * size + x] = (60 + ((x / 20 + y / 20) % 2) * 130 + (x + 2 * y) % 17).toByte()
    }
    return out
  }

  @Test
  fun `sharpness is the Laplacian variance over the intensity variance on the central face region`() {
    // A face box covering the whole 256 px frame: central half 64..192, step 1.
    val size = 256
    val image = pattern(size)
    val luma = UprightLuma(image, size, size, 0)
    val actual = Sharpness.measure(luma, doubleArrayOf(0.0, 0.0, 1.0, 1.0))!!
    // Direct reference over the same samples.
    var n = 0.0; var ls = 0.0; var lq = 0.0; var vs = 0.0; var vq = 0.0
    for (y in 65 until 191) for (x in 65 until 191) {
      val c = luma.at(x, y).toDouble()
      val lap = 4 * c - luma.at(x - 1, y) - luma.at(x + 1, y) - luma.at(x, y - 1) - luma.at(x, y + 1)
      n++; ls += lap; lq += lap * lap; vs += c; vq += c * c
    }
    val expected = (lq / n - (ls / n) * (ls / n)) / (vq / n - (vs / n) * (vs / n))
    assertEquals(expected, actual, expected * 1e-12)
  }

  @Test
  fun `sharpness is invariant to contrast and drops with blur`() {
    val size = 600
    val base = pattern(size)
    val dimmer = base.copyOf()
    for (i in 0 until size * size) dimmer[i] = (((base[i].toInt() and 0xff) / 2) + 10).toByte()
    val box = doubleArrayOf(0.25, 0.25, 0.5, 0.5)
    val a = Sharpness.measure(UprightLuma(base, size, size, 0), box)!!
    val b = Sharpness.measure(UprightLuma(dimmer, size, size, 0), box)!!
    assertEquals(a, b, a * 0.10)
    val blurred = base.copyOf()
    for (y in 2 until size - 2) for (x in 2 until size - 2) {
      var sum = 0
      for (dy in -2..2) for (dx in -2..2) sum += base[(y + dy) * size + x + dx].toInt() and 0xff
      blurred[y * size + x] = (sum / 25).toByte()
    }
    val c = Sharpness.measure(UprightLuma(blurred, size, size, 0), box)!!
    assertTrue("blurred $c vs sharp $a", c < a * 0.8)
    // A flat region has no contrast to normalise by.
    val flat = ByteArray(Nv21Ops.byteCount(size, size)) { 90 }
    assertNull(Sharpness.measure(UprightLuma(flat, size, size, 0), box))
    assertNull(Sharpness.measure(UprightLuma(base, size, size, 0), doubleArrayOf(0.5, 0.5, 0.01, 0.01)))
  }
}
