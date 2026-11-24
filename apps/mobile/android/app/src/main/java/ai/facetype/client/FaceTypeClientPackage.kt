package ai.facetype.client

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers the client camera (`FaceTypeClientCamera` module and
 * `FaceTypeClientCameraView` component). An in-app module is invisible to
 * autolinking, so `MainApplication` adds this package explicitly.
 */
class FaceTypeClientPackage : ReactPackage {

  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(FaceTypeClientCameraModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    listOf(FaceTypeClientCameraViewManager())
}
