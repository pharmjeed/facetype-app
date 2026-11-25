//
//  ProfileView.swift
//  Screen 3 — «ملفي». The person's own details (unmasked, owner decision 2026-11-24), the capture status, the
//  optional repeat, and the personality block, which always reads «النتيجة غير متاحة بعد»: there is no validated
//  model, so there is nothing else it could truthfully say. Actions: take photos, refresh (pull or toolbar).
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

  static func isoDay(_ value: String?) -> String {
    guard let value, value.count >= 10 else { return "" }
    let day = String(value.prefix(10))
    return day.range(of: "^\\d{4}-\\d{2}-\\d{2}$", options: .regularExpression) != nil ? day : ""
  }
}

struct ProfileScreen: View {
  @EnvironmentObject private var model: AppModel

  private func docKey(_ raw: String) -> String {
    IdDocumentType(rawValue: raw).map { "doc.\($0.rawValue)" } ?? raw
  }

  var body: some View {
    NavigationStack {
      List {
        if let me = model.state.me {
          if let p = me.profile {
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

          Section {
            Label(s(ProfileStatus.key(me: me, spool: model.spool)), systemImage: "camera.viewfinder")
            if let captures = me.captures {
              Text(s("profile.capture_count", ["count": captures.count])).foregroundStyle(.secondary)
              if let last = captures.last_at, !ProfileStatus.isoDay(last).isEmpty {
                Text(s("profile.last_capture", ["date": ProfileStatus.isoDay(last)])).foregroundStyle(.secondary)
              }
              if let due = captures.next_repeat_due_at, let dueDate = ISO8601DateFormatter.lenient(due) {
                Text(dueDate <= Date() ? s("profile.repeat_now") : s("profile.repeat_due", ["date": ProfileStatus.isoDay(due)]))
                  .font(.footnote)
              }
            }
            Button {
              model.openCapture()
            } label: {
              Label(s("profile.capture"), systemImage: "camera.fill").frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
            .listRowBackground(Color.clear)
          } header: {
            Text(s("profile.capture_title"))
          }

          Section {
            Text(s("profile.personality_unavailable")).font(.headline)
            Text(s("profile.personality_note")).font(.footnote).foregroundStyle(.secondary)
          } header: {
            Text(s("profile.personality_title"))
          }
        }
      }
      .listStyle(.insetGrouped)
      .navigationTitle(s("profile.title"))
      .refreshable { await model.refresh() }
      .toolbar {
        ToolbarItem(placement: .navigationBarTrailing) { LanguageToggle() }
        ToolbarItem(placement: .navigationBarLeading) {
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

extension ISO8601DateFormatter {
  static func lenient(_ text: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: text) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: text)
  }
}
