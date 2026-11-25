//
//  AppModel.swift
//  Owns every side effect of the client app (port of apps/mobile/src/client/ClientApp.tsx): boot, sign-in,
//  profile save + notice consent, the upload pump, session end, and the interface language. Screens read its
//  published state; flows are the pure reducers in Flows.swift.
//

import AuthenticationServices
import SwiftUI
import UIKit

enum SetupError: Equatable {
  case identifierTaken
  case network
  case consentFailed
  case other(code: String)
}

@MainActor
final class AppModel: ObservableObject {
  static let consentVersions: [Lang: String] = [.ar: "client-notice-v1", .en: "client-notice-v1-en"]
  private static let languageKey = "ai.facetype.client.language"
  private static let mockSubjectKey = "ai.facetype.client.mock-subject"

  @Published private(set) var state = ClientState()
  @Published private(set) var language: Lang
  @Published private(set) var spool: SpoolOutcome = .idle
  @Published var form = ProfileForm()
  @Published var formErrors: [ProfileField: String] = [:]
  @Published private(set) var saving = false
  @Published private(set) var setupError: SetupError?
  @Published private(set) var refreshing = false
  @Published private(set) var bootFailed = false
  @Published private(set) var appleNonce: String?

  let camera = CameraService.shared
  private let tokens: TokenStore = KeychainTokenStore()
  private var api: ClientAPI!
  private var runner: SpoolRunner!
  private var pumpTask: Task<Void, Never>?
  private var signedIn = false
  private var lastTerminal: String?
  private var capabilities: [String: Any]?

  init() {
    let stored = UserDefaults.standard.string(forKey: Self.languageKey).flatMap(Lang.init(rawValue:)) ?? .ar
    language = stored
    L10n.lang = stored
    Self.applyUIKitDirection(stored)
    let base = AppConfig.configError == nil ? AppConfig.apiBaseURL : "https://invalid.invalid"
    api = ClientAPI(baseURL: base, tokens: tokens) { [weak self] in
      Task { @MainActor in self?.sessionEnded() }
    }
    runner = SpoolRunner(
      api: api, camera: camera, manifestFile: ProtectedFile(name: "spool-manifest.json"),
      queue: AttemptQueue(file: ProtectedFile(name: "attempt-queue.json")), gateHash: camera.gateHash,
      protocolVersion: "capture-spec-v2")
  }

  // MARK: language

  /// UIKit-backed pieces (lists, text fields, navigation bars) take their direction from the phone's language,
  /// SwiftUI from the environment. When the two disagree (English chosen on an Arabic phone) UIKit content is
  /// drawn mirrored. Forcing UIKit's semantic direction to the chosen language keeps them in agreement; the tree
  /// is rebuilt on a switch (`.id(language)`), so every new view picks it up.
  static func applyUIKitDirection(_ language: Lang) {
    let attribute: UISemanticContentAttribute = language.isRTL ? .forceRightToLeft : .forceLeftToRight
    UIView.appearance().semanticContentAttribute = attribute
    UINavigationBar.appearance().semanticContentAttribute = attribute
    UISearchBar.appearance().semanticContentAttribute = attribute
    UITextField.appearance().semanticContentAttribute = attribute
  }

  func setLanguage(_ next: Lang) {
    guard next != language else { return }
    L10n.lang = next
    Self.applyUIKitDirection(next)
    language = next
    UserDefaults.standard.set(next.rawValue, forKey: Self.languageKey)
  }

  // MARK: boot and session

  func boot() async {
    bootFailed = false
    if let code = AppConfig.configError {
      state = ClientFlow.reduce(state, .configError(code))
      return
    }
    if !(await api.restore()) {
      await runner.discard(keepTelemetry: true)
      state = ClientFlow.reduce(state, .bootNoSession)
      return
    }
    do {
      try await enterSession()
    } catch let error as ClientAPIError where error.kind == .session_expired {
      state = ClientFlow.reduce(state, .bootNoSession)
    } catch {
      bootFailed = true
    }
  }

  private func enterSession() async throws {
    let me = try await api.me()
    await runner.bindAccount(me.account.id)
    signedIn = true
    state = ClientFlow.reduce(state, .sessionReady(me))
    prefillForm(from: me)
    await runner.cleanupOrphans()
    pump()
  }

  private func prefillForm(from me: ClientMe) {
    guard let p = me.profile else { return }
    form = ProfileForm(
      full_name: p.full_name, id_issuing_country: p.id_issuing_country,
      id_document_type: IdDocumentType(rawValue: p.id_document_type), id_number: p.id_number, phone: p.phone,
      sex: Sex(rawValue: p.sex), birth_date: p.birth_date, nationality: p.nationality)
  }

