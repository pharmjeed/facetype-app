//
//  LatinTextField.swift
//  The document-number and phone fields. They hold Latin letters and digits only, so they are written left to
//  right in both languages and placed on the reading side: right in Arabic, left in English.
//
//  Owner report 2026-11-26 (iPhone, Arabic): typed digits did not show in these two fields while typing. The
//  SwiftUI field left its writing direction to the content, and a number has no direction of its own. Here the
//  UIKit field is told both: left to right, aligned to the reading side. CI test
//  `testTypedTextShowsWhileTyping` measures the typed text on screen while the keyboard is up.
//

import SwiftUI
import UIKit

struct LatinTextField: UIViewRepresentable {
  let placeholder: String
  let identifier: String
  @Binding var text: String
  var keyboard: UIKeyboardType = .asciiCapable
  var contentType: UITextContentType? = nil
  var capitalization: UITextAutocapitalizationType = .none

  func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

  func makeUIView(context: Context) -> UITextField {
    let field = UITextField()
    field.semanticContentAttribute = .forceLeftToRight
    field.font = .preferredFont(forTextStyle: .body)
    field.adjustsFontForContentSizeCategory = true
    field.textColor = .label
    field.autocorrectionType = .no
    field.spellCheckingType = .no
    field.smartQuotesType = .no
    field.smartDashesType = .no
    field.setContentHuggingPriority(.defaultLow, for: .horizontal)
    field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
    field.delegate = context.coordinator
    return field
  }

  func updateUIView(_ field: UITextField, context: Context) {
    context.coordinator.text = $text
    if field.text != text { field.text = text }
    // The language switch rebuilds the screen, so the reading side is read again then.
    let alignment: NSTextAlignment = L10n.lang.isRTL ? .right : .left
    field.textAlignment = alignment
    let style = NSMutableParagraphStyle()
    style.alignment = alignment
    field.attributedPlaceholder = NSAttributedString(
      string: placeholder, attributes: [.foregroundColor: UIColor.placeholderText, .paragraphStyle: style])
    if field.keyboardType != keyboard { field.keyboardType = keyboard }
    field.textContentType = contentType
    field.autocapitalizationType = capitalization
    field.accessibilityIdentifier = identifier
    field.accessibilityLabel = placeholder
  }

  /// As wide as the row offers, as tall as one line of text.
  func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextField, context: Context) -> CGSize? {
    CGSize(width: proposal.width ?? uiView.intrinsicContentSize.width, height: uiView.intrinsicContentSize.height)
  }

  final class Coordinator: NSObject, UITextFieldDelegate {
    var text: Binding<String>

    init(text: Binding<String>) { self.text = text }

    @objc func changed(_ field: UITextField) { text.wrappedValue = field.text ?? "" }

    /// The return key closes the keyboard (the phone pad has none; a tap outside closes it).
    func textFieldShouldReturn(_ field: UITextField) -> Bool {
      field.resignFirstResponder()
      return true
    }
  }
}
