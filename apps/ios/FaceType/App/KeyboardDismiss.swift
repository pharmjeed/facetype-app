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

/// Placed behind the root view; installs the recognizer on the window that shows the app.
struct KeyboardDismissInstaller: UIViewRepresentable {
  func makeUIView(context: Context) -> InstallerView {
    let view = InstallerView()
    view.isUserInteractionEnabled = false
    return view
  }

  func updateUIView(_ uiView: InstallerView, context: Context) {}

  final class InstallerView: UIView {
    override func didMoveToWindow() {
      super.didMoveToWindow()
      if let window { KeyboardDismisser.shared.install(on: window) }
    }
  }
}
