//
//  JSONValue.swift
//  A Codable JSON value, for the free-form objects the spool keeps (device, camera, frame meta descriptors)
//  and sends back unchanged.
//

import Foundation

enum JSONValue: Codable, Equatable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let v = try? c.decode(Bool.self) {
      self = .bool(v)
    } else if let v = try? c.decode(Double.self) {
      self = .number(v)
    } else if let v = try? c.decode(String.self) {
      self = .string(v)
    } else if let v = try? c.decode([JSONValue].self) {
      self = .array(v)
    } else {
      self = .object(try c.decode([String: JSONValue].self))
    }
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .string(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .object(let v): try c.encode(v)
    }
  }

  /// From a JSONSerialization-style value (NSNumber booleans stay booleans).
  init(any value: Any?) {
    switch value {
    case nil, is NSNull: self = .null
    case let v as NSNumber where CFGetTypeID(v) == CFBooleanGetTypeID(): self = .bool(v.boolValue)
    case let v as NSNumber: self = .number(v.doubleValue)
    case let v as String: self = .string(v)
    case let v as [Any]: self = .array(v.map { JSONValue(any: $0) })
    case let v as [String: Any]: self = .object(v.mapValues { JSONValue(any: $0) })
    case let v as Bool: self = .bool(v)
    case let v as Int: self = .number(Double(v))
    case let v as Double: self = .number(v)
    default: self = .string(String(describing: value!))
    }
  }

  /// Back to a JSONSerialization-compatible value.
  var any: Any {
    switch self {
    case .null: return NSNull()
    case .bool(let v): return v
    case .number(let v): return v.rounded() == v && abs(v) < 9e15 ? Int(v) as Any : v
    case .string(let v): return v
    case .array(let v): return v.map(\.any)
    case .object(let v): return v.mapValues(\.any)
    }
  }

  var objectValue: [String: JSONValue]? { if case .object(let v) = self { return v } else { return nil } }
}
