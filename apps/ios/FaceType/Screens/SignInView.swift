//
//  SignInView.swift
//  Screen 1 — sign in with Apple (the system button) or Google. The profile has no sign-out; an ended
//  session brings the person back here with a notice.
//

import AuthenticationServices
import SwiftUI

struct SignInView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.colorScheme) private var colorScheme

  private var errorKey: String? {
    switch model.state.signInError {
    case .cancelled: return "signin.cancelled"
    case .network: return "common.network"
    case .server_unconfigured: return "signin.server_unconfigured"
    case .unconfigured: return "signin.unconfigured"
    case .unsupported: return "signin.unsupported"
    case .nonce_invalid: return "apierr.nonce_invalid"
    case .account_withdrawing: return "apierr.account_withdrawing"
    case .failed: return "signin.failed"
    case nil: return nil
    }
  }

  private var busy: Bool { model.state.signInBusy != nil }
  private var blocked: Bool { model.state.configError != nil }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          Image(systemName: "face.dashed")
            .font(.system(size: 64, weight: .light))
            .foregroundStyle(.tint)
            .frame(maxWidth: .infinity)
            .padding(.top, 24)
          Text(s("signin.subtitle"))
            .font(.body)
            .foregroundStyle(.secondary)

          if model.state.notice == "session_expired" {
            Label(s("common.session_expired"), systemImage: "clock.badge.exclamationmark")
              .foregroundStyle(.orange)
          }
          if let code = model.state.configError {
            Label(s("config.api_error", ["code": code]), systemImage: "exclamationmark.triangle")
              .foregroundStyle(.red)
          }

          SignInWithAppleButton(.continue) { request in
            model.configureAppleRequest(request)
          } onCompletion: { result in
            Task { await model.completeApple(result) }
          }
          .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
          .frame(height: 50)
          .disabled(busy || blocked || model.appleNonce == nil)
          .accessibilityLabel(s("signin.apple"))

          Button {
            Task { await model.signInGoogle() }
          } label: {
            HStack {
              if model.state.signInBusy == .google { ProgressView() }
              Text(AppConfig.googleIOSClientId.isEmpty
                ? "\(s("signin.google")) — \(s("signin.unconfigured"))" : s("signin.google"))
            }
            .frame(maxWidth: .infinity, minHeight: 44)
          }
          .buttonStyle(.bordered)
          .controlSize(.large)
          .disabled(busy || blocked || AppConfig.googleIOSClientId.isEmpty)

          if AppConfig.mockAuth {
            Button(s("signin.mock")) { Task { await model.signInMock() } }
              .buttonStyle(.bordered)
              .disabled(busy || blocked)
            Text(s("signin.mock_note")).font(.footnote).foregroundStyle(.secondary)
          }

          if let errorKey {
            Text(s(errorKey)).foregroundStyle(.red).accessibilityAddTraits(.updatesFrequently)
          }

          Text(s("signin.privacy_note"))
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        .padding(20)
      }
      .navigationTitle(s("signin.title"))
      .toolbar { ToolbarItem(placement: .navigationBarTrailing) { LanguageToggle() } }
      .task { await model.prepareAppleNonce() }
    }
  }
}
