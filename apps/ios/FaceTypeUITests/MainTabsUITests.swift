//
//  MainTabsUITests.swift
//  After sign-in the app has three pages in a tab bar (owner request 2026-11-26): «معلوماتي» (the saved details),
//  «التصوير» (status and camera) and «ملفي» (the profile, with the personality block that stays unavailable).
//  Build 12: the camera is offered again after complete photos, and «معلوماتي» ends with the account section.
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

      // The demo person's photos are complete: build 12 offers the camera again, as «تصوير جديد», with no
      // invitation to repeat (owner 2026-11-26).
      capture.tap()
      let open = app.buttons["capture.open"]
      XCTAssertTrue(open.waitForExistence(timeout: 5), "camera button after complete photos (\(lang))")
      XCTAssertTrue(open.isHittable, "camera button not tappable (\(lang))")
      XCTAssertTrue(open.label.contains(lang == "ar" ? "تصوير جديد" : "Take new photos"), "button label: \(open.label)")
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
      XCTAssertTrue(app.buttons["capture.open"].label.contains(lang == "ar" ? "التصوير" : "Take photos"),
                    "button label: \(app.buttons["capture.open"].label)")
      shot("\(lang)-tab-capture-needs-more")
      app.terminate()
    }
  }

  /// While a burst is with the server the camera is not offered.
  func testNoCameraWhileTheServerChecks() {
    let app = XCUIApplication()
    app.launchArguments = ["-FTDemo", "profile", "-FTLang", "ar", "-FTDemoStatus", "measuring",
                           "-AppleLanguages", "(ar)", "-AppleLocale", "ar_SA"]
    app.launch()
    let bar = app.tabBars.firstMatch
    XCTAssertTrue(bar.waitForExistence(timeout: 30), "no tab bar")
    bar.buttons["التصوير"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["capture.status"].waitForExistence(timeout: 5), "status line")
    XCTAssertFalse(app.buttons["capture.open"].exists, "camera offered while the server checks")
    app.terminate()
  }

  /// «معلوماتي» ends with the account: sign out, and delete, which asks first and can be cancelled. The demo has
  /// no network, and the test only cancels.
  func testAccountSectionAsksBeforeDeleting() {
    continueAfterFailure = true
    for lang in ["ar", "en"] {
      let app = XCUIApplication()
      app.launchArguments = ["-FTDemo", "profile", "-FTLang", lang, "-AppleLanguages", "(ar)", "-AppleLocale", "ar_SA"]
      app.launch()
      let bar = app.tabBars.firstMatch
      XCTAssertTrue(bar.waitForExistence(timeout: 30), "no tab bar (\(lang))")
      bar.buttons[lang == "ar" ? "معلوماتي" : "My details"].tap()
      let delete = app.buttons["account.delete"]
      var swipes = 0
      while !(delete.exists && delete.isHittable) && swipes < 5 {
        app.swipeUp()
        swipes += 1
      }
      XCTAssertTrue(app.buttons["account.sign_out"].exists, "sign-out button (\(lang))")
      XCTAssertTrue(delete.isHittable, "delete button (\(lang))")
      shot("\(lang)-tab-info-account")
      delete.tap()
      let confirm = app.buttons[lang == "ar" ? "حذف نهائيًا" : "Delete permanently"]
      XCTAssertTrue(confirm.waitForExistence(timeout: 5), "confirmation (\(lang))")
      XCTAssertTrue(anything(app, containing: lang == "ar" ? "لا يمكن التراجع" : "cannot be undone").exists,
                    "the confirmation says it cannot be undone (\(lang))")
      shot("\(lang)-tab-info-delete-confirm")
      app.buttons[lang == "ar" ? "إلغاء" : "Cancel"].firstMatch.tap()
      XCTAssertFalse(confirm.waitForExistence(timeout: 2), "confirmation still shown after cancel (\(lang))")
      XCTAssertTrue(bar.exists, "left the signed-in pages after cancel (\(lang))")
      app.terminate()
    }
  }
}
