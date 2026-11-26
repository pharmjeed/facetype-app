//
//  ProfileScreen.swift
//  After sign-in: three pages in a tab bar (owner request 2026-11-26):
//   - «معلوماتي»: the person's own details (unmasked, owner decision 2026-11-24), then the account: sign out, and
//     delete the account and its data (owner 2026-11-26);
//   - «التصوير»: the capture status, and the button that opens the camera. It is offered again after complete
//     photos (build 12, owner 2026-11-26 «ارجع الكاميرا لي لنجرب عليها»), labelled «تصوير جديد»; never while a
//     burst is still on its way. There is no repeat invitation;
//   - «ملفي»: the person's profile. Today it shows who the person is and the personality block, which always reads
//     «النتيجة غير متاحة بعد»: there is no validated model, so there is nothing else it could truthfully say.
//  Refresh: pull to refresh, or the toolbar button on «التصوير» and «ملفي».
//

import SwiftUI

enum ProfileStatus {
  /// The capture status line: the local spool wins while it is still working (port of captureStatusKey).
  static func key(me: ClientMe, spool: SpoolOutcome) -> String {
    if spool.kind == .waiting || spool.kind == .terminal, let stage = spool.manifest?.stage, !stage.isTerminal {
      if spool.kind == .waiting && spool.reason == .offline { return "status.queued_offline" }
      return stage == .checking || stage == .finalizing ? "status.checking" : "status.uploading"
    }
    guard let latest = me.captures?.latest_status, (me.captures?.count ?? 0) > 0 else { return "status.none" }
    return CaptureStatus(rawValue: latest).map { "status.\($0.rawValue)" } ?? "status.unknown"
  }

  /// The camera is offered unless a burst is still on its way (uploading, waiting offline, or with the server).
  /// Build 11 also withheld it after complete photos; build 12 offers it again for testing (owner 2026-11-26).
  static func offersCamera(_ statusKey: String) -> Bool {
    !["status.received", "status.uploading", "status.checking", "status.measuring",
      "status.queued_offline"].contains(statusKey)
  }

  /// The photos are done: the camera button then reads «تصوير جديد».
  static func isDone(_ statusKey: String) -> Bool {
    statusKey == "status.complete" || statusKey == "status.stored"
  }

  static func isoDay(_ value: String?) -> String {
    guard let value, value.count >= 10 else { return "" }
    let day = String(value.prefix(10))
    return day.range(of: "^\\d{4}-\\d{2}-\\d{2}$", options: .regularExpression) != nil ? day : ""
  }
}

enum MainTab: String, Hashable {
  case info, capture, profile
}

struct ProfileScreen: View {
  @EnvironmentObject private var model: AppModel

  /// Until the person picks a page: «التصوير» before the first photos, «ملفي» after.
  private var defaultTab: MainTab {
    (model.state.me?.captures?.count ?? 0) == 0 ? .capture : .profile
  }

  var body: some View {
    TabView(selection: Binding(get: { model.mainTab ?? defaultTab }, set: { model.mainTab = $0 })) {
      InfoPage()
        .tabItem { Label(s("tab.info"), systemImage: "person.text.rectangle") }
        .tag(MainTab.info)
      CapturePage()
        .tabItem { Label(s("tab.capture"), systemImage: "camera") }
        .tag(MainTab.capture)
      ProfilePage()
        .tabItem { Label(s("tab.profile"), systemImage: "person.crop.circle") }
        .tag(MainTab.profile)
    }
  }
}

/// The toolbar shared by the three pages: the language switch, and refresh where the page shows server state.
private struct PageToolbar: ViewModifier {
  @EnvironmentObject private var model: AppModel
  let refresh: Bool

  func body(content: Content) -> some View {
    content
      .refreshable { await model.refresh() }
      .toolbar {
        ToolbarItem(placement: .navigationBarTrailing) { LanguageToggle() }
        ToolbarItem(placement: .navigationBarLeading) {
          if refresh {
            Button {
              Task { await model.refresh() }
            } label: {
              if model.refreshing { ProgressView() } else { Image(systemName: "arrow.clockwise") }
            }
            .accessibilityLabel(s("profile.refresh"))
          }
        }
      }
  }
}

/// «معلوماتي»: the details the person saved.
struct InfoPage: View {
  @EnvironmentObject private var model: AppModel

  private func docKey(_ raw: String) -> String {
    IdDocumentType(rawValue: raw).map { "doc.\($0.rawValue)" } ?? raw
  }

  var body: some View {
    NavigationStack {
      List {
        if let p = model.state.me?.profile {
          Section {
            LabeledContent(s("setup.full_name"), value: p.full_name)
            LabeledContent(s("setup.id_type"), value: "\(s(docKey(p.id_document_type))) · \(Countries.name(p.id_issuing_country))")
            LabeledContent(s("setup.id_number"), value: p.id_number)
            LabeledContent(s("setup.phone"), value: p.phone)
            LabeledContent(s("setup.sex"), value: s(p.sex == "female" ? "sex.female" : "sex.male"))
            LabeledContent(s("setup.birth_date"), value: DateWheel.formatBirthDate(p.birth_date))
            if let age = p.age_years { Text(s("profile.age", ["value": age])) }
            LabeledContent(s("setup.nationality"), value: Countries.name(p.nationality))
          }
        }
        AccountSection()
      }
      .listStyle(.insetGrouped)
      .navigationTitle(s("tab.info"))
      .modifier(PageToolbar(refresh: false))
    }
  }
}

