package ai.facetype.capture

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Stores the anonymous bearer token with a non-exportable Android Keystore key.
 *
 * This is ordinary app-secret encryption. It deliberately does not request
 * user authentication, fingerprints, face authentication, or device presence.
 */
class FaceTypeSecureSessionModule(context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {

    private val preferences = context.getSharedPreferences(PREFERENCES, 0)

    override fun getName(): String = "FaceTypeSecureSession"

    @ReactMethod
    fun saveSession(value: String, promise: Promise) {
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            val committed = preferences.edit()
                .putString(IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .putString(CIPHERTEXT, Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .commit()
            check(committed) { "Secure session ciphertext was not committed." }
            promise.resolve(null)
        } catch (error: Exception) {
            promise.reject("FT-AUTH-SECURE-SAVE", "Could not secure the session.", error)
        }
    }

    @ReactMethod
    fun loadSession(promise: Promise) {
        val iv = preferences.getString(IV, null)
        val ciphertext = preferences.getString(CIPHERTEXT, null)
        if (iv == null || ciphertext == null) {
            promise.resolve(null)
            return
        }
        try {
            val keyStore = keyStore()
            val key = keyStore.getKey(KEY_ALIAS, null) as? SecretKey
            if (key == null) {
                clearStoredValues()
                promise.resolve(null)
                return
            }
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                key,
                GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)),
            )
            val plain = cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP))
            promise.resolve(String(plain, Charsets.UTF_8))
        } catch (_: Exception) {
            // A replaced/inaccessible key makes the checkpoint unusable. Erase
            // the ciphertext and let the app start a fresh anonymous session.
            clearStoredValues()
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun clearSession(promise: Promise) {
        try {
            val keyStore = keyStore()
            if (keyStore.containsAlias(KEY_ALIAS)) keyStore.deleteEntry(KEY_ALIAS)
            check(clearStoredValues()) { "Secure session ciphertext was not cleared." }
            promise.resolve(null)
        } catch (error: Exception) {
            promise.reject("FT-AUTH-SECURE-CLEAR", "Could not clear the session.", error)
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = keyStore()
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE).run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setUserAuthenticationRequired(false)
                    .build(),
            )
            generateKey()
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }

    private fun clearStoredValues(): Boolean =
        preferences.edit().remove(IV).remove(CIPHERTEXT).commit()

    private companion object {
        const val ANDROID_KEY_STORE = "AndroidKeyStore"
        const val KEY_ALIAS = "ai.facetype.session.aes"
        const val PREFERENCES = "facetype_secure_session"
        const val IV = "iv"
        const val CIPHERTEXT = "ciphertext"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
