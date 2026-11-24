package ai.facetype.client

/**
 * Burst acceptance (`capture-spec-v2` §4; cross-platform rules fixed in
 * `docs/client-native-interface.md` §5 and identical to the iOS
 * `FaceTypeClientBurstRules`), with no Android in it.
 *
 * A frame becomes a CANDIDATE when it passes every per-frame check
 * ([FrameChecks.allPass]) and is at least [candidateSpacingMs] after the
 * previous candidate (sensor timestamps): `max(minSpacingMs,
 * minCoverageMs / (target - 1))`, so `target` consecutive candidates already
 * span the coverage and the burst never encodes more frames than it needs. Its JPEG is encoded and spooled at that
 * moment, from the buffer that was measured. Two rules can only be decided
 * against the burst as a whole and are re-evaluated over all candidates:
 *
 * - eyes: each eye's lid opening >= [minRelativeOpening] x the median opening
 *   of that eye over the burst's candidates (the "valid median");
 * - sharpness: sharpness >= [minRelativeSharpness] x the sharpest candidate.
 *
 * Candidates passing both are SURVIVORS (a candidate failing both is counted
 * under `sharp`, as on iOS). The burst is complete as soon as the selection
 * (see [selection]) holds [target] survivors spanning at least
 * [minCoverageMs]. Dropping a candidate only widens the gaps between the
 * rest, so survivors are always >= [candidateSpacingMs] apart.
 *
 * Single-threaded by contract: the analysis thread owns an instance.
 */
