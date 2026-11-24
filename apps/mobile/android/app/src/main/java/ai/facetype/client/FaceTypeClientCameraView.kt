package ai.facetype.client

import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.Surface
import android.widget.FrameLayout
import androidx.camera.view.PreviewView
import androidx.lifecycle.LifecycleOwner
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.events.RCTEventEmitter
import java.lang.ref.WeakReference

/**
 * The `FaceTypeClientCameraView` native component: a CameraX preview plus the
 * analysis session behind it.
 *
 * The camera runs only while `active` is true, a valid `gateConfig` is set,
 * the view is attached and the host activity is resumed. Leaving any of those
 * states stops it; a burst in progress is cancelled when JavaScript
 * deactivates the view and ends as `partial` when the app is backgrounded or
 * the camera is taken away.
 *
 * The preview is mirrored for the user (PreviewView does that for the front
 * camera); analysed and stored frames are never mirrored.
 */
class FaceTypeClientCameraView(private val reactContext: ThemedReactContext) :
  FrameLayout(reactContext), LifecycleEventListener {

  private val previewView = PreviewView(reactContext).apply {
    // TextureView: composes correctly inside the React view hierarchy.
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    scaleType = PreviewView.ScaleType.FILL_CENTER
    layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
  }

  private val emitter = object : ClientCameraSession.Events {
    override fun frameMeasure(payload: Map<String, Any?>) = emit(EVENT_FRAME_MEASURE, payload)

    override fun burstProgress(payload: Map<String, Any?>) = emit(EVENT_BURST_PROGRESS, payload)

    override fun error(code: String, message: String) =
      emit(EVENT_ERROR, linkedMapOf("code" to code, "message" to message))

    override fun burstCompleted() {
      // performHapticFeedback honours the user's system haptics setting and
      // needs no VIBRATE permission.
      post {
        if (!released) {
          val feedback = if (Build.VERSION.SDK_INT >= 30) {
            HapticFeedbackConstants.CONFIRM
          } else {
            HapticFeedbackConstants.VIRTUAL_KEY
          }
          performHapticFeedback(feedback)
        }
      }
    }
  }

  internal val session = ClientCameraSession(reactContext, emitter)

  private var active = false
  private var configJson: String? = null
  private var config: ClientGateConfig? = null
  private var attached = false
  private var hostResumed = true
  private var released = false

  private var layoutPosted = false

  init {
    addView(previewView)
    reactContext.addLifecycleEventListener(this)
  }

  fun setActive(value: Boolean) {
    active = value
  }

  fun setGateConfig(json: String?) {
    if (json == configJson) return
    configJson = json
    config = null
    if (json == null) return
    try {
      config = ClientGateConfig.parse(json)
    } catch (error: Exception) {
      emitter.error("internal", "Invalid gate config: ${error.message}")
    }
  }

  /** Called once per React prop transaction. */
  fun commitProps() = reconcile(restartIfConfigChanged = true)

  private var runningConfigHash: String? = null

  private fun reconcile(restartIfConfigChanged: Boolean = false) {
    if (released) return
    val cfg = config
    val shouldRun = active && attached && hostResumed && cfg != null
    if (!shouldRun) {
      if (session.isStarted) session.stop(ClientCameraSession.StopReason.DEACTIVATED)
      runningConfigHash = null
      ClientCameraRegistry.clear(this)
      return
    }
    if (session.isStarted && !(restartIfConfigChanged && runningConfigHash != cfg!!.hash)) return
    val owner = reactContext.currentActivity as? LifecycleOwner
    if (owner == null) {
      emitter.error("camera_unavailable", "No activity is available to host the camera.")
      return
    }
    runningConfigHash = cfg!!.hash
    session.start(owner, previewView.surfaceProvider, display?.rotation ?: Surface.ROTATION_0, cfg)
    ClientCameraRegistry.set(this)
  }

  override fun requestLayout() {
    super.requestLayout()
    // React Native lays out its own children only; the TextureView PreviewView
    // adds later would otherwise never be measured. (May run from the
    // FrameLayout constructor, before this class's fields exist: no field
    // other than a primitive is touched here.)
    if (layoutPosted) return
    layoutPosted = true
    post {
      layoutPosted = false
      measure(
        MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
        MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
      )
      layout(left, top, right, bottom)
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    attached = true
    reconcile()
  }

  override fun onDetachedFromWindow() {
    attached = false
    reconcile()
    super.onDetachedFromWindow()
  }

  override fun onHostResume() {
    hostResumed = true
    reconcile()
  }

  override fun onHostPause() {
    hostResumed = false
    if (session.isStarted) session.stop(ClientCameraSession.StopReason.INTERRUPTED)
    runningConfigHash = null
  }

  override fun onHostDestroy() = release()

  fun release() {
    if (released) return
    released = true
    UiThreadUtil.assertOnUiThread()
    session.release()
    ClientCameraRegistry.clear(this)
    reactContext.removeLifecycleEventListener(this)
  }

  private fun emit(name: String, payload: Map<String, Any?>) {
    if (released) return
    try {
      reactContext.getJSModule(RCTEventEmitter::class.java)?.receiveEvent(id, name, ReactMaps.toWritableMap(payload))
    } catch (_: Exception) {
      // The React instance is gone; there is nobody to tell.
    }
  }

  companion object {
    const val EVENT_FRAME_MEASURE = "topFaceTypeClientFrameMeasure"
    const val EVENT_BURST_PROGRESS = "topFaceTypeClientBurstProgress"
    const val EVENT_ERROR = "topFaceTypeClientError"
  }
}

/** The view whose camera the module's burst calls address: the most recently started one. */
internal object ClientCameraRegistry {
  @Volatile private var current: WeakReference<FaceTypeClientCameraView>? = null

  fun set(view: FaceTypeClientCameraView) {
    current = WeakReference(view)
  }

  fun clear(view: FaceTypeClientCameraView) {
    if (current?.get() === view) current = null
  }

  fun session(): ClientCameraSession? = current?.get()?.session
}
