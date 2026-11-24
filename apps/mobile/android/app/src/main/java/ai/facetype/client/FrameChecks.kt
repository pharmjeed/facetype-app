package ai.facetype.client

import kotlin.math.abs
import kotlin.math.max

/**
 * Everything one analysed frame measured, unsmoothed, in the upright delivered
 * frame. `null` means "could not be measured" and fails every check that needs
 * it.
 */
internal data class FrameMeasurement(
  /** Faces MediaPipe detected (0, 1 or 2 with `numFaces = 2`). */
  val faces: Int,
  val uprightWidth: Int,
  val uprightHeight: Int,
  val geometry: FaceGeometry?,
  /** True when the effective focal length in delivered pixels is known. */
  val focalKnown: Boolean,
  val distanceCm: Double?,
  val clipFrac: Double?,
  val crushFrac: Double?,
  val cheekRatio: Double?,
  /** `max(mouthSmileLeft, mouthSmileRight)`. */
  val smile: Double?,
  val jawOpen: Double?,
  val blinkL: Double?,
  val blinkR: Double?,
  val sharpness: Double?,
  val gyroDegPerS: Double?,
)

/**
 * The per-frame checks (`docs/client-native-interface.md` §2), each evaluated
 * on this frame alone with the gate config's ENTER limits.
 *
 * Exit limits are hysteresis for the TypeScript guidance and are not used
 * here: a frame that is stored has to satisfy the stricter limit on its own.
 * The two burst-relative rules (eye opening against the burst median,
 * sharpness against the burst's sharpest frame) cannot be decided from one
 * frame; [eyes] and [sharp] here carry only their per-frame parts, and
 * [BurstSelector] applies the relative parts.
 */
internal data class FrameChecks(
  val oneFace: Boolean,
  val distanceOrSize: Boolean,
  val centred: Boolean,
  val facing: Boolean,
  val light: Boolean,
  val expression: Boolean,
  val eyes: Boolean,
  val sharp: Boolean,
) {
  val allPass: Boolean
    get() = oneFace && distanceOrSize && centred && facing && light && expression && eyes && sharp

  /** The highest-priority failing check, in guidance order; null when all pass. */
  fun firstFailure(): String? = when {
    !oneFace -> REASON_ONE_FACE
    !distanceOrSize -> REASON_DISTANCE_OR_SIZE
    !centred -> REASON_CENTRED
    !facing -> REASON_FACING
    !light -> REASON_LIGHT
    !expression -> REASON_EXPRESSION
    !eyes -> REASON_EYES
    !sharp -> REASON_SHARP
    else -> null
  }

  fun toMap(snakeCase: Boolean): Map<String, Any?> = linkedMapOf(
    (if (snakeCase) "one_face" else REASON_ONE_FACE) to oneFace,
    (if (snakeCase) "distance_or_size" else REASON_DISTANCE_OR_SIZE) to distanceOrSize,
    REASON_CENTRED to centred,
    REASON_FACING to facing,
    REASON_LIGHT to light,
    REASON_EXPRESSION to expression,
    REASON_EYES to eyes,
    REASON_SHARP to sharp,
  )

  companion object {
    const val REASON_ONE_FACE = "oneFace"
    const val REASON_DISTANCE_OR_SIZE = "distanceOrSize"
    const val REASON_CENTRED = "centred"
    const val REASON_FACING = "facing"
    const val REASON_LIGHT = "light"
    const val REASON_EXPRESSION = "expression"
    const val REASON_EYES = "eyes"
    const val REASON_SHARP = "sharp"

    /** Guidance priority; ties in reason counts resolve to the earlier entry. */
    val PRIORITY = listOf(
      REASON_ONE_FACE, REASON_DISTANCE_OR_SIZE, REASON_CENTRED, REASON_FACING,
      REASON_LIGHT, REASON_EXPRESSION, REASON_EYES, REASON_SHARP,
    )

    val NONE_PASS = FrameChecks(false, false, false, false, false, false, false, false)
  }
}

internal object FrameCheckEvaluator {

