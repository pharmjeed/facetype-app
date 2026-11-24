//
//  FaceTypeClientBurst.swift
//  FaceType AI — native burst selection (docs/capture-spec-v2.md §4,
//  docs/client-native-interface.md §3 `startBurst`).
//
//  A frame becomes a *candidate* when every per-frame check passed and it is
//  far enough from the previous candidate; its JPEG is encoded from the very
//  buffer that was measured and goes straight into the encrypted spool.
//  Two rules can only be judged across the burst, so they are re-applied to
//  the whole candidate set every time it grows:
//
//   - sharpness < `sharpness.minRelativeToBurstMax` x the sharpest candidate
//     drops the frame (no absolute floor, A7.78-B);
//   - an eye opening < `eyes.minRelativeOpening` x the burst's valid median
//     (per eye) drops the frame.
//
//  The burst completes as soon as `targetFrames` accepted frames span at
//  least `minCoverageMs`; otherwise it ends at `maxDurationMs` as `partial`
//  with whatever was accepted. Candidates that are not returned are deleted
//  from the spool when the burst ends.
//

import Foundation
import React

struct FaceTypeClientBurstOptions {
  let targetFrames: Int
  let maxDurationMs: Double
  let minSpacingMs: Double
  let minCoverageMs: Double
}

enum FaceTypeClientBurstStatus: String {
  case complete
  case partial
  case cancelled
}

struct FaceTypeClientBurstCandidate {
  let id: String
  let ptsMs: Double
  let width: Int
  let height: Int
  let sha256: String
  let bytes: Int
  var meta: [String: Any]
  let sharpness: Double
  let openingL: Double
  let openingR: Double
}

enum FaceTypeClientBurstRules {
  /// Reject reasons in the order `topRejectReason` breaks ties.
  static let reasonPriority = ["effects_active"] + FaceTypeClientChecks.priority + ["internal"]

  /// Spacing between stored candidates. At least `minSpacingMs`, and wide
  /// enough that `targetFrames` consecutive candidates already span
  /// `minCoverageMs` -- so the burst never encodes more frames than it needs.
  static func candidateSpacingMs(_ options: FaceTypeClientBurstOptions) -> Double {
    guard options.targetFrames > 1 else { return options.minSpacingMs }
    return max(options.minSpacingMs, options.minCoverageMs / Double(options.targetFrames - 1))
  }

  static func median(_ values: [Double]) -> Double? {
    guard !values.isEmpty else { return nil }
    let sorted = values.sorted()
    let middle = sorted.count / 2
    return sorted.count % 2 == 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  }

  struct Verdict {
    var accepted: [FaceTypeClientBurstCandidate] = []
    var dropped: [(candidate: FaceTypeClientBurstCandidate, reason: String)] = []
  }

  static func apply(
    _ candidates: [FaceTypeClientBurstCandidate],
    minRelativeToBurstMax: Double,
    minRelativeOpening: Double
  ) -> Verdict {
    var verdict = Verdict()
    guard
      let sharpest = candidates.map(\.sharpness).max(),
      let medianL = median(candidates.map(\.openingL)),
      let medianR = median(candidates.map(\.openingR))
    else { return verdict }
    for candidate in candidates {
      if candidate.sharpness < minRelativeToBurstMax * sharpest {
        verdict.dropped.append((candidate, "sharp"))
      } else if candidate.openingL < minRelativeOpening * medianL
        || candidate.openingR < minRelativeOpening * medianR
      {
        verdict.dropped.append((candidate, "eyes"))
      } else {
        verdict.accepted.append(candidate)
      }
    }
    return verdict
  }

  /// Exactly `target` frames spread evenly across the accepted ones, first
  /// and last included, so coverage is kept and spacing only grows.
  static func select(_ accepted: [FaceTypeClientBurstCandidate], target: Int) -> [FaceTypeClientBurstCandidate] {
    guard target >= 1, accepted.count > target else { return accepted }
    guard target > 1 else { return [accepted[0]] }
    var picked: [FaceTypeClientBurstCandidate] = []
    var previous = -1
    for i in 0..<target {
      let index = Int((Double(i) * Double(accepted.count - 1) / Double(target - 1)).rounded())
      if index != previous {
        picked.append(accepted[index])
        previous = index
      }
    }
    return picked
  }