internal class BurstSelector(
  val target: Int,
  val maxDurationMs: Long,
  val minSpacingMs: Long,
  val minCoverageMs: Long,
  val minRelativeOpening: Double,
  val minRelativeSharpness: Double,
  val maxCandidates: Int = target * 4,
) {
  init {
    require(target >= 1) { "target must be positive" }
    require(maxCandidates >= target) { "maxCandidates must be at least target" }
  }

  data class Candidate(
    val id: String,
    val sensorTsNs: Long,
    val sharpness: Double,
    val openingL: Double,
    val openingR: Double,
  )

  /** The relative-rule context a candidate was judged in. */
  data class RelativeVerdict(
    val eyesPass: Boolean,
    val sharpPass: Boolean,
    val medianOpeningL: Double,
    val medianOpeningR: Double,
    val maxSharpness: Double,
  ) {
    val pass: Boolean get() = eyesPass && sharpPass
  }

  data class Selection(
    val selected: List<Candidate>,
    /** Candidates not returned: failed a relative rule, or survivors beyond [target]. */
    val discarded: List<Candidate>,
    val verdicts: Map<String, RelativeVerdict>,
    val coverageMs: Double,
    val complete: Boolean,
  )

  private val candidates = ArrayList<Candidate>()
  private val rejectionCounts = HashMap<String, Int>()
  private var lastCandidateTsNs: Long? = null

  val candidateCount: Int get() = candidates.size

  val isFull: Boolean get() = candidates.size >= maxCandidates

  /** `max(minSpacingMs, minCoverageMs / (target - 1))` (contract §5.6). */
  val candidateSpacingMs: Double =
    if (target > 1) maxOf(minSpacingMs.toDouble(), minCoverageMs.toDouble() / (target - 1)) else minSpacingMs.toDouble()

  /** True when a frame at [sensorTsNs] is far enough from the previous candidate. */
  fun spacingAllows(sensorTsNs: Long): Boolean {
    val last = lastCandidateTsNs ?: return true
    return (sensorTsNs - last) / 1e6 >= candidateSpacingMs
  }

  fun addCandidate(candidate: Candidate) {
    require(!isFull) { "candidate cap reached" }
    require(candidate.sharpness.isFinite() && candidate.openingL.isFinite() && candidate.openingR.isFinite()) {
      "candidates must carry finite relative-rule inputs"
    }
    require(spacingAllows(candidate.sensorTsNs)) { "candidate violates the minimum spacing" }
    candidates.add(candidate)
    lastCandidateTsNs = candidate.sensorTsNs
  }

  /** Counts a rejected frame under its highest-priority failing check. */
  fun recordRejection(reason: String) {
    rejectionCounts[reason] = (rejectionCounts[reason] ?: 0) + 1
  }

  fun verdicts(): Map<String, RelativeVerdict> {
    if (candidates.isEmpty()) return emptyMap()
    val medianL = median(candidates.map { it.openingL })
    val medianR = median(candidates.map { it.openingR })
    val maxSharp = candidates.maxOf { it.sharpness }
    return candidates.associate { c ->
      c.id to RelativeVerdict(
        eyesPass = c.openingL >= minRelativeOpening * medianL && c.openingR >= minRelativeOpening * medianR,
        sharpPass = c.sharpness >= minRelativeSharpness * maxSharp,
        medianOpeningL = medianL,
        medianOpeningR = medianR,
        maxSharpness = maxSharp,
      )
    }
  }

  fun survivors(): List<Candidate> {
    val verdicts = verdicts()
    return candidates.filter { verdicts[it.id]?.pass == true }
  }

  /**
   * The frames to return now. With more than [target] survivors, [target] of
   * them evenly spread over the survivors' time span (first and last always
   * kept), so coverage is the whole span.
   */
  fun selection(): Selection {
    val verdicts = verdicts()
    val alive = candidates.filter { verdicts[it.id]?.pass == true }.sortedBy { it.sensorTsNs }
    val chosen = if (alive.size <= target) alive else spread(alive, target)
    val chosenIds = chosen.map { it.id }.toHashSet()
    val coverage = if (chosen.size >= 2) (chosen.last().sensorTsNs - chosen.first().sensorTsNs) / 1e6 else 0.0
    return Selection(
      selected = chosen,
      discarded = candidates.filter { it.id !in chosenIds },
      verdicts = verdicts,
      coverageMs = coverage,
      complete = chosen.size >= target && coverage >= minCoverageMs,
    )
  }

  fun isComplete(): Boolean = selection().complete

  /** Survivors counted toward the target (for `onBurstProgress.accepted`). */
  fun acceptedCount(): Int = minOf(survivors().size, target)

  /**
   * The most frequent reason a frame was not used. While the burst runs
   * (`onBurstProgress`) this counts per-frame rejections only; the final
   * result ([includeRelative]) also counts the candidates the relative rules
   * dropped (`sharp` before `eyes` when a candidate fails both), as on iOS.
   * Ties go to the earlier entry of [REASON_PRIORITY]. Null when nothing was
   * rejected.
   */
  fun topRejectReason(includeRelative: Boolean = false): String? {
    val counts = HashMap(rejectionCounts)
    if (includeRelative) {
      for (verdict in verdicts().values) {
        if (!verdict.sharpPass) {
          counts[FrameChecks.REASON_SHARP] = (counts[FrameChecks.REASON_SHARP] ?: 0) + 1
        } else if (!verdict.eyesPass) {
          counts[FrameChecks.REASON_EYES] = (counts[FrameChecks.REASON_EYES] ?: 0) + 1
        }
      }
    }
    return topReason(counts)
  }

  fun rejectionCounts(): Map<String, Int> = HashMap(rejectionCounts)

  companion object {
    const val REASON_EFFECTS_ACTIVE = "effects_active"
    const val REASON_INTERNAL = "internal"

    /** `effects_active`, the check names in guidance order, then `internal` (contract §5.9). */
    val REASON_PRIORITY: List<String> = listOf(REASON_EFFECTS_ACTIVE) + FrameChecks.PRIORITY + REASON_INTERNAL

    fun topReason(counts: Map<String, Int>): String? {
      var best: String? = null
      var bestCount = 0
      val ordered = REASON_PRIORITY.filter { it in counts } + counts.keys.filter { it !in REASON_PRIORITY }.sorted()
      for (reason in ordered) {
        val count = counts[reason] ?: 0
        if (count > bestCount) {
          best = reason
          bestCount = count
        }
      }
      return best
    }

    fun median(values: List<Double>): Double {
      require(values.isNotEmpty()) { "median of nothing" }
      val sorted = values.sorted()
      val mid = sorted.size / 2
      return if (sorted.size % 2 == 1) sorted[mid] else (sorted[mid - 1] + sorted[mid]) / 2.0
    }

    /** [count] items of [sorted] at evenly spaced indices, first and last included. */
    fun <T> spread(sorted: List<T>, count: Int): List<T> {
      if (count >= sorted.size) return sorted
      if (count == 1) return listOf(sorted.first())
      val last = sorted.size - 1
      val indices = LinkedHashSet<Int>()
      for (i in 0 until count) indices.add(Math.round(i.toDouble() * last / (count - 1)).toInt())
      return indices.sorted().map { sorted[it] }
    }
  }
}
