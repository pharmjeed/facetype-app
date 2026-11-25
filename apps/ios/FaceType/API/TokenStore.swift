//
//  TokenStore.swift
//  The session tokens, in the Keychain slot the React Native app used (FaceTypeSecureSession.swift:
//  service `ai.facetype.anonymous-session`, account `facetype-session`, after first unlock, this device only),
//  in the same `client-1` JSON envelope, so updating to the native app keeps the person signed in.
//  Nothing token-shaped is written anywhere else.
//

import Foundation
import Security

struct StoredTokens: Codable, Equatable {
  var version = "client-1"
  let accessToken: String
  let accessExpiresAtMs: Double
  let refreshToken: String

  static func from(_ pair: TokenPair, nowMs: Double) -> StoredTokens {
    StoredTokens(
      accessToken: pair.access_token, accessExpiresAtMs: nowMs + pair.expires_in * 1000,
      refreshToken: pair.refresh_token)
  }
}

protocol TokenStore: AnyObject {
  func load() -> StoredTokens?
  func save(_ tokens: StoredTokens) throws
  func clear()
}

final class KeychainTokenStore: TokenStore {
  private let service = "ai.facetype.anonymous-session"
  private let account = "facetype-session"

  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
     kSecAttrAccount as String: account]
  }

  func load() -> StoredTokens? {
    var q = query
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else {
      return nil
    }
    guard let tokens = try? JSONDecoder().decode(StoredTokens.self, from: data), tokens.version == "client-1",
      !tokens.accessToken.isEmpty, !tokens.refreshToken.isEmpty
    else {
      // Not a client-1 envelope (e.g. the anonymous lane's value): it is not ours to keep using.
      clear()
      return nil
    }
    return tokens
  }

  func save(_ tokens: StoredTokens) throws {
    let data = try JSONEncoder().encode(tokens)
    SecItemDelete(query as CFDictionary)
    var q = query
    q[kSecValueData as String] = data
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(q as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
    }
  }

  func clear() {
    SecItemDelete(query as CFDictionary)
  }
}

final class MemoryTokenStore: TokenStore {
  private var tokens: StoredTokens?
  func load() -> StoredTokens? { tokens }
  func save(_ tokens: StoredTokens) throws { self.tokens = tokens }
  func clear() { tokens = nil }
}
