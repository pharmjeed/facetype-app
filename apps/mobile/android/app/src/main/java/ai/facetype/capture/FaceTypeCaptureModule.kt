package ai.facetype.capture

/*
 * FaceTypeCaptureModule — ARCore Augmented Faces bridge.
 *
 * WHAT THIS MODULE DOES
 * Forwards Promise-based start/capture/stop calls to whichever
 * [FaceTypePreviewView] is currently mounted (via [FaceTypePreviewRegistry]),
 * and owns the one piece of ARCore setup that has to run before any preview
 * exists at all: `ArCoreApk.requestInstall`, which needs a foreground
 * Activity and may launch Google Play Services' own installer Activity.
 *
 * WHAT THIS MODULE MUST NEVER DO
 * Own a `Session`, a GL context or an ARCore render thread. Design review D1/
 * D2 (message 2026-08-25T21-54-44Z_53356c299477) moved all of that to
 * [FaceTypePreviewView], which has the one thread ARCore actually needs
 * (`GLSurfaceView`'s own GL thread) instead of a private `HandlerThread` that
 * raced RN's native-modules thread against a live `Frame`/`AugmentedFace`.
 *
 * It also must never touch BiometricPrompt, the Android Keystore biometric
 * bindings, or any biometric template. FT-00 §3 forbids it. Those APIs are
 * not imported here and must not be added: `make security-scan` fails the
 * build if they appear in executable code anywhere in the tree.
 *
 * ARCore Augmented Faces is a public rendering API. It is unrelated to the
 * biometric authentication subsystem, and that separation is what makes this
 * module permissible.
 */

import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.ar.core.ArCoreApk
import com.google.ar.core.exceptions.UnavailableDeviceNotCompatibleException
import com.google.ar.core.exceptions.UnavailableUserDeclinedInstallationException
import java.util.concurrent.atomic.AtomicReference

class FaceTypeCaptureModule(context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context), LifecycleEventListener {

  // ArCoreApk.requestInstall's own contract: pass true the first time it is
  // asked for a given foreground activity, then false on every subsequent
  // call so a user who already agreed (or already has ARCore) is not asked
  // again. Google Play Services for AR may run its own installer Activity in
  // between, which is why this has to survive a host pause/resume rather than
  // living on the call stack of a single start() invocation.
  @Volatile private var arCoreInstallUserRequested = false

  // requestInstall(activity, false) returning INSTALL_REQUESTED pauses this
  // Activity to run Google Play Services' own installer. The original
  // start() call cannot resolve or reject yet: it has to be retried from
  // onHostResume once the installer Activity hands control back. Holding the
  // caller's own Promise here (instead of settling it with a generic error)
  // is what makes that retry an actual continuation of the same start() call
  // rather than a second, caller-triggered scan.
  //
  // An AtomicReference rather than a @Volatile field (Codex M2 requirement G):
  // onHostResume and invalidate can both reach for this promise, and a
  // read-then-null pair is not atomic -- both could take the same Promise and
  // settle it twice, which React Native surfaces as a hard error. getAndSet
  // makes exactly one of them the owner.
  private val pendingStartPromise = AtomicReference<Promise?>(null)

  init {
    context.addLifecycleEventListener(this)
  }

  override fun getName(): String = "FaceTypeCapture"

  /**
   * ArCoreApk.checkAvailability can return UNKNOWN_CHECKING the first time it
   * runs on a device: it has not yet reached Google Play Services to learn
   * whether ARCore is installable. Resolving immediately on that transient
   * state would report a supported device as unsupported.
   * ArCoreApk.checkAvailabilityAsync(Context, Consumer) is Google's own
   * replacement for hand-rolled polling: it re-checks on Google's schedule,
   * guarantees its callback runs on the main thread, and never invokes the
   * callback with a still-transient (UNKNOWN_CHECKING) result -- so there is
   * no unbounded loop, no timeout to invent and nothing here to remove on
   * invalidate() because ARCore owns the retry, not this module.
   */
  @ReactMethod
  fun isAvailable(promise: Promise) {
    ArCoreApk.getInstance().checkAvailabilityAsync(reactApplicationContext) { availability ->
      promise.resolve(availability.isSupported)
    }
  }