  private func sessionEnded() {
    signedIn = false
    pumpTask?.cancel()
    pumpTask = nil
    spool = .idle
    Task {
      await self.runner.discard(keepTelemetry: true)
      await self.runner.bindAccount(nil)
    }
    GoogleAuth.signOut()
    state = ClientFlow.reduce(state, .signedOut(reason: "session_expired"))
  }

  // MARK: sign-in

  func prepareAppleNonce() async {
    guard appleNonce == nil, state.configError == nil else { return }
    appleNonce = try? await api.nonce().nonce
  }

  func configureAppleRequest(_ request: ASAuthorizationAppleIDRequest) {
    request.requestedScopes = [.fullName]
    if let nonce = appleNonce { request.nonce = AppleSignIn.sha256(nonce) }
  }

  func completeApple(_ result: Result<ASAuthorization, Error>) async {
    state = ClientFlow.reduce(state, .signInStarted(.apple))
    let nonce = appleNonce
    appleNonce = nil
    switch result {
    case .failure(let error):
      let cancelled = (error as? ASAuthorizationError)?.code == .canceled
      state = ClientFlow.reduce(state, .signInFailed(cancelled ? .cancelled : .failed))
    case .success(let authorization):
      let credential = authorization.credential as? ASAuthorizationAppleIDCredential
      guard let nonce, let token = credential?.identityToken.flatMap({ String(data: $0, encoding: .utf8) }) else {
        state = ClientFlow.reduce(state, .signInFailed(.failed))
        return
      }
      let parts = [credential?.fullName?.givenName, credential?.fullName?.familyName].compactMap { $0 }
        .filter { !$0.isEmpty }
      let name = parts.isEmpty ? nil : parts.joined(separator: " ")
      if let name, form.full_name.isEmpty { form.full_name = name }
      await exchange { try await self.api.signInApple(identityToken: token, nonce: nonce, fullName: name) }
    }
    await prepareAppleNonce()
  }

  func signInGoogle() async {
    state = ClientFlow.reduce(state, .signInStarted(.google))
    switch await GoogleAuth.signIn(
      iosClientId: AppConfig.googleIOSClientId, serverClientId: AppConfig.googleServerClientId)
    {
    case .google(let idToken):
      await exchange { try await self.api.signInGoogle(idToken: idToken) }
    case .cancelled:
      state = ClientFlow.reduce(state, .signInFailed(.cancelled))
    case .failed(let error):
      state = ClientFlow.reduce(state, .signInFailed(error))
    default:
      state = ClientFlow.reduce(state, .signInFailed(.failed))
    }
  }

  func signInMock() async {
    state = ClientFlow.reduce(state, .signInStarted(.mock))
    let subject =
      UserDefaults.standard.string(forKey: Self.mockSubjectKey) ?? "dev-\(UUID().uuidString.lowercased())"
    UserDefaults.standard.set(subject, forKey: Self.mockSubjectKey)
    await exchange { try await self.api.signInMock(subject: subject) }
  }

  private func exchange(_ work: () async throws -> Void) async {
    do {
      try await work()
      try await enterSession()
    } catch let error as ClientAPIError {
      let mapped: SignInError
      switch error.kind {
      case .network: mapped = .network
      case .provider_unconfigured: mapped = .server_unconfigured
      case .nonce_invalid: mapped = .nonce_invalid
      case .account_withdrawing: mapped = .account_withdrawing
      default: mapped = .failed
      }
      state = ClientFlow.reduce(state, .signInFailed(mapped))
    } catch {
      state = ClientFlow.reduce(state, .signInFailed(.failed))
    }
  }

  // MARK: profile

  var needsConsent: Bool { state.me?.consent?.store_accepted != true }

