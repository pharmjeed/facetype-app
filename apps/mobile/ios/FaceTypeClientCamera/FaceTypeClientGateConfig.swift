//
//  FaceTypeClientGateConfig.swift
//  FaceType AI — the shared client gate config (docs/client-native-interface.md §1).
//
//  Native never hard-codes a threshold. Every per-frame limit the client
//  camera applies is read from the JSON JavaScript passes in the view's
//  `gateConfig` prop, decoded strictly into exactly the shape the contract
//  declares. A config that does not decode, or that carries an impossible
//  value, is refused -- and the camera then does not run -- instead of being
//  patched with a default nobody chose.
//
//  `tests/contract/test_ios_client_camera.py` parses the TypeScript shape out
//  of docs/client-native-interface.md and fails if a field there has no
//  decoded counterpart here.
//

import CryptoKit
import Foundation

struct FaceTypeClientGateConfig: Decodable {
  struct Stream: Decodable {
    let preferredSizes: [[Double]]
    let minSize: [Double]
    let preferredMinFps: Double
    let jpegQuality: Double
  }

  struct Faces: Decodable {
    /// The contract types this as the literal `2`: MediaPipe runs with
    /// `numFaces = 2` so that any detected second face can block storing.
    static let required = 2
    let maxFaces: Int
  }

  struct Pose: Decodable {
    let enterDeg: Double
    let exitDeg: Double
    let rollMessageDeg: Double
  }

  struct Distance: Decodable {
    let enterCm: [Double]
    let exitCm: [Double]
    let irisMm: Double
  }

  struct Size: Decodable {
    let minFaceWidthPx: Double
    let preferredFaceWidthPx: Double
    let maxFaceWidthFrac: Double
  }

  struct Centre: Decodable {
    let eyeMidX: [Double]
    let faceCentreY: [Double]
    let edgeMarginFrac: Double
  }

  struct Light: Decodable {
    let maxClipFrac: Double
    let maxCrushFrac: Double
    let cheekRatio: [Double]
    /// Decoded for the contract; this older module does not apply the light
    /// level (the native app in apps/ios does).
    let ev100: [Double]
    let ev100ExitWiden: Double
  }

  /// Decoded for the contract; this older module does not apply it.
  struct Motion: Decodable {
    let maxBlurFrac: Double
  }

  struct Expression: Decodable {
    let maxSmile: Double
    let maxJawOpen: Double
  }

  struct Eyes: Decodable {
    let maxBlink: Double
    let minRelativeOpening: Double
  }

  struct Sharpness: Decodable {
    let minRelativeToBurstMax: Double
  }

  struct Burst: Decodable {
    let targetFrames: Int
    let maxDurationMs: Double
    let minSpacingMs: Double
    let minCoverageMs: Double
    let holdMs: Double
  }

  static let supportedVersion = "client-gate-1"

  let version: String
  let stream: Stream
  let faces: Faces
  let pose: Pose
  let distance: Distance
  let size: Size
  let centre: Centre
  let light: Light
  let motion: Motion
  let expression: Expression
  let eyes: Eyes
  let sharpness: Sharpness
  let burst: Burst
  let labels: [String: String]

  /// `preferredSizes` as integer (width, height) pairs, in the contract's
  /// order of preference (landscape sensor dimensions, e.g. 3840x2160).
  var preferredSizes: [(Int, Int)] {
    stream.preferredSizes.map { (Int($0[0].rounded()), Int($0[1].rounded())) }
  }

  var minSize: (Int, Int) {
    (Int(stream.minSize[0].rounded()), Int(stream.minSize[1].rounded()))
  }

  var jpegQuality: Int { Int(stream.jpegQuality.rounded()) }
}

struct FaceTypeClientGateError: Error {
  let message: String
}

/// A decoded, validated config plus the hash every stored frame records.
struct FaceTypeClientGate {
  let config: FaceTypeClientGateConfig
  /// SHA-256 hex of the canonical JSON (keys sorted at every level, no
  /// whitespace, numbers and strings written the way `JSON.stringify`
  /// writes them) -- the definition `gateConfigHash()` uses in
  /// packages/contracts/src/clientGate.ts.
  let hash: String

  static func parse(_ json: String) -> Result<FaceTypeClientGate, FaceTypeClientGateError> {
    guard let data = json.data(using: .utf8) else {
      return .failure(FaceTypeClientGateError(message: "gateConfig is not UTF-8"))
    }
    let config: FaceTypeClientGateConfig
    do {
      config = try JSONDecoder().decode(FaceTypeClientGateConfig.self, from: data)
    } catch {
      return .failure(FaceTypeClientGateError(message: "gateConfig does not match the contract shape: \(error)"))
    }
    if let problem = validate(config) {
      return .failure(FaceTypeClientGateError(message: "gateConfig is invalid: \(problem)"))
    }
    guard
      let object = try? JSONSerialization.jsonObject(with: data, options: []),
      let canonical = FaceTypeClientCanonicalJSON.serialize(object)
    else {
      return .failure(FaceTypeClientGateError(message: "gateConfig could not be canonicalised"))
    }
    let digest = SHA256.hash(data: Data(canonical.utf8))
    let hash = digest.map { String(format: "%02x", $0) }.joined()
    return .success(FaceTypeClientGate(config: config, hash: hash))
  }

