import React
import React_RCTAppDelegate
import UIKit

@main
class AppDelegate: RCTAppDelegate {

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Must match the name registered in index.js via app.json.
    self.moduleName = "FaceTypeAI"
    self.initialProps = [:]

    // Arabic is the primary locale (FT-07 §1/§7). Layout direction has to be
    // settled before the first render, or the capture overlay mirrors
    // mid-session.
    UIView.appearance().semanticContentAttribute = .forceRightToLeft

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    #if DEBUG
      return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
    #else
      return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    #endif
  }
}
