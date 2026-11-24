package ai.facetype.client

import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.sqrt

/**
 * Per-frame face geometry from one MediaPipe Face Landmarker result.
 *
 * Inputs are already in the UPRIGHT, NOT MIRRORED delivered frame: landmark x/y
 * are normalised to that frame (0..1) and [FaceGeometryCalc.compute] is told its
 * pixel size, so every pixel quantity here is in full delivered-resolution
 * pixels, never in the downscaled copy MediaPipe was given.
 *
 * Nothing here is smoothed across frames. A value that cannot be computed is
 * `null`, and the checks treat `null` as a failure, never as 0.
 */
internal data class FaceGeometry(
  val yawDeg: Double?,
  val pitchDeg: Double?,
  val rollDeg: Double?,
  /** Iris centre 468 to iris centre 473, delivered px. */
  val interPupilPx: Double?,
  /** Landmark 234 to landmark 454, delivered px (the A7.78-B face-width definition). */
  val faceWidthPx: Double?,
  /** Bounding box of all landmarks, normalised `[x, y, w, h]`. */
  val faceBox: DoubleArray?,
  /** Bounding box of all landmarks in delivered px `[left, top, right, bottom]`. */
  val faceBoxPx: DoubleArray?,
  val eyeMidX: Double?,
  val faceCentreY: Double?,
  /** Mean iris diameter of both eyes, delivered px (horizontal and vertical contour pairs averaged). */
  val irisDiameterPx: Double?,
  /** Lid aperture / eye width, subject's left eye (landmarks 386-374 over 362-263). */
  val eyeOpeningL: Double?,
  /** Lid aperture / eye width, subject's right eye (landmarks 159-145 over 33-133). */
  val eyeOpeningR: Double?,
)

internal object FaceLandmarkIndex {
  const val COUNT = 478
  const val RIGHT_IRIS_CENTRE = 468
  val RIGHT_IRIS_CONTOUR = intArrayOf(469, 470, 471, 472)
  const val LEFT_IRIS_CENTRE = 473
  val LEFT_IRIS_CONTOUR = intArrayOf(474, 475, 476, 477)
  const val FACE_WIDTH_A = 234
  const val FACE_WIDTH_B = 454
  const val RIGHT_EYE_UPPER = 159
  const val RIGHT_EYE_LOWER = 145
  const val RIGHT_EYE_OUTER = 33
  const val RIGHT_EYE_INNER = 133
  const val LEFT_EYE_UPPER = 386
  const val LEFT_EYE_LOWER = 374
  const val LEFT_EYE_INNER = 362
  const val LEFT_EYE_OUTER = 263
  /** Contract "left" cheek patch: the subject's right cheek, on the image's left (upright, not mirrored). */
  const val CHEEK_LEFT = 205
  /** Contract "right" cheek patch: the subject's left cheek, on the image's right. */
  const val CHEEK_RIGHT = 425
  /** Nose tip. */
  const val NOSE_TIP = 4
}

internal object FaceGeometryCalc {

