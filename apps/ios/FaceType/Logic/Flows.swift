//
//  Flows.swift
//  The app's screen flow and the capture flow — pure reducers, ports of apps/mobile/src/client/clientFlow.ts
//  and captureFlow.ts, checked against docs/fixtures/client/{client_flow,capture_flow,spool}.json.
//

import Foundation

// MARK: - client flow

enum ClientScreen: String { case boot, signedOut, profileSetup, profile, capture }

enum ProviderId: String { case apple, google, mock }

enum SignInError: String {
  case cancelled, network, server_unconfigured, unconfigured, unsupported, nonce_invalid, account_withdrawing, failed
}

struct ClientState: Equatable {
  var screen: ClientScreen = .boot
  var me: ClientMe?
  var signInBusy: ProviderId?
  var signInError: SignInError?
  var notice: String?
  var configError: String?
}

enum ClientEvent {
  case configError(String)
  case bootNoSession
  case signInStarted(ProviderId)
  case signInFailed(SignInError)
  case sessionReady(ClientMe)
  case meRefreshed(ClientMe)
  case profileSaved(ClientMe)
  case openCapture
  case closeCapture
  case signedOut(reason: String)
}

enum ClientFlow {
  static func needsSetup(_ me: ClientMe?) -> Bool {
    guard let me else { return true }
    return me.profile == nil || me.consent == nil || me.consent?.store_accepted != true
  }

  private static func signedIn(_ state: ClientState, _ me: ClientMe) -> ClientState {
    var next = state
    next.me = me
    next.screen = needsSetup(me) ? .profileSetup : .profile
    next.signInBusy = nil
    next.signInError = nil
    next.notice = nil
    return next
  }

  static func reduce(_ state: ClientState, _ event: ClientEvent) -> ClientState {
    var next = state
    switch event {
    case .configError(let code):
      next.configError = code
      next.screen = .signedOut
    case .bootNoSession:
      guard state.screen == .boot else { return state }
      next.screen = .signedOut
      next.me = nil
    case .signInStarted(let provider):
      guard state.screen == .signedOut, state.signInBusy == nil, state.configError == nil else { return state }
      next.signInBusy = provider
      next.signInError = nil
      next.notice = nil
    case .signInFailed(let error):
      guard state.screen == .signedOut else { return state }
      next.signInBusy = nil
      next.signInError = error
    case .sessionReady(let me):
      guard state.screen == .boot || state.screen == .signedOut else { return state }
      return signedIn(state, me)
    case .meRefreshed(let me):
      guard state.screen != .boot, state.screen != .signedOut else { return state }
      next.me = me
      if state.screen == .profile && needsSetup(me) { next.screen = .profileSetup }
    case .profileSaved(let me):
      guard state.screen == .profileSetup else { return state }
      next.me = me
      if !needsSetup(me) { next.screen = .profile }
    case .openCapture:
      guard state.screen == .profile, !needsSetup(state.me) else { return state }
      next.screen = .capture
    case .closeCapture:
      guard state.screen == .capture else { return state }
      next.screen = .profile
    case .signedOut(let reason):
      next = ClientState()
      next.configError = state.configError
      next.screen = .signedOut
      next.notice = reason
    }
    return next
  }
}

// MARK: - capture flow

enum CameraErrorCode: String {
  case permission_denied, camera_unavailable, camera_interrupted, model_unavailable, effects_active, internal
}

enum CapturePhase: Equatable {
  case tips
  case guiding(partialReason: String?, retrying: Bool)
  case bursting(accepted: Int, target: Int, topRejectReason: String?)
  case help
  case permissionDenied
  case interrupted
  case cameraError(CameraErrorCode)
  case uploading(done: Int, total: Int, offline: Bool)
  case checking(slow: Bool, measuring: Bool)
  case received
  case done
  case retake(reasons: [String])
  case more(reasons: [String])
  case complete
  case lost
  case failed(code: String)

  var name: String {
    switch self {
    case .tips: return "tips"
    case .guiding: return "guiding"
    case .bursting: return "bursting"
    case .help: return "help"
    case .permissionDenied: return "permission_denied"
    case .interrupted: return "interrupted"
    case .cameraError: return "camera_error"
    case .uploading: return "uploading"
    case .checking: return "checking"
    case .received: return "received"
    case .done: return "done"
    case .retake: return "retake"
    case .more: return "more"
    case .complete: return "complete"
    case .lost: return "lost"
    case .failed: return "failed"
    }
  }

  var isCamera: Bool { name == "guiding" || name == "bursting" }
  var isAfterCamera: Bool {
    ["uploading", "checking", "received", "done", "retake", "more", "complete", "lost", "failed"].contains(name)
  }
}

struct BurstResult {
  enum Status: String { case complete, partial, cancelled }
  let status: Status
  let frames: [BurstFrameRecord]
  let topRejectReason: String?
}

struct CaptureFlowState: Equatable {
  var phase: CapturePhase = .tips
  var kept: [BurstFrameRecord] = []
  var attempts = 0
  var reasonCounts: [String: Int] = [:]
  var guidanceStartedAtMs: Double?
  var sessionStartedAtMs: Double
  var helpShown = false

  init(nowMs: Double) { sessionStartedAtMs = nowMs }
}

