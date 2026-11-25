//
//  FormBehaviourUITests.swift
//  The «بياناتك» form as the owner uses it (reports of 2026-11-25): the keyboard closes on a tap outside a field
//  and stays open when another field is tapped; and the layout follows the app's language whatever the phone's
//  language is (English on an Arabic phone drew mirrored). Runs the app in its CI demo mode: synthetic data, no
//  network.
//

import XCTest

final class FormBehaviourUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  private func launch(app lang: String, phone: String) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-FTDemo", "setup-errors", "-FTLang", lang,
                           "-AppleLanguages", "(\(phone))", "-AppleLocale", phone == "ar" ? "ar_SA" : "en_US"]
    app.launch()
    return app
  }

  /// Whether the element is the first responder; independent of the simulator's hardware-keyboard setting.
  private func hasFocus(_ element: XCUIElement) -> Bool {
    (element.value(forKey: "hasKeyboardFocus") as? Bool) ?? false
  }

  private func waitFocus(_ element: XCUIElement, _ expected: Bool, _ message: String) {
    let deadline = Date().addingTimeInterval(5)
    while Date() < deadline {
      if hasFocus(element) == expected { return }
      RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
    XCTFail(message)
  }

  func testTapOutsideClosesTheKeyboard() {
    for lang in ["ar", "en"] {
      let app = launch(app: lang, phone: "ar")
      let name = app.textFields["field.full_name"]
      XCTAssertTrue(name.waitForExistence(timeout: 30), "name field missing (\(lang))")
      name.tap()
      waitFocus(name, true, "name field did not take focus (\(lang))")

      // Another field keeps the keyboard and takes the focus.
      let number = app.textFields["field.id_number"]
      number.tap()
      waitFocus(number, true, "document number did not take focus (\(lang))")

      // A tap on text that is not a field closes the keyboard.
      let intro = app.staticTexts["setup.intro"]
      if intro.isHittable { intro.tap() } else { app.navigationBars.firstMatch.tap() }
      waitFocus(number, false, "keyboard stayed open after a tap outside the fields (\(lang))")

      // The phone pad has no key to close it; a tap outside must.
      let phone = app.textFields["field.phone"]
      if !phone.isHittable { app.swipeUp() }
      phone.tap()
      waitFocus(phone, true, "phone field did not take focus (\(lang))")
      app.navigationBars.firstMatch.tap()
      waitFocus(phone, false, "phone pad stayed open after a tap outside the fields (\(lang))")
      app.terminate()
    }
  }

  /// The «Full name» header sits on the reading side of the chosen language on both phone languages.
  func testLayoutFollowsTheAppLanguage() {
    for phone in ["ar", "en"] {
      for lang in ["ar", "en"] {
        let app = launch(app: lang, phone: phone)
        let header = app.staticTexts["header.full_name"]
        XCTAssertTrue(header.waitForExistence(timeout: 30), "header missing (phone \(phone), app \(lang))")
        let width = app.windows.firstMatch.frame.width
        if lang == "ar" {
          XCTAssertGreaterThan(header.frame.maxX, width * 0.7,
                               "Arabic header not on the right (phone \(phone)): \(header.frame)")
        } else {
          XCTAssertLessThan(header.frame.minX, width * 0.3,
                            "English header not on the left (phone \(phone)): \(header.frame)")
        }
        app.terminate()
      }
    }
  }
}
