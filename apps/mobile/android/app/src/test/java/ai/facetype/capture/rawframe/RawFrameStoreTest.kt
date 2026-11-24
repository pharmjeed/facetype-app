package ai.facetype.capture.rawframe

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Ownership rules for the one slot a consented participant photograph lives in.
 *
 * Plain JVM: no Android framework, no bitmap, no camera. The rules under test
 * are about lifetime and erasure, which is exactly the part that has to hold on
 * a device nobody can attach a debugger to.
 */
class RawFrameStoreTest {

  private fun frame(size: Int = 32, fill: Byte = 7): ByteArray = ByteArray(size) { fill }

  @Test
  fun `a stored frame is readable by its own token and nobody else's`() {
    val store = RawFrameStore()
    val handle = store.put(frame(), 640, 480)

    assertArrayEquals(frame(), store.read(handle.token)!!)
    assertNull(store.read("rf-somebody-else"))
    assertEquals(32, handle.byteLength)
    assertEquals(640, handle.width)
    assertEquals(480, handle.height)
  }

  @Test
  fun `the digest is of the exact bytes, so the upload slot can be signed for them`() {
    val store = RawFrameStore()
    val handle = store.put(frame(), 640, 480)

    assertEquals(RawFrameStore.sha256Hex(frame()), handle.sha256)
    assertEquals(64, handle.sha256.length)
    assertTrue(handle.sha256.all { it in "0123456789abcdef" })
    // A different frame is a different digest; a same-size substitution cannot
    // pass as the one the slot was signed for.
    assertNotEquals(handle.sha256, RawFrameStore.sha256Hex(frame(fill = 8)))
  }

  @Test
  fun `read hands out a copy, so a concurrent wipe cannot hollow out a live buffer`() {
    val store = RawFrameStore()
    val handle = store.put(frame(), 640, 480)

    val borrowed = store.read(handle.token)!!
    store.discardAll()

    // The caller's copy is intact even though the store's own array is gone.
    assertArrayEquals(frame(), borrowed)
  }

  @Test
  fun `discard zeroes the held bytes rather than only dropping the reference`() {
    val store = RawFrameStore()
    val held = frame()
    val handle = store.put(held, 640, 480)

    assertTrue(store.discard(handle.token))
    assertNull(store.read(handle.token))
    // The array the store was given is wiped in place: dropping the reference
    // would leave a face legible in the heap, and in any heap dump taken
    // before the collector happened to reuse the pages.
    assertArrayEquals(ByteArray(32), held)
  }

  @Test
  fun `discarding a token that is not the current occupant leaves the slot alone`() {
    val store = RawFrameStore()
    val handle = store.put(frame(), 640, 480)

    assertFalse(store.discard("rf-stale"))
    assertArrayEquals(frame(), store.read(handle.token)!!)
  }

  @Test
  fun `storing a second frame wipes the first, so faces cannot stack up`() {
    val store = RawFrameStore()
    val first = frame(fill = 1)
    val firstHandle = store.put(first, 640, 480)
    val secondHandle = store.put(frame(fill = 2), 320, 240)

    assertArrayEquals(ByteArray(32), first)
    assertNull(store.read(firstHandle.token))
    assertArrayEquals(frame(fill = 2), store.read(secondHandle.token)!!)
    assertNotEquals(firstHandle.token, secondHandle.token)
  }

  @Test
  fun `discardAll is idempotent and reports whether anything was held`() {
    val store = RawFrameStore()
    assertTrue(store.isEmpty())
    assertFalse(store.discardAll())

    store.put(frame(), 640, 480)
    assertFalse(store.isEmpty())
    assertTrue(store.discardAll())
    assertFalse(store.discardAll())
    assertTrue(store.isEmpty())
  }

  @Test
  fun `tokens are opaque and are never a path or a participant reference`() {
    val store = RawFrameStore()
    val token = store.put(frame(), 640, 480).token

    assertTrue(token.startsWith("rf-"))
    assertFalse(token.contains("/"))
    assertFalse(token.contains("\\"))
    assertFalse(token.contains("."))
  }

  @Test
  fun `an empty or degenerate frame is refused rather than stored`() {
    val store = RawFrameStore()
    for (attempt in listOf(
      { store.put(ByteArray(0), 640, 480) },
      { store.put(frame(), 0, 480) },
      { store.put(frame(), 640, -1) },
    )) {
      var threw = false
      try {
        attempt()
      } catch (_: IllegalArgumentException) {
        threw = true
      }
      assertTrue(threw)
    }
    assertTrue(store.isEmpty())
  }
}
