//
//  ClientAPI.swift
//  /api/v1/client over URLSession (port of apps/mobile/src/client/api/clientApi.ts):
//  - the access token is refreshed 30 s before it expires; one refresh at a time, every caller awaits it;
//  - a 401 retries once with a fresher token, a second 401 ends the session;
//  - a refused refresh (400/401/403, or account withdrawing) ends the session; a network failure keeps it;
//  - tokens are saved before they are used.
//  Errors are `ClientAPIError`; `mapProblem` is checked against docs/fixtures/client/problems.json.
//

import Foundation

enum ClientErrorKind: String, Codable {
  case network, session_expired, unauthorized, provider_unconfigured, nonce_invalid, identifier_taken, validation,
    consent_required, profile_required, account_withdrawing, not_found, capture_conflict, capture_state,
    frame_immutable, upload_missing, upload_mismatch, rate_limited, server, unknown
}

struct ClientAPIError: Error, Equatable {
  let kind: ClientErrorKind
  let status: Int
  var code: String?
  var retryable = false
  var retryAfterSeconds: Double?
  var fieldErrors: [String: String] = [:]
}

enum ProblemContext: String { case auth, profile, capture, other }

enum ClientAPIMapping {
  static let prefix = "/api/v1/client"
  static let refreshSkewMs: Double = 30_000
  static let requestTimeout: TimeInterval = 30

  static let codeKinds: [String: ClientErrorKind] = [
    "FT-CLIENT-AUTH-UNCONFIGURED": .provider_unconfigured,
    "FT-CLIENT-NONCE-INVALID": .nonce_invalid,
    "FT-CLIENT-ACCOUNT-WITHDRAWING": .account_withdrawing,
    "FT-CLIENT-PROFILE-INVALID": .validation,
    "FT-CLIENT-ID-TAKEN": .identifier_taken,
    "FT-CLIENT-PROFILE-REQUIRED": .profile_required,
    "FT-CLIENT-CAPTURE-NOT-FOUND": .not_found,
    "FT-CLIENT-CAPTURE-CONFLICT": .capture_conflict,
    "FT-CLIENT-CAPTURE-STATE": .capture_state,
    "FT-CLIENT-FRAME-IMMUTABLE": .frame_immutable,
    "FT-CLIENT-UPLOAD-MISSING": .upload_missing,
    "FT-CLIENT-UPLOAD-MISMATCH": .upload_mismatch,
    "FT-PRIV-003": .consent_required,
    "FT-AUTH-001": .unauthorized,
    "FT-AUTH-002": .provider_unconfigured,
    "FT-AUTH-003": .unauthorized,
    "FT-SYS-001": .rate_limited,
    "FT-SYS-002": .server,
  ]

  /// An HTTP failure → kind; `context` disambiguates a bare 409/503.
  static func mapProblem(status: Int, body: [String: Any]?, context: ProblemContext) -> ClientAPIError {
    let code = body?["error_code"] as? String
    var kind = code.flatMap { codeKinds[$0] }
    if kind == nil {
      if status == 401 {
        kind = .unauthorized
      } else if status == 409 && context == .profile {
        kind = .identifier_taken
      } else if status == 503 && context == .auth {
        kind = .provider_unconfigured
      } else if status == 400 || status == 422 {
        kind = .validation
      } else if status == 404 {
        kind = .not_found
      } else if status == 429 {
        kind = .rate_limited
      } else if status >= 500 {
        kind = .server
      } else {
        kind = .unknown
      }
    }
    var fields: [String: String] = [:]
    for item in body?["errors"] as? [[String: Any]] ?? [] {
      if let field = item["field"] as? String {
        let name = field.hasPrefix("body.") ? String(field.dropFirst(5)) : field
        fields[name] = item["message"] as? String ?? ""
      }
    }
    let action = body?["action"] as? [String: Any]
    if let actionFields = action?["fields"] as? [String: Any] {
      for (field, reason) in actionFields {
        if let reason = reason as? String { fields[field] = reason }
      }
    }
    let finalUpload =
      kind == .upload_mismatch
      && ((action?["reason"] as? String) == "jpeg_invalid" || (action?["reason"] as? String) == "dimensions_mismatch")
    let retryable: Bool
    if kind == .validation || finalUpload {
      retryable = false
    } else if let flag = body?["retryable"] as? Bool {
      retryable = flag
    } else {
      retryable = status >= 500 || status == 429 || kind == .upload_missing || kind == .upload_mismatch
    }
    return ClientAPIError(
      kind: kind!, status: status, code: code, retryable: retryable,
      retryAfterSeconds: (body?["retry_after_seconds"] as? NSNumber)?.doubleValue, fieldErrors: fields)
  }
}

