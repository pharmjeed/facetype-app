//
//  Messages.swift
//  Codes → string keys (port of apps/mobile/src/client/messages.ts, checked against
//  docs/fixtures/client/messages.json). Server text is never shown.
//

import Foundation

enum Messages {
  /// Native check name → the one message that helps.
  static func rejectReasonKey(_ reason: String?, current: GuidanceMessage) -> String? {
    switch reason {
    case nil: return nil
    case "oneFace": return "guide.multiple_faces"
    case "distanceOrSize": return current == .move_back ? "guide.move_back" : "guide.move_closer"
    case "centred": return "guide.centre"
    case "facing": return "guide.look_straight"
    case "light": return "guide.light"
    case "expression": return "guide.no_smile"
    case "eyes": return "guide.eyes"
    case "sharp": return "guide.hold_still"
    case "effects_active": return "burst.effects"
    case "internal": return "burst.internal"
    default: return nil
    }
  }

  private static let moreReasons: [String: String] = [
    "remove_glasses": "more.remove_glasses",
    "face_camera": "more.face_camera",
    "neutral_face": "more.neutral_face",
    "open_eyes": "more.open_eyes",
    "hold_still": "more.hold_still",
    "one_face": "more.one_face",
    "same_person": "more.same_person",
    "more_photos": "more.more_photos",
  ]

  static func moreReasonKey(_ reason: String?) -> String {
    reason.flatMap { moreReasons[$0] } ?? "more.more_photos"
  }

  static func verdictReasonKey(_ reason: String) -> String {
    let r = reason.lowercased()
    if r == "upload_integrity" { return "reason.upload_integrity" }
    if r.contains("glasses") { return "reason.glasses" }
    if r.contains("cover") || r.contains("occlu") || r.contains("mask") { return "reason.face_covered" }
    if r.contains("second") || r.contains("multiple") { return "reason.second_face" }
    if r.contains("frames") || r.contains("too_few") { return "reason.too_few_frames" }
    if r.contains("quality") || r.contains("blur") || r.contains("light") || r.contains("sharp") {
      return "reason.quality"
    }
    return "reason.generic"
  }

  static let apiErrorKeys: [String: String] = [
    "FT-CLIENT-AUTH-UNCONFIGURED": "signin.server_unconfigured",
    "FT-CLIENT-NONCE-INVALID": "apierr.nonce_invalid",
    "FT-CLIENT-ACCOUNT-WITHDRAWING": "apierr.account_withdrawing",
    "FT-CLIENT-PROFILE-INVALID": "setup.fix_fields",
    "FT-CLIENT-ID-TAKEN": "apierr.id_taken",
    "FT-CLIENT-PROFILE-REQUIRED": "apierr.profile_required",
    "FT-CLIENT-CAPTURE-NOT-FOUND": "apierr.capture_not_found",
    "FT-CLIENT-CAPTURE-CONFLICT": "apierr.capture_conflict",
    "FT-CLIENT-CAPTURE-STATE": "apierr.capture_state",
    "FT-CLIENT-FRAME-IMMUTABLE": "apierr.frame_immutable",
    "FT-CLIENT-UPLOAD-MISSING": "apierr.upload_missing",
    "FT-CLIENT-UPLOAD-MISMATCH": "apierr.upload_mismatch",
    "FT-PRIV-003": "apierr.consent_required",
    "FT-AUTH-001": "common.session_expired",
    "FT-AUTH-002": "signin.server_unconfigured",
    "FT-AUTH-003": "common.session_expired",
    "FT-SYS-001": "apierr.rate_limited",
    "FT-SYS-002": "apierr.server",
  ]

  private static let kindKeys: [ClientErrorKind: String] = [
    .network: "common.network",
    .session_expired: "common.session_expired",
    .unauthorized: "common.session_expired",
    .rate_limited: "apierr.rate_limited",
    .server: "apierr.server",
  ]

  /// The sentence for a server error code, else for its kind; nil = the generic «({code})» line.
  static func apiErrorKey(code: String?, kind: ClientErrorKind?) -> String? {
    if let code, let key = apiErrorKeys[code] { return key }
    return kind.flatMap { kindKeys[$0] }
  }

  private static let fieldKeys: [String: String] = [
    "full_name": "err.full_name",
    "id_issuing_country": "err.country",
    "id_document_type": "err.id_type",
    "id_number": "err.id_generic",
    "phone": "err.phone",
    "sex": "err.sex",
    "birth_date": "err.birth_date",
    "nationality": "err.nationality",
  ]

  static func profileFieldErrorKey(field: String, reason: String) -> String? {
    if field == "birth_date", reason == "under_18" { return "err.underage" }
    if field == "id_number", reason == "checksum" { return "err.id_checksum" }
    return fieldKeys[field]
  }
}
