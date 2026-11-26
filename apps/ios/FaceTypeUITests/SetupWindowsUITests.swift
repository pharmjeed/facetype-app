//
//  SetupWindowsUITests.swift
//  The «بياناتك» page as the owner reported it on 2026-11-26:
//   - «حفظ ومتابعة» sat partly below the bottom of the screen;
//   - the birth-date window did not close;
//   - the nationality list misbehaved when opened;
//   - the one notice line is replaced by «الشروط والأحكام» and a box to tick.
//  Each test drives the real screen in the CI demo mode (synthetic data, no network) in Arabic and in English, on an
//  Arabic phone as the owner's. Screenshots of every step go to apps/ios/shots/uitest (uploaded by CI).
//

import XCTest

final class SetupWindowsUITests: XCTestCase {
  private static let shotDir = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("shots/uitest", isDirectory: true)

  override func setUp() {
    continueAfterFailure = false
  }

  private func launch(_ screen: String, app lang: String, phone: String = "ar") -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-FTDemo", screen, "-FTLang", lang,
                           "-AppleLanguages", "(\(phone))", "-AppleLocale", phone == "ar" ? "ar_SA" : "en_US"]
    app.launch()
    XCTAssertTrue(app.buttons["setup.save"].waitForExistence(timeout: 30), "save button missing (\(lang))")
    return app
  }

  private func shot(_ name: String) {
    let screenshot = XCUIScreen.main.screenshot()
    try? FileManager.default.createDirectory(at: Self.shotDir, withIntermediateDirectories: true)
    try? screenshot.pngRepresentation.write(to: Self.shotDir.appendingPathComponent("\(name).png"))
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func waitGone(_ element: XCUIElement, _ message: String, timeout: TimeInterval = 5) {
    let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element)
    if XCTWaiter().wait(for: [gone], timeout: timeout) != .completed { XCTFail(message) }
  }

  private func hasFocus(_ element: XCUIElement) -> Bool {
    (element.value(forKey: "hasKeyboardFocus") as? Bool) ?? false
  }

  /// The top of whatever covers the bottom of the form: the pinned bar (terms row and save button) or, while
  /// typing, the keyboard.
  private func coverTop(_ app: XCUIApplication) -> CGFloat {
    var top = app.windows.firstMatch.frame.height
    let box = app.buttons["terms.checkbox"]
    let save = app.buttons["setup.save"]
    if box.exists { top = min(top, box.frame.minY - 8) } else if save.exists { top = min(top, save.frame.minY - 8) }
    let keyboard = app.keyboards.firstMatch
    if keyboard.exists { top = min(top, keyboard.frame.minY) }
    return top
  }

  /// Scrolls the form until the element lies wholly above the bar and the keyboard. `isHittable` alone is not
  /// enough: a row under the translucent bar still reports hittable while a real tap lands on the bar (CI
  /// 2026-11-26). Each drag starts in the visible part of the form and ends at rest, so the list is not gliding
  /// when the row is tapped (a tap on a gliding list only stops it).
  private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
    var tries = 0
    while !(element.isHittable && element.frame.maxY <= coverTop(app)) && tries < 8 {
      let window = app.windows.firstMatch.frame
      let cover = coverTop(app)
      let below = !element.exists || element.frame.minY > window.height * 0.5  // a row not yet built lies below
      let origin = app.coordinate(withNormalizedOffset: .zero)
      let upper = window.height * 0.2
      let lower = min(cover - 40, window.height * 0.45)
      let start = origin.withOffset(CGVector(dx: window.width / 2, dy: below ? lower : upper))
      let end = origin.withOffset(CGVector(dx: window.width / 2, dy: below ? upper : lower))
      start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .default, thenHoldForDuration: 0.4)
      tries += 1
    }
    XCTAssertTrue(element.isHittable && element.frame.maxY <= coverTop(app),
                  "could not scroll \(element) clear of the bar: \(element.frame) cover \(coverTop(app))")
  }

  // MARK: the save bar

  func testSaveButtonIsWhollyOnScreen() {
    for lang in ["ar", "en"] {
      for screen in ["setup", "setup-errors"] {
        let app = launch(screen, app: lang)
        let save = app.buttons["setup.save"]
        let window = app.windows.firstMatch.frame
        XCTAssertTrue(save.isHittable, "save not tappable (\(lang), \(screen))")
        // Wholly inside the window and clear of the home indicator (34 pt on Face ID phones).
        XCTAssertGreaterThanOrEqual(save.frame.minY, window.minY, "save above the window (\(lang), \(screen))")
        XCTAssertLessThanOrEqual(save.frame.maxY, window.maxY - 30, "save under the bottom edge (\(lang), \(screen))")
        XCTAssertTrue(app.buttons["terms.checkbox"].isHittable, "terms box not tappable (\(lang), \(screen))")
        shot("\(lang)-\(screen)-bar")
        // Still wholly visible after scrolling to the end of the form.
        app.swipeUp()
        app.swipeUp()
        XCTAssertTrue(save.isHittable, "save not tappable after scrolling (\(lang), \(screen))")
        XCTAssertLessThanOrEqual(save.frame.maxY, window.maxY - 30, "save under the bottom edge after scrolling")
        shot("\(lang)-\(screen)-bar-scrolled")
        app.terminate()
      }
    }
  }

  // MARK: terms

  func testTermsBoxMustBeTickedAndTheLinkOpensTheTerms() {
    for lang in ["ar", "en"] {
      let app = launch("setup", app: lang)
      let box = app.buttons["terms.checkbox"]
      XCTAssertEqual(box.value as? String, "0", "box starts ticked (\(lang))")

      // Saving with the box empty asks for the tick and sends nothing.
      app.buttons["setup.save"].tap()
      XCTAssertTrue(app.staticTexts["terms.required"].waitForExistence(timeout: 5), "no terms message (\(lang))")
      shot("\(lang)-terms-required")

      // The link opens the terms; «إغلاق» closes them without ticking.
      let link = app.buttons["terms.link"]
      XCTAssertTrue(link.waitForExistence(timeout: 5), "no terms link (\(lang))")
      XCTAssertEqual(link.label, lang == "ar" ? "الشروط والأحكام" : "Terms and Conditions")
      link.tap()
      let close = app.buttons["terms.close"]
      XCTAssertTrue(close.waitForExistence(timeout: 5), "terms window did not open (\(lang))")
      shot("\(lang)-terms-window")
      close.tap()
      waitGone(close, "terms window did not close (\(lang))")
      XCTAssertEqual(box.value as? String, "0", "closing the terms ticked the box (\(lang))")

      // «أوافق» ticks the box and closes the window.
      link.tap()
      let accept = app.buttons["terms.accept"]
      XCTAssertTrue(accept.waitForExistence(timeout: 5), "terms window did not open again (\(lang))")
      accept.tap()
      waitGone(accept, "«أوافق» did not close the terms (\(lang))")
      XCTAssertEqual(box.value as? String, "1", "«أوافق» did not tick the box (\(lang))")
      XCTAssertFalse(app.staticTexts["terms.required"].exists, "terms message stayed after agreeing (\(lang))")
      shot("\(lang)-terms-ticked")

      // The box itself toggles.
      box.tap()
      XCTAssertEqual(box.value as? String, "0", "the box did not untick (\(lang))")
      box.tap()
      XCTAssertEqual(box.value as? String, "1", "the box did not tick (\(lang))")
      app.terminate()
    }
  }

  // MARK: birth date

  func testBirthDateWindowClosesWithDoneAndWithATapOutside() {
    for lang in ["ar", "en"] {
      let app = launch("setup-errors", app: lang)
      let row = app.buttons["field.birth_date"]
      reveal(row, in: app)
      let before = row.label
      row.tap()
      let done = app.buttons["date.done"]
      XCTAssertTrue(done.waitForExistence(timeout: 5), "date window did not open (\(lang))")
      let wheels = app.pickerWheels.allElementsBoundByIndex.compactMap { $0.value as? String }
      shot("\(lang)-date-window")
      // Gregorian on an Arabic, Saudi-region phone too: the wheels open on 1 January, thirty years ago.
      let year = String(Calendar(identifier: .gregorian).component(.year, from: Date()) - 30)
      XCTAssertTrue(wheels.contains { $0.contains(year) }, "wheels not Gregorian (\(lang)): \(wheels)")
      done.tap()
      waitGone(done, "«تم» did not close the date window (\(lang))")
      XCTAssertNotEqual(row.label, before, "«تم» did not keep a date (\(lang)): \(row.label)")
      shot("\(lang)-date-chosen")

      // A tap above the window closes it too.
      reveal(row, in: app)
      row.tap()
      XCTAssertTrue(done.waitForExistence(timeout: 5), "date window did not open again (\(lang))")
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
      waitGone(done, "a tap outside did not close the date window (\(lang))")
      app.terminate()
    }
  }

  // MARK: countries

  func testCountryWindowsOpenSearchAndClose() {
    // Every language and path runs even when one fails, so the screenshots cover them all.
    continueAfterFailure = true
    for lang in ["ar", "en"] {
      for (field, keyboardFirst) in [("field.nationality", false), ("field.nationality", true),
                                     ("field.id_issuing_country", false)] {
        let label = "\(lang)-\(field == "field.nationality" ? "nationality" : "id-country")\(keyboardFirst ? "-kb" : "")"
        let app = launch("setup-errors", app: lang)
        if keyboardFirst {
          // As on a phone: typing the mobile number, then going straight to the nationality.
          let phone = app.textFields["field.phone"]
          reveal(phone, in: app)
          phone.tap()
          let deadline = Date().addingTimeInterval(5)
          while !hasFocus(phone) && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.2)) }
          XCTAssertTrue(hasFocus(phone), "phone field did not take focus (\(label))")
          // The bar steps aside while the keyboard is up, so the last rows can be scrolled into view.
          waitGone(app.buttons["setup.save"], "save bar stayed above the keyboard (\(label))")
        }
        let row = app.buttons[field]
        reveal(row, in: app)
        row.tap()
        // Snapshots while the window opens, to catch a jump or a blank list.
        RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        shot("\(label)-opening")
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5), "country window did not open (\(label))")
        XCTAssertTrue(app.buttons["country.cancel"].exists, "no cancel in the country window (\(label))")
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        shot("\(label)-open")
        XCTAssertTrue(app.buttons["country.SA"].exists || app.buttons["country.AF"].exists || app.cells.count > 5,
                      "country list empty (\(label))")

        // Search by the code (both languages accept it) and choose.
        search.tap()
        search.typeText("EG")
        let egypt = app.buttons["country.EG"]
        XCTAssertTrue(egypt.waitForExistence(timeout: 5), "search did not find EG (\(label))")
        shot("\(label)-search")
        egypt.tap()
        waitGone(search, "choosing a country did not close the window (\(label))")
        let expected = lang == "ar" ? "مصر" : "Egypt"
        XCTAssertTrue(row.label.contains(expected), "row does not show the choice (\(label)): \(row.label)")
        XCTAssertTrue(app.buttons["setup.save"].waitForExistence(timeout: 5), "save bar did not come back (\(label))")
        shot("\(label)-chosen")

        // «إلغاء» closes without changing the choice. Closing the keyboard brought the bar back over the bottom rows.
        reveal(row, in: app)
        row.tap()
        let cancel = app.buttons["country.cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 5), "country window did not open again (\(label))")
        cancel.tap()
        waitGone(cancel, "«إلغاء» did not close the window (\(label))")
        XCTAssertTrue(row.label.contains(expected), "cancel changed the choice (\(label)): \(row.label)")
        app.terminate()
      }
    }
  }
}