/// The HTTP layer, swappable in tests.
protocol HTTPTransport {
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

struct URLSessionTransport: HTTPTransport {
  let session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = ClientAPIMapping.requestTimeout
    configuration.urlCache = nil
    return URLSession(configuration: configuration)
  }()

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    return (data, http)
  }
}

actor ClientAPI {
  private let base: String
  private let apiRoot: String
  private let tokens: TokenStore
  private let transport: HTTPTransport
  private let now: () -> Double
  private let onSessionEnded: @Sendable () -> Void

  /// nil = not loaded yet; .some(nil) = signed out.
  private var cached: StoredTokens??
  private var refreshing: Task<StoredTokens, Error>?
  private var ended = false

  init(
    baseURL: String, tokens: TokenStore, transport: HTTPTransport = URLSessionTransport(),
    now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 },
    onSessionEnded: @escaping @Sendable () -> Void
  ) {
    var root = baseURL
    while root.hasSuffix("/") { root.removeLast() }
    apiRoot = root
    base = root + ClientAPIMapping.prefix
    self.tokens = tokens
    self.transport = transport
    self.now = now
    self.onSessionEnded = onSessionEnded
  }

  // MARK: tokens

  private func currentTokens() -> StoredTokens? {
    if cached == nil { cached = .some(tokens.load()) }
    return cached!
  }

  private func adopt(_ pair: TokenPair) throws {
    let stored = StoredTokens.from(pair, nowMs: now())
    try tokens.save(stored)
    cached = .some(stored)
    ended = false
  }

  private func endSession() {
    cached = .some(nil)
    refreshing = nil
    tokens.clear()
    if !ended {
      ended = true
      onSessionEnded()
    }
  }

  // MARK: transport

  private func send(
    _ method: String, _ path: String, body: Any?, token: String?, idempotencyKey: String?
  ) async throws -> (Data, HTTPURLResponse) {
    guard let url = URL(string: base + path) else {
      throw ClientAPIError(kind: .network, status: 0, retryable: false)
    }
    var request = URLRequest(url: url, timeoutInterval: ClientAPIMapping.requestTimeout)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
    }
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
    do {
      return try await transport.send(request)
    } catch is CancellationError {
      throw ClientAPIError(kind: .network, status: 0, retryable: false)
    } catch let error as ClientAPIError {
      throw error
    } catch {
      throw ClientAPIError(kind: .network, status: 0, retryable: true)
    }
  }

  private func failure(_ data: Data, _ response: HTTPURLResponse, _ context: ProblemContext) -> ClientAPIError {
    let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    return ClientAPIMapping.mapProblem(status: response.statusCode, body: body, context: context)
  }

  private func refresh() async throws -> StoredTokens {
    if let refreshing { return try await refreshing.value }
    let task = Task<StoredTokens, Error> {
      guard let current = currentTokens() else { throw ClientAPIError(kind: .session_expired, status: 401) }
      let (data, response) = try await send(
        "POST", "/auth/refresh", body: ["refresh_token": current.refreshToken], token: nil, idempotencyKey: nil)
      guard (200..<300).contains(response.statusCode) else {
        let error = failure(data, response, .auth)
        if [400, 401, 403].contains(response.statusCode) || error.kind == .account_withdrawing {
          endSession()
          throw ClientAPIError(kind: .session_expired, status: response.statusCode, code: error.code)
        }
        throw error
      }
      try adopt(try JSONDecoder().decode(TokenPair.self, from: data))
      return currentTokens()!
    }
    refreshing = task
    defer { refreshing = nil }
    return try await task.value
  }

  private func freshAccessToken() async throws -> String {
    if let refreshing { return try await refreshing.value.accessToken }
    guard let current = currentTokens() else { throw ClientAPIError(kind: .session_expired, status: 401) }
    if current.accessExpiresAtMs - now() <= ClientAPIMapping.refreshSkewMs { return try await refresh().accessToken }
    return current.accessToken
  }

  private func request(
    _ method: String, _ path: String, body: Any? = nil, auth: Bool = true, context: ProblemContext = .other,
    idempotencyKey: String? = nil
  ) async throws -> Data {
    var used = auth ? try await freshAccessToken() : nil
    var (data, response) = try await send(method, path, body: body, token: used, idempotencyKey: idempotencyKey)
    if auth && response.statusCode == 401 {
      if let current = currentTokens(), current.accessToken != used {
        used = current.accessToken
      } else {
        used = try await refresh().accessToken
      }
      (data, response) = try await send(method, path, body: body, token: used, idempotencyKey: idempotencyKey)
      if response.statusCode == 401 {
        endSession()
        throw ClientAPIError(kind: .session_expired, status: 401)
      }
    }
    guard (200..<300).contains(response.statusCode) else {
      let error = failure(data, response, context)
      if auth && error.kind == .account_withdrawing { endSession() }
      throw error
    }
    return data
  }

  private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
    do {
      return try JSONDecoder().decode(type, from: data)
    } catch {
      throw ClientAPIError(kind: .unknown, status: 200, code: "decode_failed")
    }
  }

  private func absolute(_ target: FrameUploadTarget) -> FrameUploadTarget {
    var copy = target
    if let url = target.upload_url, url.hasPrefix("/") { copy.upload_url = apiRoot + url }
    return copy
  }

  private func exchange(_ path: String, _ body: [String: Any]) async throws {
    let data = try await request("POST", path, body: body, auth: false, context: .auth)
    try adopt(try decode(TokenPair.self, data))
  }

  /// `encodeURIComponent`: ASCII letters, digits and -_.!~*'() stay; everything else is percent-encoded.
  private static let unreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

  private static func escape(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
  }

  // MARK: endpoints

  func restore() -> Bool { currentTokens() != nil }

  func nonce() async throws -> NonceResponse {
    try decode(NonceResponse.self, try await request("POST", "/auth/nonce", auth: false, context: .auth))
  }

  func signInGoogle(idToken: String) async throws { try await exchange("/auth/google", ["id_token": idToken]) }

  func signInApple(identityToken: String, nonce: String, fullName: String?) async throws {
    var body: [String: Any] = ["identity_token": identityToken, "nonce": nonce]
    if let fullName { body["full_name"] = fullName }
    try await exchange("/auth/apple", body)
  }

  func signInMock(subject: String) async throws { try await exchange("/auth/mock", ["subject": subject]) }

  func me() async throws -> ClientMe { try decode(ClientMe.self, try await request("GET", "/me")) }

  func putProfile(_ values: ProfileValues) async throws {
    let body = (try JSONSerialization.jsonObject(with: JSONEncoder().encode(values))) as? [String: Any] ?? [:]
    _ = try await request("PUT", "/me/profile", body: body, context: .profile)
  }

  func postConsent(version: String, storeAccepted: Bool, researchUse: Bool) async throws {
    _ = try await request(
      "POST", "/me/consent", body: ["version": version, "store_accepted": storeAccepted, "research_use": researchUse])
  }

  func createCapture(_ body: [String: Any], idempotencyKey: String) async throws -> CaptureCreated {
    var created = try decode(
      CaptureCreated.self,
      try await request("POST", "/captures", body: body, context: .capture, idempotencyKey: idempotencyKey))
    created.frames = created.frames.map(absolute)
    return created
  }

  func renewFrameUpload(captureId: String, index: Int) async throws -> FrameUploadTarget {
    absolute(
      try decode(
        FrameUploadTarget.self,
        try await request("POST", "/captures/\(Self.escape(captureId))/frames/\(index)/renew", context: .capture)))
  }

  func completeFrame(captureId: String, index: Int, meta: [String: Any]) async throws {
    _ = try await request(
      "POST", "/captures/\(Self.escape(captureId))/frames/\(index)/complete", body: ["meta": meta], context: .capture)
  }

  func finalizeCapture(captureId: String) async throws -> CaptureView {
    try decode(
      CaptureView.self, try await request("POST", "/captures/\(Self.escape(captureId))/finalize", context: .capture))
  }

  func getCapture(captureId: String) async throws -> CaptureView {
    try decode(CaptureView.self, try await request("GET", "/captures/\(Self.escape(captureId))", context: .capture))
  }

  func postAttempt(_ telemetry: [String: Any]) async throws {
    _ = try await request("POST", "/attempts", body: telemetry)
  }
}
