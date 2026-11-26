//
//  ProfileSetupView.swift
//  Screen 2 — «بياناتك», shown once after the first sign-in. A native grouped Form: text fields, segmented
//  pickers for document type and sex, and rows that open a window (sheet) for the birth date and for each
//  country. Owner decisions of 2026-11-26: the agreement is a ticked box under a «الشروط والأحكام» link
//  (docs/client-terms-v1-ar.md), and the box and «حفظ ومتابعة» stay pinned at the bottom of the screen, always
//  in view except while the keyboard is up (a tap outside a field closes it). The birth-date window closes with «تم» (or a tap outside it); a country window closes when a country
//  is chosen. Any refusal is shown at the top of the form and the form scrolls to the first field in error.
//

import SwiftUI
import UIKit

/// The windows this screen opens; one at a time.
enum SetupSheet: String, Identifiable {
  case birthDate, idCountry, nationality, terms
  var id: String { rawValue }
}

struct ProfileSetupView: View {
  @EnvironmentObject private var model: AppModel
  @State private var sheet: SetupSheet?
  @State private var draftDate = DateWheel.wheelStart()
  /// The bar steps aside while the keyboard is up: with both on screen the form could not scroll its last rows
  /// clear of the bar, and a tap on the nationality row landed on the terms link (UI test 2026-11-26).
  @State private var keyboardShown = false

  private func error(_ field: ProfileField) -> String? {
    if field == .id_number, model.setupError == .identifierTaken {
      return s("setup.id_taken", ["contact": AppConfig.supportContact ?? s("setup.support_unconfigured")])
    }
    return model.formErrors[field].map { s($0) }
  }

  private var topError: String? {
    switch model.setupError {
    case .network: return s("common.network")
    case .consentFailed: return s("setup.saved_profile_consent_failed")
    case .identifierTaken: return s("apierr.id_taken")
    case .other(let code):
      return Messages.apiErrorKey(code: code, kind: ClientErrorKind(rawValue: code)).map { s($0) }
        ?? s("common.unexpected", ["code": code])
    case nil: return model.formErrors.isEmpty ? nil : s("setup.fix_fields")
    }
  }

