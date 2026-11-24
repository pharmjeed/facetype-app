package ai.facetype.capture.quality

/*
 * The bundled Google ML Kit face detector, behind [FaceDetectorHandle].
 *
 * WHAT IS AND IS NOT IN THIS FILE. Only the parts that need Android: building
 * the detector, wrapping a frame as an `InputImage`, and turning ML Kit's
 * bounding boxes into [RoiRect]s. The lifecycle -- who may register a request,
 * who may settle it, when the detector may be closed and where a completion is
 * allowed to run -- lives in [DetectionPassRunner], which has no Android in it
 * and is therefore driven directly by JVM tests. That split matches
 * [MediaPipeBlendshapeHandle]/[BlendshapePassRunner], and exists for the same
 * reason: the bugs worth testing here are races, and a race that can only be
 * reproduced on a handset is a race nobody reproduces (Codex review
 * `2026-08-27T11-58-19Z`).
 *
 * WHY BUNDLED, NOT THE PLAY-SERVICES VARIANT. `com.google.mlkit:face-detection`
 * ships the model inside the APK. The thin variant
 * (`com.google.android.gms:play-services-mlkit-face-detection`) downloads it
 * from Google Play on first use, so a device that has just installed the app --
 * exactly the device a capture is attempted on first -- can be missing the
 * model at the moment it is needed. Failing the first scan of a fresh install
 * is not an acceptable degradation for a guided capture flow, so the model is
 * paid for in APK size instead.
 *
 * WHAT LEAVES THE DEVICE. Nothing about the face. ML Kit vision APIs are
 * on-device only; there is no cloud fallback and no network path for the
 * pixels. The SDK does pull in `com.google.android.datatransport`, which is
 * Google's own anonymous SDK-diagnostics transport -- SDK usage telemetry, not
 * image content. That is disclosed in `docs/mobile-android-install.md` and
 * remains an item for the physical-device network check, because this host
 * cannot observe the handset's traffic.
 *
 * WHAT THIS FILE MUST NEVER DO. Touch BiometricPrompt, the Android Keystore
 * biometric bindings or any biometric template (FT-00 s.3). ML Kit face
 * *detection* finds where a face is in an image; it is not face recognition,
 * builds no template, and produces no identifier. Detected geometry is used
 * only to place a rectangle for [PixelMetrics] and to count faces, and every
 * box is dropped as soon as those two things are derived.
 */

import android.graphics.Rect
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetector
import com.google.mlkit.vision.face.FaceDetectorOptions
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

internal class MlKitFaceDetectorHandle(
  detector: FaceDetector = FaceDetection.getClient(OPTIONS),
  callbackExecutor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "facetype-quality").apply { isDaemon = true }
  },
) : FaceDetectorHandle {

  private val runner = DetectionPassRunner(
    callbackExecutor = callbackExecutor,
    detection = { nv21, width, height, rotationDegrees, dispatcher, onComplete ->
      // Both calls can throw -- `fromByteArray` on a buffer that does not
      // describe the frame, `process` on a detector that has already been
      // closed -- and in neither case did ML Kit take the pixels. The runner
      // reads that throw as "nothing is reading this buffer", which is why
      // they are deliberately not caught here.
      val image = InputImage.fromByteArray(
        nv21,
        width,
        height,
        rotationDegrees,
        InputImage.IMAGE_FORMAT_NV21,
      )
      // One completion listener rather than success + failure listeners: the
      // request must be answered exactly once, and a pair of listeners is one
      // refactor away from answering it twice or not at all.
      //
      // The listener is registered on the runner's `dispatcher`, never on the
      // executor directly. An executor handed straight to Play services is one
      // that `close()` can shut down between this line and the completion, and
      // a completion submitted to a dead queue is silently dropped -- taking
      // both the answer and the frame's reader-done with it.
      detector.process(image).addOnCompleteListener(dispatcher) { task ->
        onComplete(if (task.isSuccessful) task.result?.map { toRoi(it.boundingBox) } else null)
      }
    },
    releaseDetector = { detector.close() },
  )

  override fun detect(
    nv21: ByteArray,
    width: Int,
    height: Int,
    rotationDegrees: Int,
    onFaces: (List<RoiRect>) -> Unit,
    onFailure: () -> Unit,
    onReaderDone: () -> Unit,
  ) = runner.submit(nv21, width, height, rotationDegrees, onFaces, onFailure, onReaderDone)

  /**
   * Releases the detector, having answered every in-flight request first.
   *
   * WHAT IT DELIBERATELY DOES NOT DO (Codex review `2026-08-26T23-29-26Z`).
   * It does not declare any buffer free that ML Kit has actually been given.
   * ML Kit offers no way to know whether a request it has not answered is still
   * being read, and the caller's release of those pixels is keyed on the
   * reader-done signal, which only the real completion listener can send. So a
   * request settled here is answered — a capture never waits on a detector that
   * is going away — while its pixels stay readable until ML Kit itself says
   * otherwise. A request ML Kit never received is both answered and freed,
   * because there is provably nobody reading it.
   *
   * The cost is explicit: if `detector.close()` never causes the listener to
   * run, that buffer is never zeroed and is reclaimed by the collector like any
   * other array. That is a weaker privacy posture than zeroing it, and a much
   * better one than zeroing a buffer a model is reading, which corrupts the
   * measurement rather than failing it.
   */
  override fun close() = runner.close()

  companion object {
    private fun toRoi(box: Rect): RoiRect = RoiRect(box.left, box.top, box.right, box.bottom)

    /**
     * FAST mode, no landmarks, no classification, no contours, no tracking.
     *
     * This is the minimum that answers the two questions the analyser is
     * allowed to ask -- how many faces, and where is the one face -- and the
     * cheapest configuration for a detector invoked once per capture. Every
     * richer mode was considered and rejected: landmark and classification
     * outputs would only be useful for occlusion and neutrality, which this
     * milestone deliberately leaves unmeasured rather than inferring them from
     * evidence that does not support them (see
     * `docs/adr/ADR-009-android-capture-quality-scope.md`).
     */
    private val OPTIONS: FaceDetectorOptions = FaceDetectorOptions.Builder()
      .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
      .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_NONE)
      .setContourMode(FaceDetectorOptions.CONTOUR_MODE_NONE)
      .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_NONE)
      // ML Kit's own default, restated so it is a reviewed choice rather than
      // an inherited one. It is also a real limit on what `faceCount` means:
      // a face spanning less than a tenth of the frame may not be reported at
      // all, so the count is a lower bound and `FT-SCAN-004` can miss a
      // distant bystander. Lowering it further trades detector cost for
      // sensitivity and is one of the things physical-device calibration has
      // to settle; it is recorded as an open limitation, not solved here.
      .setMinFaceSize(0.1f)
      .build()
  }
}
