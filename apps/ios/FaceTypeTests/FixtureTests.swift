//
//  FixtureTests.swift
//  The native port must behave exactly like the TypeScript client it replaces. Every case here is read from
//  docs/fixtures/client/*.json, exported from that TypeScript (apps/mobile/scripts/export-native-fixtures.ts).
//

import XCTest

@testable import FaceType_AI

final class FixtureTests: XCTestCase {
  private func fixture(_ name: String) throws -> [String: Any] {
    let bundle = Bundle(for: FixtureTests.self)
    let url = try XCTUnwrap(
      bundle.url(forResource: name, withExtension: "json", subdirectory: "client")
        ?? bundle.url(forResource: name, withExtension: "json"),
      "fixture \(name).json is not in the test bundle")
    return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
  }

  private let today: Date = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar.date(from: DateComponents(year: 2026, month: 11, day: 25, hour: 12))!
  }()

  private func expect(_ checked: Checked<String>, _ c: [String: Any], _ label: String) {
    if c["ok"] as? Bool == true {
      XCTAssertEqual(checked.value, c["value"] as? String, label)
    } else {
      XCTAssertEqual(checked.errorKey, c["error"] as? String, label)
    }
  }

  // MARK: strings

  func testEveryStringKeyExistsInBothLanguages() throws {
    let f = try fixture("strings")
    let keys = try XCTUnwrap(f["keys"] as? [String])
    for lang in Lang.allCases {
      let table = try XCTUnwrap(f[lang.rawValue] as? [String: String])
      for key in keys {
        XCTAssertEqual(L10n.s(key, language: lang), table[key], "\(lang.rawValue) \(key)")
      }
    }
    XCTAssertEqual(L10n.fill("{done} of {total}", ["done": 3, "total": 10]), "3 of 10")
    XCTAssertEqual(L10n.fill("{missing}", [:]), "{missing}")
  }

  /// The agreement records the version of the terms the person saw, in the language they saw them; the terms
  /// window shows every section of docs/client-terms-v1-ar.md and no more.
  @MainActor
  func testTermsVersionAndSections() throws {
    let f = try fixture("strings")
    let versions = try XCTUnwrap(f["terms_versions"] as? [String: String])
    for lang in Lang.allCases {
      XCTAssertEqual(AppModel.consentVersions[lang], versions[lang.rawValue], lang.rawValue)
    }
    let keys = try XCTUnwrap(f["keys"] as? [String])
    let titles = keys.filter { $0.hasPrefix("terms.") && $0.hasSuffix(".title") && $0 != "terms.title" }
    XCTAssertEqual(titles.count, TermsView.sectionCount)
    for i in 1...TermsView.sectionCount {
      XCTAssertTrue(keys.contains("terms.\(i).title") && keys.contains("terms.\(i).body"), "section \(i)")
    }
  }

  // MARK: countries

  func testCountriesOrderAndSearch() throws {
    let f = try fixture("countries")
    XCTAssertEqual(Countries.all(.ar).map(\.code), f["order_ar"] as? [String])
    XCTAssertEqual(Countries.all(.en).map(\.code), f["order_en"] as? [String])
    for c in try XCTUnwrap(f["search"] as? [[String: Any]]) {
      let lang = Lang(rawValue: c["lang"] as! String)!
      let query = c["query"] as! String
      XCTAssertEqual(Countries.search(query, language: lang).map(\.code), c["search8"] as? [String], "search \(lang) '\(query)'")
      XCTAssertEqual(Countries.filter(query, language: lang).map(\.code), c["filter"] as? [String], "filter \(lang) '\(query)'")
    }
  }

  // MARK: validation

  func testValidation() throws {
    let f = try fixture("validation")
    for c in try XCTUnwrap(f["full_name"] as? [[String: Any]]) {
      expect(Validation.checkFullName(c["input"] as! String), c, "name \(c["input"]!)")
    }
    for c in try XCTUnwrap(f["id_number"] as? [[String: Any]]) {
      let type = (c["type"] as? String).flatMap(IdDocumentType.init(rawValue:)) ?? .passport
      expect(Validation.checkIdNumber(country: c["country"] as! String, type: type, c["input"] as! String), c,
             "id \(c["input"]!)")
    }
    for c in try XCTUnwrap(f["phone"] as? [[String: Any]]) {
      expect(Validation.checkPhone(c["input"] as! String), c, "phone \(c["input"]!)")
    }
    for c in try XCTUnwrap(f["birth_date"] as? [[String: Any]]) {
      expect(Validation.checkBirthDate(c["input"] as! String, today: today), c, "birth \(c["input"]!)")
    }
    for c in try XCTUnwrap(f["country"] as? [[String: Any]]) {
      expect(Validation.checkCountry(c["input"] as! String), c, "country \(c["input"]!)")
    }
    for c in try XCTUnwrap(f["luhn"] as? [[String: Any]]) {
      XCTAssertEqual(Validation.luhnValid(c["input"] as! String), c["valid"] as? Bool)
    }
    for c in try XCTUnwrap(f["profile"] as? [[String: Any]]) {
      let form = c["form"] as! [String: Any]
      let value = ProfileForm(
        full_name: form["full_name"] as? String ?? "", id_issuing_country: form["id_issuing_country"] as? String ?? "",
        id_document_type: (form["id_document_type"] as? String).flatMap(IdDocumentType.init(rawValue:)),
        id_number: form["id_number"] as? String ?? "", phone: form["phone"] as? String ?? "",
        sex: (form["sex"] as? String).flatMap(Sex.init(rawValue:)), birth_date: form["birth_date"] as? String ?? "",
        nationality: form["nationality"] as? String ?? "")
      switch Validation.validateProfile(value, today: today) {
      case .success(let ok):
        XCTAssertEqual(c["ok"] as? Bool, true)
        let expected = c["value"] as! [String: String]
        XCTAssertEqual(ok.phone, expected["phone"])
        XCTAssertEqual(ok.id_number, expected["id_number"])
        XCTAssertEqual(ok.birth_date, expected["birth_date"])
      case .failure(let errors):
        XCTAssertEqual(c["ok"] as? Bool, false)
        let expected = c["errors"] as! [String: String]
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: errors.fields.map { ($0.key.rawValue, $0.value) }), expected)
      }
    }
  }

  func testDates() throws {
    let f = try fixture("dates")
    XCTAssertEqual(DateWheel.arabicMonths, f["months_ar"] as? [String])
    XCTAssertEqual(DateWheel.englishMonths, f["months_en"] as? [String])
    for c in try XCTUnwrap(f["format_birth_date"] as? [[String: Any]]) {
      let lang = Lang(rawValue: c["lang"] as? String ?? "ar")!
      XCTAssertEqual(DateWheel.formatBirthDate(c["input"] as! String, language: lang), c["output"] as? String)
    }
  }

  // MARK: gate

  func testGateConfigHashMatchesTheContract() throws {
    let f = try fixture("gate")
    let json = try XCTUnwrap(f["canonical_json"] as? String)
    guard case .success(let gate) = FaceTypeClientGate.parse(json) else { return XCTFail("gate config refused") }
    XCTAssertEqual(gate.hash, f["sha256"] as? String)
    XCTAssertEqual(gate.config.burst.targetFrames, 10)
  }

  // MARK: guidance

  func testGuidanceMatchesStepByStep() throws {
    let f = try fixture("guidance")
    let gate = try XCTUnwrap({ () -> FaceTypeClientGate? in
      if case .success(let g) = FaceTypeClientGate.parse(try! fixture("gate")["canonical_json"] as! String) { return g }
      return nil
    }())
    for scenario in try XCTUnwrap(f["scenarios"] as? [[String: Any]]) {
      let name = scenario["name"] as! String
      var state = GuidanceState(nowMs: (scenario["start_ms"] as? NSNumber)?.doubleValue ?? 0)
      for (i, step) in (scenario["steps"] as! [[String: Any]]).enumerated() {
        let data = try JSONSerialization.data(withJSONObject: step["measure"]!)
        let measure = try JSONDecoder().decode(FrameMeasure.self, from: data)
        state = Guidance.step(state, measure, gate.config)
        if step["rearmed"] as? Bool == true { state = Guidance.rearm(state) }
        let view = Guidance.view(state, gate.config)
        let expected = step["view"] as! [String: Any]
        XCTAssertEqual(view.message.rawValue, expected["message"] as? String, "\(name) #\(i) message")
        XCTAssertEqual(view.ready, expected["ready"] as? Bool, "\(name) #\(i) ready")
        XCTAssertEqual(view.holdProgress, (expected["holdProgress"] as? NSNumber)?.doubleValue ?? -1, accuracy: 1e-9,
                       "\(name) #\(i) hold")
        XCTAssertEqual(view.failing?.rawValue, expected["failing"] as? String, "\(name) #\(i) failing")
      }
    }
  }

  // MARK: messages and problems

  func testMessageKeys() throws {
    let f = try fixture("messages")
    XCTAssertEqual(Messages.apiErrorKeys, f["api_error_keys"] as? [String: String])
    for c in try XCTUnwrap(f["api_error_key"] as? [[String: Any]]) {
      let kind = (c["kind"] as? String).flatMap(ClientErrorKind.init(rawValue:))
      XCTAssertEqual(Messages.apiErrorKey(code: c["code"] as? String, kind: kind), c["key"] as? String)
    }
    for c in try XCTUnwrap(f["profile_field_error_key"] as? [[String: Any]]) {
      XCTAssertEqual(Messages.profileFieldErrorKey(field: c["field"] as! String, reason: c["reason"] as! String),
                     c["key"] as? String)
    }
    for c in try XCTUnwrap(f["verdict_reason_key"] as? [[String: Any]]) {
      XCTAssertEqual(Messages.verdictReasonKey(c["reason"] as! String), c["key"] as? String)
    }
    for c in try XCTUnwrap(f["more_reason_key"] as? [[String: Any]]) {
      XCTAssertEqual(Messages.moreReasonKey(c["reason"] as? String), c["key"] as? String)
    }
    for c in try XCTUnwrap(f["reject_reason_key"] as? [[String: Any]]) {
      let current = GuidanceMessage(rawValue: c["current"] as! String)!
      XCTAssertEqual(Messages.rejectReasonKey(c["reason"] as? String, current: current), c["key"] as? String)
    }
  }

  func testProblemMapping() throws {
    for c in try XCTUnwrap(try fixture("problems")["cases"] as? [[String: Any]]) {
      let e = ClientAPIMapping.mapProblem(
        status: c["status"] as! Int, body: c["body"] as? [String: Any],
        context: ProblemContext(rawValue: c["context"] as! String)!)
      let label = "\(c["status"]!) \(c["body"] ?? "nil")"
      XCTAssertEqual(e.kind.rawValue, c["kind"] as? String, label)
      XCTAssertEqual(e.code, c["code"] as? String, label)
      XCTAssertEqual(e.retryable, c["retryable"] as? Bool, label)
      XCTAssertEqual(e.retryAfterSeconds, (c["retry_after_seconds"] as? NSNumber)?.doubleValue, label)
      XCTAssertEqual(e.fieldErrors, c["field_errors"] as? [String: String] ?? [:], label)
    }
  }

  // MARK: flows

  func testClientFlowSequences() throws {
    let f = try fixture("client_flow")
    // The fixture's `me` objects carry only what the flow reads (profile present, consent accepted).
    func me(_ value: Any?) throws -> ClientMe? {
      guard let object = value as? [String: Any] else { return nil }
      let account = object["account"] as? [String: Any]
      let profile: ProfileView? = (object["profile"] is NSNull || object["profile"] == nil) ? nil : ProfileView(
        revision_id: nil, revision: nil, full_name: "x", id_issuing_country: "SA", id_document_type: "passport",
        id_number: "AB12345", phone: "+966512345678", sex: "male", birth_date: "1990-01-01", nationality: "SA",
        age_years: nil, identity_verification: nil, updated_at: nil)
      let consent = (object["consent"] as? [String: Any]).map {
        ConsentView(id: nil, version: nil, store_accepted: $0["store_accepted"] as? Bool ?? false, research_use: nil,
                    created_at: nil)
      }
      return ClientMe(
        account: AccountView(id: account?["id"] as? String ?? "acc", provider: nil, state: nil, created_at: nil),
        profile: profile, consent: consent, captures: nil, personality: nil)
    }
    for c in try XCTUnwrap(f["needs_setup"] as? [[String: Any]]) {
      XCTAssertEqual(ClientFlow.needsSetup(try me(c["me"])), c["expected"] as? Bool)
    }
    for seq in try XCTUnwrap(f["sequences"] as? [[String: Any]]) {
      var state = ClientState()
      for (i, step) in (seq["steps"] as! [[String: Any]]).enumerated() {
        let e = step["event"] as! [String: Any]
        let event: ClientEvent
        switch e["type"] as! String {
        case "CONFIG_ERROR": event = .configError(e["code"] as! String)
        case "BOOT_NO_SESSION": event = .bootNoSession
        case "SIGN_IN_STARTED": event = .signInStarted(ProviderId(rawValue: e["provider"] as! String)!)
        case "SIGN_IN_FAILED": event = .signInFailed(SignInError(rawValue: e["error"] as! String)!)
        case "SESSION_READY": event = .sessionReady(try me(e["me"])!)
        case "ME_REFRESHED": event = .meRefreshed(try me(e["me"])!)
        case "PROFILE_SAVED": event = .profileSaved(try me(e["me"])!)
        case "OPEN_CAPTURE": event = .openCapture
        case "CLOSE_CAPTURE": event = .closeCapture
        default: event = .signedOut(reason: e["reason"] as! String)
        }
        state = ClientFlow.reduce(state, event)
        let expected = step["state"] as! [String: Any]
        let label = "\(seq["name"]!) #\(i)"
        XCTAssertEqual(state.screen.rawValue, expected["screen"] as? String, label)
        XCTAssertEqual(state.signInBusy?.rawValue, expected["signInBusy"] as? String, label)
        XCTAssertEqual(state.signInError?.rawValue, expected["signInError"] as? String, label)
        XCTAssertEqual(state.notice, expected["notice"] as? String, label)
        XCTAssertEqual(state.configError, expected["configError"] as? String, label)
        XCTAssertEqual(state.me == nil, expected["me"] == nil || expected["me"] is NSNull, label)
      }
    }
  }

  private func manifest(stage: String, verdictStatus: String?, reasons: [String]?, checkingSince: Double?,
                        error: String?, completed: Int, total: Int) -> SpoolManifest {
    SpoolManifest(
      accountId: "acc-1", clientCaptureId: "cc-1", createdAtMs: 0, updatedAtMs: 0,
      stage: SpoolStage(rawValue: stage)!, captureId: "cap-1", attempt: 1, protocolVersion: "capture-spec-v2",
      gateConfigHash: "", device: [:], camera: [:],
      frames: (0..<total).map { i in
        ManifestFrame(index: i, nativeId: "f\(i)", sha256: String(repeating: "a", count: 64), bytes: 1, width: 1,
                      height: 1, uploaded: i <= completed, completed: i < completed)
      },
      verdict: verdictStatus.map { CaptureView(id: "cap-1", status: $0, accepted_frames: 10, reasons: reasons) },
      checkingSinceMs: checkingSince, error: error, attemptTelemetry: nil)
  }

  private func phaseJSON(_ phase: CapturePhase?) -> [String: AnyHashable]? {
    guard let phase else { return nil }
    switch phase {
    case .uploading(let done, let total, let offline):
      return ["name": "uploading", "done": done, "total": total, "offline": offline]
    case .checking(let slow, let measuring): return ["name": "checking", "slow": slow, "measuring": measuring]
    case .retake(let reasons): return ["name": "retake", "reasons": reasons]
    case .more(let reasons): return ["name": "more", "reasons": reasons]
    case .failed(let code): return ["name": "failed", "code": code]
    default: return ["name": phase.name]
    }
  }

  func testSpoolPhaseMappingAndBackoff() throws {
    let f = try fixture("spool")
    for c in try XCTUnwrap(f["backoff_ms"] as? [[String: Any]]) {
      XCTAssertEqual(SpoolTiming.backoffMs(c["n"] as! Int), (c["ms"] as! NSNumber).doubleValue)
    }
    for c in try XCTUnwrap(f["phase_from_spool"] as? [[String: Any]]) {
      let name = c["name"] as! String
      let kind = SpoolOutcome.Kind(rawValue: c["outcome_kind"] as! String)!
      let expected = c["phase"] as? [String: Any]
      var outcome = SpoolOutcome(kind: kind)
      if let stage = c["stage"] as? String {
        let checking: Double? = name.hasPrefix("checking") ? 1000 : nil
        let status: String? =
          name == "checking_measuring" ? "measuring" : (SpoolStage(rawValue: stage)!.isTerminal ? stage : nil)
        outcome.manifest = manifest(
          stage: stage, verdictStatus: status, reasons: status == nil ? nil : ["glasses_detected"],
          checkingSince: checking, error: stage == "failed" ? "upload_rejected_415" : nil, completed: 3, total: 10)
        outcome.reason = name == "uploading_offline" || name == "pending_create" ? .offline : .server
      }
      let phase = CaptureFlow.phase(from: outcome, nowMs: (c["now_ms"] as! NSNumber).doubleValue)
      XCTAssertEqual(phaseJSON(phase)?["name"] as? String, expected?["name"] as? String, name)
      if let expected, let got = phaseJSON(phase) {
        for (key, value) in expected where key != "name" {
          let label = "\(name).\(key)"
          switch value {
          case let flag as NSNumber where CFGetTypeID(flag) == CFBooleanGetTypeID():
            XCTAssertEqual(got[key] as? Bool, flag.boolValue, label)
          case let number as NSNumber:
            XCTAssertEqual(got[key] as? Int, number.intValue, label)
          case let list as [String]:
            XCTAssertEqual(got[key] as? [String], list, label)
          default:
            XCTAssertEqual(got[key] as? String, value as? String, label)
          }
        }
      }
    }
    for c in try XCTUnwrap(f["outcome_for_stage"] as? [[String: Any]]) {
      XCTAssertEqual(Telemetry.outcome(for: SpoolStage(rawValue: c["stage"] as! String)!)?.rawValue,
                     c["outcome"] as? String)
    }
  }

  func testTelemetryWireReasons() throws {
    let f = try fixture("telemetry")
    XCTAssertEqual(Telemetry.maxReasonKeys, f["max_reason_keys"] as? Int)
    XCTAssertEqual(AttemptQueue.max, f["queue_max"] as? Int)
    for c in try XCTUnwrap(f["wire_reason"] as? [[String: Any]]) {
      XCTAssertEqual(Telemetry.wireReason(c["reason"] as! String), c["wire"] as? String)
    }
    XCTAssertEqual(
      Telemetry.wireReasonCounts([("oneFace", 2), ("facing", 1), ("BAD!", 3)]), ["one_face": 2, "facing": 1])
  }

  func testQueueAcceptsEveryOutcomeIncludingNeedsMoreAndComplete() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let queue = AttemptQueue(file: ProtectedFile(name: "q.json", directory: dir))
    let pending = PendingAttempt(duration_ms: 1, attempts: 1, reason_counts: [:], device: ["platform": .string("ios")])
    for outcome in AttemptOutcome.allCases {
      try queue.queue(accountId: "a", QueuedAttempt(key: outcome.rawValue, telemetry: AttemptTelemetry(outcome: outcome, pending: pending), queuedAtMs: 0))
    }
    XCTAssertEqual(queue.load(accountId: "a").count, AttemptOutcome.allCases.count)
  }
}
