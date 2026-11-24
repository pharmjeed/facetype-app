package ai.facetype.capture.rawframe

import ai.facetype.capture.quality.Nv21Argb
import android.graphics.Bitmap
import java.io.ByteArrayOutputStream

/**
 * Encodes one camera frame as a JPEG, for a consented field-study photograph.
 *
 * WHAT IT ENCODES, AND WHAT IT CANNOT. Its only input is an NV21 buffer copied
 * out of ARCore's own camera image ([ai.facetype.capture.FaceTypePreviewView.
 * copyCameraImage]). It never reads the window, the `SurfaceView`, the view
 * hierarchy or the display: there is no screenshot path here to review, because
 * there is no drawing surface in scope. A photograph produced by this object
 * therefore cannot contain the app's own overlay, another app's content, or
 * anything on screen that was not in front of the camera.
 *
 * WHY IT REUSES `Nv21Argb`. That object already owns the NV21 → upright ARGB
 * conversion the ML Kit path depends on, including the rotation convention and
 * — importantly — the guarantee that the intermediate full-resolution pixel
 * array is zeroed the moment its reader returns. A second conversion here would
 * be a second copy of a face with a second set of lifetime rules, and a second
 * chance for the rotation convention to disagree with the one the detector uses.
 *
 * WHY THE IMAGE IS NOT MIRRORED. The front camera's buffer is in sensor
 * handedness; the preview mirrors it for the user's benefit, and a reference
 * photograph must not. A calibration reviewer comparing the photograph with a
 * left-25° pose needs the participant's real left, not the one a mirror shows.
 */
internal object RawFrameJpeg {

  /**
   * Keep more photographic detail for later review. This is an encoder
   * setting, not a measured quality score or a claim of full sensor resolution.
   */
  private const val QUALITY = 95

  /** The encoded frame plus its upright dimensions, or null if encoding failed. */
  class Encoded(val jpeg: ByteArray, val width: Int, val height: Int)

  /**
   * Encodes [nv21] as an upright JPEG.
   *
   * Returns null rather than throwing for a frame this build cannot convert: a
   * field capture that could not take a photograph still collects geometry, and
   * the operator is told which pose has no image. [rotationDegrees] is the same
   * clockwise correction the detector is given, so the photograph and the
   * measurement agree about which way up the frame was.
   */
  fun encode(nv21: ByteArray, width: Int, height: Int, rotationDegrees: Int): Encoded? =
    try {
      Nv21Argb.withUprightArgb(nv21, width, height, rotationDegrees) { pixels, uprightWidth, uprightHeight ->
        val bitmap = Bitmap.createBitmap(pixels, uprightWidth, uprightHeight, Bitmap.Config.ARGB_8888)
        try {
          val stream = ByteArrayOutputStream(uprightWidth * uprightHeight / 8)
          val compressed = bitmap.compress(Bitmap.CompressFormat.JPEG, QUALITY, stream)
          if (compressed) Encoded(stream.toByteArray(), uprightWidth, uprightHeight) else null
        } finally {
          // The bitmap holds its own copy of the pixels, which `withUprightArgb`
          // is about to zero. Recycling it here is what keeps that second copy
          // from outliving the first.
          bitmap.recycle()
        }
      }
    } catch (_: Exception) {
      // A buffer layout, rotation or allocation this path cannot handle
      // produces no photograph rather than a corrupted one.
      null
    }
}
