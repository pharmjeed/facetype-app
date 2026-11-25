//
//  Models.swift
//  Wire shapes of /api/v1/client (apps/mobile/src/client/api/types.ts, services/api/openapi.json).
//  Decoding is lenient: optional server fields stay optional so a new server field never breaks the app.
//

import Foundation

struct TokenPair: Decodable {
  let access_token: String
  let expires_in: Double
  let refresh_token: String
  let account_id: String?
}

struct NonceResponse: Decodable {
  let nonce: String
  let expires_at: String?
}

struct AccountView: Decodable, Equatable {
  let id: String
  let provider: String?
  let state: String?
  let created_at: String?
}

struct ProfileView: Decodable, Equatable {
  let revision_id: String?
  let revision: Int?
  let full_name: String
  let id_issuing_country: String
  let id_document_type: String
  let id_number: String
  let phone: String
  let sex: String
  let birth_date: String
  let nationality: String
  let age_years: Int?
  let identity_verification: String?
  let updated_at: String?
}

struct ConsentView: Decodable, Equatable {
  let id: String?
  let version: String?
  let store_accepted: Bool
  let research_use: Bool?
  let created_at: String?
}

struct CaptureSummary: Decodable, Equatable {
  let count: Int
  let last_at: String?
  let latest_status: String?
  let next_repeat_due_at: String?
}

struct PersonalityView: Decodable, Equatable {
  let status: String?
}

struct ClientMe: Decodable, Equatable {
  let account: AccountView
  let profile: ProfileView?
  let consent: ConsentView?
  let captures: CaptureSummary?
  let personality: PersonalityView?
}

struct FrameUploadTarget: Codable, Equatable {
  let index: Int
  let completed: Bool
  var upload_url: String?
  let method: String?
  let headers: [String: String]?
  let expires_at: String?
}

struct CaptureCreated: Decodable {
  let capture_id: String
  let status: String?
  var frames: [FrameUploadTarget]
}

/// A capture as the server sees it; `status` decides the spool's next step.
struct CaptureView: Codable, Equatable {
  let id: String
  let status: String
  let accepted_frames: Int?
  let reasons: [String]?
  let sequence: Int?
  let frame_count: Int?
  let previous_capture_id: String?
  let created_at: String?
  let finalized_at: String?
  let checked_at: String?

  init(id: String, status: String, accepted_frames: Int? = nil, reasons: [String]? = nil) {
    self.id = id
    self.status = status
    self.accepted_frames = accepted_frames
    self.reasons = reasons
    sequence = nil
    frame_count = nil
    previous_capture_id = nil
    created_at = nil
    finalized_at = nil
    checked_at = nil
  }
}

enum CaptureStatus: String {
  case uploading, checking, received, stored, needs_retake, measuring, needs_more, complete
}

enum AttemptOutcome: String, Codable, CaseIterable {
  case stored, received, needs_retake, needs_more, complete, abandoned, cancelled, timed_out, out_of_scope,
    permission_denied
}
