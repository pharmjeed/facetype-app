package ai.facetype.capture.quality

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Structural guard for the opt-in capture-quality diagnostic.
 *
 * There are two copies of CaptureQualityDiagnostics under one
 * fully-qualified name: an emitting one in `src/calibration/java` and a
 * silent, empty-bodied one in `src/quiet/java`. Which one a variant compiles
 * is decided by the `sourceSets` block in app/build.gradle -- release always
 * gets the silent copy, and debug only gets the emitting one when the build
 * passed `-PfacetypeCalibrationDiagnostics=true`.
 *
 * WHY IT READS SOURCE INSTEAD OF CALLING CODE. The property under test is
 * which variants the emitting statement is compiled into, and a JVM unit test
 * only ever sees the one variant it was built for -- it cannot observe the
 * other's absence by executing it. The sources and the wiring that selects
 * between them are what carry the guarantee, so they are what is asserted on.
 * The artifact-level half of the check -- whether the log tag is actually in
 * the shipped dex -- lives in tools/build_android_apk.py.
 */
class CaptureQualityDiagnosticsSourceTest {

  private val emittingSource =
    "src/calibration/java/ai/facetype/capture/quality/CaptureQualityDiagnostics.kt"
  private val silentSource =
    "src/quiet/java/ai/facetype/capture/quality/CaptureQualityDiagnostics.kt"

  private val allowedFields =
    listOf("blur", "exposure", "neutrality", "faceCount", "yawDeg", "pitchDeg")

  // Anything in this list, reaching the debug logger, would put biometric-like
  // or identifying data into logcat -- readable by anyone holding the handset
  // (FT-00 treats meshes, geometry and embeddings as sensitive).
  private val forbiddenFields =
    listOf(
      "landmark",
      "textureCoordinates",
      "triangleIndices",
      "headPose",
      "blendshape",
      "categories",
      "nv21",
      "pixels",
      "observationId",
      "sessionId",
      "token",
      "userId",
    )

  private fun source(relative: String): String {
    var dir: File? = File("").absoluteFile
    while (dir != null && !File(dir, "src/main/java/ai/facetype/capture").isDirectory) {
      dir = dir.parentFile
    }
    val file = File(requireNotNull(dir) { "app module root not found" }, relative)
    assertTrue("missing source file: " + relative, file.isFile)
    return file.readText()
  }

  /** Comments discuss the forbidden fields on purpose; only code is asserted on. */
  private fun code(text: String): String =
    text.lines()
      .filterNot { it.trimStart().startsWith("*") || it.trimStart().startsWith("//") }
      .joinToString("\n")
      .replace(Regex("""/\*.*?\*/""", RegexOption.DOT_MATCHES_ALL), "")

  @Test
  fun `the emitting copy logs the six aggregate scores under the agreed tag`() {
    val emitting = code(source(emittingSource))

    assertTrue("the tag must be FaceTypeQuality", emitting.contains("\"FaceTypeQuality\""))
    allowedFields.forEach {
      assertTrue("the emitting copy must log " + it, emitting.contains(it + "="))
    }
  }

  @Test
  fun `the emitting copy names no forbidden field`() {
    val emitting = code(source(emittingSource))

    forbiddenFields.forEach {
      assertTrue(
        "the emitting copy must not reference " + it,
        !emitting.contains(it, ignoreCase = true),
      )
    }
  }

  @Test
  fun `the silent copy emits nothing`() {
    val silent = code(source(silentSource))

    assertTrue("the silent copy must not import a logger", !silent.contains("android.util.Log"))
    assertTrue("the silent copy must not call a logger", !silent.contains("Log."))
    assertTrue("the silent copy must not print", !silent.contains("print"))
    assertTrue(
      "the silent copy must keep the same object name",
      silent.contains("object CaptureQualityDiagnostics"),
    )
    forbiddenFields.forEach {
      assertTrue(
        "the silent copy must not reference " + it,
        !silent.contains(it, ignoreCase = true),
      )
    }
  }

  @Test
  fun `the one call site sits immediately before the promise resolves`() {
    val view = source("src/main/java/ai/facetype/capture/FaceTypePreviewView.kt")
    val calls = Regex("""CaptureQualityDiagnostics\.logAggregate\(""").findAll(view).toList()

    assertTrue("expected exactly one diagnostic call site", calls.size == 1)
    val fromCall = view.substring(calls[0].range.first).replace(Regex("""(?m)^[ \t]+"""), "")

    assertTrue(
      "the diagnostic must sit immediately before request.promise.resolve",
      Regex("""^CaptureQualityDiagnostics\.logAggregate\([^)]*\)\s*request\.promise\.resolve\(""")
        .containsMatchIn(fromCall),
    )
  }

  @Test
  fun `the release source set is wired to the silent copy and nothing else`() {
    val gradle = source("build.gradle")
    val releaseWiring = gradle.lines().filter { it.contains("release.java.srcDirs") }

    assertTrue("the release source set declares no diagnostics wiring", releaseWiring.isNotEmpty())
    releaseWiring.forEach {
      assertTrue("release must be wired to src/quiet/java", it.contains("src/quiet/java"))
      assertTrue("release must never receive the emitting copy", !it.contains("calibration"))
    }
  }

  @Test
  fun `the emitting copy reaches debug only behind the opt-in property`() {
    val gradle = source("build.gradle")
    val debugWiring = gradle.lines().single { it.contains("debug.java.srcDirs") }

    assertTrue(
      "the debug source set must choose on calibrationDiagnostics",
      debugWiring.contains("calibrationDiagnostics ?"),
    )
    assertTrue(
      "the default branch must be the silent copy",
      debugWiring.indexOf("src/calibration/java") < debugWiring.indexOf("src/quiet/java"),
    )
    assertTrue(
      "the opt-in must come from an explicit Gradle property",
      gradle.contains("hasProperty(\"facetypeCalibrationDiagnostics\")"),
    )
  }
}
