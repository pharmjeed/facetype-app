//
//  SpoolRunner.swift
//  The durable upload of one capture (port of apps/mobile/src/client/spool/spool.ts + manifest.ts):
//  create → upload + complete each frame → finalize → poll until the server's verdict. Every step is saved
//  before the next network call, so a restart resumes where it stopped. One capture at a time, bound to the
//  signed-in account; another account's manifest is deleted, never resumed.
//
//  Concurrency: an actor. A discard (sign-out, session end, account switch) bumps the generation; a run of an
//  older generation stops at its next await and writes nothing more. The manifest file is removed before the
//  frames, so a process death in the middle never resumes a discarded capture (leftover frames are orphans,
//  deleted by `cleanupOrphans`).
//

import Foundation

enum SpoolStage: String, Codable, CaseIterable {
  case pending_create, uploading, finalizing, checking, received, stored, needs_retake, needs_more, complete, failed,
    abandoned

  var isTerminal: Bool {
    switch self {
    case .received, .stored, .needs_retake, .needs_more, .complete, .failed, .abandoned: return true
    default: return false
    }
  }
}

struct ManifestFrame: Codable, Equatable {
  let index: Int
  let nativeId: String
  let sha256: String
  let bytes: Int
  let width: Int
  let height: Int
  var uploaded: Bool
  var completed: Bool
}

struct SpoolManifest: Codable, Equatable {
  var version = SpoolTiming.manifestVersion
  let accountId: String
  let clientCaptureId: String
  let createdAtMs: Double
  var updatedAtMs: Double
  var stage: SpoolStage
  var captureId: String?
  let attempt: Int
  let protocolVersion: String
  let gateConfigHash: String
  let device: [String: JSONValue]
  let camera: [String: JSONValue]
  var frames: [ManifestFrame]
  var verdict: CaptureView?
  var checkingSinceMs: Double?
  var error: String?
  var attemptTelemetry: PendingAttempt?

  var isValid: Bool {
    let indices = Set(frames.map(\.index))
    return version == SpoolTiming.manifestVersion && !accountId.isEmpty && !clientCaptureId.isEmpty
      && !frames.isEmpty && indices.count == frames.count
      && frames.allSatisfy { $0.sha256.count == 64 && (!$0.completed || $0.uploaded) }
      && (stage == .pending_create || stage == .failed || stage == .abandoned || captureId != nil)
  }
}

enum SpoolTiming {
  static let manifestVersion = 2
  static let maxAgeMs: Double = 48 * 60 * 60 * 1000
  static let renewMarginMs: Double = 60_000
  static let pollFastMs: Double = 2_000
  static let pollSlowMs: Double = 5_000
  static let checkingNoticeMs: Double = 30_000
  static let backoffBaseMs: Double = 2_000
  static let backoffMaxMs: Double = 60_000

  static func backoffMs(_ failures: Int) -> Double {
    min(backoffBaseMs * pow(2, Double(min(failures, 10))), backoffMaxMs)
  }
}

struct SpoolOutcome: Equatable {
  enum Kind: String { case idle, terminal, waiting, blocked }
  enum Reason: String { case offline, server, checking }

  var kind: Kind
  var manifest: SpoolManifest?
  var retryInMs: Double?
  var reason: Reason?
  var telemetryRetryInMs: Double?

  static let idle = SpoolOutcome(kind: .idle)
  static func terminal(_ m: SpoolManifest) -> SpoolOutcome { SpoolOutcome(kind: .terminal, manifest: m) }
  static func waiting(_ m: SpoolManifest, _ retry: Double, _ reason: Reason) -> SpoolOutcome {
    SpoolOutcome(kind: .waiting, manifest: m, retryInMs: retry, reason: reason)
  }
  static let blocked = SpoolOutcome(kind: .blocked)

  /// When to run again: the capture's retry or the owed telemetry's, whichever is first; nil = not until
  /// something changes.
  var nextRunInMs: Double? {
    if kind == .blocked { return nil }
    let delays = [kind == .waiting ? retryInMs : nil, telemetryRetryInMs].compactMap { $0 }
    return delays.isEmpty ? nil : max(0, delays.min()!)
  }
}