  var body: some View {
    NavigationStack {
      ScrollViewReader { proxy in
        Form {
          if let topError {
            Section {
              Label(topError, systemImage: "exclamationmark.circle.fill")
                .foregroundStyle(.red)
                .accessibilityAddTraits(.updatesFrequently)
            }
            .id("top")
          }

          Section {
            HintedTextField(title: s("setup.full_name"), identifier: "field.full_name", text: $model.form.full_name)
              .textContentType(.name)
              .autocorrectionDisabled()
          } header: {
            VStack(alignment: .leading, spacing: 12) {
              Text(s("setup.intro")).font(.footnote).textCase(nil)
                .accessibilityIdentifier("setup.intro")
              Text(s("setup.full_name")).accessibilityIdentifier("header.full_name")
            }
          } footer: {
            FieldError(text: error(.full_name))
          }
          .id(ProfileField.full_name)

          Section {
            ChoiceRow(
              title: s("setup.id_country"), identifier: "field.id_issuing_country",
              value: model.form.id_issuing_country.isEmpty ? nil : Countries.name(model.form.id_issuing_country),
              placeholder: s("picker.choose_country")
            ) { sheet = .idCountry }
            .id(ProfileField.id_issuing_country)
            Picker(s("setup.id_type"), selection: $model.form.id_document_type) {
              Text(s("doc.national_id")).tag(IdDocumentType?.some(.national_id))
              Text(s("doc.residence_id")).tag(IdDocumentType?.some(.residence_id))
              Text(s("doc.passport")).tag(IdDocumentType?.some(.passport))
            }
            .pickerStyle(.segmented)
            .id(ProfileField.id_document_type)
            HintedTextField(title: s("setup.id_number"), identifier: "field.id_number", text: $model.form.id_number)
              .keyboardType(.asciiCapable)
              .textInputAutocapitalization(.characters)
              .autocorrectionDisabled()
              .id(ProfileField.id_number)
          } header: {
            Text(s("setup.id_type"))
          } footer: {
            VStack(alignment: .leading, spacing: 4) {
              FieldError(text: error(.id_issuing_country))
              FieldError(text: error(.id_document_type))
              FieldError(text: error(.id_number))
            }
          }

          Section {
            HintedTextField(title: s("setup.phone"), identifier: "field.phone", text: $model.form.phone)
              .keyboardType(.phonePad)
              .textContentType(.telephoneNumber)
          } header: {
            Text(s("setup.phone"))
          } footer: {
            VStack(alignment: .leading, spacing: 4) {
              Text(s("setup.phone_hint"))
              FieldError(text: error(.phone))
            }
          }
          .id(ProfileField.phone)

          Section {
            Picker(s("setup.sex"), selection: $model.form.sex) {
              Text(s("sex.male")).tag(Sex?.some(.male))
              Text(s("sex.female")).tag(Sex?.some(.female))
            }
            .pickerStyle(.segmented)
          } header: {
            Text(s("setup.sex"))
          } footer: {
            FieldError(text: error(.sex))
          }
          .id(ProfileField.sex)

          Section {
            ChoiceRow(
              title: s("setup.birth_date"), identifier: "field.birth_date",
              value: model.form.birth_date.isEmpty ? nil : DateWheel.formatBirthDate(model.form.birth_date),
              placeholder: s("picker.choose_date")
            ) {
              draftDate = DateWheel.date(fromIso: model.form.birth_date) ?? DateWheel.wheelStart()
              sheet = .birthDate
            }
          } footer: {
            FieldError(text: error(.birth_date))
          }
          .id(ProfileField.birth_date)

          Section {
            ChoiceRow(
              title: s("setup.nationality"), identifier: "field.nationality",
              value: model.form.nationality.isEmpty ? nil : Countries.name(model.form.nationality),
              placeholder: s("picker.choose_country")
            ) { sheet = .nationality }
          } footer: {
            FieldError(text: error(.nationality))
          }
          .id(ProfileField.nationality)
        }
        // Dragging the form down also closes the keyboard (a tap outside a field closes it too: KeyboardDismiss).
        .scrollDismissesKeyboard(.interactively)
        // Pinned under the form, never scrolled away: the terms box and «حفظ ومتابعة» (owner 2026-11-26: the
        // button sat partly below the bottom of the screen).
        .safeAreaInset(edge: .bottom, spacing: 0) {
          if !keyboardShown {
            SaveBar(showTerms: { sheet = .terms }) { save(proxy) }
          }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
          keyboardShown = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
          keyboardShown = false
        }
        .navigationTitle(s("setup.title"))
        .toolbar { ToolbarItem(placement: .navigationBarTrailing) { LanguageToggle() } }
        .sheet(item: $sheet) { which in
          sheetContent(which)
            .modifier(LanguageDirection(language: model.language))
            .environment(\.locale, Locale(identifier: model.language == .ar ? "ar@numbers=latn" : "en"))
        }
      }
    }
  }

  private func save(_ proxy: ScrollViewProxy) {
    Task {
      let first = await model.saveProfile()
      withAnimation {
        if let first {
          proxy.scrollTo(first, anchor: .top)
        } else if model.setupError != nil {
          proxy.scrollTo("top", anchor: .top)
        }
      }
    }
  }

  @ViewBuilder
  private func sheetContent(_ which: SetupSheet) -> some View {
    switch which {
    case .birthDate:
      BirthDateSheet(date: $draftDate, range: birthRange) { model.form.birth_date = DateWheel.iso(from: draftDate) }
    case .idCountry:
      NavigationStack { CountryPickerView(title: s("setup.id_country"), code: $model.form.id_issuing_country) }
    case .nationality:
      NavigationStack { CountryPickerView(title: s("setup.nationality"), code: $model.form.nationality) }
    case .terms:
      TermsView {
        model.termsAccepted = true
        model.termsMissing = false
      }
    }
  }

  private var birthRange: ClosedRange<Date> {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let start = calendar.date(from: DateComponents(year: DateWheel.firstYear, month: 1, day: 1))!
    return start...Date()
  }
}

