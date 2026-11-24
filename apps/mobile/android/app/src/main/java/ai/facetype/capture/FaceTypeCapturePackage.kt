package ai.facetype.capture

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers [FaceTypeCaptureModule] with the React Native bridge.
 *
 * This file is the piece that was missing. The Kotlin module existed as an
 * orphan source with nothing importing it, so it could never have been called
 * from JavaScript no matter how correct its contents were (audit P0-03).
 */
class FaceTypeCapturePackage : ReactPackage {

    override fun createNativeModules(
        reactContext: ReactApplicationContext
    ): List<NativeModule> = listOf(
        FaceTypeCaptureModule(reactContext),
        FaceTypeSecureSessionModule(reactContext),
    )

    override fun createViewManagers(
        reactContext: ReactApplicationContext
    ): List<ViewManager<*, *>> = listOf(FaceTypePreviewViewManager())
}
