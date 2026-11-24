package ai.facetype

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader
import ai.facetype.capture.FaceTypeCapturePackage
import ai.facetype.client.FaceTypeClientPackage

class MainApplication : Application(), ReactApplication {

    override val reactNativeHost: ReactNativeHost =
        object : DefaultReactNativeHost(this) {
            override fun getPackages(): List<ReactPackage> =
                PackageList(this).packages.apply {
                    // Autolinking cannot find a module that lives in the app
                    // itself, so the capture package is registered explicitly.
                    // Without this the Swift/Kotlin sources compile and are
                    // never reachable from JavaScript -- which is the state the
                    // audit found (P0-03).
                    add(FaceTypeCapturePackage())
                    // Client app v1 camera (docs/client-native-interface.md).
                    add(FaceTypeClientPackage())
                }

            override fun getJSMainModuleName(): String = "index"

            override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

            override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
            override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
        }

    override val reactHost: ReactHost
        get() = getDefaultReactHost(applicationContext, reactNativeHost)

    override fun onCreate() {
        super.onCreate()
        // React Native 0.76 ships its native code as one merged library, so the
        // legacy boolean overload leaves the runtime looking for the old
        // per-module names.  The first JS call then dies with
        // UnsatisfiedLinkError: libhermes_executor.so not found.  The mapping
        // overload is what resolves merged names to the shipped library.
        SoLoader.init(this, OpenSourceMergedSoMapping)
        if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
            load()
        }
    }
}
