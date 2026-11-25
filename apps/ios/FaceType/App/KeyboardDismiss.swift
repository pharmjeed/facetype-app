//
//  KeyboardDismiss.swift
//  A tap anywhere outside a text field closes the keyboard (owner report 2026-11-25: in the «بياناتك» form the
//  keyboard stayed open, and the phone pad has no key to close it). One tap recognizer on the app's own window,
//  found through a zero-size view placed behind the root, so it never lands on the keyboard's windows. It does
//  not cancel or delay the tapped control's touch: a tap on a picker or on «حفظ ومتابعة» still acts, and a tap
//  into another field moves the cursor there without closing the keyboard.
//

import SwiftUI
import UIKit

final class KeyboardDismisser: NSObject, UIGestureRecognizerDelegate {
  static let shared = KeyboardDismisser()
  private static let recognizerName = "ai.facetype.keyboard-dismiss"

  func install(on window: UIWindow) {
    if (window.gestureRecognizers ?? []).contains(where: { $0.name == Self.recognizerName }) { return }
    let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
    tap.name = Self.recognizerName
    tap.cancelsTouchesInView = false
    tap.delaysTouchesBegan = false
    tap.delaysTouchesEnded = false
    tap.delegate = self
    window.addGestureRecognizer(tap)
  }

  @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
    recognizer.view?.endEditing(true)
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                         shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

  /// Touches inside a text field or text view (the search field included) keep the keyboard.
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    var view = touch.view
    while let current = view {
      if current is UITextField || current is UITextView { return false }
      view = current.superview
    }
    return true
  }
}

/// The windows that show the app (never the keyboard's), and the interface direction applied to them.
///
/// SwiftUI lists and forms are hosted in UIKit cells that take their direction from the trait collection, which
/// follows the phone's language — not from the SwiftUI environment. English chosen on an Arabic phone was drawn
/// right to left inside every Form (CI test `testLayoutFollowsTheAppLanguage`, 2026-11-25). Overriding the
/// window's layout-direction trait makes UIKit agree with the chosen language at once (iOS 17+); the app's own
/// `AppleLanguages` (AppModel.applyUIKitDirection) makes the next launch agree from the start on every iOS.
@MainActor
enum AppWindows {
  private static let windows = NSHashTable<UIWindow>.weakObjects()

  static func register(_ window: UIWindow) {
    windows.add(window)
    apply(L10n.lang, to: window)
  }

  static func applyDirection(_ language: Lang) {
    for window in windows.allObjects { apply(language, to: window) }
  }

  private static func apply(_ language: Lang, to window: UIWindow) {
    if #available(iOS 17.0, *) {
      window.traitOverrides.layoutDirection = language.isRTL ? .rightToLeft : .leftToRight
    }
  }
}

/// Placed behind the root view: registers the window that shows the app (direction) and installs the
/// keyboard-dismiss recognizer on it.
struct AppWindowHook: UIViewRepresentable {
  func makeUIView(context: Context) -> HookView {
    let view = HookView()
    view.isUserInteractionEnabled = false
    return view
  }

  func updateUIView(_ uiView: HookView, context: Context) {}

  final class HookView: UIView {
    override func didMoveToWindow() {
      super.didMoveToWindow()
      guard let window else { return }
      AppWindows.register(window)
      KeyboardDismisser.shared.install(on: window)
    }
  }
}
