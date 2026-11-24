package ai.facetype.client

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SpoolAndUploadTest {

  @get:Rule val folder = TemporaryFolder()

  /** Stand-in for the Android Keystore wrapper: a software AES-256-GCM key. */
  private class SoftwareWrapper(private val key: SecretKey = newKey()) : KeyWrapper {
    override fun wrap(dataKey: ByteArray): KeyWrapper.Wrapped {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, key)
      return KeyWrapper.Wrapped(cipher.iv, cipher.doFinal(dataKey))
    }

    override fun unwrap(iv: ByteArray, wrappedKey: ByteArray): ByteArray {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
      return cipher.doFinal(wrappedKey)
    }

    companion object {
      fun newKey(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    }
  }

  private val id = "0b8f9a52-1d6e-4c3b-9a1e-2f4d5c6b7a80"

  private fun jpegLike(size: Int): ByteArray = ByteArray(size).also { SecureRandom().nextBytes(it) }.apply {
    if (size >= 2) {
      this[0] = 0xFF.toByte()
      this[1] = 0xD8.toByte()
    }
  }

  @Test
  fun `a spooled frame decrypts to exactly the bytes that were hashed`() {
    val wrapper = SoftwareWrapper()
    for (size in listOf(0, 1, SpoolFormat.SEGMENT_SIZE - 1, SpoolFormat.SEGMENT_SIZE, SpoolFormat.SEGMENT_SIZE * 3 + 17)) {
      val plain = jpegLike(size)
      val file = File(folder.root, "$id-$size.ftc")
      SpoolFormat.write(file, id, 1_795_000_000_000L, plain, wrapper)
      val header = SpoolFormat.readHeader(file)
      assertEquals(id, header.id)
      assertEquals(size.toLong(), header.plainLength)
      assertEquals(1_795_000_000_000L, header.createdAtMs)
      assertEquals(ClientGateConfig.sha256Hex(plain), header.sha256Hex)
      val out = ByteArrayOutputStream()
      assertEquals(size.toLong(), SpoolFormat.decryptTo(file, wrapper, out))
      assertArrayEquals(plain, out.toByteArray())
      assertFalse(File(folder.root, file.name + ".part").exists())
    }
  }

  @Test
  fun `no plaintext byte appears in the spool file`() {
    val wrapper = SoftwareWrapper()
    val plain = ByteArray(200_000) { (it % 251).toByte() }
    val file = File(folder.root, "$id.ftc")
    SpoolFormat.write(file, id, 0L, plain, wrapper)
    val stored = file.readBytes()
    val window = plain.copyOfRange(1000, 1032)
    for (i in 0..stored.size - window.size) {
      if (stored.copyOfRange(i, i + window.size).contentEquals(window)) fail("plaintext found at offset $i")
    }
  }

  @Test
  fun `a flipped byte, a truncation or another key is detected`() {
    val wrapper = SoftwareWrapper()
    val plain = jpegLike(SpoolFormat.SEGMENT_SIZE * 2 + 5)
    val file = File(folder.root, "$id.ftc")

    fun expectCorrupt(label: String, reader: KeyWrapper = wrapper) {
      try {
        SpoolFormat.decryptTo(file, reader, ByteArrayOutputStream())
        fail("$label was not detected")
      } catch (_: SpoolCorruptException) {
      }
    }

    // Ciphertext byte.
    SpoolFormat.write(file, id, 0L, plain, wrapper)
    RandomAccessFile(file, "rw").use { raf ->
      raf.seek(raf.length() - 100)
      val b = raf.read()
      raf.seek(raf.length() - 100)
      raf.write(b xor 0x01)
    }
    expectCorrupt("a flipped ciphertext byte")

    // Header byte (the created-at time is authenticated as AAD).
    SpoolFormat.write(file, id, 0L, plain, wrapper)
    val headerLength = SpoolFormat.readHeader(file).raw.size
    RandomAccessFile(file, "rw").use { raf ->
      raf.seek(6L + id.length + 3)
      raf.write(0x7f)
    }
    assertTrue(headerLength > 0)
    expectCorrupt("a modified header")

    // Truncation at a segment boundary: the last-segment flag catches it.
    SpoolFormat.write(file, id, 0L, plain, wrapper)
    RandomAccessFile(file, "rw").use { raf ->
      raf.setLength(headerLength + 2L * (SpoolFormat.SEGMENT_SIZE + 16))
    }
    expectCorrupt("a truncated file")

    // A different keystore key.
    SpoolFormat.write(file, id, 0L, plain, wrapper)
    expectCorrupt("another key", SoftwareWrapper())
  }

  @Test
  fun `nothing of a failed segment reaches the sink`() {
    val wrapper = SoftwareWrapper()
    val plain = jpegLike(SpoolFormat.SEGMENT_SIZE + 10)
    val file = File(folder.root, "$id.ftc")
    SpoolFormat.write(file, id, 0L, plain, wrapper)
    RandomAccessFile(file, "rw").use { raf ->
      raf.seek(raf.length() - 3)
      raf.write(0)
    }
    val out = ByteArrayOutputStream()
    try {
      SpoolFormat.decryptTo(file, wrapper, out)
      fail("tamper not detected")
    } catch (_: SpoolCorruptException) {
    }
    // Only the first, authenticated segment was released.
    assertEquals(SpoolFormat.SEGMENT_SIZE, out.size())
    assertArrayEquals(plain.copyOf(SpoolFormat.SEGMENT_SIZE), out.toByteArray())
  }

  @Test
  fun `FrameMeta round-trips through its own encrypted sidecar, bound to a distinct header id`() {
    val wrapper = SoftwareWrapper()
    val meta = linkedMapOf<String, Any?>(
      "frame_id" to id, "stream_w" to 1920, "landmarks_478" to listOf(0.1, 0.2, 0.3),
      "intrinsics" to null, "intrinsics_missing_reason" to "focal_length_or_sensor_size_unknown",
    )
    val json = Json.stringify(meta)
    val file = File(folder.root, "$id.meta.ftc")
    SpoolFormat.write(file, "$id.meta", 0L, json.toByteArray(Charsets.UTF_8), wrapper)
    assertEquals("$id.meta", SpoolFormat.readHeader(file).id)
    val out = ByteArrayOutputStream()
    SpoolFormat.decryptTo(file, wrapper, out)
    val back = Json.parse(String(out.toByteArray(), Charsets.UTF_8)) as Map<*, *>
    assertEquals(1920.0, back["stream_w"])
    assertEquals(listOf(0.1, 0.2, 0.3), back["landmarks_478"])
    assertTrue(back.containsKey("intrinsics"))
    assertNull(back["intrinsics"])
    // The sidecar's stem is not a frame id, so listSpool never reports it as a frame.
    assertFalse(FrameIds.isValid("$id.meta"))
    assertFalse(File(folder.root, "$id.ftc").exists())
  }

  @Test
  fun `frame ids are UUIDs and nothing else can name a spool path`() {
    assertTrue(FrameIds.isValid(id))
    assertTrue(FrameIds.isValid(FrameIds.newId()))
    for (bad in listOf("../etc/passwd", "", "0B8F9A52-1D6E-4C3B-9A1E-2F4D5C6B7A80", "$id.ftc", "$id/..")) {
      assertFalse(bad, FrameIds.isValid(bad))
    }
  }

  @Test
  fun `uploads send the exact length and only the server's end-to-end headers`() {
    val headers = linkedMapOf(
      "Content-Type" to "image/jpeg",
      "x-amz-checksum-sha256" to "abc=",
      "Content-Length" to "1234",
      "Host" to "evil.example",
      "Transfer-Encoding" to "chunked",
    )
    val forwarded = UploadPolicy.forwardedHeaders(headers, 1234L)
    assertEquals(listOf("Content-Type" to "image/jpeg", "x-amz-checksum-sha256" to "abc="), forwarded)
    assertEquals("image/jpeg", UploadPolicy.contentType(headers))
    assertNull(UploadPolicy.contentType(emptyMap()))
    try {
      UploadPolicy.forwardedHeaders(headers, 1235L)
      fail("a mismatched Content-Length was accepted")
    } catch (_: IllegalArgumentException) {
    }
  }

  @Test
  fun `capture results are matched to images by exact sensor timestamp`() {
    val ring = TimestampedRing<String>(capacity = 3)
    ring.put(100L, "a")
    ring.put(200L, "b")
    assertEquals("b", ring.await(200L, 0))
    assertNull(ring.await(150L, 0))
    ring.put(300L, "c")
    ring.put(400L, "d")
    assertNull(ring.await(100L, 0)) // evicted
    val late = Thread {
      Thread.sleep(30)
      ring.put(500L, "e")
    }
    late.start()
    assertEquals("e", ring.await(500L, 2000))
    late.join()
  }

  @Test
  fun `gyro samples are matched within a gap and fps is measured from timestamps`() {
    val gyro = GyroRing(capacity = 4)
    assertNull(gyro.nearest(0, 1_000))
    gyro.add(1_000_000L, 2.0)
    gyro.add(2_000_000L, 4.0)
    assertEquals(4.0, gyro.nearest(2_100_000L, 500_000L)!!, 0.0)
    assertNull(gyro.nearest(9_000_000L, 500_000L))
    assertEquals(2_000_000L, gyro.latest()!!.first)

    val rate = DeliveredRate(window = 10, minFrames = 5)
    for (i in 0 until 4) rate.add(i * 66_666_667L)
    assertNull(rate.fps())
    rate.add(4 * 66_666_667L)
    assertEquals(15.0, rate.fps()!!, 0.01)
  }
}
