//
//  CaptureScreen.swift
//  Screen 4 — capture (port of apps/mobile/src/client/screens/CaptureScreen.tsx): tips → camera with the oval
//  and one live message at a time → the burst starts by itself once guidance is ready (no shutter) → upload →
//  the server's check and measurement → its verdict. The only instruction about the face itself is «بدون ابتسامة».
//

import SwiftUI
import UIKit

@MainActor
final class CaptureModel: ObservableObject {
  @Published private(set) var flow: CaptureFlowState
  @Published private(set) var guidance: GuidanceState
  @Published private(set) var enqueueFailed = false
  private var burstTask: Task<Void, Never>?
  private var ticker: Task<Void, Never>?
  private weak var app: AppModel?
  private let gate: FaceTypeClientGateConfig?
  private var enqueued = false

  init(app: AppModel) {
    self.app = app
    let now = Self.nowMs()
    flow = CaptureFlowState(nowMs: now)
    guidance = GuidanceState(nowMs: now)
    gate = app.camera.gate?.config
    if let target = gate?.burst.targetFrames { CaptureFlow.targetFrames = target }
  }

  static func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

  private func send(_ event: CaptureEvent) { flow = CaptureFlow.reduce(flow, event) }

  var view: GuidanceView? { gate.map { Guidance.view(guidance, $0) } }

  // MARK: camera events

  func start() {
    send(.start(nowMs: Self.nowMs()))
    guidance = GuidanceState(nowMs: Self.nowMs())
    startTicker()
  }

  func resume() {
    send(.resume(nowMs: Self.nowMs()))
    guidance = Guidance.rearm(guidance)
  }

  private func startTicker() {
    ticker?.cancel()
    ticker = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        await MainActor.run { self?.send(.tick(nowMs: Self.nowMs())) }
      }
    }
  }

  func onMeasure(_ m: FrameMeasure) {
    guard let gate, flow.phase.isCamera else { return }
    guidance = Guidance.step(guidance, m, gate)
    if case .guiding = flow.phase, burstTask == nil, Guidance.view(guidance, gate).ready { beginBurst() }
  }

  func onProgress(accepted: Int, topRejectReason: String?) {
    send(.burstProgress(accepted: accepted, topRejectReason: topRejectReason))
  }

  func onError(_ code: String) {
    send(.cameraError(CameraErrorCode(rawValue: code) ?? .internal))
  }

  private func beginBurst() {
    guard let app else { return }
    send(.burstStarted)
    burstTask = Task { [weak self] in
      do {
        let out = try await app.camera.startBurst()
        await self?.handle(out)
      } catch {
        self?.send(.burstFailed(nowMs: Self.nowMs()))
      }
      self?.burstTask = nil
    }
  }

  private func handle(_ out: BurstOutcome) async {
    guard let app else { return }
    let result = BurstResult(status: out.status, frames: out.frames, topRejectReason: out.topRejectReason)
    let disposition = CaptureFlow.burstDisposition(result)
    if !disposition.discard.isEmpty { app.deleteFrames(disposition.discard) }
    send(.burstResult(result, nowMs: Self.nowMs()))
    guard !disposition.keep.isEmpty else {
      guidance = Guidance.rearm(guidance)
      return
    }
    let pending = PendingAttempt.make(
      startedAtMs: flow.sessionStartedAtMs, nowMs: Self.nowMs(), attempts: flow.attempts,
      reasonCounts: flow.reasonCounts, device: app.device())
    do {
      try await app.enqueue(frames: disposition.keep, attempts: flow.attempts, telemetry: pending)
      enqueued = true
      send(.enqueued)
    } catch {
      enqueueFailed = true
    }
  }

  func spoolChanged(_ outcome: SpoolOutcome) {
    send(.spoolStatus(outcome, nowMs: Self.nowMs()))
  }

  // MARK: actions

  func cancel() async {
    guard let app else { return }
    ticker?.cancel()
    if burstTask != nil { await app.camera.cancelBurst() }
    if !enqueued, !flow.kept.isEmpty { app.deleteFrames(flow.kept.map(\.id)) }
    if flow.phase != .tips, !flow.phase.isAfterCamera {
      let outcome: AttemptOutcome =
        flow.phase == .permissionDenied ? .permission_denied : (flow.helpShown ? .timed_out : .cancelled)
      let pending = PendingAttempt.make(
        startedAtMs: flow.sessionStartedAtMs, nowMs: Self.nowMs(), attempts: flow.attempts,
        reasonCounts: flow.reasonCounts, device: app.device())
      await app.recordAttempt(AttemptTelemetry(outcome: outcome, pending: pending))
    }
    if enqueueFailed, !flow.kept.isEmpty { app.deleteFrames(flow.kept.map(\.id)) }
    app.closeCapture()
  }

  func finish() async {
    guard let app else { return }
    ticker?.cancel()
    await app.acknowledge()
    app.closeCapture()
  }

  func retake() async {
    await app?.acknowledge()
    enqueued = false
    enqueueFailed = false
    send(.retake)
  }

  func continueCapture() async {
    await app?.acknowledge()
    enqueued = false
    send(.continueCapture(nowMs: Self.nowMs()))
    guidance = GuidanceState(nowMs: Self.nowMs())
  }

  // MARK: the one live message

  var liveMessage: String {
    let current = view?.message ?? .camera_starting
    switch flow.phase {
    case .bursting(let accepted, let target, let top):
      if let top, top == "effects_active" || top == "internal",
        let key = Messages.rejectReasonKey(top, current: current)
      {
        return s(key)
      }
      if current != .hold_still { return s("guide.\(current.rawValue)") }
      return s("burst.progress", ["accepted": accepted, "target": target])
    default:
      return s("guide.\(current.rawValue)")
    }
  }

  var subMessage: String? {
    guard case .guiding(let reason, let retrying) = flow.phase, retrying else { return nil }
    if let reason, let key = Messages.rejectReasonKey(reason, current: view?.message ?? .camera_starting) {
      return s("burst.incomplete", ["reason": s(key)])
    }
    return s("burst.partial")
  }

  var progress: Double {
    if case .bursting(let accepted, let target, _) = flow.phase, target > 0 { return Double(accepted) / Double(target) }
    return view?.holdProgress ?? 0
  }
}