  /// Shape facts the type system cannot express. Returns the first problem.
  private static func validate(_ c: FaceTypeClientGateConfig) -> String? {
    func isPair(_ v: [Double]) -> Bool {
      v.count == 2 && v[0].isFinite && v[1].isFinite && v[0] <= v[1]
    }
    func isFraction(_ v: Double) -> Bool { v.isFinite && v >= 0 && v <= 1 }

    if c.version != FaceTypeClientGateConfig.supportedVersion {
      return "version \(c.version) is not \(FaceTypeClientGateConfig.supportedVersion)"
    }
    if c.stream.preferredSizes.isEmpty
      || !c.stream.preferredSizes.allSatisfy({ $0.count == 2 && $0[0] > 0 && $0[1] > 0 })
    {
      return "stream.preferredSizes"
    }
    if c.stream.minSize.count != 2 || !(c.stream.minSize[0] > 0) || !(c.stream.minSize[1] > 0) {
      return "stream.minSize"
    }
    if !(c.stream.jpegQuality >= 1 && c.stream.jpegQuality <= 100) { return "stream.jpegQuality" }
    if c.faces.maxFaces != FaceTypeClientGateConfig.Faces.required { return "faces.maxFaces" }
    if !(c.pose.enterDeg > 0) || !(c.pose.exitDeg >= c.pose.enterDeg) { return "pose" }
    if !isPair(c.distance.enterCm) || !isPair(c.distance.exitCm) || !(c.distance.irisMm > 0) {
      return "distance"
    }
    if !(c.size.minFaceWidthPx > 0) || !(c.size.maxFaceWidthFrac > 0 && c.size.maxFaceWidthFrac <= 1) {
      return "size"
    }
    if !isPair(c.centre.eyeMidX) || !isPair(c.centre.faceCentreY) || !isFraction(c.centre.edgeMarginFrac) {
      return "centre"
    }
    if !isFraction(c.light.maxClipFrac) || !isFraction(c.light.maxCrushFrac) || !isPair(c.light.cheekRatio) {
      return "light"
    }
    if !isFraction(c.expression.maxSmile) || !isFraction(c.expression.maxJawOpen) { return "expression" }
    if !isFraction(c.eyes.maxBlink) || !isFraction(c.eyes.minRelativeOpening) { return "eyes" }
    if !isFraction(c.sharpness.minRelativeToBurstMax) { return "sharpness" }
    if c.burst.targetFrames < 1 || !(c.burst.maxDurationMs > 0) || !(c.burst.minSpacingMs >= 0)
      || !(c.burst.minCoverageMs >= 0)
    {
      return "burst"
    }
    return nil
  }
}

/// Canonical JSON with `JSON.stringify` semantics, so the hash computed here
/// equals the hash TypeScript computes for the same object: object keys
/// sorted by UTF-16 code units at every level, no whitespace, numbers in
/// ECMAScript `Number#toString` form, strings escaped as `JSON.stringify`
/// escapes them.
enum FaceTypeClientCanonicalJSON {
  static func serialize(_ value: Any) -> String? {
    switch value {
    case is NSNull:
      return "null"
    case let number as NSNumber:
      if CFGetTypeID(number) == CFBooleanGetTypeID() {
        return number.boolValue ? "true" : "false"
      }
      return jsNumber(number.doubleValue)
    case let string as String:
      return quote(string)
    case let array as [Any]:
      var parts: [String] = []
      for element in array {
        guard let part = serialize(element) else { return nil }
        parts.append(part)
      }
      return "[" + parts.joined(separator: ",") + "]"
    case let object as [String: Any]:
      let keys = object.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
      var parts: [String] = []
      for key in keys {
        guard let element = object[key], let part = serialize(element) else { return nil }
        parts.append(quote(key) + ":" + part)
      }
      return "{" + parts.joined(separator: ",") + "}"
    default:
      return nil
    }
  }

  /// ECMAScript Number#toString for a finite double. Swift's description
  /// already yields the shortest round-tripping digits (the same digits
  /// ECMAScript picks); only the placement of the decimal point differs.
  static func jsNumber(_ value: Double) -> String? {
    guard value.isFinite else { return nil }
    if value == 0 { return "0" }
    let text = "\(abs(value))"
    var mantissa = text
    var exponent = 0
    if let marker = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
      mantissa = String(text[..<marker])
      guard let parsed = Int(text[text.index(after: marker)...]) else { return nil }
      exponent = parsed
    }
    let pieces = mantissa.split(separator: ".", omittingEmptySubsequences: false)
    let integerPart = String(pieces[0])
    let fractionPart = pieces.count > 1 ? String(pieces[1]) : ""
    var digits = integerPart + fractionPart
    // Position of the decimal point measured from the start of `digits`.
    var point = integerPart.count + exponent
    while digits.count > 1, digits.hasPrefix("0") {
      digits.removeFirst()
      point -= 1
    }
    while digits.count > 1, digits.hasSuffix("0") {
      digits.removeLast()
    }
    let k = digits.count
    var out: String
    if k <= point, point <= 21 {
      out = digits + String(repeating: "0", count: point - k)
    } else if point > 0, point <= 21 {
      let split = digits.index(digits.startIndex, offsetBy: point)
      out = String(digits[..<split]) + "." + String(digits[split...])
    } else if point > -6, point <= 0 {
      out = "0." + String(repeating: "0", count: -point) + digits
    } else {
      let e = point - 1
      let sign = e < 0 ? "-" : "+"
      let head = String(digits.prefix(1))
      let tail = String(digits.dropFirst())
      out = (tail.isEmpty ? head : head + "." + tail) + "e" + sign + String(abs(e))
    }
    return value < 0 ? "-" + out : out
  }

  static func quote(_ string: String) -> String {
    var out = "\""
    for scalar in string.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\u{08}": out += "\\b"
      case "\u{0C}": out += "\\f"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        if scalar.value < 0x20 {
          out += String(format: "\\u%04x", scalar.value)
        } else {
          out.unicodeScalars.append(scalar)
        }
      }
    }
    return out + "\""
  }
}
