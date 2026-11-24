package ai.facetype.capture.quality

import java.nio.ByteBuffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The YUV_420_888 layouts a real device actually hands back.
 *
 * None of these are hypothetical: a dense NV21-ish buffer, a row-padded one, a
 * semi-planar one whose chroma planes interleave (pixelStride 2), a cropped
 * one, and a buffer whose `position()` is not zero. Each of them is a
 * different way to read the wrong bytes and still produce a plausible-looking
 * number, which is why they are pinned by test rather than by comment.
 */
class YuvNv21Test {

  @Test
  fun `a dense planar image copies through unchanged`() {
    val image = SyntheticYuv(width = 4, height = 4)
    val out = ByteArray(YuvNv21.byteCount(4, 4))

    YuvNv21.convert(image.y(), image.u(), image.v(), 0, 0, 4, 4, out)

    assertArrayEquals(image.expectedNv21(0, 0, 4, 4), out)
  }

  @Test
  fun `row padding is skipped instead of being copied as pixels`() {
    // A 4-wide image in a 16-byte-stride plane: 12 bytes of alignment padding
    // per row that must never reach the detector.
    val image = SyntheticYuv(width = 4, height = 4, yRowStride = 16, chromaRowStride = 16)
    val out = ByteArray(YuvNv21.byteCount(4, 4))

    YuvNv21.convert(image.y(), image.u(), image.v(), 0, 0, 4, 4, out)

    assertArrayEquals(image.expectedNv21(0, 0, 4, 4), out)
  }

  @Test
  fun `interleaved chroma with pixel stride two is de-interleaved correctly`() {
    val image = SyntheticYuv(width = 4, height = 4, chromaPixelStride = 2)
    val out = ByteArray(YuvNv21.byteCount(4, 4))

    YuvNv21.convert(image.y(), image.u(), image.v(), 0, 0, 4, 4, out)

    assertArrayEquals(image.expectedNv21(0, 0, 4, 4), out)
  }

  @Test
  fun `a luma pixel stride greater than one is honoured`() {
    val image = SyntheticYuv(width = 4, height = 4, yPixelStride = 2)
    val out = ByteArray(YuvNv21.byteCount(4, 4))

    YuvNv21.convert(image.y(), image.u(), image.v(), 0, 0, 4, 4, out)

    assertArrayEquals(image.expectedNv21(0, 0, 4, 4), out)
  }

  @Test
  fun `a crop rectangle selects only the picture region`() {
    val image = SyntheticYuv(width = 8, height = 8, yRowStride = 12)
    val out = ByteArray(YuvNv21.byteCount(4, 4))

    YuvNv21.convert(image.y(), image.u(), image.v(), 2, 2, 4, 4, out)

    assertArrayEquals(image.expectedNv21(2, 2, 4, 4), out)
  }

  @Test
  fun `a buffer positioned past zero is read from its position`() {
    val image = SyntheticYuv(width = 4, height = 4, leadingSlack = 7)
    val out = ByteArray(YuvNv21.byteCount(4, 4))

    YuvNv21.convert(image.y(), image.u(), image.v(), 0, 0, 4, 4, out)

    assertArrayEquals(image.expectedNv21(0, 0, 4, 4), out)
  }

  @Test
  fun `NV21 orders chroma as V then U`() {
    val image = SyntheticYuv(width = 2, height = 2)
    val out = ByteArray(YuvNv21.byteCount(2, 2))

    YuvNv21.convert(image.y(), image.u(), image.v(), 0, 0, 2, 2, out)

    // Four luma bytes, then exactly one chroma pair, V first.
    assertEquals(6, out.size)
    assertEquals(image.chroma(isV = true, x = 0, y = 0), out[4])
    assertEquals(image.chroma(isV = false, x = 0, y = 0), out[5])
  }

  @Test
  fun `odd dimensions are rejected rather than silently truncated`() {
    val image = SyntheticYuv(width = 4, height = 4)
    val out = ByteArray(64)

    assertRejects { YuvNv21.convert(image.y(), image.u(), image.v(), 0, 0, 3, 4, out) }
    assertRejects { YuvNv21.convert(image.y(), image.u(), image.v(), 0, 0, 4, 3, out) }
  }

