//
//  Guidance.swift
//  Live guidance while the camera runs (capture spec v2 §3): priority, hysteresis, rolling median of 5,
//  ≥ 1.2 s message hold, and a 0.5 s hold that survives 1–2 bad frames. Port of
//  apps/mobile/src/client/guidance/guidance.ts, checked step by step against docs/fixtures/client/guidance.json.
//

import Foundation

/// One `onFrameMeasure` payload (docs/client-native-interface.md). Every value may be missing.
struct FrameMeasure: Decodable, Equatable {
  var tsMs: Double?
  var faces: Double?
  var yaw: Double?
  var pitch: Double?
  var roll: Double?
  var faceBox: [Double?]?
  var eyeMidX: Double?
  var faceCentreY: Double?
  var faceWidthPx: Double?
  var distanceCm: Double?
  var clipFrac: Double?
  var crushFrac: Double?
  var cheekRatio: Double?
  var exposureTimeNs: Double?

  init(
    tsMs: Double? = nil, faces: Double? = nil, yaw: Double? = nil, pitch: Double? = nil, roll: Double? = nil,
    faceBox: [Double?]? = nil, eyeMidX: Double? = nil, faceCentreY: Double? = nil, faceWidthPx: Double? = nil,
    distanceCm: Double? = nil, clipFrac: Double? = nil, crushFrac: Double? = nil, cheekRatio: Double? = nil,
    exposureTimeNs: Double? = nil
  ) {
    self.tsMs = tsMs
    self.faces = faces
    self.yaw = yaw
    self.pitch = pitch
    self.roll = roll
    self.faceBox = faceBox
    self.eyeMidX = eyeMidX
    self.faceCentreY = faceCentreY
    self.faceWidthPx = faceWidthPx
    self.distanceCm = distanceCm
    self.clipFrac = clipFrac
    self.crushFrac = crushFrac
    self.cheekRatio = cheekRatio
    self.exposureTimeNs = exposureTimeNs
  }

  /// From the camera controller's event dictionary.
  init(payload: [AnyHashable: Any]) {
    func number(_ key: String) -> Double? { (payload[key] as? NSNumber)?.doubleValue }
    tsMs = number("tsMs")
    faces = number("faces")
    yaw = number("yaw")
    pitch = number("pitch")
    roll = number("roll")
    faceBox = (payload["faceBox"] as? [Any])?.map { ($0 as? NSNumber)?.doubleValue }
    eyeMidX = number("eyeMidX")
    faceCentreY = number("faceCentreY")
    faceWidthPx = number("faceWidthPx")
    distanceCm = number("distanceCm")
    clipFrac = number("clipFrac")
    crushFrac = number("crushFrac")
    cheekRatio = number("cheekRatio")
    exposureTimeNs = number("exposureTimeNs")
  }
}

enum GuidanceMessage: String, Codable {
  case camera_starting, no_face, multiple_faces, move_closer, move_back, centre, look_straight, light, hold_still
}

enum GuidanceCheck: String, CaseIterable, Codable {
  case oneFace, distance, size, centred, facing, light
}

enum GuidanceTiming {
  static let medianWindow = 5
  static let messageHoldMs: Double = 1200
  static let holdTolerance = 2
  static let sizeExitFrac = 0.1
  static let centreExitWiden = 0.05
  static let lightExitFactor = 1.5
  static let maxExposureNs: Double = 33_333_333
}

struct CheckState: Equatable {
  var pass: Bool
  var message: GuidanceMessage?
  static func failing(_ message: GuidanceMessage?) -> CheckState { CheckState(pass: false, message: message) }
  static let passing = CheckState(pass: true, message: nil)
}

struct GuidanceState: Equatable {
  var window: [FrameMeasure] = []
  var checks: [GuidanceCheck: CheckState] = [
    .oneFace: .failing(.no_face),
    .distance: .failing(nil),
    .size: .failing(.move_closer),
    .centred: .failing(.centre),
    .facing: .failing(.look_straight),
    .light: .failing(.light),
  ]
  var shown: GuidanceMessage = .camera_starting
  var shownSinceMs: Double
  var holdStartMs: Double?
  var badInHold = 0
  var ready = false
  var lastTsMs: Double?

