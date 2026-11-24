package ai.facetype.capture.quality

/**
 * The silent build of the aggregate capture-quality diagnostic: it does not
 * exist as anything but a signature.
 *
 * WHERE THIS FILE IS COMPILED. Into every release variant, unconditionally,
 * and into every debug variant that was not assembled with
 * `-PfacetypeCalibrationDiagnostics=true` -- which is the default, so the
 * tester APK `tools/build_android_apk.py` produces contains this file and not
 * the emitting twin in `src/calibration/java/`.
 *
 * Same fully-qualified name and same signature as that twin, so the shared
 * call site in `FaceTypePreviewView.resolveCapture` compiles either way, but
 * with an empty body and no logging import: nothing is emitted and there is no
 * switch that could make it emit. `logAggregate` compiles to a bare `return`,
 * and the diagnostic's log tag is not in the dex at all -- which is the
 * property `assert_installable` reads back out of the APK. Keep this body
 * empty.
 */
internal object CaptureQualityDiagnostics {

  fun logAggregate(
    blur: Double,
    exposure: Double,
    neutrality: Double,
    faceCount: Int,
    yawDeg: Double,
    pitchDeg: Double,
  ) {
  }
}