  /**
   * @param landmarks flat `[x, y, z] * n`, normalised to the upright frame.
   * @param width upright delivered frame width in px.
   * @param height upright delivered frame height in px.
   * @param transform MediaPipe facial transformation matrix, column-major 4x4, or null.
   */
  fun compute(landmarks: FloatArray, width: Int, height: Int, transform: FloatArray?): FaceGeometry {
    require(width > 0 && height > 0) { "frame size must be positive" }
    val count = landmarks.size / 3
    val usable = count >= FaceLandmarkIndex.COUNT && allFinite(landmarks)
    val pose = transform?.let { poseDegrees(it) }
    if (!usable) {
      return FaceGeometry(
        yawDeg = pose?.get(0), pitchDeg = pose?.get(1), rollDeg = pose?.get(2),
        interPupilPx = null, faceWidthPx = null, faceBox = null, faceBoxPx = null,
        eyeMidX = null, faceCentreY = null, irisDiameterPx = null, eyeOpeningL = null, eyeOpeningR = null,
      )
    }
    fun px(index: Int): Double = landmarks[index * 3].toDouble() * width
    fun py(index: Int): Double = landmarks[index * 3 + 1].toDouble() * height
    fun distance(a: Int, b: Int): Double = hypot(px(a) - px(b), py(a) - py(b))

    var minX = Double.POSITIVE_INFINITY
    var minY = Double.POSITIVE_INFINITY
    var maxX = Double.NEGATIVE_INFINITY
    var maxY = Double.NEGATIVE_INFINITY
    for (i in 0 until count) {
      val x = landmarks[i * 3].toDouble()
      val y = landmarks[i * 3 + 1].toDouble()
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }

    val interPupil = distance(FaceLandmarkIndex.RIGHT_IRIS_CENTRE, FaceLandmarkIndex.LEFT_IRIS_CENTRE)
    val faceWidth = distance(FaceLandmarkIndex.FACE_WIDTH_A, FaceLandmarkIndex.FACE_WIDTH_B)
    val eyeMidX = (landmarks[FaceLandmarkIndex.RIGHT_IRIS_CENTRE * 3].toDouble() +
      landmarks[FaceLandmarkIndex.LEFT_IRIS_CENTRE * 3].toDouble()) / 2.0

    // MediaPipe's own iris-to-depth step averages the two contour diameters of
    // each iris; averaging both eyes halves the per-eye regression noise.
    fun irisDiameter(contour: IntArray): Double =
      (distance(contour[0], contour[2]) + distance(contour[1], contour[3])) / 2.0
    val iris = (irisDiameter(FaceLandmarkIndex.RIGHT_IRIS_CONTOUR) +
      irisDiameter(FaceLandmarkIndex.LEFT_IRIS_CONTOUR)) / 2.0

    fun opening(upper: Int, lower: Int, cornerA: Int, cornerB: Int): Double? {
      val eyeWidth = distance(cornerA, cornerB)
      if (eyeWidth <= 0.0) return null
      return distance(upper, lower) / eyeWidth
    }

    return FaceGeometry(
      yawDeg = pose?.get(0),
      pitchDeg = pose?.get(1),
      rollDeg = pose?.get(2),
      interPupilPx = finiteOrNull(interPupil),
      faceWidthPx = finiteOrNull(faceWidth),
      faceBox = doubleArrayOf(minX, minY, maxX - minX, maxY - minY),
      faceBoxPx = doubleArrayOf(minX * width, minY * height, maxX * width, maxY * height),
      eyeMidX = finiteOrNull(eyeMidX),
      faceCentreY = finiteOrNull((minY + maxY) / 2.0),
      irisDiameterPx = finiteOrNull(iris)?.takeIf { it > 0.0 },
      eyeOpeningL = opening(
        FaceLandmarkIndex.LEFT_EYE_UPPER, FaceLandmarkIndex.LEFT_EYE_LOWER,
        FaceLandmarkIndex.LEFT_EYE_INNER, FaceLandmarkIndex.LEFT_EYE_OUTER,
      ),
      eyeOpeningR = opening(
        FaceLandmarkIndex.RIGHT_EYE_UPPER, FaceLandmarkIndex.RIGHT_EYE_LOWER,
        FaceLandmarkIndex.RIGHT_EYE_OUTER, FaceLandmarkIndex.RIGHT_EYE_INNER,
      ),
    )
  }

