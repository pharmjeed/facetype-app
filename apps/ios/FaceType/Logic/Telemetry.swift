//
//  Telemetry.swift
//  Capture attempt telemetry (port of apps/mobile/src/client/telemetry.ts and spool/telemetryQueue.ts).
//  The queue keeps what POST /attempts still owes; past 200 entries the oldest records fold into aggregates
//  (never dropped). Fixed while porting: the queue now accepts the `needs_more` and `complete` outcomes — the
//  TypeScript list missed them, so loading such an entry wiped the whole queue.
//

import Foundation

enum Telemetry {
  static let wireReasons: [String: String] = [
    "oneFace": "one_face", "distanceOrSize": "distance_or_size", "centred": "centred", "facing": "facing",
    "light": "light", "expression": "expression", "eyes": "eyes", "sharp": "sharp",
    "effects_active": "effects_active", "internal": "internal",
  ]
  static let maxReasonKeys = 64
  private static let wireKey = try! NSRegularExpression(pattern: "^[a-z0-9_]{1,40}$")
  private static let camelHump = try! NSRegularExpression(pattern: "([a-z0-9])([A-Z])")

  private static func isWireKey(_ key: String) -> Bool {
    wireKey.firstMatch(in: key, range: NSRange(key.startIndex..., in: key)) != nil
  }

  /// snake_case wire key for a native reason; nil when it cannot be one.
  static func wireReason(_ reason: String) -> String? {
    if let known = wireReasons[reason] { return known }
    let snake = camelHump.stringByReplacingMatches(
      in: reason, range: NSRange(reason.startIndex..., in: reason), withTemplate: "$1_$2"
    ).lowercased()
    return isWireKey(snake) ? snake : nil
  }

  /// Native-keyed counts → wire-keyed counts (merged, invalid keys dropped, capped), in input order.
  static func wireReasonCounts(_ counts: [(String, Int)]) -> [String: Int] {
    var out: [String: Int] = [:]
    for (reason, count) in counts {
      guard let key = wireReason(reason), count >= 0 else { continue }
      if out[key] == nil && out.count >= maxReasonKeys { continue }
      out[key, default: 0] += count
    }
    return out
  }

  static func outcome(for stage: SpoolStage) -> AttemptOutcome? {
    switch stage {
    case .stored: return .stored
    case .received: return .received
    case .needs_retake: return .needs_retake
    case .needs_more: return .needs_more
    case .complete: return .complete
    case .failed, .abandoned: return .abandoned
    default: return nil
    }
  }
}

/// Everything about an attempt except its outcome, kept with the manifest until the verdict.
struct PendingAttempt: Codable, Equatable {
  var duration_ms: Int
  var attempts: Int
  var reason_counts: [String: Int]
  var device: [String: JSONValue]

  static func make(startedAtMs: Double, nowMs: Double, attempts: Int, reasonCounts: [String: Int],
                   device: [String: JSONValue]) -> PendingAttempt {
    PendingAttempt(
      duration_ms: Int(max(0, min(3_600_000, (nowMs - startedAtMs).rounded()))),
      attempts: max(0, attempts),
      reason_counts: Telemetry.wireReasonCounts(reasonCounts.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }),
      device: device)
  }
}

struct AttemptTelemetry: Codable, Equatable {
  var outcome: AttemptOutcome
  var duration_ms: Int
  var attempts: Int
  var reason_counts: [String: Int]
  var device: [String: JSONValue]

  init(outcome: AttemptOutcome, pending: PendingAttempt) {
    self.outcome = outcome
    duration_ms = pending.duration_ms
    attempts = pending.attempts
    reason_counts = pending.reason_counts
    device = pending.device
  }

  var body: [String: Any] {
    ["outcome": outcome.rawValue, "duration_ms": duration_ms, "attempts": attempts, "reason_counts": reason_counts,
     "device": device.mapValues(\.any)]
  }
}

struct AttemptAggregate: Codable, Equatable {
  var records: Int
  var lastQueuedAtMs: Double
}

struct QueuedAttempt: Codable, Equatable {
  var key: String
  var telemetry: AttemptTelemetry
  var queuedAtMs: Double
  var aggregate: AttemptAggregate?
}

