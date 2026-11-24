// FaceType AI — non-biometric API-session storage.

import Foundation
import React
import Security

@objc(FaceTypeSecureSession)
final class FaceTypeSecureSession: NSObject {
  private static let service = "ai.facetype.anonymous-session"
  private static let account = "facetype-session"

  @objc(saveSession:resolver:rejecter:)
  func saveSession(
    _ value: String,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    guard let data = value.data(using: .utf8) else {
      reject("FT-AUTH-SECURE-SAVE", "Could not encode the session.", nil)
      return
    }
    SecItemDelete(Self.baseQuery() as CFDictionary)
    var query = Self.baseQuery()
    query[kSecValueData as String] = data
    // Available to background/restarted app code after the first unlock, never
    // migrated to another device, and no biometric access control is attached.
    query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else {
      reject("FT-AUTH-SECURE-SAVE", "Could not secure the session (\(status)).", nil)
      return
    }
    resolve(nil)
  }

  @objc(loadSession:rejecter:)
  func loadSession(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    var query = Self.baseQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound {
      resolve(nil)
      return
    }
    guard status == errSecSuccess,
          let data = item as? Data,
          let value = String(data: data, encoding: .utf8) else {
      SecItemDelete(Self.baseQuery() as CFDictionary)
      reject("FT-AUTH-SECURE-LOAD", "Could not restore the session (\(status)).", nil)
      return
    }
    resolve(value)
  }

  @objc(clearSession:rejecter:)
  func clearSession(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    let status = SecItemDelete(Self.baseQuery() as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      reject("FT-AUTH-SECURE-CLEAR", "Could not clear the session (\(status)).", nil)
      return
    }
    resolve(nil)
  }

  @objc static func requiresMainQueueSetup() -> Bool { false }

  private static func baseQuery() -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }
}