struct CaptureScreen: View {
  @EnvironmentObject private var app: AppModel

  var body: some View {
    CaptureContent(model: CaptureModel(app: app))
  }
}

private struct CaptureContent: View {
  @EnvironmentObject private var app: AppModel
  @Environment(\.scenePhase) private var scenePhase
  @StateObject var model: CaptureModel
  @State private var lastAnnounced = ""

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      if model.flow.phase.isCamera {
        camera
      } else {
        card
      }
    }
    .onChange(of: app.spool) { outcome in model.spoolChanged(outcome) }
    .onChange(of: model.liveMessage) { message in
      if model.flow.phase.isCamera, message != lastAnnounced {
        lastAnnounced = message
        UIAccessibility.post(notification: .announcement, argument: message)
      }
    }
    .onChange(of: scenePhase) { phase in
      if phase != .active, case .bursting = model.flow.phase { Task { await app.camera.cancelBurst() } }
    }
    .task { _ = await app.loadCapabilities() }
  }

  // MARK: camera

  private var camera: some View {
    GeometryReader { geo in
      ZStack(alignment: .top) {
        CameraPreview(
          active: model.flow.phase.isCamera && scenePhase == .active,
          gateJSON: app.camera.gateJSON,
          onMeasure: { model.onMeasure($0) },
          onProgress: { model.onProgress(accepted: $0, topRejectReason: $1) },
          onError: { model.onError($0) })
          .ignoresSafeArea()
        let width = geo.size.width * 0.72
        Ellipse()
          .stroke(model.view?.message == .hold_still ? Color.green : Color.white, lineWidth: 4)
          .frame(width: width, height: width / 0.75)
          .padding(.top, geo.size.height * 0.15)
          .accessibilityHidden(true)
        VStack(spacing: 12) {
          Spacer()
          VStack(spacing: 8) {
            Text(model.liveMessage)
              .font(.title2.bold())
              .foregroundStyle(.white)
              .multilineTextAlignment(.center)
            if let sub = model.subMessage {
              Text(sub).font(.subheadline).foregroundStyle(.white.opacity(0.85)).multilineTextAlignment(.center)
            }
            ProgressView(value: model.progress).tint(.green)
          }
          .padding(16)
          .frame(maxWidth: .infinity)
          .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
          Button(s("common.cancel")) { Task { await model.cancel() } }
            .buttonStyle(.bordered)
            .tint(.white)
            .controlSize(.large)
        }
        .padding(20)
      }
    }
  }

  // MARK: cards

  @ViewBuilder private var card: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        cardContent
      }
      .padding(24)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(Color(.systemBackground))
  }

  private func title(_ key: String) -> some View {
    Text(s(key)).font(.largeTitle.bold())
  }

  private func primary(_ key: String, _ action: @escaping () async -> Void) -> some View {
    Button { Task { await action() } } label: { Text(s(key)).frame(maxWidth: .infinity, minHeight: 44) }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
  }

  private func secondary(_ key: String, _ action: @escaping () async -> Void) -> some View {
    Button { Task { await action() } } label: { Text(s(key)).frame(maxWidth: .infinity, minHeight: 44) }
      .buttonStyle(.bordered)
      .controlSize(.large)
  }

  @ViewBuilder private var cardContent: some View {
    switch model.flow.phase {
    case .tips:
      title("tips.title")
      Label(s("tips.glasses"), systemImage: "eyeglasses")
      Label(s("tips.no_smile"), systemImage: "face.smiling")
      Label(s("tips.light"), systemImage: "sun.max")
      Text(s("tips.auto")).foregroundStyle(.secondary)
      primary("tips.start") { model.start() }
      secondary("common.cancel") { await model.cancel() }
    case .help:
      title("help.title")
      Label(s("help.eye_level"), systemImage: "iphone")
      Label(s("help.light"), systemImage: "sun.max")
      Label(s("help.alone"), systemImage: "person")
      Label(s("tips.glasses"), systemImage: "eyeglasses")
      Label(s("tips.no_smile"), systemImage: "face.smiling")
      primary("help.again") { model.resume() }
      secondary("common.cancel") { await model.cancel() }
    case .permissionDenied:
      Text(s("camera.permission_denied")).font(.title3)
      primary("camera.open_settings") {
        if let url = URL(string: UIApplication.openSettingsURLString) { await UIApplication.shared.open(url) }
      }
      secondary("common.retry") { model.resume() }
      secondary("common.cancel") { await model.cancel() }
    case .interrupted:
      Text(s("camera.interrupted")).font(.title3)
      primary("camera.resume") { model.resume() }
      secondary("common.cancel") { await model.cancel() }
    case .cameraError(let code):
      Text(s(cameraErrorKey(code))).font(.title3)
      primary("common.retry") { model.resume() }
      secondary("common.cancel") { await model.cancel() }
    case .uploading(let done, let total, let offline):
      title("upload.title")
      ProgressView(value: total > 0 ? Double(done) / Double(total) : 0)
      Text(s("upload.progress", ["done": done, "total": total])).foregroundStyle(.secondary)
      if offline { Text(s("upload.offline")) }
      secondary("capture.back_profile") { await model.cancel() }
    case .checking(let slow, let measuring):
      title("check.title")
      ProgressView()
      if measuring { Text(s("check.measuring")) }
      if slow { Text(s("check.slow")).foregroundStyle(.secondary) }
      secondary("capture.back_profile") { app.closeCapture() }
    case .received:
      Text(s("received.body")).font(.title3)
      primary("capture.back_profile") { await model.finish() }
    case .done:
      title("done.title")
      Text(s("done.body"))
      primary("capture.back_profile") { await model.finish() }
    case .complete:
      Image(systemName: "checkmark.seal.fill").font(.system(size: 56)).foregroundStyle(.green)
      title("complete.title")
      Text(s("complete.body"))
      primary("capture.back_profile") { await model.finish() }
    case .more(let reasons):
      title("more.title")
      Text(s(Messages.moreReasonKey(reasons.first)))
      primary("more.continue") { await model.continueCapture() }
      secondary("capture.back_profile") { await model.finish() }
    case .retake(let reasons):
      title("retake.title")
      ForEach(Array(Set(reasons.map(Messages.verdictReasonKey))).sorted(), id: \.self) { key in
        Label(s(key), systemImage: "exclamationmark.circle")
      }
      primary("retake.again") { await model.retake() }
      secondary("capture.back_profile") { await model.finish() }
    case .lost:
      Text(s("upload.lost")).font(.title3)
      primary("retake.again") { await model.retake() }
      secondary("capture.back_profile") { await model.finish() }
    case .failed(let code):
      Text(Messages.apiErrorKey(code: code, kind: nil).map { s($0) } ?? s("upload.rejected", ["code": code]))
        .font(.title3)
      primary("retake.again") { await model.retake() }
      secondary("capture.back_profile") { await model.finish() }
    case .guiding, .bursting:
      EmptyView()
    }
  }

  private func cameraErrorKey(_ code: CameraErrorCode) -> String {
    switch code {
    case .camera_unavailable: return "camera.unavailable"
    case .model_unavailable: return "camera.model_unavailable"
    case .effects_active: return "camera.effects_active"
    default: return "camera.internal"
    }
  }
}