  /**
   * ReactMethod invocations run on RN's native_modules queue, a dedicated
   * background thread distinct from the UI queue
   * (ReactQueueConfigurationSpec.createDefault() vs.
   * ReactQueueConfigurationImpl's mainThreadSpec() UI thread). attemptStart
   * calls ArCoreApk.requestInstall(activity, ...), which may launch Google
   * Play Services' own installer Activity and therefore must run on the UI
   * thread like any other Activity transition. onHostResume is already
   * guaranteed UI-thread by RN's LifecycleEventListener contract; this initial
   * entrypoint is not, so it has to be marshalled explicitly.
   */
  @ReactMethod
  fun start(promise: Promise) {
    reactApplicationContext.runOnUiQueueThread { attemptStart(promise) }
  }

  /**
   * The body of start(), factored out so onHostResume can drive the same
   * install-then-start attempt for a Promise that INSTALL_REQUESTED left
   * pending, instead of the caller having to invoke start() again (which
   * would begin a second, redundant scan).
   */
  @Synchronized
  private fun attemptStart(promise: Promise) {
    // SUPPORTED_NOT_INSTALLED / SUPPORTED_APK_TOO_OLD both need
    // ArCoreApk.requestInstall before a Session can be created; skipping it is
    // the difference between "installable" and "actually starts" on a
    // supported device that has never opened an ARCore app before.
    val activity = currentActivity
    if (activity == null) {
      promise.reject(
        "FT-REC-005",
        "ARCore capture needs a foreground activity to request installation.",
      )
      return
    }
    val installStatus =
      try {
        ArCoreApk.getInstance().requestInstall(activity, !arCoreInstallUserRequested)
      } catch (error: UnavailableDeviceNotCompatibleException) {
        arCoreInstallUserRequested = false
        promise.reject("FT-REC-005", "This device does not support ARCore.", error)
        return
      } catch (error: UnavailableUserDeclinedInstallationException) {
        arCoreInstallUserRequested = false
        promise.reject("FT-REC-005", "ARCore installation was declined.", error)
        return
      }
    if (installStatus == ArCoreApk.InstallStatus.INSTALL_REQUESTED) {
      // requestInstall launched Google Play Services' own installer Activity
      // and this Activity is about to pause. The promise must not be settled:
      // rejecting it here would surface a generic error to JS and, if the
      // caller reacted by calling start() again, would start a second,
      // orphaned scan. Instead hold the promise and let onHostResume continue
      // this exact attempt once requestInstall (called next with
      // userRequestedInstall=false) returns INSTALLED without prompting again.
      arCoreInstallUserRequested = true
      // Any promise already parked here belongs to an earlier start() that
      // this one supersedes; settling it keeps that caller from waiting
      // forever behind a promise nobody will ever resume.
      pendingStartPromise.getAndSet(promise)
        ?.reject("FT-REC-005", "A newer ARCore start request replaced this one.")
      return
    }
    arCoreInstallUserRequested = false

    val view = FaceTypePreviewRegistry.current()
    if (view == null) {
      // start() is only ever called from the JS preview-ready sequence
      // (App.tsx), which waits for the native `onPreviewReady` event before
      // calling it -- so this is a defensive fail-closed path, not the
      // expected route (design review D3, message
      // 2026-08-25T21-54-44Z_53356c299477).
      promise.reject("FT-REC-005", "Camera preview is not mounted.")
      return
    }
    view.startSession(promise)
  }

  @ReactMethod
  fun captureGeometry(pose: String, promise: Promise) {
    val view = FaceTypePreviewRegistry.current()
    if (view == null) {
      promise.reject("FT-REC-005", "Capture session is not running.")
      return
    }
    view.requestCapture(pose, promise)
  }

  @ReactMethod
  fun stop(promise: Promise) {
    val view = FaceTypePreviewRegistry.current()
    if (view == null) {
      promise.resolve(null)
      return
    }
    // Whatever the stop does or does not manage, no consented photograph may
    // outlive the session it was taken in.
    view.discardAllRawFrames()
    view.stopSession(promise)
  }

