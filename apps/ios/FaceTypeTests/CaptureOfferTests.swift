//
//  CaptureOfferTests.swift
//  When «التصوير» offers the camera (build 12, owner 2026-11-26 «ارجع الكاميرا لي لنجرب عليها»), and when the
//  app keeps a burst going after the person leaves it.
//

import XCTest

@testable import FaceType_AI

final class CaptureOfferTests: XCTestCase {
  func testCameraIsOfferedUnlessABurstIsOnItsWay() {
    for key in ["status.none", "status.needs_more", "status.needs_retake", "status.unknown", "status.complete",
                "status.stored"] {
      XCTAssertTrue(ProfileStatus.offersCamera(key), key)
    }
    for key in ["status.received", "status.uploading", "status.checking", "status.measuring",
                "status.queued_offline"] {
      XCTAssertFalse(ProfileStatus.offersCamera(key), key)
    }
  }

  func testOnlyCompleteOrStoredPhotosAreDone() {
    XCTAssertTrue(ProfileStatus.isDone("status.complete"))
    XCTAssertTrue(ProfileStatus.isDone("status.stored"))
    for key in ["status.none", "status.needs_more", "status.checking", "status.measuring", "status.received"] {
      XCTAssertFalse(ProfileStatus.isDone(key), key)
    }
  }

  /// Every status the server can send maps to a key the rule knows, and the build-12 strings exist in both
  /// languages.
  func testEveryServerStatusHasAKnownKey() {
    let all: [CaptureStatus] = [.uploading, .checking, .received, .stored, .needs_retake, .measuring, .needs_more,
                                .complete]
    for status in all {
      let key = "status.\(status.rawValue)"
      XCTAssertNotEqual(s(key), key, "missing string for \(key)")
    }
    for key in ["capture.again", "account.title", "account.sign_out", "account.delete", "account.delete_title",
                "account.delete_body", "account.delete_confirm", "account.delete_failed", "account.deleted"] {
      for lang in [Lang.ar, .en] {
        XCTAssertNotEqual(L10n.s(key, language: lang), key, "missing \(lang) string for \(key)")
      }
    }
  }

  private func manifest(_ stage: SpoolStage) -> SpoolManifest {
    SpoolManifest(
      accountId: "a", clientCaptureId: "c", createdAtMs: 0, updatedAtMs: 0, stage: stage, captureId: nil, attempt: 1,
      protocolVersion: "capture-spec-v2", gateConfigHash: "h", device: [:], camera: [:], frames: [], verdict: nil,
      checkingSinceMs: nil, error: nil, attemptTelemetry: nil)
  }

  /// The phone asks to stay awake for a burst only while frames are still to be sent; from `checking` on the
  /// server works alone.
  func testUploadKeepsGoingOnlyWhileFramesAreOnThePhone() {
    for stage in [SpoolStage.pending_create, .uploading, .finalizing] {
      XCTAssertTrue(AppModel.stillSending(.waiting(manifest(stage), 1000, .offline)), stage.rawValue)
    }
    XCTAssertFalse(AppModel.stillSending(.waiting(manifest(.checking), 1000, .checking)))
    XCTAssertFalse(AppModel.stillSending(.terminal(manifest(.complete))))
    XCTAssertFalse(AppModel.stillSending(.idle))
    XCTAssertFalse(AppModel.stillSending(.blocked))
  }
}