  static func coverageMs(_ frames: [FaceTypeClientBurstCandidate]) -> Double {
    guard let first = frames.first, let last = frames.last else { return 0 }
    return last.ptsMs - first.ptsMs
  }

  static func topReason(_ counts: [String: Int]) -> String? {
    var best: (reason: String, count: Int)?
    let known = reasonPriority.filter { counts[$0] != nil }
    let others = counts.keys.filter { !reasonPriority.contains($0) }.sorted()
    for reason in known + others {
      guard let count = counts[reason], count > 0 else { continue }
      if count > (best?.count ?? 0) { best = (reason, count) }
    }
    return best?.reason
  }
}

/// One `startBurst` call. Confined to the controller's video queue.
final class FaceTypeClientBurst {
  let token = UUID()
  let options: FaceTypeClientBurstOptions
  let minRelativeToBurstMax: Double
  let minRelativeOpening: Double
  let startedNs: UInt64
  let resolve: RCTPromiseResolveBlock
  private(set) var candidates: [FaceTypeClientBurstCandidate] = []
  private(set) var rejectCounts: [String: Int] = [:]
  var lastProgressNs: UInt64 = 0

  init(
    options: FaceTypeClientBurstOptions,
    gate: FaceTypeClientGateConfig,
    startedNs: UInt64,
    resolve: @escaping RCTPromiseResolveBlock
  ) {
    self.options = options
    self.minRelativeToBurstMax = gate.sharpness.minRelativeToBurstMax
    self.minRelativeOpening = gate.eyes.minRelativeOpening
    self.startedNs = startedNs
    self.resolve = resolve
  }

  func elapsedMs(now: UInt64) -> Double {
    now >= startedNs ? Double(now - startedNs) / 1_000_000 : 0
  }

  func countReject(_ reason: String) {
    rejectCounts[reason, default: 0] += 1
  }

  func isSpaced(_ ptsMs: Double) -> Bool {
    guard let last = candidates.last?.ptsMs else { return true }
    return ptsMs - last >= FaceTypeClientBurstRules.candidateSpacingMs(options)
  }

  func add(_ candidate: FaceTypeClientBurstCandidate) {
    candidates.append(candidate)
  }

  var verdict: FaceTypeClientBurstRules.Verdict {
    FaceTypeClientBurstRules.apply(
      candidates,
      minRelativeToBurstMax: minRelativeToBurstMax,
      minRelativeOpening: minRelativeOpening
    )
  }

  var acceptedCount: Int { min(verdict.accepted.count, options.targetFrames) }

  var isComplete: Bool {
    let selected = FaceTypeClientBurstRules.select(verdict.accepted, target: options.targetFrames)
    return selected.count >= options.targetFrames
      && FaceTypeClientBurstRules.coverageMs(selected) >= options.minCoverageMs
  }

  var topRejectReason: String? { FaceTypeClientBurstRules.topReason(rejectCounts) }

  struct Outcome {
    let status: FaceTypeClientBurstStatus
    let selected: [FaceTypeClientBurstCandidate]
    let discarded: [FaceTypeClientBurstCandidate]
    let topRejectReason: String?
  }

  func outcome(_ requested: FaceTypeClientBurstStatus) -> Outcome {
    guard requested != .cancelled else {
      return Outcome(status: .cancelled, selected: [], discarded: candidates, topRejectReason: topRejectReason)
    }
    let verdict = self.verdict
    var counts = rejectCounts
    for dropped in verdict.dropped { counts[dropped.reason, default: 0] += 1 }
    let selected = FaceTypeClientBurstRules.select(verdict.accepted, target: options.targetFrames)
    let kept = Set(selected.map(\.id))
    let complete = selected.count >= options.targetFrames
      && FaceTypeClientBurstRules.coverageMs(selected) >= options.minCoverageMs
    return Outcome(
      status: complete ? .complete : .partial,
      selected: selected,
      discarded: candidates.filter { !kept.contains($0.id) },
      topRejectReason: FaceTypeClientBurstRules.topReason(counts)
    )
  }
}