/// A frame of a finished burst as the spool records it (the JPEG and its meta stay in the native spool).
struct BurstFrameRecord: Equatable {
  let id: String
  let width: Int
  let height: Int
  let sha256: String
  let bytes: Int
}

struct SpoolNativeError: Error { let code: String }

/// What the spool needs from the camera's native spool.
protocol SpoolCamera: Sendable {
  func uploadFrame(id: String, url: String, headers: [String: String]) async throws -> Int
  func deleteFrames(_ ids: [String])
  func listSpool() throws -> [(id: String, createdAtMs: Double)]
  func frameMeta(id: String) -> [String: Any]?
}

/// What the spool needs from the API (`ClientAPI` conforms; tests use a fake).
protocol SpoolAPI: Sendable {
  func createCapture(_ body: [String: Any], idempotencyKey: String) async throws -> CaptureCreated
  func renewFrameUpload(captureId: String, index: Int) async throws -> FrameUploadTarget
  func completeFrame(captureId: String, index: Int, meta: [String: Any]) async throws
  func finalizeCapture(captureId: String) async throws -> CaptureView
  func getCapture(captureId: String) async throws -> CaptureView
  func postAttempt(_ telemetry: [String: Any]) async throws
}

extension ClientAPI: SpoolAPI {}

private struct Superseded: Error {}
private struct Retryable: Error { let reason: SpoolOutcome.Reason }
private struct Fatal: Error { let code: String }

