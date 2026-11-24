package ai.facetype.capture

import kotlin.math.atan2
import kotlin.math.sqrt

/**
 * Pure ARCore pose-matrix math, factored out of [FaceTypePreviewView] so it
 * is testable under a plain JVM unit test (`testDebugUnitTest`) with no
 * Android framework and no ARCore native library on the classpath.
 */
internal object FaceGeometryMath {

  /**
   * ARCore's `Pose.toMatrix` writes an OpenGL column-major matrix in metres.
   * FTOB/Python is explicitly row-major, and every translation component the
   * wire contract carries shares the landmark unit (millimetres).
   */
  fun toRowMajorMillimeters(columnMajor: FloatArray): FloatArray {
    require(columnMajor.size == 16) { "expected a 4x4 matrix (16 floats)" }
    val rowMajor = FloatArray(16) { index ->
      val row = index / 4
      val column = index % 4
      columnMajor[column * 4 + row]
    }
    rowMajor[3] *= 1000f
    rowMajor[7] *= 1000f
    rowMajor[11] *= 1000f
    return rowMajor
  }

  /**
   * Yaw/pitch, in degrees, from a row-major rigid transform's rotation block,
   * in the sign convention the frozen capture protocol uses: chin raised (the
   * `up_15` stage) is a POSITIVE pitch, chin lowered (`down_15`) is negative.
   *
   * The rotation block is read as the ZYX Tait-Bryan decomposition of the
   * ARCore face centre pose: yaw is the rotation about the frame's Y axis,
   * pitch the rotation about its X axis.
   *
   * The pitch term is negated on purpose. ARCore's face frame has +Y up, +Z
   * out of the face and therefore +X toward the subject's own left, so a
   * mathematically positive rotation about +X tips the top of the head forward
   * -- looking DOWN. Taking `atan2(r21, r22)` unnegated reported the opposite
   * of the protocol on hardware: a physical SM-T875 calibration produced
   * pitchDeg -18.5..-21.7 with the chin raised and +43.2..+45.5 with the chin
   * lowered, which made both `up_15` (requires pitch >= 0) and `down_15`
   * (requires pitch <= 0) unreachable on a real device. The protocol signs and
   * thresholds in `packages/contracts/src/quality.ts` are frozen; the platform
   * measurement is what had to move.
   */
  fun yawPitchDegrees(rowMajor: FloatArray): Pair<Double, Double> {
    require(rowMajor.size == 16) { "expected a 4x4 matrix (16 floats)" }
    val yaw = Math.toDegrees(
      atan2(
        -rowMajor[8].toDouble(),
        sqrt((rowMajor[0] * rowMajor[0] + rowMajor[4] * rowMajor[4]).toDouble()),
      ),
    )
    val pitch = Math.toDegrees(atan2(-rowMajor[9].toDouble(), rowMajor[10].toDouble()))
    return yaw to pitch
  }
}