enum CaptureEvent {
  case start(nowMs: Double)
  case permissionDenied
  case cameraError(CameraErrorCode)
  case resume(nowMs: Double)
  case tick(nowMs: Double)
  case burstStarted
  case burstProgress(accepted: Int, topRejectReason: String?)
  case burstResult(BurstResult, nowMs: Double)
  case burstFailed(nowMs: Double)
  case enqueued
  case spoolStatus(SpoolOutcome, nowMs: Double)
  case retake
  case continueCapture(nowMs: Double)
}

enum CaptureFlow {
  static let guidanceLimitMs: Double = 60_000
  static var targetFrames = 10

  static func burstDisposition(_ result: BurstResult) -> (keep: [BurstFrameRecord], discard: [String]) {
    if result.status == .complete && result.frames.count == targetFrames { return (result.frames, []) }
    return ([], result.frames.map(\.id))
  }

  /// The durable spool state on the screen.
  static func phase(from outcome: SpoolOutcome, nowMs: Double) -> CapturePhase? {
    guard outcome.kind == .terminal || outcome.kind == .waiting, let m = outcome.manifest else { return nil }
    switch m.stage {
    case .pending_create, .uploading:
      return .uploading(
        done: m.frames.filter(\.completed).count, total: m.frames.count,
        offline: outcome.kind == .waiting && outcome.reason == .offline)
    case .finalizing, .checking:
      let slow = m.checkingSinceMs.map { nowMs - $0 >= SpoolTiming.checkingNoticeMs } ?? false
      return .checking(slow: slow, measuring: m.verdict?.status == "measuring")
    case .received: return .received
    case .stored: return .done
    case .needs_retake: return .retake(reasons: m.verdict?.reasons ?? [])
    case .needs_more: return .more(reasons: m.verdict?.reasons ?? [])
    case .complete: return .complete
    case .abandoned: return .lost
    case .failed: return .failed(code: m.error ?? "unknown")
    }
  }

  private static func guiding(_ state: CaptureFlowState, nowMs: Double) -> CaptureFlowState {
    var next = state
    next.phase = .guiding(partialReason: nil, retrying: false)
    next.guidanceStartedAtMs = nowMs
    return next
  }

  static func reduce(_ state: CaptureFlowState, _ event: CaptureEvent) -> CaptureFlowState {
    var next = state
    let phase = state.phase
    switch event {
    case .start(let nowMs):
      guard phase == .tips else { return state }
      return guiding(state, nowMs: nowMs)
    case .permissionDenied:
      if phase.isAfterCamera { return state }
      next.phase = .permissionDenied
    case .cameraError(let code):
      if phase.isAfterCamera || phase == .tips { return state }
      switch code {
      case .permission_denied: next.phase = .permissionDenied
      case .camera_interrupted: next.phase = .interrupted
      default: next.phase = .cameraError(code)
      }
    case .resume(let nowMs):
      guard ["interrupted", "help", "camera_error", "permission_denied"].contains(phase.name) else { return state }
      return guiding(state, nowMs: nowMs)
    case .tick(let nowMs):
      if phase.name == "guiding", let started = state.guidanceStartedAtMs, nowMs - started >= guidanceLimitMs {
        next.phase = .help
        next.helpShown = true
      } else {
        return state
      }
    case .burstStarted:
      guard phase.name == "guiding" else { return state }
      next.phase = .bursting(accepted: 0, target: targetFrames, topRejectReason: nil)
      next.attempts += 1
    case .burstProgress(let accepted, let top):
      guard case .bursting(_, let target, _) = phase else { return state }
      next.phase = .bursting(accepted: accepted, target: target, topRejectReason: top)
    case .burstResult(let result, let nowMs):
      guard phase.name == "bursting" else { return state }
      if result.status == .cancelled {
        next.kept = []
        next.phase = .guiding(partialReason: nil, retrying: false)
        return next
      }
      let keep = burstDisposition(result).keep
      if let reason = result.topRejectReason { next.reasonCounts[reason, default: 0] += 1 }
      if !keep.isEmpty {
        next.kept = keep
        next.phase = .uploading(done: 0, total: keep.count, offline: false)
        return next
      }
      let overTime = state.guidanceStartedAtMs.map { nowMs - $0 >= guidanceLimitMs } ?? false
      next.kept = []
      next.helpShown = state.helpShown || overTime
      next.phase = overTime ? .help : .guiding(partialReason: result.topRejectReason, retrying: true)
    case .burstFailed:
      guard phase.name == "bursting" else { return state }
      next.phase = .guiding(partialReason: nil, retrying: false)
    case .enqueued:
      next.kept = []
    case .spoolStatus(let outcome, let nowMs):
      guard let mapped = self.phase(from: outcome, nowMs: nowMs) else { return state }
      if phase == .tips || phase.isCamera || phase == .help {
        guard mapped.name == "uploading" || mapped.name == "checking" else { return state }
      }
      next.phase = mapped
    case .retake:
      next = CaptureFlowState(nowMs: state.sessionStartedAtMs)
      next.reasonCounts = state.reasonCounts
    case .continueCapture(let nowMs):
      guard phase.name == "more" else { return state }
      next = CaptureFlowState(nowMs: state.sessionStartedAtMs)
      next.reasonCounts = state.reasonCounts
      return guiding(next, nowMs: nowMs)
    }
    return next
  }
}
