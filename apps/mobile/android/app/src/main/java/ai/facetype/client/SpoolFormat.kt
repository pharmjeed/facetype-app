package ai.facetype.client

import java.io.DataInputStream
import java.io.EOFException
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Wraps and unwraps a per-file data key with a key that never leaves its
 * keystore. On the handset this is an Android Keystore AES-256-GCM key
 * ([KeystoreKeyWrapper]); JVM tests use a software key.
 */
internal interface KeyWrapper {
  class Wrapped(val iv: ByteArray, val wrappedKey: ByteArray)

  fun wrap(dataKey: ByteArray): Wrapped

  fun unwrap(iv: ByteArray, wrappedKey: ByteArray): ByteArray
}

/** Frame ids are lower-case UUIDs; anything else is refused before it can name a spool path. */
internal object FrameIds {
  private val PATTERN = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

  fun newId(): String = java.util.UUID.randomUUID().toString()

  fun isValid(id: String): Boolean = PATTERN.matches(id)

  fun requireValid(id: String) = require(isValid(id)) { "invalid frame id" }
}

/** Thrown when a spool file is malformed, truncated, or fails authentication. */
internal class SpoolCorruptException(message: String, cause: Throwable? = null) : IOException(message, cause)

/**
 * The encrypted spool file format.
 *
 * WHY ENVELOPE + SEGMENTS. A 4K JPEG is several MB. Encrypting it inside the
 * Android Keystore would push every byte through the TEE; instead each file
 * gets a fresh random AES-256 data key, used in-process, and only that 32-byte
 * key is encrypted by the Keystore key. And because one AES-GCM message
 * cannot release any plaintext before its tag is checked at the very end,
 * the payload is cut into [SEGMENT_SIZE] segments, each its own GCM message
 * (the STREAM construction): `uploadFrame` can then decrypt and send in
 * bounded memory, and every byte it sends has already been authenticated.
 *
 * Layout (big-endian):
 * ```
 * "FTCS" | version=1 | idLen u8 | id | createdAtMs i64 | plainLen i64 | sha256[32]
 *   | segmentSize i32 | wrapIvLen u8 | wrapIv | wrappedLen u16 | wrappedKey | noncePrefix[7]
 * segment_i = AES-GCM(dataKey, nonce = prefix || i (u32) || last (u8), aad = header) -> ct || tag16
 * ```
 * The whole header is the AAD of every segment, so id, length, digest and the
 * wrapped key are all bound to the ciphertext; the `last` byte in the nonce
 * makes truncation at a segment boundary detectable.
 *
 * Nothing in this format is ever plaintext image data.
 */
internal object SpoolFormat {
  private val MAGIC = byteArrayOf('F'.code.toByte(), 'T'.code.toByte(), 'C'.code.toByte(), 'S'.code.toByte())
  private const val VERSION: Byte = 1
  const val SEGMENT_SIZE = 64 * 1024
  private const val TAG_BYTES = 16
  private const val NONCE_PREFIX_BYTES = 7
  private const val TRANSFORMATION = "AES/GCM/NoPadding"
  private val random = SecureRandom()

  data class Header(
    val id: String,
    val createdAtMs: Long,
    val plainLength: Long,
    val sha256: ByteArray,
    val segmentSize: Int,
    val wrapIv: ByteArray,
    val wrappedKey: ByteArray,
    val noncePrefix: ByteArray,
    /** The exact header bytes, used as the AAD. */
    val raw: ByteArray,
  ) {
    val sha256Hex: String get() = ClientGateConfig.hex(sha256)
  }

