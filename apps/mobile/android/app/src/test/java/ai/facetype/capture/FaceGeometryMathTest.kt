package ai.facetype.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class FaceGeometryMathTest {

  @Test
  fun `toRowMajorMillimeters transposes and scales only the translation column`() {
    // A column-major identity with a pure translation of 1m on each axis, as
    // ARCore's Pose.toMatrix would write it.
    val columnMajor = floatArrayOf(
      1f, 0f, 0f, 0f,
      0f, 1f, 0f, 0f,
      0f, 0f, 1f, 0f,
      1f, 2f, 3f, 1f,
    )
    val rowMajor = FaceGeometryMath.toRowMajorMillimeters(columnMajor)

    // Rotation/scale block is untouched by the transpose for an identity.
    assertEquals(1f, rowMajor[0], 0f)
    assertEquals(1f, rowMajor[5], 0f)
    assertEquals(1f, rowMajor[10], 0f)
    // Translation lands in column 3 of each row, converted metres -> millimetres.
    assertEquals(1000f, rowMajor[3], 0f)
    assertEquals(2000f, rowMajor[7], 0f)
    assertEquals(3000f, rowMajor[11], 0f)
    // Bottom-right homogeneous 1 is untouched (never scaled as if it were a
    // translation component).
    assertEquals(1f, rowMajor[15], 0f)
  }

  @Test
  fun `toRowMajorMillimeters rejects a non 4x4 input`() {
    assertThrows(IllegalArgumentException::class.java) {
      FaceGeometryMath.toRowMajorMillimeters(FloatArray(12))
    }
  }

  @Test
  fun `yawPitchDegrees reports zero for an axis-aligned identity pose`() {
    val identity = floatArrayOf(
      1f, 0f, 0f, 0f,
      0f, 1f, 0f, 0f,
      0f, 0f, 1f, 0f,
      0f, 0f, 0f, 1f,
    )
    val (yaw, pitch) = FaceGeometryMath.yawPitchDegrees(identity)
    assertEquals(0.0, yaw, 1e-6)
    assertEquals(0.0, pitch, 1e-6)
  }

  @Test
  fun `yawPitchDegrees reports a positive yaw for a head turned toward +x`() {
    // Row-major rotation about Y by +25 degrees: standard rotation-matrix
    // layout, embedded in a row-major 4x4 with no translation.
    val angle = Math.toRadians(25.0)
    val cos = Math.cos(angle).toFloat()
    val sin = Math.sin(angle).toFloat()
    val rotatedY = floatArrayOf(
      cos, 0f, sin, 0f,
      0f, 1f, 0f, 0f,
      -sin, 0f, cos, 0f,
      0f, 0f, 0f, 1f,
    )
    val (yaw, _) = FaceGeometryMath.yawPitchDegrees(rotatedY)
    assertEquals(25.0, yaw, 1e-3)
  }

  /**
   * Row-major rotation about the face frame's X axis by [degrees], embedded in
   * a 4x4 with no translation.
   *
   * ARCore's face centre pose has +Y up and +Z out of the face, so +X points
   * toward the subject's own left. A mathematically POSITIVE rotation about
   * that axis therefore carries the head's up vector (0,1,0) toward +Z -- the
   * top of the head tips forward, i.e. the subject is looking DOWN. A negative
   * rotation raises the chin, i.e. looking UP.
   */
  private fun rotationAboutX(degrees: Double): FloatArray {
    val angle = Math.toRadians(degrees)
    val cos = Math.cos(angle).toFloat()
    val sin = Math.sin(angle).toFloat()
    return floatArrayOf(
      1f, 0f, 0f, 0f,
      0f, cos, -sin, 0f,
      0f, sin, cos, 0f,
      0f, 0f, 0f, 1f,
    )
  }

  @Test
  fun `yawPitchDegrees reports a positive pitch when the chin is raised`() {
    // Chin raised / looking up: the head's up vector (0,1,0) tips backward,
    // away from the camera, which is a -15 degree rotation about +X.
    val (yaw, pitch) = FaceGeometryMath.yawPitchDegrees(rotationAboutX(-15.0))

    assertEquals(0.0, yaw, 1e-3)
    // The frozen protocol's `up_15` stage requires pitch >= 0.
    assertEquals(15.0, pitch, 1e-3)
    assertTrue("up_15 requires a non-negative pitch, got $pitch", pitch >= 0.0)
  }

  @Test
  fun `yawPitchDegrees reports a negative pitch when the chin is lowered`() {
    // Chin lowered / looking down: the head's up vector tips forward, toward
    // the camera, which is a +15 degree rotation about +X.
    val (yaw, pitch) = FaceGeometryMath.yawPitchDegrees(rotationAboutX(15.0))

    assertEquals(0.0, yaw, 1e-3)
    // The frozen protocol's `down_15` stage requires pitch <= 0.
    assertEquals(-15.0, pitch, 1e-3)
    assertTrue("down_15 requires a non-positive pitch, got $pitch", pitch <= 0.0)
  }

  @Test
  fun `yawPitchDegrees lands both vertical stages inside the protocol band`() {
    // packages/contracts/src/quality.ts: vertical_pitch_min_deg = 8.0,
    // vertical_pitch_max_deg = 20.0, applied to |pitch| once the hemisphere
    // check above has passed. Angles across the physical band must stay signed
    // the way the stage asks for.
    //
    // The magnitudes sit just inside the band rather than exactly on 8.0/20.0:
    // the matrix is built in Float32, as ARCore's is, so a recovered angle at
    // an inclusive endpoint carries a few 1e-6 degrees of noise either side of
    // it. That is a property of the matrix, not of the sign under test.
    for (magnitude in listOf(8.5, 15.0, 19.5)) {
      val (_, up) = FaceGeometryMath.yawPitchDegrees(rotationAboutX(-magnitude))
      assertEquals(magnitude, up, 1e-3)
      assertTrue("chin raised at $magnitude deg must satisfy up_15", up >= 8.0 && up <= 20.0)

      val (_, down) = FaceGeometryMath.yawPitchDegrees(rotationAboutX(magnitude))
      assertEquals(-magnitude, down, 1e-3)
      assertTrue(
        "chin lowered at $magnitude deg must satisfy down_15",
        down <= -8.0 && down >= -20.0,
      )
    }
  }

  @Test
  fun `yawPitchDegrees flips the hemisphere the SM-T875 calibration recorded`() {
    // The physical calibration that found this bug reported, with the previous
    // unnegated atan2(r21, r22): chin raised -> -18.48..-21.72 and chin lowered
    // -> +43.22..+45.46, so `up_15` (pitch >= 0) and `down_15` (pitch <= 0)
    // were both unreachable on the device. Those readings pin down the device's
    // own rotations: chin raised was a -18.48 degree rotation about +X, chin
    // lowered a +45.33 degree one. Replay both.
    val (_, raised) = FaceGeometryMath.yawPitchDegrees(rotationAboutX(-18.48))
    assertEquals(18.48, raised, 1e-3)
    assertTrue("chin raised must satisfy up_15's pitch >= 0, got $raised", raised >= 0.0)

    val (_, lowered) = FaceGeometryMath.yawPitchDegrees(rotationAboutX(45.33))
    assertEquals(-45.33, lowered, 1e-3)
    assertTrue("chin lowered must satisfy down_15's pitch <= 0, got $lowered", lowered <= 0.0)
    // Magnitude stays the subject's to get right: 45 degrees overshoots
    // vertical_pitch_max_deg = 20.0 and is still rejected on magnitude rather
    // than silently accepted in the wrong hemisphere.
    assertTrue("45 degrees still overshoots the band", Math.abs(lowered) > 20.0)
  }
}
