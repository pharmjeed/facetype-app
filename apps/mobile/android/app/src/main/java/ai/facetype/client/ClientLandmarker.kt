package ai.facetype.client

import android.content.Context
import android.graphics.Bitmap
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker
import java.io.Closeable
import java.security.MessageDigest

/**
 * MediaPipe Face Landmarker for the client camera: landmarks (478), the 52
 * blendshapes and the facial transformation matrix, for up to `numFaces`
 * faces, on the downscaled upright copy of the analysed frame.
 *
 * RUNNING MODE IS IMAGE ON PURPOSE. The contract asks for unsmoothed per-frame
 * values. VIDEO/LIVE_STREAM modes carry state between frames (tracking ROIs
 * from the previous result, landmark smoothing), so a frame's numbers would
 * partly describe its predecessors. IMAGE mode runs detection and landmarks on
 * this frame alone; with `numFaces = 2` and one face in view the streaming
 * modes would re-run the detector on every frame anyway, so little speed is
 * given up. Recorded in every FrameMeta under `mediapipe_options`.
 *
 * On-device only: the model is packaged in the APK (`fetchFaceLandmarkerModel`,
 * pinned SHA-256), the CPU delegate runs in this process, and nothing about
 * the face leaves the device from here. This is expression and geometry
 * measurement, not recognition; it never touches biometric APIs.
 */
internal class ClientLandmarker private constructor(
  private val landmarker: FaceLandmarker,
  val options: Map<String, Any?>,
) : Closeable {

  class Face(
    /** Flat `[x, y, z] * 478`, normalised to the image MediaPipe was given. */
    val landmarks: FloatArray,
    val blendshapes: Map<String, Float>?,
    /** Column-major 4x4, or null. */
    val transform: FloatArray?,
  )

  fun detect(bitmap: Bitmap): List<Face> {
    val image = BitmapImageBuilder(bitmap).build()
    try {
      val result = landmarker.detect(image)
      val landmarkLists = result.faceLandmarks()
      val blendshapeLists = result.faceBlendshapes().orElse(null)
      val matrices = result.facialTransformationMatrixes().orElse(null)
      val faces = ArrayList<Face>(landmarkLists.size)
      for ((index, points) in landmarkLists.withIndex()) {
        val flat = FloatArray(points.size * 3)
        for ((i, point) in points.withIndex()) {
          flat[i * 3] = point.x()
          flat[i * 3 + 1] = point.y()
          flat[i * 3 + 2] = point.z()
        }
        val categories = blendshapeLists?.getOrNull(index)
        val blendshapes = categories?.takeIf { it.isNotEmpty() }?.associate { it.categoryName() to it.score() }
        faces.add(Face(flat, blendshapes, matrices?.getOrNull(index)?.copyOf()))
      }
      return faces
    } finally {
      image.close()
    }
  }

  override fun close() = landmarker.close()

  companion object {
    const val MODEL_ASSET_PATH = "face_landmarker.task"
    const val TASKS_VISION_VERSION = "0.10.35"
    const val MIN_DETECTION_CONFIDENCE = 0.5f
    const val MIN_PRESENCE_CONFIDENCE = 0.5f

    /** The landmarker, or the failure that prevented it (reported as `model_unavailable`). */
    fun create(context: Context, numFaces: Int): Result<ClientLandmarker> = runCatching {
      val options = FaceLandmarker.FaceLandmarkerOptions.builder()
        .setBaseOptions(
          BaseOptions.builder()
            .setModelAssetPath(MODEL_ASSET_PATH)
            .setDelegate(Delegate.CPU)
            .build(),
        )
        .setRunningMode(RunningMode.IMAGE)
        .setNumFaces(numFaces)
        .setMinFaceDetectionConfidence(MIN_DETECTION_CONFIDENCE)
        .setMinFacePresenceConfidence(MIN_PRESENCE_CONFIDENCE)
        .setOutputFaceBlendshapes(true)
        .setOutputFacialTransformationMatrixes(true)
        .build()
      val landmarker = FaceLandmarker.createFromOptions(context.applicationContext, options)
      ClientLandmarker(
        landmarker,
        linkedMapOf(
          "tasks_vision_version" to TASKS_VISION_VERSION,
          "model_asset" to MODEL_ASSET_PATH,
          "running_mode" to "IMAGE",
          "delegate" to "CPU",
          "num_faces" to numFaces,
          "min_face_detection_confidence" to MIN_DETECTION_CONFIDENCE.toDouble(),
          "min_face_presence_confidence" to MIN_PRESENCE_CONFIDENCE.toDouble(),
          "output_face_blendshapes" to true,
          "output_facial_transformation_matrixes" to true,
          "smoothing" to false,
        ),
      )
    }

    @Volatile private var cachedModelSha: String? = null

    /** SHA-256 of the model bundle actually packaged in this APK, or null if it cannot be read. */
    fun modelSha256(context: Context): String? {
      cachedModelSha?.let { return it }
      return try {
        val digest = MessageDigest.getInstance("SHA-256")
        context.assets.open(MODEL_ASSET_PATH).use { input ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            digest.update(buffer, 0, read)
          }
        }
        ClientGateConfig.hex(digest.digest()).also { cachedModelSha = it }
      } catch (_: Exception) {
        null
      }
    }
  }
}
