package ai.facetype.client

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.io.OutputStream
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Wraps spool data keys with a non-exportable Android Keystore AES-256-GCM key.
 *
 * Ordinary app-secret encryption, like `FaceTypeSecureSessionModule`: it does
 * NOT request user authentication, and it never touches BiometricPrompt, Face
 * ID / face unlock, or any biometric-bound key (FT-00 s.3).
 */
internal class KeystoreKeyWrapper(private val alias: String = KEY_ALIAS) : KeyWrapper {

  override fun wrap(dataKey: ByteArray): KeyWrapper.Wrapped {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key(create = true))
    val wrapped = cipher.doFinal(dataKey)
    return KeyWrapper.Wrapped(cipher.iv, wrapped)
  }

  override fun unwrap(iv: ByteArray, wrappedKey: ByteArray): ByteArray {
    val key = key(create = false) ?: throw IllegalStateException("the spool key is gone")
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
    return cipher.doFinal(wrappedKey)
  }

  @Synchronized
  private fun key(create: Boolean): SecretKey? {
    val store = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
    (store.getKey(alias, null) as? SecretKey)?.let { return it }
    if (!create) return null
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE).run {
      init(
        KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
          .setKeySize(256)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setUserAuthenticationRequired(false)
          .build(),
      )
      generateKey()
    }
  }

  companion object {
    const val ANDROID_KEY_STORE = "AndroidKeyStore"
    const val KEY_ALIAS = "ai.facetype.client.spool.aes"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
  }
}

/**
 * The encrypted, app-private frame spool: `noBackupFilesDir/client_spool/`.
 *
 * `noBackupFilesDir` is excluded from Auto Backup and device-transfer by the
 * platform (and the manifest also sets `allowBackup="false"`). Every file is
 * [SpoolFormat] ciphertext; no JPEG byte is ever written here in the clear.
 * Files leave by [delete] (after the server confirms) or by JavaScript's 48 h
 * cleanup calling [delete].
 */
internal class ClientSpool(context: Context, private val wrapper: KeyWrapper = KeystoreKeyWrapper()) {

  val directory: File = File(context.applicationContext.noBackupFilesDir, DIRECTORY).apply { mkdirs() }

  data class Entry(val id: String, val bytes: Long, val createdAtMs: Long, val sha256: String)

  fun write(id: String, createdAtMs: Long, jpeg: ByteArray) {
    requireValidId(id)
    SpoolFormat.write(fileFor(id), id, createdAtMs, jpeg, wrapper)
  }

  /** Header of a stored frame, or null if there is none. */
  fun entry(id: String): Entry? {
    requireValidId(id)
    val file = fileFor(id)
    if (!file.isFile) return null
    val header = SpoolFormat.readHeader(file)
    if (header.id != id) throw SpoolCorruptException("spool file name and header disagree")
    return Entry(header.id, header.plainLength, header.createdAtMs, header.sha256Hex)
  }

  /** Streams the authenticated JPEG bytes of [id] into [sink]. */
  fun decryptTo(id: String, sink: OutputStream): Long {
    requireValidId(id)
    return SpoolFormat.decryptTo(fileFor(id), wrapper, sink)
  }

  /**
   * Stores [id]'s FrameMeta JSON encrypted beside its JPEG (contract §5.12),
   * so JavaScript can resume uploads after a restart without ever keeping
   * landmarks or blendshapes in its own storage. The header id is
   * `<id>.meta`, so a meta file can never pass for a frame and vice versa.
   */
  fun writeMeta(id: String, json: String) {
    requireValidId(id)
    SpoolFormat.write(metaFileFor(id), id + META_ID_SUFFIX, System.currentTimeMillis(), json.toByteArray(Charsets.UTF_8), wrapper)
  }

  /** [id]'s FrameMeta JSON, or null if none is stored. */
  fun readMeta(id: String): String? {
    requireValidId(id)
    val file = metaFileFor(id)
    if (!file.isFile) return null
    val header = SpoolFormat.readHeader(file)
    if (header.id != id + META_ID_SUFFIX) throw SpoolCorruptException("meta file name and header disagree")
    val out = java.io.ByteArrayOutputStream(header.plainLength.toInt().coerceAtLeast(0))
    SpoolFormat.decryptTo(file, wrapper, out)
    return String(out.toByteArray(), Charsets.UTF_8)
  }

  /** Deletes [id]'s frame and its meta; true if the frame existed. Idempotent. */
  fun delete(id: String): Boolean {
    requireValidId(id)
    val meta = metaFileFor(id)
    if (meta.exists()) meta.delete()
    val file = fileFor(id)
    return file.exists() && file.delete()
  }

  /** Every complete spool entry; interrupted `.part` files are removed (they are ciphertext). */
  fun list(): List<Entry> {
    val files = directory.listFiles() ?: return emptyList()
    val out = ArrayList<Entry>()
    for (file in files) {
      val name = file.name
      if (name.endsWith(PART_SUFFIX)) {
        // An interrupted write (ciphertext only). A recent one may still be in progress.
        if (System.currentTimeMillis() - file.lastModified() > STALE_PART_MS) file.delete()
        continue
      }
      if (!name.endsWith(SUFFIX)) continue
      val id = name.removeSuffix(SUFFIX)
      if (!isValidId(id)) continue
      try {
        val header = SpoolFormat.readHeader(file)
        if (header.id == id) out.add(Entry(id, header.plainLength, header.createdAtMs, header.sha256Hex))
      } catch (_: Exception) {
        // An unreadable header is unusable ciphertext; leave it for deleteFrames.
      }
    }
    return out.sortedBy { it.createdAtMs }
  }

  private fun fileFor(id: String) = File(directory, id + SUFFIX)

  private fun metaFileFor(id: String) = File(directory, id + META_SUFFIX)

  companion object {
    const val DIRECTORY = "client_spool"
    const val SUFFIX = ".ftc"
    const val PART_SUFFIX = ".ftc.part"
    /** Meta sidecars end in `.meta.ftc`; [list] skips them (the stem is not a frame id). */
    const val META_SUFFIX = ".meta.ftc"
    const val META_ID_SUFFIX = ".meta"
    const val STALE_PART_MS = 60_000L

    fun isValidId(id: String): Boolean = FrameIds.isValid(id)

    fun requireValidId(id: String) = FrameIds.requireValid(id)

    @Volatile private var shared: ClientSpool? = null

    fun get(context: Context): ClientSpool =
      shared ?: synchronized(this) { shared ?: ClientSpool(context).also { shared = it } }
  }
}