  init(nowMs: Double = 0) { shownSinceMs = nowMs }
}

struct GuidanceView: Equatable {
  let message: GuidanceMessage
  let holdProgress: Double
  let ready: Bool
  let failing: GuidanceCheck?
}

enum Guidance {
  static let priority: [GuidanceCheck] = [.oneFace, .distance, .size, .centred, .facing, .light]

  struct Smoothed {
    var faces, yaw, pitch, roll: Double?
    var faceBox: [Double]?
    var eyeMidX, faceCentreY, faceWidthPx, distanceCm, clipFrac, crushFrac, cheekRatio, exposureTimeNs: Double?
  }

  /// Median of the finite values, or nil when there are none.
  static func median(_ values: [Double?]) -> Double? {
    let sorted = values.compactMap { $0 }.filter { $0.isFinite }.sorted()
    guard !sorted.isEmpty else { return nil }
    let mid = sorted.count / 2
    return sorted.count % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  }

  static func smooth(_ window: [FrameMeasure]) -> Smoothed {
    func pick(_ read: (FrameMeasure) -> Double?) -> Double? { median(window.map(read)) }
    let box = (0..<4).map { i in pick { m in (m.faceBox.flatMap { $0.count > i ? $0[i] : nil }) } }
    return Smoothed(
      faces: pick(\.faces), yaw: pick(\.yaw), pitch: pick(\.pitch), roll: pick(\.roll),
      faceBox: box.allSatisfy({ $0 != nil }) ? box.map { $0! } : nil,
      eyeMidX: pick(\.eyeMidX), faceCentreY: pick(\.faceCentreY), faceWidthPx: pick(\.faceWidthPx),
      distanceCm: pick(\.distanceCm), clipFrac: pick(\.clipFrac), crushFrac: pick(\.crushFrac),
      cheekRatio: pick(\.cheekRatio), exposureTimeNs: pick(\.exposureTimeNs))
  }

  private static func within(_ value: Double, _ lo: Double, _ hi: Double) -> Bool { value >= lo && value <= hi }

  /// JavaScript `Math.round` (halves round up).
  private static func jsRound(_ value: Double) -> Double { (value + 0.5).rounded(.down) }

