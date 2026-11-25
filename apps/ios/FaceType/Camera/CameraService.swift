//
//  CameraService.swift
//  Async Swift over the moved camera module (FaceTypeClientCamera + controller + native spool), and the
//  SwiftUI view around FaceTypeClientCameraView. Nothing here measures or decides: the controller does,
//  exactly as it did under React Native.
//

import AVFoundation
import SwiftUI
import UIKit

struct BurstOutcome {
  let status: BurstResult.Status
  let frames: [BurstFrameRecord]
  let topRejectReason: String?
}

final class CameraService: SpoolCamera, @unchecked Sendable {
  static let shared = CameraService()

  private let module = FaceTypeClientCamera()
  private var controller: FaceTypeClientCameraController { .shared }

  /// The gate config every stored frame is measured against (canonical JSON from docs/fixtures/client/gate.json,
  /// bundled as gate-config.json) and its hash.
  let gateJSON: String
  let gate: FaceTypeClientGate?

  private init() {
    let url = Bundle.main.url(forResource: "gate-config", withExtension: "json")
    gateJSON = url.flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    if case .success(let parsed) = FaceTypeClientGate.parse(gateJSON) { gate = parsed } else { gate = nil }
  }

  var gateHash: String { gate?.hash ?? "" }

  func capabilities() async -> [String: Any]? {
    await withCheckedContinuation { continuation in
      module.getCapabilities({ value in continuation.resume(returning: value as? [String: Any]) },
                             rejecter: { _, _, _ in continuation.resume(returning: nil) })
    }
  }

  func startBurst() async throws -> BurstOutcome {
    guard let burst = gate?.config.burst else { throw SpoolNativeError(code: "internal") }
    let options: NSDictionary = [
      "targetFrames": burst.targetFrames, "maxDurationMs": burst.maxDurationMs, "minSpacingMs": burst.minSpacingMs,
      "minCoverageMs": burst.minCoverageMs,
    ]
    let payload: [String: Any] = try await withCheckedThrowingContinuation { continuation in
      module.startBurst(
        options,
        resolver: { value in continuation.resume(returning: value as? [String: Any] ?? [:]) },
        rejecter: { code, _, _ in continuation.resume(throwing: SpoolNativeError(code: code ?? "internal")) })
    }
    let frames = (payload["frames"] as? [[String: Any]] ?? []).compactMap { f -> BurstFrameRecord? in
      guard let id = f["id"] as? String, let sha = f["sha256"] as? String else { return nil }
      return BurstFrameRecord(
        id: id, width: (f["width"] as? NSNumber)?.intValue ?? 0, height: (f["height"] as? NSNumber)?.intValue ?? 0,
        sha256: sha, bytes: (f["bytes"] as? NSNumber)?.intValue ?? 0)
    }
    let status = BurstResult.Status(rawValue: payload["status"] as? String ?? "") ?? .partial
    return BurstOutcome(status: status, frames: frames, topRejectReason: payload["topRejectReason"] as? String)
  }

  func cancelBurst() async {
    await withCheckedContinuation { continuation in
      module.cancelBurst({ _ in continuation.resume() }, rejecter: { _, _, _ in continuation.resume() })
    }
  }

  // MARK: SpoolCamera

  func uploadFrame(id: String, url: String, headers: [String: String]) async throws -> Int {
    let target: NSDictionary = ["url": url, "method": "PUT", "headers": headers]
    return try await withCheckedThrowingContinuation { continuation in
      module.uploadFrame(
        id, target: target,
        resolver: { value in
          continuation.resume(returning: ((value as? [String: Any])?["status"] as? NSNumber)?.intValue ?? 0)
        },
        rejecter: { code, _, _ in continuation.resume(throwing: SpoolNativeError(code: code ?? "upload_failed")) })
    }
  }

  func deleteFrames(_ ids: [String]) {
    guard !ids.isEmpty else { return }
    controller.spool.delete(ids: ids)
  }

  func listSpool() throws -> [(id: String, createdAtMs: Double)] {
    do {
      return try controller.spool.list().compactMap { entry in
        guard let id = entry["id"] as? String else { return nil }
        return (id, (entry["createdAtMs"] as? NSNumber)?.doubleValue ?? 0)
      }
    } catch let error as FaceTypeClientSpoolError {
      throw SpoolNativeError(code: error.code)
    }
  }

  func frameMeta(id: String) -> [String: Any]? {
    try? controller.spool.openMeta(id: id)
  }
}

/// The live camera preview with its measure/progress/error events.
struct CameraPreview: UIViewRepresentable {
  let active: Bool
  let gateJSON: String
  let onMeasure: (FrameMeasure) -> Void
  let onProgress: (_ accepted: Int, _ topRejectReason: String?) -> Void
  let onError: (String) -> Void

  func makeUIView(context: Context) -> FaceTypeClientCameraView {
    let view = FaceTypeClientCameraView(frame: .zero)
    view.gateConfig = gateJSON
    return view
  }

  func updateUIView(_ view: FaceTypeClientCameraView, context: Context) {
    view.onFrameMeasure = { payload in onMeasure(FrameMeasure(payload: payload ?? [:])) }
    view.onBurstProgress = { payload in
      onProgress((payload?["accepted"] as? NSNumber)?.intValue ?? 0, payload?["topRejectReason"] as? String)
    }
    view.onError = { payload in onError(payload?["code"] as? String ?? "internal") }
    if view.gateConfig != gateJSON { view.gateConfig = gateJSON }
    if view.active != active { view.active = active }
  }

  static func dismantleUIView(_ view: FaceTypeClientCameraView, coordinator: ()) {
    view.active = false
  }
}
