//
//  DemoScreen.swift
//  Screenshot mode for CI (`-FTDemo <screen> -FTLang <ar|en>` launch arguments): the real screens with a
//  synthetic, made-up profile and no network. Used only to review the layout in both directions before a build
//  is uploaded; nothing here can be reached by a normal launch.
//

import SwiftUI
import UIKit

enum DemoScreen: String {
  case signin, setup, setupErrors = "setup-errors", profile, tips

  static var requested: DemoScreen? {
    let args = ProcessInfo.processInfo.arguments
    guard let i = args.firstIndex(of: "-FTDemo"), i + 1 < args.count else { return nil }
    return DemoScreen(rawValue: args[i + 1])
  }

  static var language: Lang? {
    let args = ProcessInfo.processInfo.arguments
    guard let i = args.firstIndex(of: "-FTLang"), i + 1 < args.count else { return nil }
    return Lang(rawValue: args[i + 1])
  }

  /// Demo mode only: the document-number and phone fields as they were up to build 8 (SwiftUI `TextField`), so
  /// the UI test can compare them with `LatinTextField` on the same simulator.
  static var legacyTextFields: Bool {
    requested != nil && ProcessInfo.processInfo.arguments.contains("-FTLegacyTextFields")
  }
}

struct DemoRoot: View {
  let screen: DemoScreen
  @EnvironmentObject private var model: AppModel

  var body: some View {
    Group {
      switch screen {
      case .signin: SignInView()
      case .setup, .setupErrors: ProfileSetupView()
      case .profile: ProfileScreen()
      case .tips: CaptureScreen()
      }
    }
    .onAppear {
      model.applyDemo(screen)
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { probe = DirectionProbe.describe() }
    }
    // Demo mode only: how UIKit sees the direction, for the UI tests' failure messages.
    .overlay(alignment: .bottomLeading) {
      Text(probe).font(.system(size: 2)).foregroundStyle(.clear).accessibilityIdentifier("debug.direction")
    }
  }

  @State private var probe = ""
}

enum DirectionProbe {
  @MainActor static func describe() -> String {
    func uiName(_ d: UIUserInterfaceLayoutDirection) -> String { d == .rightToLeft ? "rtl" : "ltr" }
    func traitName(_ d: UITraitEnvironmentLayoutDirection) -> String {
      switch d { case .rightToLeft: return "rtl"; case .leftToRight: return "ltr"; default: return "unspecified" }
    }
    let window = AppWindows.first
    return [
      "app=\(uiName(UIApplication.shared.userInterfaceLayoutDirection))",
      "windowTrait=\(window.map { traitName($0.traitCollection.layoutDirection) } ?? "none")",
      "windowEffective=\(window.map { uiName($0.effectiveUserInterfaceLayoutDirection) } ?? "none")",
      "appearance=\(UIView.appearance().semanticContentAttribute.rawValue)",
      "bundle=\(Bundle.main.preferredLocalizations.first ?? "-")",
      "lang=\(L10n.lang.rawValue)",
    ].joined(separator: " ")
  }
}

extension AppModel {
  /// Synthetic state for screenshots only.
  func applyDemo(_ screen: DemoScreen) {
    if let lang = DemoScreen.language { setLanguage(lang) }
    let profile = ProfileView(
      revision_id: "demo", revision: 1, full_name: "سارة محمد العلي", id_issuing_country: "SA",
      id_document_type: "national_id", id_number: "1000000008", phone: "+966512345678", sex: "female",
      birth_date: "1995-04-23", nationality: "SA", age_years: 31, identity_verification: "self_declared",
      updated_at: nil)
    let me = ClientMe(
      account: AccountView(id: "demo", provider: "apple", state: "active", created_at: nil),
      profile: screen == .profile ? profile : nil,
      consent: screen == .profile ? ConsentView(id: "c", version: "client-terms-v1", store_accepted: true,
                                                research_use: true, created_at: nil) : nil,
      captures: CaptureSummary(count: 1, last_at: "2026-11-25T09:00:00Z", latest_status: "complete",
                               next_repeat_due_at: "2026-12-02T09:00:00Z"),
      personality: PersonalityView(status: "unavailable"))
    switch screen {
    case .signin:
      demoState(ClientState(screen: .signedOut))
    case .setup:
      form = ProfileForm(full_name: "سارة محمد العلي", id_issuing_country: "SA", id_document_type: .national_id,
                         id_number: "1000000008", phone: "0512345678", sex: .female, birth_date: "1995-04-23",
                         nationality: "SA")
      demoState(ClientState(screen: .profileSetup, me: me))
    case .setupErrors:
      form = ProfileForm()
      _ = Validation.validateProfile(form)
      if case .failure(let e) = Validation.validateProfile(form) { formErrors = e.fields }
      demoState(ClientState(screen: .profileSetup, me: me))
    case .profile, .tips:
      demoState(ClientState(screen: screen == .profile ? .profile : .capture, me: me))
    }
  }
}