  /*
   * ---------------------------------------------------------------------
   * Field-study raw frames (apps/mobile/docs/field-study.md).
   *
   * These four methods exist only for the calibration lane, and only run for a
   * participant whose consent record carries an explicit raw-retention grant —
   * the JavaScript channel is not even constructed otherwise
   * (`src/field/fieldCapture.ts`). They export the AR session's *camera image*;
   * nothing here reads the window, the SurfaceView or the display, so there is
   * no screenshot path to review.
   *
   * The bytes never reach the filesystem: [ai.facetype.capture.rawframe.
   * RawFrameStore] holds exactly one encoded frame in memory and zeroes it on
   * discard, on host pause, on stop and on bridge invalidation.
   * ---------------------------------------------------------------------
   */

  @ReactMethod
  fun captureRawFrame(promise: Promise) {
    val view = FaceTypePreviewRegistry.current()
    if (view == null) {
      promise.reject("FT-REC-005", "Capture session is not running.")
      return
    }
    view.requestRawFrame(promise)
  }

  @ReactMethod
  fun readRawFrame(token: String, promise: Promise) {
    val view = FaceTypePreviewRegistry.current()
    if (view == null) {
      promise.reject("FT-REC-005", "Capture session is not running.")
      return
    }
    view.readRawFrame(token, promise)
  }

  @ReactMethod
  fun discardRawFrame(token: String, promise: Promise) {
    val view = FaceTypePreviewRegistry.current()
    // Nothing held is the state a discard is trying to reach, so a missing
    // view resolves rather than failing: a caller cleaning up must never be
    // left with an error it cannot act on.
    view?.discardRawFrame(token, promise) ?: promise.resolve(null)
  }

  @ReactMethod
  fun discardAllRawFrames(promise: Promise) {
    FaceTypePreviewRegistry.current()?.discardAllRawFrames()
    promise.resolve(null)
  }

  /**
   * A bridge invalidation (JS reload, CatalystInstance teardown) is not
   * guaranteed to run through `stop()` first, and it races the mounted
   * view's own `onDetachedFromWindow`/`onDropViewInstance` teardown rather
   * than being ordered after it: RN's own doc for `invalidate()` promises
   * only that no further JS calls into this module will occur, not that the
   * view tree has already unmounted. Without an explicit release here, a
   * bridge torn down while a view is still mounted leaves that view's
   * `GLSurfaceView` render thread alive and its ARCore `Session` open (and
   * therefore the physical front camera held open) for as long as the view
   * happens to take to detach on its own -- or indefinitely, if RN drops the
   * view tree without ever calling `onDetachedFromWindow` on a torn-down
   * bridge. `release()` is UI-thread-agnostic (it only queues GL work via
   * `GLSurfaceView.queueEvent`, which is documented safe from any thread,
   * and touches the `Synchronized` registry/`SingleSlotQueue`s), so calling
   * it here -- whatever thread `invalidate()` itself runs on -- is safe.
   */
  @Synchronized
  override fun invalidate() {
    reactApplicationContext.removeLifecycleEventListener(this)
    pendingStartPromise.getAndSet(null)
      ?.reject("FT-REC-005", "ARCore capture module was torn down mid-install.")
    // `release()` discards held raw frames itself; this is the same call made
    // ahead of it so a bridge teardown that races the view's own detach still
    // wipes them at the first opportunity rather than the last.
    FaceTypePreviewRegistry.current()?.discardAllRawFrames()
    FaceTypePreviewRegistry.current()?.release()
    super.invalidate()
  }

  @Synchronized
  override fun onHostResume() {
    // React Native guarantees LifecycleEventListener callbacks run on the UI
    // (main) thread, which is exactly where ArCoreApk.requestInstall is
    // required to run (it may launch Play Services' installer Activity). A
    // pending start() takes priority: it means requestInstall paused this
    // Activity last time and there is no session yet to resume.
    val pending = pendingStartPromise.getAndSet(null)
    if (pending != null) {
      attemptStart(pending)
      return
    }
    FaceTypePreviewRegistry.current()?.hostResume()
  }

  override fun onHostPause() {
    FaceTypePreviewRegistry.current()?.hostPause()
  }

  override fun onHostDestroy() {
    invalidate()
  }
}
