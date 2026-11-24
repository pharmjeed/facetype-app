package ai.facetype.capture.quality

import android.util.Log

/**
 * The emitting build of the aggregate capture-quality diagnostic.
 *
 * WHEN THIS FILE IS COMPILED AT ALL. Only into a debug variant assembled with
 * `-PfacetypeCalibrationDiagnostics=true` (surfaced as
 * `python tools/task.py android-apk --calibration-diagnostics`). Every other
 * build -- a plain `assembleDebug`, the default tester APK, and every release
 * variant without exception -- compiles the empty-bodied twin in
 * `src/quiet/java/` under this same fully-qualified name instead. See the
 * `sourceSets` block in app/build.gradle: the release source set is wired to
 * `src/quiet/java` unconditionally, so no flag can make a release build emit.
 *
 * WHY A SOURCE SET RATHER THAN A BuildConfig BOOLEAN. A boolean leaves the
 * emitting statement, and this tag, compiled into every debug APK, so what a
 * tester is holding depends on a branch nobody can see from the artifact.
 * Source-set membership makes the difference visible in the dex itself, which
 * is what tools/build_android_apk.py reads back: `assert_installable` refuses
 * an APK whose dex carries this tag unless the build explicitly asked for it.
 *
 * WHAT MAY BE LOGGED. Only the six aggregate scores that are already the
 * pass/fail inputs of the capture gate: blur, exposure, neutrality,
 * faceCount, yawDeg, pitchDeg. Every one is a single scalar summarising a
 * frame -- none of them can reconstruct a face.
 *
 * WHAT MAY NEVER BE LOGGED, in any build. Image bytes, landmark or texture
 * or triangle arrays, head-pose matrices, blendshape activations, observation
 * or session identifiers, tokens, or anything else derived from a specific
 * person. FT-00 treats meshes, geometry and embeddings as biometric-like
 * data, and logcat is world-readable to anyone with the handset. The
 * parameter list of [logAggregate] is the enforcement: it accepts scalars
 * only, so there is nothing sensitive in scope to interpolate by accident.
 */
internal object CaptureQualityDiagnostics {

  const val TAG = "FaceTypeQuality"

  fun logAggregate(
    blur: Double,
    exposure: Double,
    neutrality: Double,
    faceCount: Int,
    yawDeg: Double,
    pitchDeg: Double,
  ) {
    Log.d(
      TAG,
      "blur=$blur exposure=$exposure neutrality=$neutrality " +
        "faceCount=$faceCount yawDeg=$yawDeg pitchDeg=$pitchDeg",
    )
  }
}
