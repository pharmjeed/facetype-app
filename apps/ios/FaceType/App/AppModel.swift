//
//  AppModel.swift
//  Owns every side effect of the client app (port of apps/mobile/src/client/ClientApp.tsx): boot, sign-in,
//  profile save + terms consent, the upload pump, session end, and the interface language. Screens read its
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
  /// The terms and conditions version recorded with the agreement (docs/client-terms-v1-ar.md; owner decision
  /// 2026-11-26: a ticked box under the terms replaces the one notice line). Checked against the fixtures.
  static let consentVersions: [Lang: String] = [.ar: "client-terms-v1", .en: "client-terms-v1-en"]
  private static let languageKey = "ai.facetype.client.language"
  private static let mockSubjectKey = "ai.facetype.client.mock-subject"

  @Published private(set) var state = ClientState()
  @Published private(set) var language: Lang
  @Published private(set) var spool: SpoolOutcome = .idle
  @Published var form = ProfileForm()
  @Published var formErrors: [ProfileField: String] = [:]
  @Published private(set) var saving = false
  /// The «أوافق على الشروط والأحكام» box; nothing is saved before it is ticked.
  @Published var termsAccepted = false
  /// «حفظ ومتابعة» was pressed with the box empty: the box and its message turn red until it is ticked.
  @Published var termsMissing = false
  @Published private(set) var setupError: SetupError?
  @Published private(set) var refreshing = false
  @Published private(set) var bootFailed = false
  @Published private(set) var appleNonce: String?
  /// The page shown after sign-in («معلوماتي» / «التصوير» / «ملفي»). Kept here so the person comes back to the same
  /// page after the camera closes; nil until the person picks one.
  @Published var mainTab: MainTab?
  /// Signing out or deleting the account is in progress.
  @Published private(set) var accountBusy = false
  /// Why the last account deletion failed (a string key), if it did.
  @Published private(set) var accountError: String?

  let camera = CameraService.shared
  /// Keeps a burst going for a short while when the person leaves the app (owner's 4th capture, 2026-11-26:
  /// two frames went up, the other eight waited three hours until the app was opened again).
  private let upload = UploadAssertion()
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
    watchProtectedData()
  }

  /// The spool's files are unreadable while the phone is locked (complete data protection). When it locks, the run
  /// stops before they go dark and the upload assertion is let go; when it unlocks, the pump starts again. Build 12
  /// kept running after the lock and could take an unreadable frame for a lost one.
  private func watchProtectedData() {
    ProtectedData.shared.set(UIApplication.shared.isProtectedDataAvailable)
    let center = NotificationCenter.default
    center.addObserver(
      forName: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil, queue: .main
    ) { [weak self] _ in
      ProtectedData.shared.set(false)
      MainActor.assumeIsolated { self?.pauseForLock() }
    }
    center.addObserver(
      forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main
    ) { [weak self] _ in
      ProtectedData.shared.set(true)
      MainActor.assumeIsolated { self?.pump() }
    }
  }

  private func pauseForLock() {
    pumpTask?.cancel()
    pumpTask = nil
    upload.release()
    Task { await runner.pause() }
  }

  // MARK: language

  /// UIKit-backed pieces (lists, text fields, navigation bars) take their direction from the phone's language,
  /// SwiftUI from the environment. When the two disagree (English chosen on an Arabic phone) UIKit content is
  /// drawn mirrored. Two levers keep them in agreement:
  /// - the window's layout-direction trait, at once (iOS 17+, `AppWindows`);
  /// - the app's own `AppleLanguages`, the same setting as iOS's per-app language in Settings: from the next
  ///   launch the whole app, system pieces included (the Sign in with Apple button), starts in this language.
  /// Not `UIView.appearance().semanticContentAttribute`: it is fixed into each view when the view is created, so
  /// after a switch inside the app the views that already existed kept the old direction (UI test, 2026-11-25:
  /// Arabic → English drew the form right to left even on an English phone; a relaunch was correct).
  static func applyUIKitDirection(_ language: Lang) {
    UserDefaults.standard.set([language.rawValue], forKey: "AppleLanguages")
    AppWindows.applyDirection(language)
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
    leaveSession(notice: "session_expired", keepTelemetry: true)
  }

  /// Everything local about the session goes: the pump, the spool, the Google sign-in; then the sign-in screen
  /// with `notice`.
  private func leaveSession(notice: String, keepTelemetry: Bool) {
    signedIn = false
    mainTab = nil
    pumpTask?.cancel()
    pumpTask = nil
    upload.release()
    spool = .idle
    Task {
      await self.runner.discard(keepTelemetry: keepTelemetry)
      await self.runner.bindAccount(nil)
    }
    GoogleAuth.signOut()
    state = ClientFlow.reduce(state, .signedOut(reason: notice))
  }

  // MARK: account (owner 2026-11-26: sign out, and delete the account and its data from the app)

  func signOut() async {
    accountBusy = true
    defer { accountBusy = false }
    await api.logout()
    leaveSession(notice: "signed_out", keepTelemetry: true)
  }

  /// `DELETE /client/me`, then the session ends here with nothing kept on the phone. On failure the person stays
  /// signed in and `accountError` says why.
  func deleteAccount() async {
    accountError = nil
    accountBusy = true
    defer { accountBusy = false }
    do {
      try await api.deleteMe()
    } catch let error as ClientAPIError {
      // Already being deleted: the server has it; the session ends below as after a fresh request.
      if error.kind != .account_withdrawing {
        accountError = error.kind == .network ? "common.network" : "account.delete_failed"
        return
      }
    } catch {
      accountError = "account.delete_failed"
      return
    }
    await api.forgetSession()
    leaveSession(notice: "account_deleted", keepTelemetry: false)
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

  /// Validate, check the terms box, save, then record the terms consent. Returns the first field in error (for
  /// scrolling), if any. Nothing reaches the server while a field is wrong or the box is empty.
  @discardableResult
  func saveProfile() async -> ProfileField? {
    setupError = nil
    let termsOK = termsAccepted || !needsConsent
    termsMissing = !termsOK
    switch Validation.validateProfile(form) {
    case .failure(let errors):
      formErrors = errors.fields
      return ProfileField.allCases.first { errors.fields[$0] != nil }
    case .success(let values):
      formErrors = [:]
      guard termsOK else { return nil }
      saving = true
      defer { saving = false }
      do {
        try await api.putProfile(values)
        if needsConsent {
          do {
            try await api.postConsent(
              version: Self.consentVersions[language] ?? "client-terms-v1", storeAccepted: true, researchUse: true)
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
    guard signedIn else {
      upload.release()
      return
    }
    // iOS suspends an app a few seconds after it leaves the screen; the assertion asks for the time to finish
    // sending the burst (one run creates, uploads every frame and finalizes). It is held across a retry wait while
    // frames are still to be sent, and let go once the server has the burst or nothing is owed.
    upload.hold()
    let outcome = await runner.runOnce()
    if !Self.stillSending(outcome) { upload.release() }
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

  /// Frames are still on the phone: the burst is created, uploading or finalizing and the run is waiting to retry.
  /// From `checking` on the server works alone, so the phone need not stay awake.
  nonisolated static func stillSending(_ outcome: SpoolOutcome) -> Bool {
    guard outcome.kind == .waiting, let stage = outcome.manifest?.stage else { return false }
    return stage == .pending_create || stage == .uploading || stage == .finalizing
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

/// One `beginBackgroundTask` at a time for the upload. iOS gives an app that leaves the screen a short, limited
/// time; when it runs out the expiration handler ends the task (an unended task gets the app killed), and the
/// spool resumes as before when the app is opened again.
@MainActor
final class UploadAssertion {
  private var task: UIBackgroundTaskIdentifier = .invalid

  func hold() {
    guard task == .invalid else { return }
    task = UIApplication.shared.beginBackgroundTask(withName: "ai.facetype.upload") { [weak self] in
      MainActor.assumeIsolated { self?.release() }
    }
  }

  func release() {
    guard task != .invalid else { return }
    let ending = task
    task = .invalid
    UIApplication.shared.endBackgroundTask(ending)
  }
}
