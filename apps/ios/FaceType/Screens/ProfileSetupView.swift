//
//  ProfileSetupView.swift
//  Screen 2 — «بياناتك», shown once after the first sign-in. A native grouped Form: text fields, segmented
//  pickers for document type and sex, the system wheel date picker, and a searchable country list. Pressing
//  «حفظ ومتابعة» under the one notice line is the agreement (owner decision 2026-11-24). Any refusal is shown at
//  the top of the form and the form scrolls to the first field in error.
//

import SwiftUI

struct ProfileSetupView: View {
  @EnvironmentObject private var model: AppModel
  @State private var showDatePicker = false
  @State private var draftDate = DateWheel.wheelStart()

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
            TextField(s("setup.full_name"), text: $model.form.full_name)
              .accessibilityIdentifier("field.full_name")
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
            CountryRow(title: s("setup.id_country"), code: $model.form.id_issuing_country)
              .id(ProfileField.id_issuing_country)
            Picker(s("setup.id_type"), selection: $model.form.id_document_type) {
              Text(s("doc.national_id")).tag(IdDocumentType?.some(.national_id))
              Text(s("doc.residence_id")).tag(IdDocumentType?.some(.residence_id))
              Text(s("doc.passport")).tag(IdDocumentType?.some(.passport))
            }
            .pickerStyle(.segmented)
            .id(ProfileField.id_document_type)
            TextField(s("setup.id_number"), text: $model.form.id_number)
              .accessibilityIdentifier("field.id_number")
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
            TextField(s("setup.phone"), text: $model.form.phone)
              .accessibilityIdentifier("field.phone")
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
            Button {
              if !showDatePicker { draftDate = DateWheel.date(fromIso: model.form.birth_date) ?? DateWheel.wheelStart() }
              withAnimation { showDatePicker.toggle() }
            } label: {
              HStack {
                Text(s("setup.birth_date")).foregroundStyle(.primary)
                Spacer()
                Text(model.form.birth_date.isEmpty
                  ? s("picker.choose_date") : DateWheel.formatBirthDate(model.form.birth_date))
                  .foregroundStyle(model.form.birth_date.isEmpty ? .secondary : .primary)
              }
            }
            if showDatePicker {
              DatePicker("", selection: $draftDate, in: birthRange, displayedComponents: .date)
                .datePickerStyle(.wheel)
                .labelsHidden()
                .environment(\.timeZone, TimeZone(identifier: "UTC")!)
                .onChange(of: draftDate) { date in model.form.birth_date = DateWheel.iso(from: date) }
            }
          } footer: {
            FieldError(text: error(.birth_date))
          }
          .id(ProfileField.birth_date)

          Section {
            CountryRow(title: s("setup.nationality"), code: $model.form.nationality)
          } footer: {
            FieldError(text: error(.nationality))
          }
          .id(ProfileField.nationality)

          Section {
            Text(s("setup.unverified_note")).font(.footnote).foregroundStyle(.secondary)
            Text(s("consent.notice")).font(.callout)
            Button {
              Task {
                let first = await model.saveProfile()
                withAnimation {
                  if model.setupError != nil || first == nil { proxy.scrollTo("top", anchor: .top) }
                  if let first { proxy.scrollTo(first, anchor: .top) }
                }
              }
            } label: {
              HStack {
                Spacer()
                if model.saving { ProgressView() } else { Text(s("setup.save")).bold() }
                Spacer()
              }
              .frame(minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.saving)
            .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
            .listRowBackground(Color.clear)
          }
        }
        // Dragging the form down also closes the keyboard (a tap outside a field closes it too: KeyboardDismiss).
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(s("setup.title"))
        .toolbar { ToolbarItem(placement: .navigationBarTrailing) { LanguageToggle() } }
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

struct FieldError: View {
  let text: String?
  var body: some View {
    if let text { Text(text).foregroundStyle(.red) }
  }
}

/// A row that opens the searchable country list; shows the chosen country's name in the interface language.
struct CountryRow: View {
  let title: String
  @Binding var code: String

  var body: some View {
    NavigationLink {
      CountryPickerView(title: title, code: $code)
    } label: {
      HStack {
        Text(title)
        Spacer()
        Text(code.isEmpty ? s("picker.choose_country") : Countries.name(code))
          .foregroundStyle(code.isEmpty ? .secondary : .primary)
      }
    }
  }
}

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
        }
      }
    }
    .scrollDismissesKeyboard(.immediately)
    .navigationTitle(title)
    .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: s("setup.country_search"))
  }
}
