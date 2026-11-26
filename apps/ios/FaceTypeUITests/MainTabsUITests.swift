//
//  MainTabsUITests.swift
//  After sign-in the app has three pages in a tab bar (owner request 2026-11-26): «معلوماتي» (the saved details),
//  «التصوير» (status and camera) and «ملفي» (the profile, with the personality block that stays unavailable).
//  Runs the CI demo mode (synthetic person who already has photos, no network) in Arabic and in English, on an
//  Arabic phone as the owner's. Screenshots go to apps/ios/shots/uitest.
//

import XCTest

final class MainTabsUITests: XCTestCase {
  private static let shotDir = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("shots/uitest", isDirectory: true)

  private func shot(_ name: String) {
    let screenshot = XCUIScreen.main.screenshot()
    try? FileManager.default.createDirectory(at: Self.shotDir, withIntermediateDirectories: true)
    try? screenshot.pngRepresentation.write(to: Self.shotDir.appendingPathComponent("\(name).png"))
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func anything(_ app: XCUIApplication, containing text: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
  }

  func testThreePagesAfterSignIn() {
    continueAfterFailure = true
    for lang in ["ar", "en"] {
      let app = XCUIApplication()
      app.launchArguments = ["-FTDemo", "profile", "-FTLang", lang, "-AppleLanguages", "(ar)", "-AppleLocale", "ar_SA"]
      app.launch()
      let names = lang == "ar" ? ["معلوماتي", "التصوير", "ملفي"] : ["My details", "Photos", "My profile"]
      let bar = app.tabBars.firstMatch
      XCTAssertTrue(bar.waitForExistence(timeout: 30), "no tab bar (\(lang))")
      let info = bar.buttons[names[0]], capture = bar.buttons[names[1]], profile = bar.buttons[names[2]]
      XCTAssertTrue(info.exists && capture.exists && profile.exists, "tab labels (\(lang)): \(bar.buttons.allElementsBoundByIndex.map(\.label))")

      // The demo person already has photos, so the app opens on «ملفي».
      XCTAssertTrue(app.staticTexts["profile.personality"].waitForExistence(timeout: 10), "profile page (\(lang))")
      XCTAssertTrue(anything(app, containing: "سارة").exists, "name on the profile page (\(lang))")
      shot("\(lang)-tab-profile")

      info.tap()
      XCTAssertTrue(anything(app, containing: "1000000008").waitForExistence(timeout: 5), "details page (\(lang))")
      XCTAssertFalse(app.staticTexts["profile.personality"].isHittable, "personality block on the details page (\(lang))")
      shot("\(lang)-tab-info")

      // The demo person's photos are complete: photos are taken once, so there is no camera button and no
      // invitation to repeat (owner 2026-11-26).
      capture.tap()
      XCTAssertTrue(app.staticTexts["capture.done"].waitForExistence(timeout: 5), "capture page, done line (\(lang))")
      XCTAssertFalse(app.buttons["capture.open"].exists, "camera offered after complete photos (\(lang))")
      XCTAssertFalse(anything(app, containing: lang == "ar" ? "اختياري" : "optional").exists, "repeat invitation (\(lang))")
      shot("\(lang)-tab-capture")

      // The first page sits on the reading side: right in Arabic, left in English.
      if lang == "ar" {
        XCTAssertGreaterThan(info.frame.midX, profile.frame.midX, "Arabic tab order (\(lang))")
      } else {
        XCTAssertLessThan(info.frame.midX, profile.frame.midX, "English tab order (\(lang))")
      }
      app.terminate()
    }
  }

  /// When the server asks for more photos, the camera is offered on «التصوير».
  func testCameraOfferedWhenMorePhotosAreNeeded() {
    continueAfterFailure = true
    for lang in ["ar", "en"] {
      let app = XCUIApplication()
      app.launchArguments = ["-FTDemo", "profile", "-FTLang", lang, "-FTDemoStatus", "needs_more",
                             "-AppleLanguages", "(ar)", "-AppleLocale", "ar_SA"]
      app.launch()
      let bar = app.tabBars.firstMatch
      XCTAssertTrue(bar.waitForExistence(timeout: 30), "no tab bar (\(lang))")
      bar.buttons[lang == "ar" ? "التصوير" : "Photos"].tap()
      XCTAssertTrue(app.buttons["capture.open"].waitForExistence(timeout: 5), "camera button (\(lang))")
      XCTAssertTrue(app.buttons["capture.open"].isHittable, "camera button not tappable (\(lang))")
      XCTAssertFalse(app.staticTexts["capture.done"].exists, "done line while more photos are needed (\(lang))")
      shot("\(lang)-tab-capture-needs-more")
      app.terminate()
    }
  }
}
