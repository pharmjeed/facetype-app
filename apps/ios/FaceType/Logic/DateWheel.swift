//
//  DateWheel.swift
//  Birth-date helpers (port of apps/mobile/src/client/datePicker.ts). The stored value stays ISO
//  `YYYY-MM-DD`; the field shows «23 أبريل 1995» / "23 April 1995".
//

import Foundation

enum DateWheel {
  static let arabicMonths = [
    "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
  ]
  static let englishMonths = [
    "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November",
    "December",
  ]
  static let firstYear = 1900

  static func monthNames(_ language: Lang = L10n.lang) -> [String] {
    language == .en ? englishMonths : arabicMonths
  }

  static func daysInMonth(y: Int, m: Int) -> Int {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let date = calendar.date(from: DateComponents(year: y, month: m, day: 1))!
    return calendar.range(of: .day, in: .month, for: date)!.count
  }

  static func parseIso(_ value: String) -> (y: Int, m: Int, d: Int)? {
    let parts = value.trimmingCharacters(in: .whitespaces).split(separator: "-")
    guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
      let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]),
      (1...12).contains(m), d >= 1, d <= daysInMonth(y: y, m: m)
    else { return nil }
    return (y, m, d)
  }

  static func formatBirthDate(_ value: String, language: Lang = L10n.lang) -> String {
    guard let p = parseIso(value) else { return value }
    return "\(p.d) \(monthNames(language)[p.m - 1]) \(p.y)"
  }

  /// UTC calendar date ↔ ISO string, for the native DatePicker.
  static func date(fromIso value: String) -> Date? {
    guard let p = parseIso(value) else { return nil }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar.date(from: DateComponents(year: p.y, month: p.m, day: p.d, hour: 12))
  }

  static func iso(from date: Date) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let c = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
  }

  /// Where the wheels open when nothing is chosen yet: 1 January, thirty years ago.
  static func wheelStart(today: Date = Date()) -> Date {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let year = calendar.component(.year, from: today) - 30
    return calendar.date(from: DateComponents(year: year, month: 1, day: 1, hour: 12))!
  }
}