/// The account: sign out, and delete the account with everything stored for it (`DELETE /client/me`). Deleting
/// asks first, in a sheet that says what goes and that it cannot be undone.
struct AccountSection: View {
  @EnvironmentObject private var model: AppModel
  @State private var confirmDelete = false

  var body: some View {
    Section {
      Button {
        Task { await model.signOut() }
      } label: {
        Label(s("account.sign_out"), systemImage: "rectangle.portrait.and.arrow.right")
      }
      .accessibilityIdentifier("account.sign_out")
      Button(role: .destructive) {
        confirmDelete = true
      } label: {
        Label(s("account.delete"), systemImage: "trash")
      }
      .tint(.red)  // the icon too, not only the text
      .accessibilityIdentifier("account.delete")
      if model.accountBusy {
        ProgressView().frame(maxWidth: .infinity)
      }
      if let key = model.accountError {
        Text(s(key)).foregroundStyle(.red).accessibilityIdentifier("account.error")
      }
    } header: {
      Text(s("account.title"))
    }
    .disabled(model.accountBusy)
    .confirmationDialog(s("account.delete_title"), isPresented: $confirmDelete, titleVisibility: .visible) {
      Button(s("account.delete_confirm"), role: .destructive) {
        Task { await model.deleteAccount() }
      }
      .accessibilityIdentifier("account.delete_confirm")
      Button(s("common.cancel"), role: .cancel) {}
    } message: {
      Text(s("account.delete_body"))
    }
  }
}

/// «التصوير»: where the photos stand, and the camera.
struct CapturePage: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    NavigationStack {
      List {
        if let me = model.state.me {
          let statusKey = ProfileStatus.key(me: me, spool: model.spool)
          Section {
            Label(s(statusKey), systemImage: "camera.viewfinder")
              .accessibilityIdentifier("capture.status")
            if let captures = me.captures {
              Text(s("profile.capture_count", ["count": captures.count])).foregroundStyle(.secondary)
              if let last = captures.last_at, !ProfileStatus.isoDay(last).isEmpty {
                Text(s("profile.last_capture", ["date": ProfileStatus.isoDay(last)])).foregroundStyle(.secondary)
              }
            }
          }
          if ProfileStatus.offersCamera(statusKey) {
            Section {
              Button {
                model.mainTab = .capture  // back on this page, with its status, when the camera closes
                model.openCapture()
              } label: {
                Label(s(ProfileStatus.isDone(statusKey) ? "capture.again" : "profile.capture"), systemImage: "camera.fill")
                  .frame(maxWidth: .infinity, minHeight: 44)
              }
              .buttonStyle(.borderedProminent)
              .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
              .listRowBackground(Color.clear)
              .accessibilityIdentifier("capture.open")
            }
          }
        }
      }
      .listStyle(.insetGrouped)
      .navigationTitle(s("tab.capture"))
      .modifier(PageToolbar(refresh: true))
    }
  }
}

/// «ملفي»: who the person is, and the personality result, which stays unavailable until a model passes its gates.
struct ProfilePage: View {
  @EnvironmentObject private var model: AppModel

  private var summary: String {
    guard let p = model.state.me?.profile else { return "" }
    var parts: [String] = []
    if let age = p.age_years { parts.append(s("profile.summary_age", ["value": age])) }
    parts.append(s(p.sex == "female" ? "sex.female" : "sex.male"))
    parts.append(Countries.name(p.nationality))
    return parts.joined(separator: " · ")
  }

  var body: some View {
    NavigationStack {
      List {
        if let p = model.state.me?.profile {
          Section {
            HStack(spacing: 14) {
              Image(systemName: "person.crop.circle.fill")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
              VStack(alignment: .leading, spacing: 4) {
                Text(p.full_name).font(.title3.weight(.semibold))
                Text(summary).font(.subheadline).foregroundStyle(.secondary)
              }
            }
            .padding(.vertical, 6)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("profile.header")
          }
        }
        Section {
          Text(s("profile.personality_unavailable")).font(.headline)
            .accessibilityIdentifier("profile.personality")
          Text(s("profile.personality_note")).font(.footnote).foregroundStyle(.secondary)
        } header: {
          Text(s("profile.personality_title"))
        }
      }
      .listStyle(.insetGrouped)
      .navigationTitle(s("tab.profile"))
      .modifier(PageToolbar(refresh: true))
    }
  }
}

extension ISO8601DateFormatter {
  static func lenient(_ text: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: text) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: text)
  }
}
