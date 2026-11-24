package ai.facetype.capture.quality

/*
 * MediaPipe's face-landmarker blendshape head, behind [FaceBlendshapeHandle].
 *
 * WHAT IS AND IS NOT IN THIS FILE. Only the parts that need Android: creating
 * the task, converting a frame, reading the categories out of a result. The
 * lifecycle -- who owns the pixel buffer, who may settle a request, and when
 * the native task may be closed -- lives in [BlendshapePassRunner], which has
 * no Android in it and is therefore driven directly by JVM tests. That split
 * exists because the bug worth testing here is a race, and a race that can only
 * be reproduced on a handset is a race nobody reproduces.
 *
 * WHAT THIS READS, AND WHAT IT DELIBERATELY DOES NOT. Only the 52 blendshape
 * categories. The same bundle also produces 478 landmarks and a facial
 * transformation matrix, and this app takes neither: the mesh comes from
 * ARCore, travels with its own topology mapping and provenance, and a second
 * geometry source arriving through a side door would mean two meshes with one
 * `landmarkTopology` label on the wire. `setOutputFacialTransformationMatrixes`
 * is therefore off, and the landmark list is discarded unread.
 *
 * WHY IT CANNOT SUPPLY OCCLUSION, WHICH IS THE FIRST THING ANYONE WILL ASK.
 * The landmark model in this bundle declares exactly three outputs in its own
 * embedded metadata: 478 undecoded x/y/z coordinates, one whole-face presence
 * scalar, and a tongue-out score. There is no per-landmark visibility. Unlike
 * Vision on iOS -- which reports which facial regions it localised, and can
 * report that it localised none -- MediaPipe regresses every point whatever is
 * covering the face, so "how many regions came back" is the constant 478, and
 * an occlusion score derived from it would be a hard 0.0: a fabricated pass on
 * every frame, which is strictly worse than the explicit null this path keeps
 * reporting. See ADR-010.
 *
 * WHAT LEAVES THE DEVICE. Nothing. The model is packaged in the APK by
 * `fetchFaceLandmarkerModel`, the task runs in IMAGE mode in this process, and
 * the AAR declares no permissions of its own.
 *
 * WHAT THIS FILE MUST NEVER DO. Touch BiometricPrompt, the Keystore biometric
 * bindings or any biometric template (FT-00 s.3). This is expression
 * measurement, not recognition: it builds no template and no identifier, and
 * the activations are used to decide whether a face is at rest and then to
 * remove expression as a nuisance variable (FT-01 s.15) -- never as a feature.
 */

import android.content.Context
import android.graphics.Bitmap
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker
import java.util.concurrent.Executors

