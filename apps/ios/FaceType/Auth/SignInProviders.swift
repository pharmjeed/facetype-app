//
//  SignInProviders.swift
//  Sign in with Apple (AuthenticationServices, the system button and sheet) and Google (GoogleSignIn SDK).
//  Apple: the server issues a single-use nonce; Apple receives its SHA-256 and the server gets the raw value back
//  with the identity token. Google: the ID token is exchanged as is. No email scope is requested from Apple.
//

import AuthenticationServices
import CryptoKit
import GoogleSignIn
import UIKit

enum SignInOutcome {
  case apple(identityToken: String, fullName: String?)
  case google(idToken: String)
  case cancelled
  case failed(SignInError)
}

@MainActor
final class AppleSignIn: NSObject, ASAuthorizationControllerDelegate,
  ASAuthorizationControllerPresentationContextProviding
{
  private var continuation: CheckedContinuation<SignInOutcome, Never>?
  /// Set on the main actor before the sheet is requested; AuthenticationServices reads it on the main thread.
  nonisolated(unsafe) private var anchorWindow: ASPresentationAnchor?

  static func sha256(_ text: String) -> String {
    SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  func signIn(nonce: String) async -> SignInOutcome {
    let request = ASAuthorizationAppleIDProvider().createRequest()
    request.requestedScopes = [.fullName]
    request.nonce = Self.sha256(nonce)
    let controller = ASAuthorizationController(authorizationRequests: [request])
    controller.delegate = self
    controller.presentationContextProvider = self
    anchorWindow = UIApplication.shared.keyWindowForPresentation
    return await withCheckedContinuation { continuation in
      self.continuation = continuation
      controller.performRequests()
    }
  }

  private func finish(_ outcome: SignInOutcome) {
    continuation?.resume(returning: outcome)
    continuation = nil
  }

  nonisolated func authorizationController(
    controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization
  ) {
    let credential = authorization.credential as? ASAuthorizationAppleIDCredential
    let token = credential?.identityToken.flatMap { String(data: $0, encoding: .utf8) }
    let parts = [credential?.fullName?.givenName, credential?.fullName?.familyName].compactMap { $0 }
      .filter { !$0.isEmpty }
    let name = parts.isEmpty ? nil : parts.joined(separator: " ")
    Task { @MainActor in
      if let token {
        self.finish(.apple(identityToken: token, fullName: name))
      } else {
        self.finish(.failed(.failed))
      }
    }
  }

  nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
    let cancelled = (error as? ASAuthorizationError)?.code == .canceled
    Task { @MainActor in self.finish(cancelled ? .cancelled : .failed(.failed)) }
  }

  nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    anchorWindow ?? ASPresentationAnchor()
  }
}

@MainActor
enum GoogleAuth {
  static func signIn(iosClientId: String, serverClientId: String) async -> SignInOutcome {
    guard !iosClientId.isEmpty, let presenter = UIApplication.shared.topViewController else {
      return .failed(.unconfigured)
    }
    GIDSignIn.sharedInstance.configuration = GIDConfiguration(
      clientID: iosClientId, serverClientID: serverClientId.isEmpty ? nil : serverClientId)
    do {
      let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: presenter)
      guard let token = result.user.idToken?.tokenString else { return .failed(.failed) }
      return .google(idToken: token)
    } catch let error as NSError {
      if error.domain == kGIDSignInErrorDomain, error.code == GIDSignInError.canceled.rawValue { return .cancelled }
      return .failed(.failed)
    }
  }

  static func signOut() { GIDSignIn.sharedInstance.signOut() }
}

extension UIApplication {
  var keyWindowForPresentation: UIWindow? {
    connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow }
  }

  var topViewController: UIViewController? {
    var top = keyWindowForPresentation?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }
}