  /**
   * `[yaw, pitch, roll]` in degrees from MediaPipe's facial transformation
   * matrix (column-major 4x4, canonical face -> camera).
   *
   * THE ONE FORMULA (contract §5.14, identical on iOS). The rotation block is
   * read as R = Ry(yaw) * Rx(pitch) * Rz(roll) after removing any uniform
   * scale (each column is normalised):
   * `yaw = atan2(R[0][2], R[2][2])`, `pitch = asin(clamp(-R[1][2], -1, 1))`,
   * `roll = atan2(R[1][0], R[1][1])` — yaw about the camera's vertical axis,
   * pitch about its horizontal axis, roll about the optical axis. A frontal,
   * upright face gives (0, 0, 0). Only magnitudes are gated; the signs are
   * recorded as computed. Null if the block is degenerate or not finite.
   * `docs/fixtures/pose_golden.json` (from `tools/pose_golden.py`) holds the
   * golden matrices; `PoseGoldenTest` reproduces every one to 0.01°.
   *
   * LAYOUT (contract §5.1). tasks-vision 0.10.35's
   * `FaceLandmarkerResult.create` copies `MatrixData.packed_data` into the
   * float array verbatim (verified in its bytecode: no transpose, no layout
   * read), and MediaPipe writes that proto column-major, so element (r, c) is
   * `data[c * 4 + r]`. The bottom row of an affine transform is (0, 0, 0, 1);
   * a matrix whose packed positions 3, 7, 11, 15 do not read that way is not
   * in the layout assumed here and yields null rather than a wrong pose.
   */
  fun poseDegrees(columnMajor: FloatArray): DoubleArray? {
    if (columnMajor.size != 16) return null
    val bottomRow = abs(columnMajor[3]) + abs(columnMajor[7]) + abs(columnMajor[11])
    if (!bottomRow.isFinite() || bottomRow > 1e-3f || abs(columnMajor[15] - 1f) > 1e-3f) return null
    // r[row][col] = m[col * 4 + row]
    val r = Array(3) { row -> DoubleArray(3) { col -> columnMajor[col * 4 + row].toDouble() } }
    for (col in 0 until 3) {
      val norm = sqrt(r[0][col] * r[0][col] + r[1][col] * r[1][col] + r[2][col] * r[2][col])
      if (!norm.isFinite() || norm < 1e-9) return null
      for (row in 0 until 3) r[row][col] /= norm
    }
    val sinPitch = (-r[1][2]).coerceIn(-1.0, 1.0)
    val pitch = Math.toDegrees(asin(sinPitch))
    val yaw = Math.toDegrees(atan2(r[0][2], r[2][2]))
    val roll = Math.toDegrees(atan2(r[1][0], r[1][1]))
    if (!yaw.isFinite() || !pitch.isFinite() || !roll.isFinite()) return null
    return doubleArrayOf(yaw, pitch, roll)
  }

  /** Builds a column-major transform from R = Ry(yaw) * Rx(pitch) * Rz(roll); test helper and documentation. */
  fun transformFromPose(yawDeg: Double, pitchDeg: Double, rollDeg: Double, scale: Double = 1.0): FloatArray {
    val y = Math.toRadians(yawDeg)
    val p = Math.toRadians(pitchDeg)
    val q = Math.toRadians(rollDeg)
    val cy = Math.cos(y); val sy = Math.sin(y)
    val cp = Math.cos(p); val sp = Math.sin(p)
    val cr = Math.cos(q); val sr = Math.sin(q)
    val r = arrayOf(
      doubleArrayOf(cy * cr + sy * sp * sr, -cy * sr + sy * sp * cr, sy * cp),
      doubleArrayOf(cp * sr, cp * cr, -sp),
      doubleArrayOf(-sy * cr + cy * sp * sr, sy * sr + cy * sp * cr, cy * cp),
    )
    val m = FloatArray(16)
    for (row in 0 until 3) for (col in 0 until 3) m[col * 4 + row] = (r[row][col] * scale).toFloat()
    m[15] = 1f
    return m
  }

  private fun allFinite(values: FloatArray): Boolean {
    for (value in values) if (!value.isFinite()) return false
    return true
  }

  private fun finiteOrNull(value: Double): Double? = if (value.isFinite()) value else null
}
