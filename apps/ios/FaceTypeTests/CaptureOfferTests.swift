//
//  CaptureOfferTests.swift
//  Photos are taken once (owner 2026-11-26 «التصوير المفترض مره واحدة وخلاص»): which statuses offer the camera.
//

import XCTest

@testable import FaceType_AI

final class CaptureOfferTests: XCTestCase {
  func testCameraIsOfferedOnlyBeforeThePhotosAndWhenTheServerAsksForMore() {
    for key in ["status.none", "status.needs_more", "status.needs_retake", "status.unknown"] {
      XCTAssertTrue(ProfileStatus.offersCamera(key), key)
    }
    for key in ["status.complete", "status.stored", "status.received", "status.uploading", "status.checking",
                "status.measuring", "status.queued_offline"] {
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

  /// Every status the server can send maps to a key the rule knows.
  func testEveryServerStatusHasAKnownKey() {
    let all: [CaptureStatus] = [.uploading, .checking, .received, .stored, .needs_retake, .measuring, .needs_more,
                                .complete]
    for status in all {
      let key = "status.\(status.rawValue)"
      XCTAssertNotEqual(s(key), key, "missing string for \(key)")
    }
    XCTAssertNotEqual(s("capture.done"), "capture.done", "missing string for capture.done")
  }
}