  /// Validate, save, then record the notice consent. Returns the first field in error (for scrolling), if any.
  @discardableResult
  func saveProfile() async -> ProfileField? {
    setupError = nil
    switch Validation.validateProfile(form) {
    case .failure(let errors):
      formErrors = errors.fields
      return ProfileField.allCases.first { errors.fields[$0] != nil }
    case .success(let values):
      formErrors = [:]
      saving = true
      defer { saving = false }
      do {
        try await api.putProfile(values)
        if needsConsent {
          do {
            try await api.postConsent(
              version: Self.consentVersions[language] ?? "client-notice-v1", storeAccepted: true, researchUse: true)
          } catch let error as ClientAPIError {
            setupError = error.kind == .network ? .network : .consentFailed
            return nil
          }
        }
        let me = try await api.me()
        state = ClientFlow.reduce(state, .profileSaved(me))
      } catch let error as ClientAPIError {
        switch error.kind {
        case .identifier_taken:
          setupError = .identifierTaken
          return .id_number
        case .network:
          setupError = .network
        case .validation:
          var fields: [ProfileField: String] = [:]
          for (field, reason) in error.fieldErrors {
            if let f = ProfileField(rawValue: field), let key = Messages.profileFieldErrorKey(field: field, reason: reason) {
              fields[f] = key
            }
          }
          formErrors = fields
          if fields.isEmpty { setupError = .other(code: error.code ?? error.kind.rawValue) }
          return ProfileField.allCases.first { fields[$0] != nil }
        case .session_expired:
          break
        default:
          setupError = .other(code: error.code ?? error.kind.rawValue)
        }
      } catch {
        setupError = .other(code: "unexpected")
      }
      return nil
    }
  }

  // MARK: refresh and upload pump

  func refreshMe() async {
    guard signedIn else { return }
    if let me = try? await api.me() { state = ClientFlow.reduce(state, .meRefreshed(me)) }
  }

  func refresh() async {
    refreshing = true
    await refreshMe()
    pump()
    refreshing = false
  }

  func pump() {
    pumpTask?.cancel()
    pumpTask = Task { [weak self] in await self?.runPump() }
  }

  private func runPump() async {
    guard signedIn else { return }
    let outcome = await runner.runOnce()
    guard !Task.isCancelled else { return }
    spool = outcome
    if outcome.kind == .terminal, let m = outcome.manifest, lastTerminal != "\(m.clientCaptureId):\(m.stage)" {
      lastTerminal = "\(m.clientCaptureId):\(m.stage)"
      await refreshMe()
    }
    if let delay = outcome.nextRunInMs {
      try? await Task.sleep(nanoseconds: UInt64(max(delay, 250) * 1_000_000))
      if !Task.isCancelled { pump() }
    }
  }

  func openCapture() { state = ClientFlow.reduce(state, .openCapture) }

  func closeCapture() {
    state = ClientFlow.reduce(state, .closeCapture)
    Task { await self.refreshMe() }
  }

  // MARK: capture hand-off

  func loadCapabilities() async -> [String: Any]? {
    if capabilities == nil { capabilities = await camera.capabilities() }
    return capabilities
  }

  func device() -> [String: JSONValue] {
    guard let c = capabilities else { return ["platform": .string("ios")] }
    return [
      "platform": JSONValue(any: c["platform"]), "model": JSONValue(any: c["deviceModel"]),
      "manufacturer": JSONValue(any: c["manufacturer"]), "os_version": JSONValue(any: c["osVersion"]),
    ]
  }

  private func cameraDescriptor() -> (device: [String: JSONValue], camera: [String: JSONValue]) {
    guard let c = capabilities, let front = c["frontCamera"] as? [String: Any] else {
      return (["missing_reason": .string("capabilities_unavailable")], [:])
    }
    return (
      device(),
      [
        "id": JSONValue(any: front["id"]), "sizes": JSONValue(any: front["sizes"]),
        "focal_lengths_mm": JSONValue(any: front["focalLengthsMm"]),
        "sensor_size_mm": JSONValue(any: front["sensorSizeMm"]),
        "has_intrinsic_calibration": JSONValue(any: front["hasIntrinsicCalibration"]),
        "distortion_correction": JSONValue(any: front["distortionCorrection"]),
        "mediapipe_model_sha256": JSONValue(any: c["mediapipeModelSha256"]),
      ]
    )
  }

  func enqueue(frames: [BurstFrameRecord], attempts: Int, telemetry: PendingAttempt) async throws {
    let (device, camera) = cameraDescriptor()
    _ = try await runner.enqueue(frames: frames, attempt: attempts, device: device, camera: camera,
                                 telemetry: telemetry)
    pump()
  }

  func acknowledge() async {
    await runner.acknowledge()
    spool = .idle
    pump()
  }

  func recordAttempt(_ telemetry: AttemptTelemetry) async {
    if !(await runner.recordAttempt(telemetry)) {
      try? await api.postAttempt(telemetry.body)
    }
    pump()
  }

  func deleteFrames(_ ids: [String]) { camera.deleteFrames(ids) }

  /// Screenshot mode only (DemoScreen.swift).
  func demoState(_ next: ClientState) { state = next }
}
