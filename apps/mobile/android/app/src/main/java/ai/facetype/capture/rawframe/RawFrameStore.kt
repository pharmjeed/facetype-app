package ai.facetype.capture.rawframe

import java.security.MessageDigest
import java.util.UUID

/**
 * The single slot a consented field-study photograph lives in, between being
 * encoded and being uploaded.
 *
 * WHY A SLOT AND NOT A FILE. A JPEG of a research participant's face is the
 * most sensitive thing this app ever holds. Written to app-private storage it
 * would acquire its own lifetime, its own deletion path to get wrong and its
 * own exposure to anything that can read the app's data directory — and it
 * would buy nothing, because a presigned upload needs the bytes in the
 * JavaScript heap regardless. So there is no file: the bytes are encoded into
 * this object, handed out once as base64 for the upload, and zeroed.
 *
 * WHY ONE SLOT AND NOT A MAP. A field capture uploads one photograph per pose,
 * sequentially, and never holds two. A map would let a failed cleanup
 * accumulate faces silently; a single slot makes "something is still held" a
 * state with exactly one occupant, and [put] wipes whatever was there before it
 * — so even a caller that forgets to discard cannot stack them up.
 *
 * WHY THE WIPE IS EXPLICIT. Dropping a `ByteArray` reference leaves it legible
 * in the heap until a collector happens to reuse the pages, and legible in any
 * heap dump taken in between. `Nv21Argb.withUprightArgb` already draws this
 * line for the intermediate pixels; this is the same rule for the encoded
 * frame.
 *
 * Plain JVM code — no Android framework, no ARCore, no bitmap — so
 * `RawFrameStoreTest` drives the ownership rules directly.
 */
internal class RawFrameStore {

  /** What JavaScript is told. Metadata only: never the bytes, never a path. */
  data class Handle(
    val token: String,
    val byteLength: Int,
    val sha256: String,
    val width: Int,
    val height: Int,
  )

  private val lock = Any()
  private var token: String? = null
  // The dimensions are not kept: they belong to the handle the caller already
  // holds, and a second copy here would be state nothing reads and everything
  // has to remember to clear.
  private var bytes: ByteArray? = null

  /**
   * Take ownership of [jpeg], wiping whatever was held before it.
   *
   * The array becomes this store's; the caller must not keep a reference,
   * because [discard] zeroes it in place and a retained reference would defeat
   * that. The digest is computed here, over exactly these bytes, so the upload
   * slot JavaScript requests is signed for what will actually be sent.
   */
  fun put(jpeg: ByteArray, width: Int, height: Int): Handle {
    require(jpeg.isNotEmpty()) { "a raw frame must have bytes" }
    require(width > 0 && height > 0) { "a raw frame must have positive dimensions" }
    val digest = sha256Hex(jpeg)
    val issued = "rf-${UUID.randomUUID()}"
    synchronized(lock) {
      wipeLocked()
      token = issued
      bytes = jpeg
    }
    return Handle(issued, jpeg.size, digest, width, height)
  }

  /**
   * A private copy of the held bytes, or null if [token] is not the current
   * occupant.
   *
   * A copy rather than the array itself: the caller encodes it to base64 on
   * the bridge thread while a host pause on the UI thread may be wiping the
   * slot, and handing out the live array would let that wipe run through a
   * buffer somebody is halfway through reading — producing a half-zeroed
   * photograph that still has the right length and the wrong checksum. The
   * caller wipes its copy when it is done.
   */
  fun read(token: String): ByteArray? = synchronized(lock) {
    if (this.token != token) null else bytes?.copyOf()
  }

  /** True when [token] named the current occupant and it has now been wiped. */
  fun discard(token: String): Boolean = synchronized(lock) {
    if (this.token != token) return false
    wipeLocked()
    true
  }

  /** Wipes whatever is held. Returns true if anything was. Idempotent. */
  fun discardAll(): Boolean = synchronized(lock) {
    val held = bytes != null
    wipeLocked()
    held
  }

  fun isEmpty(): Boolean = synchronized(lock) { bytes == null }

  private fun wipeLocked() {
    bytes?.fill(0)
    bytes = null
    token = null
  }

  companion object {
    fun sha256Hex(data: ByteArray): String {
      val digest = MessageDigest.getInstance("SHA-256").digest(data)
      val out = StringBuilder(digest.size * 2)
      for (byte in digest) {
        val value = byte.toInt() and 0xff
        out.append(HEX[value ushr 4]).append(HEX[value and 0x0f])
      }
      return out.toString()
    }

    private const val HEX = "0123456789abcdef"
  }
}
