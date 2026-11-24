package ai.facetype.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class GateConfigAndJsonTest {

  @Test
  fun `numbers print the way JSON stringify prints them`() {
    assertEquals("8", Json.formatNumber(8.0))
    assertEquals("0.3", Json.formatNumber(0.3))
    assertEquals("11.7", Json.formatNumber(11.7))
    assertEquals("-2", Json.formatNumber(-2.0))
    assertEquals("0", Json.formatNumber(-0.0))
    assertEquals("0.000001", Json.formatNumber(1e-6))
    assertEquals("1e-7", Json.formatNumber(1e-7))
    assertEquals("1.5e-7", Json.formatNumber(1.5e-7))
    assertEquals("1e+21", Json.formatNumber(1e21))
    assertEquals("123456789012", Json.formatNumber(123456789012.0))
    assertEquals("0.30000000000000004", Json.formatNumber(0.1 + 0.2))
  }

  @Test
  fun `canonical JSON sorts keys recursively and keeps array order`() {
    val parsed = Json.parse("""{ "b": [3, 1, {"z": 1, "a": true}], "a": "x\"y", "c": null }""")
    assertEquals("""{"a":"x\"y","b":[3,1,{"a":true,"z":1}],"c":null}""", Json.canonical(parsed))
    assertEquals("""{"b":[3,1,{"z":1,"a":true}],"a":"x\"y","c":null}""", Json.stringify(parsed))
  }

  @Test
  fun `strings escape like JSON stringify and round-trip`() {
    val text = "tab\tnew\nquote\" back\\ ctl\u0001 arabic ملخص"
    val written = Json.stringify(text)
    assertEquals("\"tab\\tnew\\nquote\\\" back\\\\ ctl\\u0001 arabic ملخص\"", written)
    assertEquals(text, Json.parse(written))
  }

  @Test
  fun `malformed JSON is rejected`() {
    for (bad in listOf("{", "[1,]", "{\"a\" 1}", "tru", "1 2", "\"unterminated")) {
      try {
        Json.parse(bad)
        fail("accepted $bad")
      } catch (_: IllegalArgumentException) {
      }
    }
  }

  @Test
  fun `the contract config parses with every documented value`() {
    val c = ClientFixtures.config
    assertEquals("client-gate-1", c.version)
    assertEquals(PixelSize(3840, 2160), c.stream.preferredSizes.first())
    assertEquals(PixelSize(1280, 720), c.stream.minSize)
    assertEquals(95, c.stream.jpegQuality)
    assertEquals(2, c.faces.maxFaces)
    assertEquals(8.0, c.pose.enterDeg, 0.0)
    assertEquals(ClientGateConfig.ClosedRange(35.0, 60.0), c.distance.enterCm)
    assertEquals(11.7, c.distance.irisMm, 0.0)
    assertEquals(220.0, c.size.minFaceWidthPx, 0.0)
    assertEquals(350.0, c.size.preferredFaceWidthPx, 0.0)
    assertEquals(0.7, c.size.maxFaceWidthFrac, 0.0)
    assertEquals(0.05, c.centre.edgeMarginFrac, 0.0)
    assertEquals(ClientGateConfig.ClosedRange(0.5, 2.0), c.light.cheekRatio)
    assertEquals(0.3, c.expression.maxSmile, 0.0)
    assertEquals(0.05, c.expression.maxJawOpen, 0.0)
    assertEquals(0.5, c.eyes.maxBlink, 0.0)
    assertEquals(0.7, c.eyes.minRelativeOpening, 0.0)
    assertEquals(0.5, c.sharpness.minRelativeToBurstMax, 0.0)
    assertEquals(10, c.burst.targetFrames)
    assertEquals(8000L, c.burst.maxDurationMs)
    assertEquals(66L, c.burst.minSpacingMs)
    assertEquals(1000L, c.burst.minCoverageMs)
    assertEquals("validated", c.labels["size.minFaceWidthPx"])
  }

  @Test
  fun `the hash is SHA-256 of the canonical form, independent of key order and whitespace`() {
    val reordered = """{"labels":{"size.minFaceWidthPx":"validated","expression.maxSmile":"research",
      "pose.enterDeg":"default"},"burst":{"holdMs":500,"minCoverageMs":1000,"minSpacingMs":66,"maxDurationMs":8000,
      "targetFrames":10},"sharpness":{"minRelativeToBurstMax":0.5},"eyes":{"minRelativeOpening":0.7,"maxBlink":0.5},
      "expression":{"maxJawOpen":0.05,"maxSmile":0.3},"light":{"cheekRatio":[0.5,2],"maxCrushFrac":0.02,
      "maxClipFrac":0.01},"centre":{"edgeMarginFrac":0.05,"faceCentreY":[0.35,0.65],"eyeMidX":[0.4,0.6]},
      "size":{"maxFaceWidthFrac":0.7,"preferredFaceWidthPx":350,"minFaceWidthPx":220},"distance":{"irisMm":11.7,
      "exitCm":[32,65],"enterCm":[35,60]},"pose":{"rollMessageDeg":15,"exitDeg":12,"enterDeg":8},
      "faces":{"maxFaces":2},"stream":{"jpegQuality":95,"preferredMinFps":15,"minSize":[1280,720],
      "preferredSizes":[[3840,2160],[1920,1080],[1280,720]]},"version":"client-gate-1"}"""
    val a = ClientFixtures.config.hash
    val b = ClientGateConfig.parse(reordered).hash
    assertEquals(a, b)
    assertEquals(64, a.length)
    val canonical = Json.canonical(Json.parse(ClientFixtures.GATE_CONFIG_JSON))
    assertEquals(ClientGateConfig.sha256Hex(canonical.toByteArray(Charsets.UTF_8)), a)
    assertTrue(canonical.startsWith("""{"burst":{"holdMs":500,"maxDurationMs":8000,"""))
    assertTrue(canonical.contains(""""distance":{"enterCm":[35,60],"exitCm":[32,65],"irisMm":11.7}"""))

    val changed = ClientFixtures.GATE_CONFIG_JSON.replace("\"maxSmile\": 0.3", "\"maxSmile\": 0.31")
    assertNotEquals(a, ClientGateConfig.parse(changed).hash)
  }

  @Test
  fun `a missing or non-finite threshold is an error, never a default`() {
    val cases = listOf(
      ClientFixtures.GATE_CONFIG_JSON.replace("\"maxBlink\": 0.5, ", ""),
      ClientFixtures.GATE_CONFIG_JSON.replace("\"minRelativeToBurstMax\": 0.5", "\"minRelativeToBurstMax\": \"0.5\""),
      ClientFixtures.GATE_CONFIG_JSON.replace("\"enterCm\": [35, 60]", "\"enterCm\": [60, 35]"),
      ClientFixtures.GATE_CONFIG_JSON.replace("\"maxFaces\": 2", "\"maxFaces\": 1"),
      ClientFixtures.GATE_CONFIG_JSON.replace("client-gate-1", "client-gate-0"),
      ClientFixtures.GATE_CONFIG_JSON.replace("\"jpegQuality\": 95", "\"jpegQuality\": 101"),
      // The pre-A7.78-B size shape is no longer accepted.
      ClientFixtures.GATE_CONFIG_JSON.replace("\"minFaceWidthPx\": 220, ", "\"minInterPupilPx\": 60, "),
    )
    for (json in cases) {
      try {
        ClientGateConfig.parse(json)
        fail("accepted an invalid config")
      } catch (_: IllegalArgumentException) {
      }
    }
  }

  @Test
  fun `closed ranges never contain a missing or non-finite value`() {
    val range = ClientGateConfig.ClosedRange(35.0, 60.0)
    assertTrue(range.contains(35.0))
    assertTrue(range.contains(60.0))
    assertEquals(false, range.contains(null))
    assertEquals(false, range.contains(Double.NaN))
    assertEquals(false, range.contains(Double.POSITIVE_INFINITY))
    assertNull(FrameCheckEvaluator.maxOf(0.1, Double.NaN))
    assertEquals(0.4, FrameCheckEvaluator.maxOf(0.1, 0.4)!!, 0.0)
  }
}