internal class MediaPipeBlendshapeHandle private constructor(
  private val runner: BlendshapePassRunner,
) : FaceBlendshapeHandle {

  override fun blendshapes(
    nv21: ByteArray,
    width: Int,
    height: Int,
    rotationDegrees: Int,
    onBlendshapes: (Map<String, Float>) -> Unit,
    onFailure: () -> Unit,
    onReaderDone: () -> Unit,
  ) = runner.submit(
    nv21,
    width,
    height,
    rotationDegrees,
    onBlendshapes,
    onFailure,
    onReaderDone,
  )

  override fun close() = runner.close()

  companion object {
    /** Packaged by `fetchFaceLandmarkerModel`; see `app/build.gradle`. */
    const val MODEL_ASSET_PATH: String = "face_landmarker.task"

    /**
     * Runs one pass and returns the activations, or null.
     *
     * `detect` is synchronous in IMAGE running mode, so this function's return
     * value *is* the result -- there is no second callback to reconcile. It
     * runs on the worker thread, which has claimed [nv21] before calling in;
     * nothing else reads those bytes while this is on the stack.
     *
     * THREE COPIES OF ONE FACE, AND EACH ONE IS RELEASED BY NAME. The caller's
     * NV21 bytes are zeroed by [FaceQualityAnalyzer]'s ownership count once
     * this returns; the ARGB conversion is zeroed by
     * [Nv21Argb.withUprightArgb], which is why the whole body of this function
     * is inside that call rather than beside it (Codex review
     * `2026-08-27T11-58-19Z`); the bitmap those pixels were copied into is
     * recycled below. An earlier version released the first and the third and
     * silently left the second -- the largest of the three -- to the collector.
     */
    private fun measure(
      landmarker: FaceLandmarker,
      nv21: ByteArray,
      width: Int,
      height: Int,
      rotationDegrees: Int,
    ): Map<String, Float>? = Nv21Argb.withUprightArgb(
      nv21,
      width,
      height,
      rotationDegrees,
    ) { pixels, uprightWidth, uprightHeight ->
      val bitmap =
        Bitmap.createBitmap(pixels, uprightWidth, uprightHeight, Bitmap.Config.ARGB_8888)
      // NESTED, AND IN THIS ORDER, ON PURPOSE. `MPImage` is `Closeable` and
      // holds a container referencing the bitmap; the first version built one
      // inline and never closed it, which leaks a native handle for every
      // capture, and recycling the bitmap while that container still pointed at
      // it would be a use-after-free rather than a leak. So: close the image
      // first, then release the pixels it was reading -- and only once both are
      // gone does `withUprightArgb` wipe the array they were built from.
      try {
        val image = BitmapImageBuilder(bitmap).build()
        try {
          val result = landmarker.detect(image)
          val faces = result.faceBlendshapes()
          if (!faces.isPresent) return@withUprightArgb null
          // numFaces is 1, so a second entry here would mean the task had been
          // reconfigured. ML Kit is what counts faces, and it has already run.
          val categories = faces.get().firstOrNull() ?: return@withUprightArgb null
          if (categories.isEmpty()) return@withUprightArgb null
          val activations = HashMap<String, Float>(categories.size)
          for (category in categories) {
            activations[category.categoryName()] = category.score()
          }
          activations
        } finally {
          image.close()
        }
      } finally {
        // The converted copy of the user's face does not outlive the
        // measurement that needed it, which is the rule the NV21 buffer itself
        // already follows.
        bitmap.recycle()
      }
    }

    /**
     * Creates the handle, or returns null if this device cannot run it.
     *
     * Null is a real outcome, not a defensive catch: a missing asset, or a
     * device the task will not initialise on, means neutrality is unmeasurable
     * here, and the analyser reports that as `FT-SCAN-014`. Returning null
     * rather than throwing keeps blur, exposure and the face count working, so
     * a user with no face in frame is still told that rather than a blanket
     * "could not measure".
     */
    fun create(context: Context): MediaPipeBlendshapeHandle? = runCatching {
      val options = FaceLandmarker.FaceLandmarkerOptions.builder()
        .setBaseOptions(BaseOptions.builder().setModelAssetPath(MODEL_ASSET_PATH).build())
        // One frame in, one answer out. LIVE_STREAM would make this a second
        // asynchronous producer racing the capture coordinator's frame
        // identity, which is the bug FrameIdentity exists to prevent.
        .setRunningMode(RunningMode.IMAGE)
        .setNumFaces(1)
        .setOutputFaceBlendshapes(true)
        // The mesh is ARCore's, with its own provenance. See the file header.
        .setOutputFacialTransformationMatrixes(false)
        .build()
      val landmarker = FaceLandmarker.createFromOptions(context.applicationContext, options)
      MediaPipeBlendshapeHandle(
        BlendshapePassRunner(
          worker = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "facetype-blendshapes").apply { isDaemon = true }
          },
          measure = { nv21, width, height, rotation ->
            measure(landmarker, nv21, width, height, rotation)
          },
          releaseModel = { landmarker.close() },
        ),
      )
    }.getOrNull()
  }
}