  @Test
  fun `an odd crop origin is rejected because chroma has no such phase`() {
    val image = SyntheticYuv(width = 8, height = 8)
    val out = ByteArray(YuvNv21.byteCount(4, 4))

    assertRejects { YuvNv21.convert(image.y(), image.u(), image.v(), 1, 0, 4, 4, out) }
    assertRejects { YuvNv21.convert(image.y(), image.u(), image.v(), 0, 1, 4, 4, out) }
  }

  @Test
  fun `a destination too small to hold the image is rejected`() {
    val image = SyntheticYuv(width = 4, height = 4)

    assertRejects {
      YuvNv21.convert(image.y(), image.u(), image.v(), 0, 0, 4, 4, ByteArray(5))
    }
  }

  @Test
  fun `a read past the plane's limit is rejected instead of returning garbage`() {
    // A plane that claims a 4x4 image but only holds three rows: the fourth
    // row's read has to fail loudly, not wrap into the chroma planes.
    val truncated = YuvPlane(ByteBuffer.allocate(12), rowStride = 4, pixelStride = 1)
    val image = SyntheticYuv(width = 4, height = 4)
    val out = ByteArray(YuvNv21.byteCount(4, 4))

    assertRejects { YuvNv21.convert(truncated, image.u(), image.v(), 0, 0, 4, 4, out) }
  }

  @Test
  fun `byteCount matches the 4 2 0 layout`() {
    assertEquals(6, YuvNv21.byteCount(2, 2))
    assertEquals(24, YuvNv21.byteCount(4, 4))
    assertEquals(640 * 480 * 3 / 2, YuvNv21.byteCount(640, 480))
  }

  private fun assertRejects(block: () -> Unit) {
    val failed = try {
      block()
      false
    } catch (_: IllegalArgumentException) {
      true
    }
    assertTrue("expected the conversion to be rejected", failed)
  }
}

/**
 * A YUV_420_888 image whose every byte is a deterministic function of its
 * plane and coordinates, so the expected NV21 output can be derived
 * independently of the code under test rather than recorded from it.
 */
private class SyntheticYuv(
  val width: Int,
  val height: Int,
  val yPixelStride: Int = 1,
  val chromaPixelStride: Int = 1,
  // A plane's row has to be at least as long as the pixels it holds; the
  // defaults are the tightest layout each pixel stride allows.
  val yRowStride: Int = width * yPixelStride,
  val chromaRowStride: Int = (width / 2) * chromaPixelStride,
  val leadingSlack: Int = 0,
) {
  fun luma(x: Int, y: Int): Byte = (17 + y * width + x).toByte()

  fun chroma(isV: Boolean, x: Int, y: Int): Byte =
    ((if (isV) 200 else 100) + y * (width / 2) + x).toByte()

  fun y(): YuvPlane = plane(yRowStride, yPixelStride, height, width) { x, y -> luma(x, y) }

  fun u(): YuvPlane =
    plane(chromaRowStride, chromaPixelStride, height / 2, width / 2) { x, y ->
      chroma(isV = false, x = x, y = y)
    }

  fun v(): YuvPlane =
    plane(chromaRowStride, chromaPixelStride, height / 2, width / 2) { x, y ->
      chroma(isV = true, x = x, y = y)
    }

  fun expectedNv21(cropLeft: Int, cropTop: Int, cropWidth: Int, cropHeight: Int): ByteArray {
    val out = ByteArray(YuvNv21.byteCount(cropWidth, cropHeight))
    var cursor = 0
    for (row in 0 until cropHeight) {
      for (column in 0 until cropWidth) {
        out[cursor++] = luma(cropLeft + column, cropTop + row)
      }
    }
    for (row in 0 until cropHeight / 2) {
      for (column in 0 until cropWidth / 2) {
        out[cursor++] = chroma(true, cropLeft / 2 + column, cropTop / 2 + row)
        out[cursor++] = chroma(false, cropLeft / 2 + column, cropTop / 2 + row)
      }
    }
    return out
  }

  private fun plane(
    rowStride: Int,
    pixelStride: Int,
    rows: Int,
    columns: Int,
    value: (Int, Int) -> Byte,
  ): YuvPlane {
    val size = leadingSlack + (rows - 1) * rowStride + (columns - 1) * pixelStride + 1
    val buffer = ByteBuffer.allocate(size)
    for (row in 0 until rows) {
      for (column in 0 until columns) {
        buffer.put(leadingSlack + row * rowStride + column * pixelStride, value(column, row))
      }
    }
    buffer.position(leadingSlack)
    return YuvPlane(buffer, rowStride, pixelStride)
  }
}