/// The bar pinned at the bottom of «بياناتك»: the terms box (until an agreement is on record) and the save button.
struct SaveBar: View {
  @EnvironmentObject private var model: AppModel
  let showTerms: () -> Void
  let save: () -> Void

  private var agreeText: String { s("terms.agree", ["link": s("terms.link")]) }

  /// The words around «الشروط والأحكام» in «أوافق على {link}» (English: "I agree to the {link}").
  private var agreeParts: (before: String, after: String) {
    let parts = s("terms.agree").components(separatedBy: "{link}")
    let trim = { (text: String) in text.trimmingCharacters(in: .whitespaces) }
    return (trim(parts.first ?? ""), parts.count > 1 ? trim(parts[1]) : "")
  }

  private func toggle() {
    model.termsAccepted.toggle()
    if model.termsAccepted { model.termsMissing = false }
  }

  var body: some View {
    VStack(spacing: 8) {
      if model.needsConsent {
        // The box and «أوافق على» tick; «الشروط والأحكام» is a button of its own that opens the terms (a link inside
        // one Text could not be tapped reliably: UI test 2026-11-26).
        HStack(spacing: 4) {
          Button(action: toggle) {
            Image(systemName: model.termsAccepted ? "checkmark.square.fill" : "square")
              .font(.title2)
              .foregroundStyle(model.termsMissing ? Color.red : Color.accentColor)
              .frame(width: 44, height: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("terms.checkbox")
          .accessibilityLabel(agreeText)
          .accessibilityValue(model.termsAccepted ? "1" : "0")
          .accessibilityAddTraits(model.termsAccepted ? [.isSelected] : [])

          if !agreeParts.before.isEmpty {
            Button(action: toggle) { Text(agreeParts.before).foregroundStyle(.primary) }
              .buttonStyle(.plain)
              .accessibilityHidden(true)
          }
          Button(action: showTerms) { Text(s("terms.link")).underline().foregroundStyle(Color.accentColor) }
            .buttonStyle(.plain)
            .accessibilityIdentifier("terms.link")
          if !agreeParts.after.isEmpty {
            Text(agreeParts.after)
          }
          Spacer(minLength: 0)
        }
        .font(.subheadline)
        .lineLimit(2)
        if model.termsMissing {
          Text(s("terms.required"))
            .font(.footnote)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("terms.required")
        }
      }
      Button(action: save) {
        HStack {
          Spacer()
          if model.saving { ProgressView() } else { Text(s("setup.save")).bold() }
          Spacer()
        }
        .frame(minHeight: 44)
      }
      .buttonStyle(.borderedProminent)
      .disabled(model.saving)
      .accessibilityIdentifier("setup.save")
    }
    .padding(.horizontal)
    .padding(.top, 6)
    .padding(.bottom, 8)
    .background(.bar)
    .overlay(alignment: .top) { Divider() }
  }
}

/// A form row that opens a window: the title, then the chosen value (or a grey prompt) on the far side.
struct ChoiceRow: View {
  let title: String
  let identifier: String
  let value: String?
  let placeholder: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack {
        Text(title).foregroundStyle(.primary)
        Spacer()
        Text(value ?? placeholder)
          .foregroundStyle(value == nil ? .secondary : .primary)
          .multilineTextAlignment(.trailing)
        Image(systemName: "chevron.forward")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(.tertiary)
      }
      .contentShape(Rectangle())
    }
    // The default Form button style tints the whole label blue (CI screenshot 2026-11-26); plain keeps the title
    // black and the prompt grey, as in the system's own forms.
    .buttonStyle(.plain)
    .accessibilityIdentifier(identifier)
  }
}