  /**
   * Encrypts [plaintext] into [target] (written via a `.part` sibling and
   * renamed, so a crash never leaves a half file under the final name).
   */
  fun write(target: File, id: String, createdAtMs: Long, plaintext: ByteArray, wrapper: KeyWrapper) {
    val dataKey = ByteArray(32).also { random.nextBytes(it) }
    try {
      val wrapped = wrapper.wrap(dataKey)
      val prefix = ByteArray(NONCE_PREFIX_BYTES).also { random.nextBytes(it) }
      val digest = MessageDigest.getInstance("SHA-256").digest(plaintext)
      val header = encodeHeader(id, createdAtMs, plaintext.size.toLong(), digest, SEGMENT_SIZE, wrapped, prefix)
      val part = File(target.parentFile, target.name + ".part")
      try {
        FileOutputStream(part).use { out ->
          out.write(header)
          val key = SecretKeySpec(dataKey, "AES")
          val cipher = Cipher.getInstance(TRANSFORMATION)
          val segments = segmentCount(plaintext.size.toLong(), SEGMENT_SIZE)
          for (index in 0 until segments) {
            val start = index * SEGMENT_SIZE
            val length = minOf(SEGMENT_SIZE, plaintext.size - start)
            cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_BYTES * 8, nonce(prefix, index, index == segments - 1)))
            cipher.updateAAD(header)
            out.write(cipher.doFinal(plaintext, start, length))
          }
          out.fd.sync()
        }
        // rename() replaces atomically on Android (POSIX); where it refuses an
        // existing target (Windows JVM), the old file is removed first. Frame
        // ids are unique, so a replacement never happens on the handset.
        if (!part.renameTo(target) && !(target.delete() && part.renameTo(target))) {
          throw IOException("could not move ${part.name} into place")
        }
      } catch (error: Exception) {
        part.delete()
        throw error
      }
    } finally {
      dataKey.fill(0)
    }
  }

  fun readHeader(file: File): Header = FileInputStream(file).use { readHeader(it) }

  /**
   * Streams the authenticated plaintext of [file] into [sink], segment by
   * segment, and returns the number of bytes written. Throws
   * [SpoolCorruptException] before writing any byte of a segment that fails
   * authentication, and if the decrypted bytes do not hash to the header's
   * digest.
   */
  fun decryptTo(file: File, wrapper: KeyWrapper, sink: OutputStream): Long {
    FileInputStream(file).use { input ->
      val header = readHeader(input)
      val dataKey = try {
        wrapper.unwrap(header.wrapIv, header.wrappedKey)
      } catch (error: Exception) {
        throw SpoolCorruptException("the spool key could not unwrap this file", error)
      }
      try {
        val key = SecretKeySpec(dataKey, "AES")
        val cipher = Cipher.getInstance(TRANSFORMATION)
        val digest = MessageDigest.getInstance("SHA-256")
        val segments = segmentCount(header.plainLength, header.segmentSize)
        val buffer = ByteArray(header.segmentSize + TAG_BYTES)
        val data = DataInputStream(input)
        var remaining = header.plainLength
        var written = 0L
        for (index in 0 until segments) {
          val plainSize = minOf(header.segmentSize.toLong(), remaining).toInt()
          try {
            data.readFully(buffer, 0, plainSize + TAG_BYTES)
          } catch (eof: EOFException) {
            throw SpoolCorruptException("spool file is truncated", eof)
          }
          val plain = try {
            cipher.init(
              Cipher.DECRYPT_MODE, key,
              GCMParameterSpec(TAG_BYTES * 8, nonce(header.noncePrefix, index, index == segments - 1)),
            )
            cipher.updateAAD(header.raw)
            cipher.doFinal(buffer, 0, plainSize + TAG_BYTES)
          } catch (error: Exception) {
            throw SpoolCorruptException("spool segment $index failed authentication", error)
          }
          digest.update(plain)
          sink.write(plain)
          plain.fill(0)
          remaining -= plainSize
          written += plainSize
        }
        if (input.read() != -1) throw SpoolCorruptException("spool file has trailing bytes")
        if (!MessageDigest.isEqual(digest.digest(), header.sha256)) {
          throw SpoolCorruptException("decrypted bytes do not match the recorded SHA-256")
        }
        buffer.fill(0)
        return written
      } finally {
        dataKey.fill(0)
      }
    }
  }

  fun segmentCount(plainLength: Long, segmentSize: Int): Int {
    if (plainLength <= 0) return 1
    return ((plainLength + segmentSize - 1) / segmentSize).toInt()
  }

  private fun nonce(prefix: ByteArray, index: Int, last: Boolean): ByteArray =
    ByteBuffer.allocate(12).put(prefix).putInt(index).put(if (last) 1.toByte() else 0.toByte()).array()

  private fun encodeHeader(
    id: String,
    createdAtMs: Long,
    plainLength: Long,
    sha256: ByteArray,
    segmentSize: Int,
    wrapped: KeyWrapper.Wrapped,
    prefix: ByteArray,
  ): ByteArray {
    val idBytes = id.toByteArray(Charsets.US_ASCII)
    require(idBytes.size in 1..255) { "id must be 1..255 ASCII bytes" }
    require(wrapped.iv.size in 1..255) { "wrap IV must be 1..255 bytes" }
    require(wrapped.wrappedKey.size in 1..65535) { "wrapped key is too long" }
    val size = 4 + 1 + 1 + idBytes.size + 8 + 8 + 32 + 4 + 1 + wrapped.iv.size + 2 + wrapped.wrappedKey.size +
      NONCE_PREFIX_BYTES
    return ByteBuffer.allocate(size)
      .put(MAGIC).put(VERSION)
      .put(idBytes.size.toByte()).put(idBytes)
      .putLong(createdAtMs).putLong(plainLength).put(sha256)
      .putInt(segmentSize)
      .put(wrapped.iv.size.toByte()).put(wrapped.iv)
      .putShort(wrapped.wrappedKey.size.toShort()).put(wrapped.wrappedKey)
      .put(prefix)
      .array()
  }

  private fun readHeader(input: InputStream): Header {
    val data = DataInputStream(input)
    val recorder = java.io.ByteArrayOutputStream()
    fun bytes(n: Int): ByteArray {
      val out = ByteArray(n)
      try {
        data.readFully(out)
      } catch (eof: EOFException) {
        throw SpoolCorruptException("spool header is truncated", eof)
      }
      recorder.write(out)
      return out
    }
    fun u8(): Int = bytes(1)[0].toInt() and 0xff
    fun u16(): Int = ByteBuffer.wrap(bytes(2)).short.toInt() and 0xffff
    fun i32(): Int = ByteBuffer.wrap(bytes(4)).int
    fun i64(): Long = ByteBuffer.wrap(bytes(8)).long

    if (!bytes(4).contentEquals(MAGIC)) throw SpoolCorruptException("not a spool file")
    val version = u8()
    if (version != VERSION.toInt()) throw SpoolCorruptException("unsupported spool version $version")
    val id = String(bytes(u8()), Charsets.US_ASCII)
    val createdAt = i64()
    val plainLength = i64()
    val sha = bytes(32)
    val segmentSize = i32()
    if (segmentSize <= 0 || segmentSize > 16 * 1024 * 1024) throw SpoolCorruptException("bad segment size")
    if (plainLength < 0) throw SpoolCorruptException("bad length")
    val wrapIv = bytes(u8())
    val wrapped = bytes(u16())
    val prefix = bytes(NONCE_PREFIX_BYTES)
    return Header(id, createdAt, plainLength, sha, segmentSize, wrapIv, wrapped, prefix, recorder.toByteArray())
  }
}
