//
//  L10n.swift
//  Interface language (owner 2026-11-25): Arabic by default, right to left; English on request. The strings
//  are generated from docs/fixtures/client/strings.json (tools/native/gen_strings.py) into
//  Resources/{ar,en}.lproj/Localizable.strings; `{token}` placeholders are filled here.
//

import Foundation
import SwiftUI

enum Lang: String, CaseIterable, Codable {
  case ar
  case en

  var isRTL: Bool { self == .ar }
  var layoutDirection: LayoutDirection { isRTL ? .rightToLeft : .leftToRight }
  var locale: Locale { Locale(identifier: rawValue) }
  var other: Lang { self == .ar ? .en : .ar }
}

enum L10n {
  /// The language every `s()` call reads. `AppModel` sets it before publishing a change, so the next render
  /// of every view reads the new table.
  static var lang: Lang = .ar

  private static var bundles: [Lang: Bundle] = [:]

  static func bundle(_ language: Lang) -> Bundle {
    if let cached = bundles[language] { return cached }
    let found = Bundle.main.path(forResource: language.rawValue, ofType: "lproj").flatMap(Bundle.init(path:))
      ?? Bundle(for: BundleToken.self).path(forResource: language.rawValue, ofType: "lproj").flatMap(Bundle.init(path:))
      ?? Bundle.main
    bundles[language] = found
    return found
  }

  /// The string for `key` in `language` (default: the current one); unknown keys come back as the key itself,
  /// which the fixture test refuses.
  static func s(_ key: String, _ vars: [String: CustomStringConvertible] = [:], language: Lang? = nil) -> String {
    let table = bundle(language ?? lang)
    let raw = table.localizedString(forKey: key, value: key, table: "Localizable")
    return fill(raw, vars)
  }

  static func fill(_ text: String, _ vars: [String: CustomStringConvertible]) -> String {
    guard text.contains("{") else { return text }
    var out = ""
    var index = text.startIndex
    while index < text.endIndex {
      if text[index] == "{", let close = text[index...].firstIndex(of: "}") {
        let name = String(text[text.index(after: index)..<close])
        // `\w` in the TypeScript original: ASCII letters, digits and underscore.
        if !name.isEmpty, name.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }),
          let value = vars[name]
        {
          out += value.description
          index = text.index(after: close)
          continue
        }
      }
      out.append(text[index])
      index = text.index(after: index)
    }
    return out
  }
}

/// Lets the test bundle find the app's .lproj folders when `Bundle.main` is the test runner.
private final class BundleToken {}

/// Short global used by the views: `s("profile.title")`.
func s(_ key: String, _ vars: [String: CustomStringConvertible] = [:]) -> String {
  L10n.s(key, vars)
}
