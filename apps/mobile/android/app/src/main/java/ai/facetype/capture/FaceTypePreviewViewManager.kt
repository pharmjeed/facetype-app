package ai.facetype.capture

import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext

/**
 * Registers [FaceTypePreviewView] as the `FaceTypePreviewView` RN native
 * component so `ScanScreen` can mount a real ARCore GL preview instead of the
 * decorative placeholder box it used to render (audit F1/F2).
 *
 * This manager only creates/destroys the view. It does not forward RN
 * commands to it: [FaceTypeCaptureModule] talks to the currently mounted view
 * directly through [FaceTypePreviewRegistry], which the view maintains itself
 * from `onAttachedToWindow`/`onDetachedFromWindow`.
 */
class FaceTypePreviewViewManager : SimpleViewManager<FaceTypePreviewView>() {

  override fun getName(): String = REACT_CLASS

  override fun createViewInstance(reactContext: ThemedReactContext): FaceTypePreviewView =
    FaceTypePreviewView(reactContext)

  override fun onDropViewInstance(view: FaceTypePreviewView) {
    // Belt and braces alongside onDetachedFromWindow: RN can drop a view
    // instance without it ever having gone through a window detach (e.g. it
    // was created but never attached because its screen unmounted first).
    view.release()
    super.onDropViewInstance(view)
  }

  override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any> = mapOf(
    EVENT_PREVIEW_READY to mapOf("registrationName" to "onPreviewReady"),
    EVENT_PREVIEW_ERROR to mapOf("registrationName" to "onPreviewError"),
  )

  companion object {
    const val REACT_CLASS = "FaceTypePreviewView"
    const val EVENT_PREVIEW_READY = "topPreviewReady"
    const val EVENT_PREVIEW_ERROR = "topPreviewError"
  }
}
