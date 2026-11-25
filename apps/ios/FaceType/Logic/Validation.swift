//
//  Validation.swift
//  Profile field rules, a port of apps/mobile/src/client/validation.ts checked against
//  docs/fixtures/client/validation.json. Error values are string keys (`err.*`).
//

import Foundation

enum IdDocumentType: String, CaseIterable, Codable {
  case national_id
  case residence_id
  case passport
}

enum Sex: String, CaseIterable, Codable {
  case male
  case female
}

enum Checked<T: Equatable>: Equatable {
  case ok(T)
  case error(String)

  var value: T? { if case .ok(let v) = self { return v } else { return nil } }
  var errorKey: String? { if case .error(let e) = self { return e } else { return nil } }
}

struct ProfileForm: Equatable {
  var full_name = ""
  var id_issuing_country = ""
  var id_document_type: IdDocumentType?
  var id_number = ""
  var phone = ""
  var sex: Sex?
  var birth_date = ""
  var nationality = ""
}

struct ProfileValues: Equatable, Codable {
  let full_name: String
  let id_issuing_country: String
  let id_document_type: IdDocumentType
  let id_number: String
  let phone: String
  let sex: Sex
  let birth_date: String
  let nationality: String
}

enum ProfileField: String, CaseIterable {
  case full_name, id_issuing_country, id_document_type, id_number, phone, sex, birth_date, nationality
}

enum Validation {
  static let minAgeYears = 18
  static let defaultCallingCode = "+966"

  private static func regex(_ pattern: String) -> NSRegularExpression {
    // The patterns are constants; a typo fails the first test run.
    try! NSRegularExpression(pattern: pattern)
  }

  private static func matches(_ re: NSRegularExpression, _ text: String) -> Bool {
    re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
  }

  /// Arabic-Indic (U+0660–0669) and Eastern Arabic-Indic (U+06F0–06F9) digits → ASCII.
  static func normalizeDigits(_ text: String) -> String {
    var out = String.UnicodeScalarView()
    for scalar in text.unicodeScalars {
      switch scalar.value {
      case 0x0660...0x0669: out.append(UnicodeScalar(0x30 + scalar.value - 0x0660)!)
      case 0x06F0...0x06F9: out.append(UnicodeScalar(0x30 + scalar.value - 0x06F0)!)
      default: out.append(scalar)
      }
    }
    return String(out)
  }

  private static let letter =
    "\\u0621-\\u063a\\u0641-\\u064a\\u0671-\\u06d3\\u06d5A-Za-z\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u024f"
  private static let mark = "\\u064b-\\u065f\\u0670"
  private static let namePattern = regex("^[\(letter)](?:[\(letter) '.\\-]|[\(mark)])*$")
  private static let letterPattern = regex("[\(letter)]")
  private static let whitespaceRun = regex("\\s+")

  /// 2–100 characters: Arabic/Latin letters, spaces, `'`, `-`, `.`.
  static func checkFullName(_ raw: String) -> Checked<String> {
    var value = raw.replacingOccurrences(of: "[\u{2018}\u{2019}\u{02BC}]", with: "'", options: .regularExpression)
    value = whitespaceRun.stringByReplacingMatches(
      in: value, range: NSRange(value.startIndex..., in: value), withTemplate: " ")
    value = value.trimmingCharacters(in: .whitespacesAndNewlines)
    let length = value.unicodeScalars.count
    guard length >= 2, length <= 100, matches(namePattern, value) else { return .error("err.full_name") }
    let letters = letterPattern.numberOfMatches(in: value, range: NSRange(value.startIndex..., in: value))
    return letters >= 2 ? .ok(value) : .error("err.full_name")
  }

  static func checkCountry(_ raw: String, error: String = "err.country") -> Checked<String> {
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    let twoLetters = value.count == 2 && value.unicodeScalars.allSatisfy { (65...90).contains($0.value) }
    return twoLetters && Countries.isCode(value) ? .ok(value) : .error(error)
  }

  /// Luhn (mod 10); the Saudi national ID and residence permit check digit.
  static func luhnValid(_ digits: String) -> Bool {
    guard !digits.isEmpty, digits.unicodeScalars.allSatisfy({ (48...57).contains($0.value) }) else { return false }
    var sum = 0
    for (i, ch) in digits.reversed().enumerated() {
      var digit = Int(String(ch))!
      if i % 2 == 1 {
        digit *= 2
        if digit > 9 { digit -= 9 }
      }
      sum += digit
    }
    return sum % 10 == 0
  }

  /// ASCII digits, no separators, upper case.
  static func canonicalIdNumber(_ raw: String) -> String {
    normalizeDigits(raw)
      .replacingOccurrences(of: "[\\s\\-_.\u{200E}\u{200F}]", with: "", options: .regularExpression)
      .uppercased()
  }

  private static let saNational = regex("^1\\d{9}$")
  private static let saResidence = regex("^2\\d{9}$")
  private static let genericId = regex("^[A-Z0-9]{5,20}$")

  static func checkIdNumber(country: String, type: IdDocumentType, _ raw: String) -> Checked<String> {
    let value = canonicalIdNumber(raw)
    if country == "SA", type == .national_id {
      guard matches(saNational, value) else { return .error("err.sa_national_id") }
      return luhnValid(value) ? .ok(value) : .error("err.id_checksum")
    }
    if country == "SA", type == .residence_id {
      guard matches(saResidence, value) else { return .error("err.sa_residence_id") }
      return luhnValid(value) ? .ok(value) : .error("err.id_checksum")
    }
    return matches(genericId, value) ? .ok(value) : .error("err.id_generic")
  }

