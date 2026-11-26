//
//  LockedSpoolTests.swift
//  Build 13: while the phone is locked the spooled frames and their metadata cannot be read (complete data
//  protection). The run must wait, not take them for lost and delete the burst; once unlocked, a frame that is
//  really missing still ends the capture as before.
//

import XCTest

@testable import FaceType_AI

private struct Unused: Error {}

private final class FakeAPI: SpoolAPI, @unchecked Sendable {
  func createCapture(_ body: [String: Any], idempotencyKey: String) async throws -> CaptureCreated { throw Unused() }
  func renewFrameUpload(captureId: String, index: Int) async throws -> FrameUploadTarget { throw Unused() }
  func completeFrame(captureId: String, index: Int, meta: [String: Any]) async throws { throw Unused() }
  func finalizeCapture(captureId: String) async throws -> CaptureView { throw Unused() }
  func getCapture(captureId: String) async throws -> CaptureView { throw Unused() }
  func postAttempt(_ telemetry: [String: Any]) async throws {}
}

/// Every file is unreadable: nothing listed, no metadata, uploads find nothing.
private final class LockedCamera: SpoolCamera, @unchecked Sendable {
  private let lock = NSLock()
  private var deletedIds: [String] = []
  var deleted: [String] {
    lock.lock()
    defer { lock.unlock() }
    return deletedIds
  }

  func uploadFrame(id: String, url: String, headers: [String: String]) async throws -> Int {
    throw SpoolNativeError(code: "not_found")
  }
  func deleteFrames(_ ids: [String]) {
    lock.lock()
    deletedIds += ids
    lock.unlock()
  }
  func listSpool() throws -> [(id: String, createdAtMs: Double)] { [] }
  func frameMeta(id: String) -> [String: Any]? { nil }
}

final class LockedSpoolTests: XCTestCase {
  private func runner(protected available: Bool, camera: LockedCamera) async throws -> SpoolRunner {
    let name = "locked-test-\(UUID().uuidString).json"
    let manifestFile = ProtectedFile(name: name)
    addTeardownBlock { manifestFile.remove() }
    let queueFile = ProtectedFile(name: "q-" + name)
    addTeardownBlock { queueFile.remove() }
    let now = Date().timeIntervalSince1970 * 1000
    let manifest = SpoolManifest(
      accountId: "a", clientCaptureId: "c", createdAtMs: now, updatedAtMs: now, stage: .uploading, captureId: "cap",
      attempt: 1, protocolVersion: "capture-spec-v2", gateConfigHash: "h", device: [:], camera: [:],
      frames: [ManifestFrame(index: 0, nativeId: "frame-0", sha256: String(repeating: "a", count: 64), bytes: 1, width: 1, height: 1,
                             uploaded: false, completed: false)],
      verdict: nil, checkingSinceMs: nil, error: nil, attemptTelemetry: nil)
    try manifestFile.write(JSONEncoder().encode(manifest))
    let r = SpoolRunner(
      api: FakeAPI(), camera: camera, manifestFile: manifestFile, queue: AttemptQueue(file: queueFile),
      gateHash: "h", protocolVersion: "capture-spec-v2", protectedData: { available })
    await r.bindAccount("a")
    return r
  }

  func testLockedPhoneWaitsAndKeepsTheFrames() async throws {
    let camera = LockedCamera()
    let r = try await runner(protected: false, camera: camera)
    let outcome = await r.runOnce()
    XCTAssertEqual(outcome.kind, .waiting)
    XCTAssertEqual(outcome.reason, .offline)
    XCTAssertEqual(outcome.manifest?.stage, .uploading)
    XCTAssertTrue(camera.deleted.isEmpty, "frames deleted while the phone was locked")
  }

  func testUnlockedPhoneStillEndsALostBurst() async throws {
    let camera = LockedCamera()
    let r = try await runner(protected: true, camera: camera)
    let outcome = await r.runOnce()
    XCTAssertEqual(outcome.kind, .terminal)
    XCTAssertEqual(outcome.manifest?.stage, .abandoned)
    XCTAssertEqual(camera.deleted, ["frame-0"])
  }
}
