package ai.facetype.client

import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

/**
 * `FaceTypeClientCameraView` (`docs/client-native-interface.md` §2).
 *
 * Props: `active`, `gateConfig` (JSON). Events: `onFrameMeasure`,
 * `onBurstProgress`, `onError`. The direct-event names are prefixed so they
 * cannot collide with another component's registration in the old
 * architecture's global event table.
 */
class FaceTypeClientCameraViewManager : SimpleViewManager<FaceTypeClientCameraView>() {

  override fun getName(): String = REACT_CLASS

  override fun createViewInstance(reactContext: ThemedReactContext): FaceTypeClientCameraView =
    FaceTypeClientCameraView(reactContext)

  @ReactProp(name = "active", defaultBoolean = false)
  fun setActive(view: FaceTypeClientCameraView, active: Boolean) = view.setActive(active)

  @ReactProp(name = "gateConfig")
  fun setGateConfig(view: FaceTypeClientCameraView, gateConfig: String?) = view.setGateConfig(gateConfig)

  override fun onAfterUpdateTransaction(view: FaceTypeClientCameraView) {
    super.onAfterUpdateTransaction(view)
    view.commitProps()
  }

  override fun onDropViewInstance(view: FaceTypeClientCameraView) {
    view.release()
    super.onDropViewInstance(view)
  }

  override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any> = mapOf(
    FaceTypeClientCameraView.EVENT_FRAME_MEASURE to mapOf("registrationName" to "onFrameMeasure"),
    FaceTypeClientCameraView.EVENT_BURST_PROGRESS to mapOf("registrationName" to "onBurstProgress"),
    FaceTypeClientCameraView.EVENT_ERROR to mapOf("registrationName" to "onError"),
  )

  companion object {
    const val REACT_CLASS = "FaceTypeClientCameraView"
  }
}