  private static let sa05 = regex("^05\\d{8}$")
  private static let sa5 = regex("^5\\d{8}$")
  private static let sa9665 = regex("^9665\\d{8}$")
  private static let e164 = regex("^\\+[1-9]\\d{6,14}$")
  private static let saMobile = regex("^\\+9665\\d{8}$")

  /// E.164, unverified. Without a country code the number is read as Saudi.
  static func checkPhone(_ raw: String) -> Checked<String> {
    var value = normalizeDigits(raw)
      .replacingOccurrences(of: "[\\s\\-().\u{200E}\u{200F}]", with: "", options: .regularExpression)
    if value.hasPrefix("00") { value = "+" + value.dropFirst(2) }
    if !value.hasPrefix("+") {
      if matches(sa05, value) {
        value = defaultCallingCode + value.dropFirst(1)
      } else if matches(sa5, value) {
        value = defaultCallingCode + value
      } else if matches(sa9665, value) {
        value = "+" + value
      } else {
        return .error("err.phone")
      }
    }
    guard matches(e164, value) else { return .error("err.phone") }
    if value.hasPrefix("+966"), !matches(saMobile, value) { return .error("err.phone") }
    return .ok(value)
  }

  static func checkSex(_ raw: String?) -> Checked<Sex> {
    if let sex = raw.flatMap(Sex.init(rawValue:)) { return .ok(sex) }
    return .error("err.sex")
  }

  static func checkIdType(_ raw: String?) -> Checked<IdDocumentType> {
    if let type = raw.flatMap(IdDocumentType.init(rawValue:)) { return .ok(type) }
    return .error("err.id_type")
  }

  /// Completed years between a birth date and `today` (UTC calendar dates).
  static func ageInYears(y: Int, m: Int, d: Int, today: Date) -> Int {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let t = calendar.dateComponents([.year, .month, .day], from: today)
    var age = t.year! - y
    if t.month! < m || (t.month! == m && t.day! < d) { age -= 1 }
    return age
  }

  private static let isoLoose = regex("^(\\d{4})-(\\d{1,2})-(\\d{1,2})$")

  /// ISO `YYYY-MM-DD`, a real calendar date from 1900, not in the future, and age ≥ 18.
  static func checkBirthDate(_ raw: String, today: Date = Date()) -> Checked<String> {
    let value = normalizeDigits(raw).trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: "[/.]", with: "-", options: .regularExpression)
    guard let match = isoLoose.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)),
      let ry = Range(match.range(at: 1), in: value), let rm = Range(match.range(at: 2), in: value),
      let rd = Range(match.range(at: 3), in: value),
      let y = Int(value[ry]), let m = Int(value[rm]), let d = Int(value[rd])
    else { return .error("err.birth_date") }
    guard y >= 1900, (1...12).contains(m), d >= 1, d <= DateWheel.daysInMonth(y: y, m: m) else {
      return .error("err.birth_date")
    }
    let age = ageInYears(y: y, m: m, d: d, today: today)
    if age < 0 { return .error("err.birth_date") }
    if age < minAgeYears { return .error("err.underage") }
    if age > 130 { return .error("err.birth_date") }
    return .ok(String(format: "%04d-%02d-%02d", y, m, d))
  }

  /// Every field at once; `errors` maps a field to its `err.*` key.
  static func validateProfile(_ form: ProfileForm, today: Date = Date())
    -> Result<ProfileValues, ProfileErrors>
  {
    let name = checkFullName(form.full_name)
    let country = checkCountry(form.id_issuing_country)
    let type = checkIdType(form.id_document_type?.rawValue)
    let id: Checked<String>
    if let c = country.value, let t = type.value {
      id = checkIdNumber(country: c, type: t, form.id_number)
    } else {
      id = checkIdNumber(country: "", type: .passport, form.id_number)
    }
    let phone = checkPhone(form.phone)
    let sex = checkSex(form.sex?.rawValue)
    let birth = checkBirthDate(form.birth_date, today: today)
    let nationality = checkCountry(form.nationality, error: "err.nationality")

    var errors: [ProfileField: String] = [:]
    errors[.full_name] = name.errorKey
    errors[.id_issuing_country] = country.errorKey
    errors[.id_document_type] = type.errorKey
    errors[.id_number] = id.errorKey
    errors[.phone] = phone.errorKey
    errors[.sex] = sex.errorKey
    errors[.birth_date] = birth.errorKey
    errors[.nationality] = nationality.errorKey
    errors = errors.compactMapValues { $0 }

    guard errors.isEmpty, let n = name.value, let c = country.value, let t = type.value, let i = id.value,
      let p = phone.value, let s = sex.value, let b = birth.value, let nat = nationality.value
    else { return .failure(ProfileErrors(fields: errors)) }
    return .success(
      ProfileValues(
        full_name: n, id_issuing_country: c, id_document_type: t, id_number: i, phone: p, sex: s,
        birth_date: b, nationality: nat))
  }
}

struct ProfileErrors: Error, Equatable {
  let fields: [ProfileField: String]
}
