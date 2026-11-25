//
//  FaceTypeApp.swift
//  FaceType client app — native SwiftUI (owner decision 2026-11-25). Arabic by default, right to left; the
//  language switch changes locale and layout direction at once. The personality result is never shown:
//  there is no validated model («النتيجة غير متاحة بعد»).
//

import GoogleSignIn
import SwiftUI

@main
struct FaceTypeApp: App {
  @StateObject private var model = AppModel()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(model)
        .modifier(LanguageDirection(language: model.language))
        .environment(\.locale, Locale(identifier: model.language == .ar ? "ar@numbers=latn" : "en"))
        .onOpenURL { url in _ = GIDSignIn.sharedInstance.handle(url) }
    }
  }
}

struct RootView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    Group {
      if let demo = DemoScreen.requested {
        DemoRoot(screen: demo)
      } else {
        switch model.state.screen {
        case .boot: BootView()
        case .signedOut: SignInView()
        case .profileSetup: ProfileSetupView()
        case .profile: ProfileScreen()
        case .capture: CaptureScreen()
        }
      }
    }
    // A language switch rebuilds the tree so every string is read again; form input lives in the model.
    .id(model.language)
    .background(AppWindowHook().frame(width: 0, height: 0))
    .task { if DemoScreen.requested == nil { await model.boot() } }
    .onChange(of: scenePhase) { phase in
      if phase == .active { model.pump() }
    }
  }
}

struct BootView: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    VStack(spacing: 16) {
      if model.bootFailed {
        Text(s("common.network")).multilineTextAlignment(.center)
        Button(s("common.retry")) { Task { await model.boot() } }
          .buttonStyle(.borderedProminent)
      } else {
        ProgressView()
        Text(s("boot.loading")).foregroundStyle(.secondary)
      }
    }
    .padding()
  }
}

/// The language switch: the other language's name, in that language.
struct LanguageToggle: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    Button(s("lang.switch")) { model.setLanguage(model.language.other) }
      .accessibilityLabel(s("lang.switch"))
  }
}

/// One source for the interface direction. On iOS 17+ it is the window's layout-direction trait (`AppWindows`),
/// which SwiftUI reads into its environment — so SwiftUI and the UIKit pieces under it can never disagree. Setting
/// the environment as well left the form mirrored after an Arabic → English switch inside the app (UI test
/// 2026-11-25: the header sat at exactly the mirror of its place; a relaunch was correct). iOS 16 has no trait
/// override, so there the environment carries the direction.
struct LanguageDirection: ViewModifier {
  let language: Lang

  func body(content: Content) -> some View {
    if #available(iOS 17.0, *) {
      content
    } else {
      content.environment(\.layoutDirection, language.layoutDirection)
    }
  }
}