  fun evaluate(m: FrameMeasurement, config: ClientGateConfig): FrameChecks {
    val g = m.geometry
    if (m.faces < 1 || g == null) return FrameChecks.NONE_PASS
    return FrameChecks(
      oneFace = m.faces == 1,
      distanceOrSize = distanceOrSize(m, g, config),
      centred = centred(g, config),
      facing = facing(g, config),
      light = light(m, config),
      expression = expression(m, config),
      eyes = eyesAbsolute(m, g, config),
      sharp = finitePositive(m.sharpness),
    )
  }

  /**
   * Size always (face width 234-454 >= minFaceWidthPx and <= maxFaceWidthFrac
   * of the frame width); distance additionally whenever the focal length is
   * known. With a known focal length an unmeasurable distance fails.
   */
  fun distanceOrSize(m: FrameMeasurement, g: FaceGeometry, config: ClientGateConfig): Boolean {
    val width = g.faceWidthPx ?: return false
    if (!width.isFinite() || m.uprightWidth <= 0) return false
    val sizeOk = width >= config.size.minFaceWidthPx &&
      width / m.uprightWidth <= config.size.maxFaceWidthFrac
    if (!sizeOk) return false
    if (!m.focalKnown) return true
    return config.distance.enterCm.contains(m.distanceCm)
  }

  fun centred(g: FaceGeometry, config: ClientGateConfig): Boolean {
    val box = g.faceBox ?: return false
    if (box.any { !it.isFinite() }) return false
    val margin = config.centre.edgeMarginFrac
    val insideEdges = box[0] >= margin && box[1] >= margin &&
      box[0] + box[2] <= 1.0 - margin && box[1] + box[3] <= 1.0 - margin
    return insideEdges &&
      config.centre.eyeMidX.contains(g.eyeMidX) &&
      config.centre.faceCentreY.contains(g.faceCentreY)
  }

  /** |yaw| and |pitch| within the enter limit; roll is recorded, never gated. */
  fun facing(g: FaceGeometry, config: ClientGateConfig): Boolean {
    val yaw = g.yawDeg ?: return false
    val pitch = g.pitchDeg ?: return false
    if (!yaw.isFinite() || !pitch.isFinite()) return false
    return abs(yaw) <= config.pose.enterDeg && abs(pitch) <= config.pose.enterDeg
  }

  fun light(m: FrameMeasurement, config: ClientGateConfig): Boolean {
    val clip = m.clipFrac ?: return false
    val crush = m.crushFrac ?: return false
    if (!clip.isFinite() || !crush.isFinite()) return false
    return clip <= config.light.maxClipFrac &&
      crush <= config.light.maxCrushFrac &&
      config.light.cheekRatio.contains(m.cheekRatio)
  }

  /** `max(smileL, smileR) <= maxSmile and jawOpen <= maxJawOpen` (research rule, never tuned). */
  fun expression(m: FrameMeasurement, config: ClientGateConfig): Boolean {
    val smile = m.smile ?: return false
    val jaw = m.jawOpen ?: return false
    if (!smile.isFinite() || !jaw.isFinite()) return false
    return smile <= config.expression.maxSmile && jaw <= config.expression.maxJawOpen
  }

  /**
   * Per-frame part of the eye rule: both blink scores finite and at most
   * maxBlink, and both lid openings measurable (the relative rule needs them).
   */
  fun eyesAbsolute(m: FrameMeasurement, g: FaceGeometry, config: ClientGateConfig): Boolean {
    val left = m.blinkL ?: return false
    val right = m.blinkR ?: return false
    if (!left.isFinite() || !right.isFinite()) return false
    if (!finitePositive(g.eyeOpeningL) || !finitePositive(g.eyeOpeningR)) return false
    return left <= config.eyes.maxBlink && right <= config.eyes.maxBlink
  }

  /** `max(a, b)` that is null unless both are finite. */
  fun maxOf(a: Double?, b: Double?): Double? {
    if (a == null || b == null || !a.isFinite() || !b.isFinite()) return null
    return max(a, b)
  }

  private fun finitePositive(value: Double?): Boolean = value != null && value.isFinite() && value > 0.0
}
