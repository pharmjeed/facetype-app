package ai.facetype.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BurstSelectorTest {

  private fun selector(target: Int = 10, maxCandidates: Int = 40, minSpacingMs: Long = 66) = BurstSelector(
    target = target,
    maxDurationMs = 8000,
    minSpacingMs = minSpacingMs,
    minCoverageMs = 1000,
    minRelativeOpening = 0.7,
    minRelativeSharpness = 0.5,
    maxCandidates = maxCandidates,
  )

  private var counter = 0

  private fun candidate(ms: Long, sharp: Double = 1.0, openL: Double = 0.3, openR: Double = 0.3) =
    BurstSelector.Candidate("c${counter++}", ms * 1_000_000L, sharp, openL, openR)

  @Test
  fun `candidate spacing is max(minSpacingMs, minCoverageMs over target minus one)`() {
    assertEquals(1000.0 / 9, selector().candidateSpacingMs, 1e-9)
    assertEquals(300.0, selector(minSpacingMs = 300).candidateSpacingMs, 0.0)
    assertEquals(66.0, selector(target = 1).candidateSpacingMs, 0.0)
    val s = selector()
    assertTrue(s.spacingAllows(0))
    s.addCandidate(candidate(0))
    assertFalse(s.spacingAllows(111_000_000L))
    assertTrue(s.spacingAllows(111_200_000L))
    try {
      s.addCandidate(candidate(100))
      throw AssertionError("a too-close candidate was accepted")
    } catch (_: IllegalArgumentException) {
    }
  }

  @Test
  fun `ten spaced candidates already cover one second and complete the burst`() {
    val s = selector()
    for (i in 0 until 9) s.addCandidate(candidate(i * 112L))
    assertFalse(s.isComplete())
    assertEquals(9, s.acceptedCount())
    s.addCandidate(candidate(9 * 112L))
    val selection = s.selection()
    assertTrue(selection.complete)
    assertEquals(10, selection.selected.size)
    assertEquals(1008.0, selection.coverageMs, 1e-9)
    assertTrue(selection.discarded.isEmpty())
  }

  @Test
  fun `with more survivors than target, first and last are kept and spacing only grows`() {
    val s = selector()
    for (i in 0 until 25) s.addCandidate(candidate(i * 120L))
    val selection = s.selection()
    assertEquals(10, selection.selected.size)
    assertEquals(0L, selection.selected.first().sensorTsNs)
    assertEquals(24 * 120_000_000L, selection.selected.last().sensorTsNs)
    assertEquals(15, selection.discarded.size)
    for (i in 1 until selection.selected.size) {
      assertTrue(selection.selected[i].sensorTsNs - selection.selected[i - 1].sensorTsNs >= 111_111_111L)
    }
  }

  @Test
  fun `a closed or narrowed eye is dropped against the candidates' median opening, per eye`() {
    val s = selector(target = 5)
    for (i in 0 until 5) s.addCandidate(candidate(i * 250L, openL = 0.30, openR = 0.30))
    // Right eye at 0.20 < 0.7 x 0.30 = 0.21: one-eye partial closure.
    val squint = candidate(1250, openL = 0.30, openR = 0.20)
    s.addCandidate(squint)
    val verdicts = s.verdicts()
    assertFalse(verdicts.getValue(squint.id).eyesPass)
    assertTrue(verdicts.getValue(squint.id).sharpPass)
    assertEquals(0.30, verdicts.getValue(squint.id).medianOpeningR, 1e-12)
    assertTrue(s.survivors().none { it.id == squint.id })
    // Progress counts per-frame rejections only; the final reason includes the drop.
    assertNull(s.topRejectReason())
    assertEquals(FrameChecks.REASON_EYES, s.topRejectReason(includeRelative = true))

    val ok = selector(target = 1)
    ok.addCandidate(candidate(0, openR = 0.30))
    ok.addCandidate(candidate(200, openR = 0.30))
    val near = candidate(400, openR = 0.22)
    ok.addCandidate(near)
    assertTrue(ok.verdicts().getValue(near.id).eyesPass)
  }

  @Test
  fun `a blurred frame is dropped against the sharpest candidate, with no absolute floor`() {
    val s = selector(target = 3)
    val sharp = candidate(0, sharp = 2.0)
    val half = candidate(500, sharp = 1.0)
    val blurred = candidate(1000, sharp = 0.99)
    listOf(sharp, half, blurred).forEach { s.addCandidate(it) }
    val v = s.verdicts()
    assertTrue(v.getValue(sharp.id).sharpPass)
    assertTrue(v.getValue(half.id).sharpPass)
    assertFalse(v.getValue(blurred.id).sharpPass)
    assertEquals(2.0, v.getValue(blurred.id).maxSharpness, 0.0)
    // All equally soft: all kept.
    val soft = selector(target = 2)
    soft.addCandidate(candidate(0, sharp = 0.01))
    soft.addCandidate(candidate(1000, sharp = 0.011))
    assertTrue(soft.isComplete())
  }

  @Test
  fun `the relative rules are re-applied to the whole candidate set of the call (Codex round 2 A7)`() {
    // Nine soft candidates first, then one ten times sharper: judged against
    // the final burst maximum, the nine early frames fail and the burst is
    // NOT complete -- nothing accepted earlier survives a later, sharper frame.
    val s = selector()
    val soft = (0 until 9).map { candidate(it * 112L, sharp = 1.0) }
    soft.forEach { s.addCandidate(it) }
    val sharp = candidate(9 * 112L, sharp = 100.0)
    s.addCandidate(sharp)
    val selection = s.selection()
    assertFalse(selection.complete)
    assertEquals(listOf(sharp.id), selection.selected.map { it.id })
    assertEquals(soft.map { it.id }.toSet(), selection.discarded.map { it.id }.toSet())
    for (c in soft) assertFalse(selection.verdicts.getValue(c.id).sharpPass)
    assertEquals(FrameChecks.REASON_SHARP, s.topRejectReason(includeRelative = true))
    // A fresh selector (a new startBurst) starts from nothing: no carry-over.
    assertEquals(0, selector().candidateCount)
  }

  @Test
  fun `a candidate failing both relative rules counts as sharp, as on iOS`() {
    val s = selector(target = 3)
    s.addCandidate(candidate(0, sharp = 2.0))
    s.addCandidate(candidate(500, sharp = 2.0))
    s.addCandidate(candidate(1000, sharp = 0.1, openL = 0.01))
    assertEquals(FrameChecks.REASON_SHARP, s.topRejectReason(includeRelative = true))
  }

  @Test
  fun `the top reject reason is the most frequent, ties broken by the contract priority`() {
    val s = selector()
    assertNull(s.topRejectReason())
    repeat(3) { s.recordRejection(FrameChecks.REASON_FACING) }
    repeat(3) { s.recordRejection(FrameChecks.REASON_ONE_FACE) }
    s.recordRejection(FrameChecks.REASON_LIGHT)
    assertEquals(FrameChecks.REASON_ONE_FACE, s.topRejectReason())
    repeat(3) { s.recordRejection(FrameChecks.REASON_LIGHT) }
    assertEquals(FrameChecks.REASON_LIGHT, s.topRejectReason())
    assertEquals(4, s.rejectionCounts()[FrameChecks.REASON_LIGHT])
    assertEquals(
      listOf("effects_active", "oneFace", "distanceOrSize", "centred", "facing", "light", "expression", "eyes", "sharp", "internal"),
      BurstSelector.REASON_PRIORITY,
    )
    assertEquals("effects_active", BurstSelector.topReason(mapOf("internal" to 2, "effects_active" to 2, "sharp" to 2)))
    assertEquals("internal", BurstSelector.topReason(mapOf("internal" to 3, "zzz" to 3)))
  }

  @Test
  fun `fewer than target frames is not complete and keeps what was accepted`() {
    val s = selector()
    for (i in 0 until 4) s.addCandidate(candidate(i * 400L))
    val selection = s.selection()
    assertFalse(selection.complete)
    assertEquals(4, selection.selected.size)
    assertTrue(selection.discarded.isEmpty())
  }

  @Test
  fun `the candidate cap bounds what is spooled`() {
    val s = selector(target = 2, maxCandidates = 3)
    for (i in 0 until 3) s.addCandidate(candidate(i * 1000L))
    assertTrue(s.isFull)
    try {
      s.addCandidate(candidate(5000))
      throw AssertionError("cap ignored")
    } catch (_: IllegalArgumentException) {
    }
  }

  @Test
  fun `spread keeps first and last and picks evenly`() {
    val items = (0 until 11).toList()
    assertEquals(listOf(0, 5, 10), BurstSelector.spread(items, 3))
    assertEquals(items, BurstSelector.spread(items, 11))
    assertEquals(listOf(0), BurstSelector.spread(items, 1))
    assertEquals(10, BurstSelector.spread((0 until 37).toList(), 10).distinct().size)
    assertEquals(2.5, BurstSelector.median(listOf(4.0, 1.0, 2.0, 3.0)), 0.0)
    assertEquals(2.0, BurstSelector.median(listOf(3.0, 1.0, 2.0)), 0.0)
  }

  @Test
  fun `non-finite relative inputs are refused as candidates`() {
    val s = selector()
    try {
      s.addCandidate(candidate(0, sharp = Double.NaN))
      throw AssertionError("NaN accepted")
    } catch (_: IllegalArgumentException) {
    }
  }
}