/// The birth-date window: the system date wheels and «تم». Every turn of a wheel is kept, so a swipe down or a tap
/// outside the window also keeps the date shown; «تم» keeps it even when no wheel was turned.
struct BirthDateSheet: View {
  @Binding var date: Date
  let range: ClosedRange<Date>
  let commit: () -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      VStack {
        DatePicker("", selection: $date, in: range, displayedComponents: .date)
          .datePickerStyle(.wheel)
          .labelsHidden()
          .environment(\.timeZone, TimeZone(identifier: "UTC")!)
          // Gregorian whatever the phone's calendar: on a Saudi-region phone the wheels showed the Hijri year
          // (1416 Sha'ban) while the row, the server and validation use the Gregorian date (CI 2026-11-26).
          .environment(\.calendar, {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: "UTC")!
            return calendar
          }())
          .onChange(of: date) { _ in commit() }
          .accessibilityIdentifier("date.wheels")
        Spacer(minLength: 0)
      }
      .frame(maxWidth: .infinity)
      .navigationTitle(s("setup.birth_date"))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button {
            commit()
            dismiss()
          } label: {
            Text(s("picker.done")).bold()
          }
          .accessibilityIdentifier("date.done")
        }
      }
    }
    .presentationDetents([.medium])
    .presentationDragIndicator(.visible)
  }
}

/// The terms and conditions (docs/client-terms-v1-ar.md), with «أوافق» at the bottom (ticks the box and closes)
/// and «إغلاق» at the top.
struct TermsView: View {
  /// Seven titled sections: `terms.1.title` … `terms.7.body` (checked against the strings fixture).
  static let sectionCount = 7
  let accept: () -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Text(s("terms.intro"))
          ForEach(1...Self.sectionCount, id: \.self) { i in
            VStack(alignment: .leading, spacing: 6) {
              Text(s("terms.\(i).title")).font(.headline)
              Text(s("terms.\(i).body"))
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .multilineTextAlignment(.leading)
        .padding()
      }
      .accessibilityIdentifier("terms.sheet")
      .navigationTitle(s("terms.title"))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(s("terms.close")) { dismiss() }
            .accessibilityIdentifier("terms.close")
        }
      }
      .safeAreaInset(edge: .bottom, spacing: 0) {
        Button {
          accept()
          dismiss()
        } label: {
          Text(s("terms.accept")).bold().frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
        .accessibilityIdentifier("terms.accept")
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
      }
    }
  }
}

/// A text field whose empty-state hint sits on the reading side of the chosen language. UIKit places the system
/// placeholder by the phone's language (CI screenshots 2026-11-25: after an in-app switch to English on an Arabic
/// phone the hint stayed on the right until the next launch); a SwiftUI hint follows the app's direction.
/// Keyboard type, content type and autocorrection set on this view reach the inner field through the environment.
struct HintedTextField: View {
  let title: String
  let identifier: String
  @Binding var text: String

  var body: some View {
    ZStack(alignment: .leading) {
      if text.isEmpty {
        Text(title)
          .foregroundStyle(Color(uiColor: .placeholderText))
          .lineLimit(1)
          .accessibilityHidden(true)
          .allowsHitTesting(false)
      }
      TextField("", text: $text)
        .accessibilityLabel(title)
        .accessibilityIdentifier(identifier)
    }
  }
}

struct FieldError: View {
  let text: String?
  var body: some View {
    if let text { Text(text).foregroundStyle(.red) }
  }
}

/// The searchable country list, shown in its own window; choosing a country closes it.
struct CountryPickerView: View {
  let title: String
  @Binding var code: String
  @State private var query = ""
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    let list = Countries.filter(query)
    List {
      if list.isEmpty {
        Text(s("picker.no_country")).foregroundStyle(.secondary)
      }
      ForEach(list) { country in
        Button {
          code = country.code
          dismiss()
        } label: {
          HStack {
            Text(country.name).foregroundStyle(.primary)
            Spacer()
            if country.code == code { Image(systemName: "checkmark").foregroundStyle(.tint) }
          }
          .contentShape(Rectangle())
        }
        .accessibilityIdentifier("country.\(country.code)")
      }
    }
    .listStyle(.plain)
    .scrollDismissesKeyboard(.immediately)
    .navigationTitle(title)
    .navigationBarTitleDisplayMode(.inline)
    .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: s("setup.country_search"))
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button(s("common.cancel")) { dismiss() }
          .accessibilityIdentifier("country.cancel")
      }
    }
  }
}