/// The owed attempts of one account, in a protected file. Another account's queue, or a corrupt one, is removed.
final class AttemptQueue {
  static let max = 200
  static let limits = (durationMs: 3_600_000, attempts: 10_000, reasonCount: 1_000_000)

  private struct Stored: Codable {
    var version = 1
    var accountId: String
    var entries: [QueuedAttempt]
  }

  private let file: ProtectedFile

  init(file: ProtectedFile) { self.file = file }

  func load(accountId: String) -> [QueuedAttempt] {
    guard let data = file.read() else { return [] }
    if let stored = try? JSONDecoder().decode(Stored.self, from: data), stored.version == 1,
      stored.accountId == accountId, stored.entries.allSatisfy(Self.isValid)
    {
      return stored.entries
    }
    file.remove()
    return []
  }

  private static func isValid(_ e: QueuedAttempt) -> Bool {
    !e.key.isEmpty && e.key.count <= 100 && e.telemetry.duration_ms >= 0 && e.telemetry.attempts >= 0
      && (e.aggregate.map { $0.records >= 2 && $0.lastQueuedAtMs >= e.queuedAtMs } ?? true)
  }

  private func store(accountId: String, _ entries: [QueuedAttempt]) throws {
    if entries.isEmpty {
      file.remove()
      return
    }
    try file.write(JSONEncoder().encode(Stored(accountId: accountId, entries: entries)))
  }

  func queue(accountId: String, _ entry: QueuedAttempt) throws {
    let entries = load(accountId: accountId)
    if entries.contains(where: { $0.key == entry.key }) { return }
    try store(accountId: accountId, Self.compact(entries + [entry]))
  }

  func remove(accountId: String, key: String) throws {
    let entries = load(accountId: accountId)
    let left = entries.filter { $0.key != key }
    if left.count != entries.count { try store(accountId: accountId, left) }
  }

  func clear() { file.remove() }

  // MARK: folding (identical to telemetryQueue.ts)

  private static func serverAccepts(_ t: AttemptTelemetry) -> Bool {
    let keys = Set(Telemetry.wireReasons.values)
    return (0...limits.durationMs).contains(t.duration_ms) && (0...limits.attempts).contains(t.attempts)
      && t.reason_counts.count <= keys.count
      && t.reason_counts.allSatisfy { keys.contains($0.key) && (0...limits.reasonCount).contains($0.value) }
  }

  private static func summed(_ a: AttemptTelemetry, _ b: AttemptTelemetry) -> AttemptTelemetry? {
    guard a.outcome == b.outcome, a.device == b.device, serverAccepts(a), serverAccepts(b) else { return nil }
    var sum = a
    sum.duration_ms = a.duration_ms + b.duration_ms
    sum.attempts = a.attempts + b.attempts
    for (key, count) in b.reason_counts { sum.reason_counts[key, default: 0] += count }
    return serverAccepts(sum) ? sum : nil
  }

  private static func fold(_ earlier: QueuedAttempt, _ later: QueuedAttempt) -> QueuedAttempt? {
    guard let telemetry = summed(earlier.telemetry, later.telemetry) else { return nil }
    func last(_ e: QueuedAttempt) -> Double { e.aggregate?.lastQueuedAtMs ?? e.queuedAtMs }
    return QueuedAttempt(
      key: earlier.aggregate != nil ? earlier.key : String("aggregate:\(earlier.key)".prefix(100)),
      telemetry: telemetry,
      queuedAtMs: min(earlier.queuedAtMs, later.queuedAtMs),
      aggregate: AttemptAggregate(
        records: (earlier.aggregate?.records ?? 1) + (later.aggregate?.records ?? 1),
        lastQueuedAtMs: Swift.max(last(earlier), last(later))))
  }

  /// Back to `max` entries without losing a count; the head and the newest entry are never folded.
  static func compact(_ entries: [QueuedAttempt]) -> [QueuedAttempt] {
    guard entries.count > max else { return entries }
    var out = entries
    var i = 2
    while i < out.count - 1 && out.count > max {
      var folded = false
      for j in 1..<i {
        if let merged = fold(out[j], out[i]) {
          out[j] = merged
          out.remove(at: i)
          folded = true
          break
        }
      }
      if !folded { i += 1 }
    }
    return out
  }
}
