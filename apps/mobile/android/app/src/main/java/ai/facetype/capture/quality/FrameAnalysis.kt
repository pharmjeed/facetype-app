package ai.facetype.capture.quality

/**
 * Which camera frame a piece of evidence came from.
 *
 * THE BUG THIS TYPE EXISTS TO PREVENT (Codex review of `80925da`, finding 1).
 * The previous design analysed frames continuously and answered a capture from
 * whatever analysis had most recently completed, while reading geometry from
 * the frame that happened to be live. Those are different frames — up to half a
 * second apart — so a scan could pair a sharp, well-exposed measurement with
 * geometry from a moment when the user had already moved. "Same-frame" was
 * asserted in prose and false in code.
 *
 * Every measurement and every mesh now travels attached to one of these, and
 * nothing downstream can combine two pieces of evidence that do not carry the
 * identical identity.
 */
internal data class FrameIdentity(
  /** The analyser generation. A session restart retires everything before it. */
  val generation: Long,
  /** Monotonic within a generation; distinguishes frames sharing a timestamp. */
  val frameId: Long,
  /** ARCore's `Frame.getTimestamp()` for this frame. */
  val frameTimestampNs: Long,
)

/**
 * The face mesh, extracted into plain arrays.
 *
 * ARCore's `AugmentedFace` is valid only until the next `Session.update()`, so
 * geometry is copied out synchronously inside the update cycle that produced it
 * and travels as this — never as a live ARCore object, never across a thread.
 * All lengths are in millimetres and all coordinates are in the same world
 * frame as [headPoseRowMajorMm].
 */
internal class GeometrySnapshot(
  val landmarksMm: FloatArray,
  val textureCoordinates: FloatArray,
  val triangleIndices: IntArray,
  val headPoseRowMajorMm: FloatArray,
  val yawDeg: Double,
  val pitchDeg: Double,
) {
  val vertexCount: Int get() = landmarksMm.size / 3
}

/**
 * One frame's pixels and mesh, handed to the detector as a single unit.
 *
 * [nv21] is owned by this request alone. It is never pooled, reused or handed
 * to a second request: the previous design leased one shared scratch array,
 * which a timeout or an `invalidate()` could zero or re-lease while ML Kit was
 * still reading it (Codex review of `80925da`, finding 2). One buffer per
 * request, freed when that request's callback has fired, is the only ownership
 * rule that cannot be got wrong.
 */
internal class AnalysisRequest(
  val identity: FrameIdentity,
  val width: Int,
  val height: Int,
  val rotationDegrees: Int,
  val nv21: ByteArray,
  val geometry: GeometrySnapshot,
)

/**
 * One frame's expression evidence: the activations, and the score read off them.
 *
 * THEY TRAVEL AS ONE OBJECT ON PURPOSE, for the same reason [FrameIdentity]
 * exists. `neutrality` is not an independent measurement — it is a function of
 * these exact activations — so a result that carried a score in one nullable
 * field and the activations it came from in another would have a representable
 * state where the wire payload reports a neutrality computed from blendshapes
 * it did not also report. Pairing them removes that state rather than
 * documenting it.
 *
 * `null` in place of one of these is the honest unknown: the blendshape pass
 * did not run, did not answer, or answered with something
 * [Neutrality.score] would not score. It reaches both gates as `FT-SCAN-014`.
 */
internal class ExpressionSample(
  /** Every category the model reported, verbatim, for the wire payload. */
  val blendshapes: Map<String, Float>,
  /** [Neutrality.score] over [blendshapes]. Uncalibrated; see ADR-010. */
  val neutrality: Double,
)

/**
 * What one frame turned out to contain.
 *
 * The geometry is carried through rather than re-read, so a result is
 * same-frame by construction: there is no code path that can pair these
 * metrics with a different frame's mesh.
 */
internal class AnalysisResult(
  val identity: FrameIdentity,
  val geometry: GeometrySnapshot,
  /** Faces the detector found. Not ARCore's tracked-face count. */
  val faceCount: Int,
  val blur: Double?,
  val exposure: Double?,
  /** Null when expression could not be measured on this frame. */
  val expression: ExpressionSample? = null,
) {
  /**
   * True when this result can answer a capture.
   *
   * Zero or several faces is *usable* — it is exactly the evidence
   * `FT-SCAN-005`/`FT-SCAN-004` need. Only the single-face case additionally
   * requires both pixel metrics and the expression sample to be present and in
   * range; an unmeasured one is `FT-SCAN-014`, never a default that reads as a
   * passing score.
   *
   * Occlusion is deliberately absent from this list, and from the whole type.
   * Nothing on this platform measures it, so there is no field here to be
   * checked — see ADR-009 and ADR-010. The client and server gates both turn
   * its absence into `FT-SCAN-014` on their own.
   */
  fun isUsable(): Boolean {
    if (faceCount < 0) return false
    if (faceCount != 1) return true
    return inUnitRange(blur) &&
      inUnitRange(exposure) &&
      inUnitRange(expression?.neutrality)
  }

  private fun inUnitRange(value: Double?): Boolean =
    value != null && value.isFinite() && value >= 0.0 && value <= 1.0
}