  /// A failing check passes only inside the ENTER limits; a passing check fails only outside the EXIT limits.
  static func evaluate(_ check: GuidanceCheck, previous: CheckState, _ v: Smoothed, _ c: FaceTypeClientGateConfig)
    -> CheckState
  {
    let was = previous.pass
    switch check {
    case .oneFace:
      guard let faces = v.faces, jsRound(faces) != 0 else { return .failing(.no_face) }
      if jsRound(faces) > 1 { return .failing(.multiple_faces) }
      return .passing
    case .distance:
      guard let d = v.distanceCm else { return .passing }
      let enter = c.distance.enterCm
      let exit = c.distance.exitCm
      if was ? (d >= exit[0] && d <= exit[1]) : (d >= enter[0] && d <= enter[1]) { return .passing }
      return .failing(d > (was ? exit[1] : enter[1]) ? .move_closer : .move_back)
    case .size:
      guard let width = v.faceWidthPx, let frac = v.faceBox?[2] else { return .failing(.move_closer) }
      let band = GuidanceTiming.sizeExitFrac
      let minPx = was ? c.size.minFaceWidthPx * (1 - band) : c.size.minFaceWidthPx
      let maxFrac = was ? c.size.maxFaceWidthFrac * (1 + band) : c.size.maxFaceWidthFrac
      if frac > maxFrac { return .failing(.move_back) }
      if width < minPx { return .failing(.move_closer) }
      return .passing
    case .centred:
      guard let eyeMidX = v.eyeMidX, let cy = v.faceCentreY, let box = v.faceBox else { return .failing(.centre) }
      let widen = was ? GuidanceTiming.centreExitWiden : 0
      let ex = c.centre.eyeMidX
      let cyr = c.centre.faceCentreY
      let margin = c.centre.edgeMarginFrac - widen
      let (x, y, w, h) = (box[0], box[1], box[2], box[3])
      let ok =
        within(eyeMidX, ex[0] - widen, ex[1] + widen) && within(cy, cyr[0] - widen, cyr[1] + widen)
        && x >= margin && y >= margin && x + w <= 1 - margin && y + h <= 1 - margin
      return ok ? .passing : .failing(.centre)
    case .facing:
      guard let yaw = v.yaw, let pitch = v.pitch else { return .failing(.look_straight) }
      let limit = was ? c.pose.exitDeg : c.pose.enterDeg
      let rollOk = v.roll.map { abs($0) <= c.pose.rollMessageDeg } ?? true
      return abs(yaw) <= limit && abs(pitch) <= limit && rollOk ? .passing : .failing(.look_straight)
    case .light:
      guard let clip = v.clipFrac, let crush = v.crushFrac, let ratio = v.cheekRatio else { return .failing(.light) }
      let k = was ? GuidanceTiming.lightExitFactor : 1
      let r = c.light.cheekRatio
      let exposureOk = v.exposureTimeNs.map { $0 <= GuidanceTiming.maxExposureNs } ?? true
      let ok =
        clip <= c.light.maxClipFrac * k && crush <= c.light.maxCrushFrac * k && within(ratio, r[0] / k, r[1] * k)
        && exposureOk
      return ok ? .passing : .failing(.light)
    }
  }

  /// Advance guidance by one measure. Pure: same inputs, same state.
  static func step(_ state: GuidanceState, _ measure: FrameMeasure, _ config: FaceTypeClientGateConfig)
    -> GuidanceState
  {
    var next = state
    let now = (measure.tsMs?.isFinite == true ? measure.tsMs : nil) ?? state.lastTsMs ?? 0
    next.window = Array((state.window + [measure]).suffix(GuidanceTiming.medianWindow))
    let values = smooth(next.window)
    for check in priority {
      next.checks[check] = evaluate(check, previous: state.checks[check]!, values, config)
    }
    let firstFailing = priority.first { !(next.checks[$0]!.pass) }
    let allPass = firstFailing == nil

    if allPass {
      if next.holdStartMs == nil { next.holdStartMs = now }
      next.badInHold = 0
    } else if next.holdStartMs != nil {
      next.badInHold += 1
      if next.badInHold > GuidanceTiming.holdTolerance {
        next.holdStartMs = nil
        next.badInHold = 0
      }
    }
    next.ready =
      state.ready || (allPass && next.holdStartMs != nil && now - next.holdStartMs! >= config.burst.holdMs)

    let desired: GuidanceMessage =
      next.holdStartMs != nil || firstFailing == nil
      ? .hold_still : (next.checks[firstFailing!]!.message ?? .centre)
    if desired != next.shown {
      let mayChange = next.shown == .camera_starting || now - next.shownSinceMs >= GuidanceTiming.messageHoldMs
      if mayChange {
        next.shown = desired
        next.shownSinceMs = now
      }
    }
    next.lastTsMs = now
    return next
  }

  static func view(_ state: GuidanceState, _ config: FaceTypeClientGateConfig) -> GuidanceView {
    let now = state.lastTsMs ?? 0
    let progress: Double =
      state.ready ? 1 : state.holdStartMs.map { min(1, (now - $0) / config.burst.holdMs) } ?? 0
    return GuidanceView(
      message: state.shown, holdProgress: progress, ready: state.ready,
      failing: priority.first { !(state.checks[$0]!.pass) })
  }

  /// Restart the hold (after a partial burst) while keeping the smoothing window.
  static func rearm(_ state: GuidanceState) -> GuidanceState {
    var next = state
    next.ready = false
    next.holdStartMs = nil
    next.badInHold = 0
    return next
  }
}
