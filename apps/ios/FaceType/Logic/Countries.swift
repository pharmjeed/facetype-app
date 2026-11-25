//
//  Countries.swift
//  ISO 3166-1 alpha-2 with Arabic and English names (docs/fixtures/client/countries.json, bundled as
//  countries.json). The stored value is the code; names and display order follow the interface language.
//  Port of apps/mobile/src/client/countries.ts, checked against the same fixture.
//

import Foundation

struct Country: Equatable, Identifiable {
  let code: String
  let name: String
  var id: String { code }
}

enum Countries {
  private struct Entry: Decodable {
    let code: String
    let ar: String
    let en: String
  }

  private struct File: Decodable {
    let countries: [Entry]
    let order_ar: [String]
    let order_en: [String]
  }

  private static let file: File = {
    let bundles = [Bundle.main, Bundle(for: CountriesToken.self)]
    for bundle in bundles {
      if let url = bundle.url(forResource: "countries", withExtension: "json"),
        let data = try? Data(contentsOf: url),
        let decoded = try? JSONDecoder().decode(File.self, from: data)
      {
        return decoded
      }
    }
    return File(countries: [], order_ar: [], order_en: [])
  }()

  private static let lists: [Lang: [Country]] = {
    let byCode = Dictionary(uniqueKeysWithValues: file.countries.map { ($0.code, $0) })
    return [
      .ar: file.order_ar.compactMap { code in byCode[code].map { Country(code: code, name: $0.ar) } },
      .en: file.order_en.compactMap { code in byCode[code].map { Country(code: code, name: $0.en) } },
    ]
  }()

  private static let byCode: [Lang: [String: Country]] = lists.mapValues { list in
    Dictionary(uniqueKeysWithValues: list.map { ($0.code, $0) })
  }

  static func all(_ language: Lang = L10n.lang) -> [Country] { lists[language] ?? [] }

  static func isCode(_ code: String) -> Bool { byCode[.ar]?[code] != nil }

  static func name(_ code: String?, language: Lang = L10n.lang) -> String {
    guard let code, !code.isEmpty else { return "" }
    return byCode[language]?[code]?.name ?? code
  }

  /// Arabic letter variants («الامارات» finds «الإمارات») and Latin accents («aland» finds «Åland»).
  static func fold(_ text: String) -> String {
    let decomposed = text.decomposedStringWithCanonicalMapping.unicodeScalars.filter {
      !(0x0300...0x036F).contains($0.value)
    }
    var value = String(String.UnicodeScalarView(decomposed)).precomposedStringWithCanonicalMapping.lowercased()
    var scalars = String.UnicodeScalarView()
    for scalar in value.unicodeScalars {
      switch scalar.value {
      case 0x0622, 0x0623, 0x0625: scalars.append(UnicodeScalar(0x0627)!)  // آ أ إ → ا
      case 0x0629: scalars.append(UnicodeScalar(0x0647)!)  // ة → ه
      case 0x0649: scalars.append(UnicodeScalar(0x064A)!)  // ى → ي
      case 0x064B...0x0670, 0x065F, 0x0640: continue  // the original's [ً-ٰٟـ]
      default: scalars.append(scalar)
      }
    }
    value = String(scalars)
    if value.hasPrefix("ال") { value = String(value.dropFirst(2)) }
    return value.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func contains(_ haystack: String, _ needle: String) -> Bool {
    haystack.range(of: needle, options: .literal) != nil
  }

  /// Countries whose code or folded name contains the query; an exact code comes first.
  static func search(_ query: String, limit: Int = 8, language: Lang = L10n.lang) -> [Country] {
    let q = fold(query)
    guard !q.isEmpty else { return [] }
    let upper = query.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    let exact = byCode[language]?[upper]
    let matches = all(language).filter { country in
      country != exact && (contains(fold(country.name), q) || country.code.lowercased() == q)
    }
    return Array(((exact.map { [$0] } ?? []) + matches).prefix(limit))
  }

  /// The picker list: every country for an empty query, else all matches.
  static func filter(_ query: String, language: Lang = L10n.lang) -> [Country] {
    if fold(query).isEmpty { return all(language) }
    return search(query, limit: all(language).count, language: language)
  }
}

private final class CountriesToken {}
