package ai.facetype.client

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Android reproduces the shared pose fixtures (contract §5.14):
 * `docs/fixtures/pose_golden.json`, written by `tools/pose_golden.py`, holds
 * column-major MediaPipe-style transforms built as Ry(yaw)·Rx(pitch)·Rz(roll)
 * and the angles the one formula reads back. iOS is held to the same file by
 * `tests/contract/test_ios_client_camera.py`. Synthetic matrices only.
 */
class PoseGoldenTest {

  private fun fixture(): File {
    var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (dir != null) {
      val candidate = File(dir, "docs/fixtures/pose_golden.json")
      if (candidate.isFile) return candidate
      dir = dir.parentFile
    }
    throw AssertionError("docs/fixtures/pose_golden.json not found above ${System.getProperty("user.dir")}")
  }

  @Suppress("UNCHECKED_CAST")
  private fun cases(): Pair<Double, List<Map<String, Any?>>> {
    val root = Json.parse(fixture().readText(Charsets.UTF_8)) as Map<String, Any?>
    assertEquals("facetype-pose-golden-1", root["schema"])
    return (root["tolerance_deg"] as Double) to (root["cases"] as List<Map<String, Any?>>)
  }

  @Test
  fun `every golden matrix gives the golden yaw, pitch and roll to 0_01 degrees`() {
    val (tolerance, cases) = cases()
    assertEquals(0.01, tolerance, 0.0)
    assertTrue("the fixture must hold about twenty cases", cases.size >= 15)
    for (case in cases) {
      val name = case["name"] as String
      @Suppress("UNCHECKED_CAST")
      val data = (case["matrix_column_major"] as List<Double>).map { it.toFloat() }.toFloatArray()
      @Suppress("UNCHECKED_CAST")
      val expected = case["expected_deg"] as Map<String, Double>
      val pose = FaceGeometryCalc.poseDegrees(data)
      assertNotNull(name, pose)
      assertEquals("$name yaw", expected.getValue("yaw"), pose!![0], tolerance)
      assertEquals("$name pitch", expected.getValue("pitch"), pose[1], tolerance)
      assertEquals("$name roll", expected.getValue("roll"), pose[2], tolerance)
    }
  }

  @Test
  fun `the Codex round-2 rotation is (7, 7, 15) here, not the old iOS (4_96, 8_57, 14_94)`() {
    val (_, cases) = cases()
    val case = cases.first { it["name"] == "codex_round2_combined" }
    @Suppress("UNCHECKED_CAST")
    val data = (case["matrix_column_major"] as List<Double>).map { it.toFloat() }.toFloatArray()
    val pose = FaceGeometryCalc.poseDegrees(data)!!
    assertEquals(7.0, pose[0], 0.01)
    assertEquals(7.0, pose[1], 0.01)
    assertEquals(15.0, pose[2], 0.01)
  }

  @Test
  fun `the test helper builds the same matrices the fixture holds`() {
    val (_, cases) = cases()
    for (case in cases) {
      if (case["scale"] != 1.0) continue
      @Suppress("UNCHECKED_CAST")
      val built = case["built_from_deg"] as Map<String, Double>
      @Suppress("UNCHECKED_CAST")
      val data = case["matrix_column_major"] as List<Double>
      val helper = FaceGeometryCalc.transformFromPose(built.getValue("yaw"), built.getValue("pitch"), built.getValue("roll"))
      // Rotation block only (the fixture's translation column may be non-zero).
      for (col in 0 until 3) for (row in 0 until 3) {
        assertEquals("${case["name"]} ($row, $col)", data[col * 4 + row], helper[col * 4 + row].toDouble(), 1e-6)
      }
    }
  }
}