actor SpoolRunner {
  private let api: SpoolAPI
  private let camera: SpoolCamera
  private let manifestFile: ProtectedFile
  private let queue: AttemptQueue
  private let now: () -> Double
  private let gateHash: String
  private let protocolVersion: String

  private(set) var accountId: String?
  private var generation = 0
  private var running: (generation: Int, task: Task<SpoolOutcome, Never>)?
  private var targets: [Int: FrameUploadTarget] = [:]
  private var targetsFor: String?
  private var failures = 0
  private var telemetryFailures = 0
  private var telemetryNextAtMs: Double = 0

  init(api: SpoolAPI, camera: SpoolCamera, manifestFile: ProtectedFile, queue: AttemptQueue, gateHash: String,
       protocolVersion: String, now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
    self.api = api
    self.camera = camera
    self.manifestFile = manifestFile
    self.queue = queue
    self.gateHash = gateHash
    self.protocolVersion = protocolVersion
    self.now = now
  }

  // MARK: manifest storage

  private func loadManifest() -> SpoolManifest? {
    guard let data = manifestFile.read() else { return nil }
    if let m = try? JSONDecoder().decode(SpoolManifest.self, from: data), m.isValid { return m }
    manifestFile.remove()
    return nil
  }

  private func live(_ g: Int) throws { if g != generation { throw Superseded() } }

  private func save(_ g: Int, _ m: SpoolManifest, _ patch: (inout SpoolManifest) -> Void) throws -> SpoolManifest {
    try live(g)
    var next = m
    patch(&next)
    next.updatedAtMs = now()
    try manifestFile.write(JSONEncoder().encode(next))
    return next
  }

  // MARK: public

  /// Bind to the signed-in account; switching straight from one account to another discards the previous one's
  /// capture and owed telemetry.
  func bindAccount(_ account: String?) {
    guard account != accountId else { return }
    let previous = accountId
    accountId = account
    invalidate()
    if previous != nil && account != nil { discardNow(keepTelemetry: false) }
  }

  /// Delete everything local about the current capture (session end, account switch).
  func discard(keepTelemetry: Bool) {
    invalidate()
    discardNow(keepTelemetry: keepTelemetry)
  }

  private func discardNow(keepTelemetry: Bool) {
    if let m = loadManifest() {
      manifestFile.remove()
      camera.deleteFrames(m.frames.map(\.nativeId))
    }
    if !keepTelemetry { queue.clear() }
  }

  /// Advance as far as possible, then send owed attempt telemetry; concurrent calls share one run.
  func runOnce() async -> SpoolOutcome {
    if let running, running.generation == generation { return await running.task.value }
    let g = generation
    let task = Task { () -> SpoolOutcome in
      do {
        return try await self.cycle(g)
      } catch {
        return .idle
      }
    }
    running = (g, task)
    let outcome = await task.value
    if running?.generation == g { running = nil }
    return outcome
  }

  /// Persist a finished burst for the bound account.
  func enqueue(frames: [BurstFrameRecord], attempt: Int, device: [String: JSONValue], camera cameraInfo: [String: JSONValue],
               telemetry: PendingAttempt?) throws -> SpoolManifest {
    guard let account = accountId else { throw SpoolNativeError(code: "no_account") }
    guard !frames.isEmpty else { throw SpoolNativeError(code: "no_frames") }
    if let existing = loadManifest() {
      if existing.accountId != account {
        manifestFile.remove()
        camera.deleteFrames(existing.frames.map(\.nativeId))
      } else if !existing.stage.isTerminal {
        throw SpoolNativeError(code: "capture_in_flight")
      }
    }
    let t = now()
    let manifest = SpoolManifest(
      accountId: account, clientCaptureId: UUID().uuidString.lowercased(), createdAtMs: t, updatedAtMs: t,
      stage: .pending_create, captureId: nil, attempt: attempt, protocolVersion: protocolVersion,
      gateConfigHash: gateHash, device: device, camera: cameraInfo,
      frames: frames.enumerated().map { index, f in
        ManifestFrame(index: index, nativeId: f.id, sha256: f.sha256, bytes: f.bytes, width: f.width,
                      height: f.height, uploaded: false, completed: false)
      },
      verdict: nil, checkingSinceMs: nil, error: nil, attemptTelemetry: telemetry)
    try manifestFile.write(JSONEncoder().encode(manifest))
    return manifest
  }

  /// Forget a terminal manifest once its verdict was seen; the attempt it owes moves to the queue first.
  func acknowledge() async {
    if let running { _ = await running.task.value }
    let g = generation
    guard let m = loadOwn(), m.stage.isTerminal else { return }
    _ = try? queueOwedAttempt(g, m)
    if loadManifest()?.clientCaptureId == m.clientCaptureId { manifestFile.remove() }
  }

  /// Owe the telemetry of an attempt that ended before reaching the spool.
  func recordAttempt(_ telemetry: AttemptTelemetry) -> Bool {
    guard let account = accountId else { return false }
    let entry = QueuedAttempt(key: "attempt-\(UUID().uuidString.lowercased())", telemetry: telemetry,
                              queuedAtMs: now(), aggregate: nil)
    return (try? queue.queue(accountId: account, entry)) != nil
  }

  /// Delete native spool frames no live manifest refers to, or older than 48 h.
  @discardableResult
  func cleanupOrphans() -> Int {
    guard accountId != nil else { return 0 }
    let m = loadOwn()
    let live = Set(m.map { $0.stage.isTerminal ? [] : $0.frames.filter { !$0.completed }.map(\.nativeId) } ?? [])
    guard let entries = try? camera.listSpool() else { return 0 }
    let t = now()
    let orphans = entries.filter { !live.contains($0.id) || t - $0.createdAtMs > SpoolTiming.maxAgeMs }.map(\.id)
    if !orphans.isEmpty { camera.deleteFrames(orphans) }
    return orphans.count
  }

  // MARK: private

  private func invalidate() {
    generation += 1
    running = nil
    targets.removeAll()
    targetsFor = nil
    failures = 0
    telemetryFailures = 0
    telemetryNextAtMs = 0
  }

  /// The bound account's manifest; another account's is deleted and never returned.
  private func loadOwn() -> SpoolManifest? {
    guard let m = loadManifest(), let account = accountId else { return nil }
    if m.accountId == account { return m }
    manifestFile.remove()
    camera.deleteFrames(m.frames.map(\.nativeId))
    return nil
  }

  private func cycle(_ g: Int) async throws -> SpoolOutcome {
    var outcome = try await advance(g)
    if outcome.kind == .blocked { return outcome }
    if let retry = try await sendOwedAttempts(g) { outcome.telemetryRetryInMs = retry }
    return outcome
  }

  private func end(_ g: Int, _ m: SpoolManifest, _ stage: SpoolStage, _ code: String) throws -> SpoolOutcome {
    camera.deleteFrames(m.frames.map(\.nativeId))
    let next = try save(g, m) {
      $0.stage = stage
      $0.error = code
    }
    targets.removeAll()
    return try terminal(g, next)
  }

  private func terminal(_ g: Int, _ m: SpoolManifest) throws -> SpoolOutcome {
    var next = m
    if try queueOwedAttempt(g, m) { next = try save(g, m) { $0.attemptTelemetry = nil } }
    failures = 0
    targets.removeAll()
    return .terminal(next)
  }

  private func queueOwedAttempt(_ g: Int, _ m: SpoolManifest) throws -> Bool {
    guard let pending = m.attemptTelemetry, let outcome = Telemetry.outcome(for: m.stage) else { return false }
    try live(g)
    let entry = QueuedAttempt(key: m.clientCaptureId, telemetry: AttemptTelemetry(outcome: outcome, pending: pending),
                              queuedAtMs: now(), aggregate: nil)
    try queue.queue(accountId: m.accountId, entry)
    return true
  }

  private func sendOwedAttempts(_ g: Int) async throws -> Double? {
    guard let account = accountId else { return nil }
    func later(_ retryAfterMs: Double) -> Double {
      telemetryFailures += 1
      let delay = max(SpoolTiming.backoffMs(telemetryFailures), retryAfterMs)
      telemetryNextAtMs = now() + delay
      return delay
    }
    for _ in 0...AttemptQueue.max {
      try live(g)
      guard let entry = queue.load(accountId: account).first else {
        telemetryFailures = 0
        telemetryNextAtMs = 0
        return nil
      }
      let wait = telemetryNextAtMs - now()
      if wait > 0 { return wait }
      do {
        try await api.postAttempt(entry.telemetry.body)
        try live(g)
      } catch is Superseded {
        throw Superseded()
      } catch let error as ClientAPIError where error.kind == .validation {
        try live(g)  // refused as invalid: dropped
      } catch let error as ClientAPIError {
        try live(g)
        return later((error.retryAfterSeconds ?? 0) * 1000)
      } catch {
        try live(g)
        return later(0)
      }
      telemetryFailures = 0
      try? queue.remove(accountId: account, key: entry.key)
    }
    return later(0)
  }

  private func createBody(_ m: SpoolManifest) -> [String: Any] {
    [
      "client_capture_id": m.clientCaptureId, "protocol_version": m.protocolVersion,
      "gate_config_hash": m.gateConfigHash, "device": m.device.mapValues(\.any), "camera": m.camera.mapValues(\.any),
      "frames": m.frames.map { ["index": $0.index, "sha256": $0.sha256, "bytes": $0.bytes, "width": $0.width,
                                "height": $0.height] },
      "attempt": ["attempts": m.attempt],
    ]
  }

  private func advance(_ g: Int) async throws -> SpoolOutcome {
    guard var m = loadOwn() else { return .idle }
    if m.stage.isTerminal { return try terminal(g, m) }
    if targetsFor != m.clientCaptureId {
      targets.removeAll()
      targetsFor = m.clientCaptureId
    }
    if (m.stage == .pending_create || m.stage == .uploading) && now() - m.createdAtMs > SpoolTiming.maxAgeMs {
      return try end(g, m, .abandoned, "expired")
    }
    do {
      if m.stage == .pending_create {
        let created = try await api.createCapture(createBody(m), idempotencyKey: m.clientCaptureId)
        try live(g)
        for target in created.frames { targets[target.index] = target }
        let done = Set(created.frames.filter(\.completed).map(\.index))
        m = try save(g, m) {
          $0.stage = .uploading
          $0.captureId = created.capture_id
          $0.error = nil
          $0.frames = $0.frames.map { f in
            var copy = f
            if done.contains(f.index) {
              copy.uploaded = true
              copy.completed = true
            }
            return copy
          }
        }
        if !done.isEmpty { camera.deleteFrames(m.frames.filter { done.contains($0.index) }.map(\.nativeId)) }
      }
      if m.stage == .uploading {
        if let lost = try preflight(m) { return try end(g, m, .abandoned, lost) }
        for frame in m.frames.sorted(by: { $0.index < $1.index }) where !frame.completed {
          m = try await uploadAndComplete(g, m, frame.index)
        }
        m = try save(g, m) { $0.stage = .finalizing }
      }
      var justFinalized = false
      if m.stage == .finalizing {
        justFinalized = true
        var view: CaptureView
        do {
          view = try await api.finalizeCapture(captureId: m.captureId!)
          try live(g)
        } catch let error as ClientAPIError where error.kind == .capture_state {
          try live(g)
          view = try await api.getCapture(captureId: m.captureId!)
          try live(g)
          if view.status == "uploading" { throw error }
        }
        m = try applyVerdict(g, m, view)
      }
      if m.stage == .checking {
        if !justFinalized {
          let view = try await api.getCapture(captureId: m.captureId!)
          try live(g)
          m = try applyVerdict(g, m, view)
        }
        if m.stage == .checking {
          failures = 0
          let since = m.checkingSinceMs ?? now()
          let slow = now() - since >= SpoolTiming.checkingNoticeMs
          return .waiting(m, slow ? SpoolTiming.pollSlowMs : SpoolTiming.pollFastMs, .checking)
        }
      }
    } catch is Superseded {
      throw Superseded()
    } catch {
      return try failed(g, m, error)
    }
    return try terminal(g, m)
  }

  private func failed(_ g: Int, _ stale: SpoolManifest, _ error: Error) throws -> SpoolOutcome {
    try live(g)
    let m = loadOwn() ?? stale
    if let fatal = error as? Fatal {
      let lost = ["frames_lost", "spool_unreadable", "meta_lost"].contains(fatal.code)
      return try end(g, m, lost ? .abandoned : .failed, fatal.code)
    }
    let api = error as? ClientAPIError
    if api?.kind == .session_expired { return .blocked }
    let retryable =
      error is Retryable
      || (api.map { $0.retryable || $0.kind == .network || $0.kind == .server || $0.kind == .rate_limited } ?? false)
    if !retryable {
      return try end(g, m, .failed, api.map { $0.code ?? $0.kind.rawValue } ?? "unexpected")
    }
    failures += 1
    let reason: SpoolOutcome.Reason =
      (error as? Retryable)?.reason ?? (api?.kind == .network ? .offline : .server)
    let code = api.map { $0.code ?? $0.kind.rawValue } ?? reason.rawValue
    let next = try save(g, m) { $0.error = code }
    let retryAfter = (api?.retryAfterSeconds ?? 0) * 1000
    return .waiting(next, max(SpoolTiming.backoffMs(failures), retryAfter), reason)
  }

  /// nil if every unfinished frame can still be uploaded and completed; else why not.
  private func preflight(_ m: SpoolManifest) throws -> String? {
    let pending = m.frames.filter { !$0.completed }
    guard !pending.isEmpty else { return nil }
    let spool: Set<String>
    do {
      spool = Set(try camera.listSpool().map(\.id))
    } catch {
      throw Retryable(reason: .server)
    }
    for frame in pending {
      if !frame.uploaded && !spool.contains(frame.nativeId) { return "frames_lost" }
      if camera.frameMeta(id: frame.nativeId) == nil { return "meta_lost" }
    }
    return nil
  }

  private static func expiresAtMs(_ t: FrameUploadTarget) -> Double {
    guard let text = t.expires_at else { return 0 }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: text) { return d.timeIntervalSince1970 * 1000 }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: text).map { $0.timeIntervalSince1970 * 1000 } ?? 0
  }

  private func target(_ g: Int, _ m: SpoolManifest, _ index: Int, forceRenew: Bool) async throws
    -> FrameUploadTarget
  {
    let cached = targets[index]
    if let cached, cached.completed || cached.upload_url == nil { return cached }
    if !forceRenew, let cached, Self.expiresAtMs(cached) - now() > SpoolTiming.renewMarginMs { return cached }
    var renewed: FrameUploadTarget
    do {
      renewed = try await api.renewFrameUpload(captureId: m.captureId!, index: index)
      try live(g)
    } catch let error as ClientAPIError where error.kind == .frame_immutable {
      try live(g)
      renewed = FrameUploadTarget(index: index, completed: true, upload_url: nil, method: "PUT", headers: [:],
                                  expires_at: nil)
    }
    targets[index] = renewed
    return renewed
  }

  private func putBytes(_ g: Int, _ m: SpoolManifest, _ index: Int, _ nativeId: String) async throws {
    var t = try await target(g, m, index, forceRenew: false)
    for attempt in 0..<2 {
      guard !t.completed, let url = t.upload_url else { return }
      let status: Int
      do {
        status = try await camera.uploadFrame(id: nativeId, url: url, headers: t.headers ?? [:])
        try live(g)
      } catch is Superseded {
        throw Superseded()
      } catch let error as SpoolNativeError {
        try live(g)
        switch error.code {
        case "not_found": throw Fatal(code: "frames_lost")
        case "spool_unreadable": throw Fatal(code: "spool_unreadable")
        case "invalid_argument": throw Fatal(code: "upload_invalid_argument")
        case "spool_error": throw Retryable(reason: .server)
        default: throw Retryable(reason: .offline)
        }
      } catch {
        try live(g)
        throw Retryable(reason: .offline)
      }
      if (200..<300).contains(status) { return }
      if status == 0 || status >= 500 || status == 408 || status == 429 {
        throw Retryable(reason: status == 0 ? .offline : .server)
      }
      if [400, 401, 403, 410].contains(status) && attempt == 0 {
        t = try await target(g, m, index, forceRenew: true)
        continue
      }
      throw Fatal(code: "upload_rejected_\(status)")
    }
  }

  private func markFrame(_ g: Int, _ m: SpoolManifest, _ index: Int, uploaded: Bool? = nil, completed: Bool? = nil)
    throws -> SpoolManifest
  {
    try save(g, m) {
      $0.frames = $0.frames.map { f in
        guard f.index == index else { return f }
        var copy = f
        if let uploaded { copy.uploaded = uploaded }
        if let completed { copy.completed = completed }
        return copy
      }
    }
  }

  private func uploadAndComplete(_ g: Int, _ start: SpoolManifest, _ index: Int) async throws -> SpoolManifest {
    var m = start
    var frame = m.frames.first { $0.index == index }!
    guard let meta = camera.frameMeta(id: frame.nativeId) else { throw Fatal(code: "meta_lost") }
    for attempt in 0..<2 {
      if !frame.uploaded {
        try await putBytes(g, m, index, frame.nativeId)
        m = try markFrame(g, m, index, uploaded: true)
        frame = m.frames.first { $0.index == index }!
      }
      do {
        try await api.completeFrame(captureId: m.captureId!, index: index, meta: meta)
        try live(g)
      } catch let error as ClientAPIError {
        try live(g)
        if error.kind == .frame_immutable {
          // completed by an earlier attempt whose 204 was lost
        } else if attempt == 0 && (error.kind == .upload_missing || error.kind == .upload_mismatch) {
          m = try markFrame(g, m, index, uploaded: false)
          frame = m.frames.first { $0.index == index }!
          continue
        } else {
          throw error
        }
      }
      m = try markFrame(g, m, index, uploaded: true, completed: true)
      camera.deleteFrames([frame.nativeId])
      return m
    }
    throw Fatal(code: "upload_mismatch")
  }

  private func applyVerdict(_ g: Int, _ m: SpoolManifest, _ view: CaptureView) throws -> SpoolManifest {
    if let stage = SpoolStage(rawValue: view.status),
      [.received, .stored, .needs_retake, .needs_more, .complete].contains(stage)
    {
      return try save(g, m) {
        $0.stage = stage
        $0.verdict = view
        $0.error = nil
      }
    }
    return try save(g, m) {
      $0.stage = .checking
      $0.verdict = view
      $0.checkingSinceMs = m.checkingSinceMs ?? now()
      $0.error = nil
    }
  }
}
