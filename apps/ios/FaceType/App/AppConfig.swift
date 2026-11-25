//
//  AppConfig.swift
//  Build-time settings, from Info.plist keys filled by project.yml build settings (FACETYPE_*). Public
//  identifiers only — never a secret.
//

import Foundation

enum AppConfig {
  private static func value(_ key: String) -> String {
    let raw = (Bundle.main.object(forInfoDictionaryKey: key) as? String ?? "").trimmingCharacters(in: .whitespaces)
    return raw.hasPrefix("$(") ? "" : raw
  }

  static var apiBaseURL: String { value("FTApiBaseURL") }
  static var googleIOSClientId: String { value("FTGoogleIOSClientID") }
  static var googleServerClientId: String { value("FTGoogleWebClientID") }
  static var supportContact: String? {
    let v = value("FTSupportContact")
    return v.isEmpty ? nil : v
  }

  /// The mock sign-in exists only in a Debug build with the flag set.
  static var mockAuth: Bool {
    #if DEBUG
      return ["1", "true"].contains(value("FTMockAuth").lowercased())
    #else
      return false
    #endif
  }

  /// A configuration problem the app cannot work around, as the code the sign-in screen shows; nil when fine.
  static var configError: String? {
    let url = apiBaseURL
    guard !url.isEmpty else { return "API_URL_UNCONFIGURED" }
    guard let parsed = URL(string: url), let scheme = parsed.scheme?.lowercased(), parsed.host != nil,
      parsed.user == nil, parsed.query == nil, parsed.fragment == nil
    else { return "API_URL_INVALID" }
    #if DEBUG
      return scheme == "https" || scheme == "http" ? nil : "API_URL_INVALID"
    #else
      return scheme == "https" ? nil : "API_URL_INSECURE"
    #endif
  }
}
