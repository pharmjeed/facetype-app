package ai.facetype.client

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * `FaceTypeClientCamera` (`docs/client-native-interface.md` §3).
 *
 * Burst calls go to the camera of the mounted, active
 * `FaceTypeClientCameraView`; spool and upload calls run on a small I/O pool
 * so a slow network never blocks the bridge or the camera.
 */
class FaceTypeClientCameraModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {

  private val io: ExecutorService = Executors.newFixedThreadPool(2) { runnable ->
    Thread(runnable, "facetype-client-io").apply { isDaemon = true }
  }
  private val spool by lazy { ClientSpool.get(context) }
  private val uploader by lazy { ClientUploader(spool) }

  override fun getName(): String = NAME

  @ReactMethod
  fun getCapabilities(promise: Promise) {
    io.execute {
      try {
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val cameraId = ClientCameraRegistry.session()?.boundCameraId
          ?: manager.cameraIdList.firstOrNull { id ->
            manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING) ==
              CameraCharacteristics.LENS_FACING_FRONT
          }
        if (cameraId == null) {
          promise.reject("camera_unavailable", "This device has no front camera.")
          return@execute
        }
        val chars = manager.getCameraCharacteristics(cameraId)
        val static = CameraInfoReader.readStatic(cameraId, chars)
        val front = linkedMapOf<String, Any?>(
          "id" to cameraId,
          "sizes" to CameraInfoReader.yuvSizes(chars).map { it.toList() },
          "focalLengthsMm" to static.focalLengthsMm,
          "sensorSizeMm" to static.physicalSizeMm?.toList(),
          "hasIntrinsicCalibration" to CameraInfoReader.hasIntrinsicCalibration(static),
          "distortionCorrection" to CameraInfoReader.distortionCorrectionCapability(static),
        )
        val result = linkedMapOf<String, Any?>(
          "platform" to "android",
          "deviceModel" to (Build.MODEL ?: ""),
          "manufacturer" to (Build.MANUFACTURER ?: ""),
          "osVersion" to (Build.VERSION.RELEASE ?: ""),
          "frontCamera" to front,
          "mediapipeModelSha256" to ClientLandmarker.modelSha256(context),
        )
        promise.resolve(ReactMaps.toWritableMap(result))
      } catch (error: Exception) {
        promise.reject("camera_unavailable", "Camera characteristics could not be read: ${error.message}", error)
      }
    }
  }

  @ReactMethod
  fun startBurst(options: ReadableMap, promise: Promise) {
    val parsed = try {
      ClientCameraSession.BurstOptions(
        targetFrames = positiveInt(options, "targetFrames"),
        maxDurationMs = positiveNumber(options, "maxDurationMs").toLong(),
        minSpacingMs = nonNegativeNumber(options, "minSpacingMs").toLong(),
        minCoverageMs = nonNegativeNumber(options, "minCoverageMs").toLong(),
      )
    } catch (error: IllegalArgumentException) {
      promise.reject("invalid_argument", error.message, error)
      return
    }
    val session = ClientCameraRegistry.session()
    if (session == null) {
      promise.reject("camera_unavailable", "No active FaceTypeClientCameraView.")
      return
    }
    session.startBurst(parsed, object : ClientCameraSession.BurstListener {
      override fun resolved(result: Map<String, Any?>) = promise.resolve(ReactMaps.toWritableMap(result))

      override fun rejected(code: String, message: String) = promise.reject(code, message)
    })
  }

  @ReactMethod
  fun cancelBurst(promise: Promise) {
    val session = ClientCameraRegistry.session()
    if (session == null) {
      promise.resolve(null)
      return
    }
    session.cancelBurst { promise.resolve(null) }
  }

  /**
   * Rejection codes (contract §5.9): `invalid_argument`, `not_found`,
   * `spool_unreadable` (authentication or key failure), `spool_error` (I/O),
   * `upload_failed` (transport). An HTTP error status resolves; JavaScript
   * owns retries.
   */
  @ReactMethod
  fun uploadFrame(id: String, target: ReadableMap, promise: Promise) {
    io.execute {
      try {
        FrameIds.requireValid(id)
        val url = (if (target.hasKey("url")) target.getString("url") else null)
          ?.takeIf { it.startsWith("https://") || it.startsWith("http://") }
          ?: throw IllegalArgumentException("uploadFrame needs an http(s) target.url.")
        val method = if (target.hasKey("method")) target.getString("method") else null
        require(method.equals("PUT", ignoreCase = true)) { "uploadFrame only performs PUT." }
        val headers = if (target.hasKey("headers") && target.getType("headers") == ReadableType.Map) {
          ReactMaps.stringMap(target.getMap("headers"))
        } else {
          emptyMap()
        }
        val entry = try {
          spool.entry(id)
        } catch (error: SpoolCorruptException) {
          promise.reject("spool_unreadable", error.message, error)
          return@execute
        } catch (error: IOException) {
          promise.reject("spool_error", error.message, error)
          return@execute
        }
        if (entry == null) {
          promise.reject("not_found", "No spooled frame with that id.")
          return@execute
        }
        val status = try {
          uploader.upload(entry, url, headers)
        } catch (error: SpoolCorruptException) {
          promise.reject("spool_unreadable", error.message, error)
          return@execute
        } catch (error: IOException) {
          promise.reject("upload_failed", error.message, error)
          return@execute
        }
        promise.resolve(ReactMaps.toWritableMap(linkedMapOf("status" to status)))
      } catch (error: IllegalArgumentException) {
        promise.reject("invalid_argument", error.message, error)
      } catch (error: Exception) {
        promise.reject("upload_failed", error.message, error)
      }
    }
  }

  /** The FrameMeta stored beside a spooled frame (contract §3, §5.12). */
  @ReactMethod
  fun getFrameMeta(id: String, promise: Promise) {
    io.execute {
      try {
        FrameIds.requireValid(id)
        val json = spool.readMeta(id)
        if (json == null) {
          promise.reject("not_found", "No stored FrameMeta for that id.")
          return@execute
        }
        val parsed = try {
          Json.parse(json) as? Map<*, *>
        } catch (error: IllegalArgumentException) {
          null
        } ?: throw SpoolCorruptException("stored FrameMeta is not a JSON object")
        promise.resolve(ReactMaps.toWritableMap(parsed.entries.associate { (k, v) -> k.toString() to v }))
      } catch (error: IllegalArgumentException) {
        promise.reject("invalid_argument", error.message, error)
      } catch (error: SpoolCorruptException) {
        promise.reject("spool_unreadable", error.message, error)
      } catch (error: Exception) {
        promise.reject("spool_error", error.message, error)
      }
    }
  }

  @ReactMethod
  fun deleteFrames(ids: ReadableArray, promise: Promise) {
    io.execute {
      try {
        val list = ReactMaps.stringList(ids)
        list.forEach { FrameIds.requireValid(it) }
        list.forEach { spool.delete(it) }
        promise.resolve(null)
      } catch (error: IllegalArgumentException) {
        promise.reject("invalid_argument", error.message, error)
      } catch (error: Exception) {
        promise.reject("spool_error", error.message, error)
      }
    }
  }

  @ReactMethod
  fun listSpool(promise: Promise) {
    io.execute {
      try {
        val entries = spool.list().map {
          linkedMapOf<String, Any?>("id" to it.id, "bytes" to it.bytes, "createdAtMs" to it.createdAtMs)
        }
        promise.resolve(ReactMaps.toWritableArray(entries))
      } catch (error: Exception) {
        promise.reject("spool_error", error.message, error)
      }
    }
  }

  override fun invalidate() {
    io.shutdown()
    super.invalidate()
  }

  private fun number(map: ReadableMap, key: String): Double {
    require(map.hasKey(key) && map.getType(key) == ReadableType.Number) { "$key must be a number" }
    val value = map.getDouble(key)
    require(value.isFinite()) { "$key must be finite" }
    return value
  }

  private fun positiveNumber(map: ReadableMap, key: String): Double =
    number(map, key).also { require(it > 0) { "$key must be positive" } }

  private fun nonNegativeNumber(map: ReadableMap, key: String): Double =
    number(map, key).also { require(it >= 0) { "$key must not be negative" } }

  private fun positiveInt(map: ReadableMap, key: String): Int {
    val value = positiveNumber(map, key)
    require(value == Math.rint(value) && value <= 1000) { "$key must be a whole number" }
    return value.toInt()
  }

  companion object {
    const val NAME = "FaceTypeClientCamera"
  }
}
