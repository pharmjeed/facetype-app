//
//  FaceTypeClientSpool.swift
//  FaceType AI — the client camera's encrypted, app-private frame spool
//  (docs/client-native-interface.md §3).
//
//  Accepted JPEGs are photographs of a face: biometric-like data. They are
//  never written to disk in the clear. Each one is sealed with AES-GCM
//  (CryptoKit) under a 256-bit key held in the Keychain as a generic
//  password -- this device only, readable only while unlocked, no biometric
//  access control, no Secure Enclave -- and written to
//  Application Support/client_spool with complete file protection and the
//  backup-exclusion flag on both the directory and every file.
//
//  A file holds AES.GCM.SealedBox.combined: 12-byte nonce, ciphertext,
//  16-byte tag. The ciphertext is exactly as long as the JPEG, so the JPEG
//  byte count is the file size minus 28 and needs no unencrypted sidecar.
//  Decryption happens in memory only, for `uploadFrame`.
//
//  Each returned frame's FrameMeta (landmarks, blendshapes: biometric-like as
//  well) is sealed the same way, under the same key, beside its JPEG as
//  `<id>.meta.aesgcm`, so JavaScript can resume after a restart through
//  `getFrameMeta` without ever keeping it in AsyncStorage (contract §5.12).
//  `delete(ids:)` removes both files.
//

import CryptoKit
import Foundation
import Security

struct FaceTypeClientSpoolError: Error {
  let code: String
  let message: String
}

final class FaceTypeClientSpool {
  static let directoryName = "client_spool"
  static let fileExtension = "aesgcm"
  /// `<id>.meta.aesgcm`: never listed as a frame, because `<id>.meta` is not
  /// a canonical spool id.
  static let metaSuffix = ".meta"
  /// AES.GCM combined layout: 12-byte nonce + ciphertext + 16-byte tag.
  static let sealOverhead = 12 + 16
  private static let keyService = "ai.facetype.client-spool"
  private static let keyAccount = "spool-key-v1"

  private let lock = NSLock()
  private var cachedKey: SymmetricKey?

  /// Spool ids are lower-case UUIDs, so a caller-supplied id can never name
  /// a path outside the spool.
  static func canonicalId(_ id: String) -> String? {
    UUID(uuidString: id).map { $0.uuidString.lowercased() }
  }

  func store(id: String, jpeg: Data) throws {
    try seal(jpeg, to: fileURL(try Self.requireId(id)))
  }

  /// The exact JPEG bytes that were sealed, in memory.
  func open(id: String) throws -> Data {
    try unseal(fileURL(try Self.requireId(id)), missing: "no spooled frame with that id")
  }

  /// Seals one frame's FrameMeta (JSON) beside its JPEG.
  func storeMeta(id: String, meta: [String: Any]) throws {
    let spoolId = try Self.requireId(id)
    // JSONSerialization raises (it does not throw) on NaN or infinity.
    guard JSONSerialization.isValidJSONObject(meta),
      let json = try? JSONSerialization.data(withJSONObject: meta, options: [.sortedKeys])
    else {
      throw FaceTypeClientSpoolError(code: "spool_error", message: "the frame metadata is not valid JSON")
    }
    try seal(json, to: metaURL(spoolId))
  }

  /// The FrameMeta stored with a frame. `not_found` for a frame whose burst
  /// never returned it (e.g. the app was killed mid-burst).
  func openMeta(id: String) throws -> [String: Any] {
    let json = try unseal(metaURL(try Self.requireId(id)), missing: "no stored metadata for that frame")
    guard let meta = (try? JSONSerialization.jsonObject(with: json, options: [])) as? [String: Any] else {
      throw FaceTypeClientSpoolError(code: "spool_unreadable", message: "the stored metadata is not a JSON object")
    }
    return meta
  }

  /// Removes each named frame and its metadata; ids that are not (or no
  /// longer) spooled are ignored, so cleanup never fails on something gone.
  func delete(ids: [String]) {
    for raw in ids {
      guard let id = Self.canonicalId(raw) else { continue }
      if let url = try? fileURL(id) { try? FileManager.default.removeItem(at: url) }
      if let url = try? metaURL(id) { try? FileManager.default.removeItem(at: url) }
    }
  }

  private static func requireId(_ raw: String) throws -> String {
    guard let id = canonicalId(raw) else {
      throw FaceTypeClientSpoolError(code: "invalid_argument", message: "not a spool id")
    }
    return id
  }

  private func seal(_ plaintext: Data, to destination: URL) throws {
    let key = try loadOrCreateKey()
    let sealed: AES.GCM.SealedBox
    do {
      sealed = try AES.GCM.seal(plaintext, using: key)
    } catch {
      throw FaceTypeClientSpoolError(code: "spool_error", message: "AES-GCM seal failed")
    }
    guard let combined = sealed.combined else {
      throw FaceTypeClientSpoolError(code: "spool_error", message: "AES-GCM produced no combined box")
    }
    var url = destination
    do {
      try combined.write(to: url, options: [.atomic, .completeFileProtection])
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try url.setResourceValues(values)
    } catch {
      try? FileManager.default.removeItem(at: url)
      throw FaceTypeClientSpoolError(code: "spool_error", message: "the sealed file could not be written")
    }
  }

  private func unseal(_ url: URL, missing: String) throws -> Data {
    guard let combined = try? Data(contentsOf: url) else {
      throw FaceTypeClientSpoolError(code: "not_found", message: missing)
    }
    let key = try loadOrCreateKey()
    do {
      let box = try AES.GCM.SealedBox(combined: combined)
      return try AES.GCM.open(box, using: key)
    } catch {
      throw FaceTypeClientSpoolError(
        code: "spool_unreadable",
        message: "the spooled file failed authentication (wrong key or damaged file)"
      )
    }
  }

  /// `[{id, bytes, createdAtMs}]` for every spooled frame.
  func list() throws -> [[String: Any]] {
    let directory = try directoryURL()
    let keys: [URLResourceKey] = [.fileSizeKey, .creationDateKey]
    let urls = try FileManager.default.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: keys,
      options: [.skipsHiddenFiles]
    )
    var out: [[String: Any]] = []
    for url in urls where url.pathExtension == Self.fileExtension {
      let name = url.deletingPathExtension().lastPathComponent
      guard let id = Self.canonicalId(name), id == name else { continue }
      let values = try? url.resourceValues(forKeys: Set(keys))
      let size = values?.fileSize ?? 0
      let created = values?.creationDate ?? Date(timeIntervalSince1970: 0)
      out.append([
        "id": id,
        "bytes": max(0, size - Self.sealOverhead),
        "createdAtMs": Int64((created.timeIntervalSince1970 * 1000).rounded()),
      ])
    }
    return out
  }

  // MARK: - files

  private func directoryURL() throws -> URL {
    do {
      let base = try FileManager.default.url(
        for: .applicationSupportDirectory,
        in: .userDomainMask,
        appropriateFor: nil,
        create: true
      )
      var directory = base.appendingPathComponent(Self.directoryName, isDirectory: true)
      if !FileManager.default.fileExists(atPath: directory.path) {
        try FileManager.default.createDirectory(
          at: directory,
          withIntermediateDirectories: true,
          attributes: [.protectionKey: FileProtectionType.complete]
        )
      }
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try directory.setResourceValues(values)
      return directory
    } catch {
      throw FaceTypeClientSpoolError(code: "spool_error", message: "the spool directory is unavailable")
    }
  }

  private func fileURL(_ canonicalId: String) throws -> URL {
    try directoryURL().appendingPathComponent("\(canonicalId).\(Self.fileExtension)", isDirectory: false)
  }

  private func metaURL(_ canonicalId: String) throws -> URL {
    try directoryURL().appendingPathComponent(
      canonicalId + Self.metaSuffix + "." + Self.fileExtension,
      isDirectory: false
    )
  }

  // MARK: - key

  private func loadOrCreateKey() throws -> SymmetricKey {
    lock.lock()
    defer { lock.unlock() }
    if let cachedKey { return cachedKey }

    var query = Self.keyQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecSuccess, let data = item as? Data, data.count == 32 {
      let key = SymmetricKey(data: data)
      cachedKey = key
      return key
    }
    guard status == errSecItemNotFound || status == errSecSuccess else {
      throw FaceTypeClientSpoolError(code: "spool_error", message: "the spool key is unavailable (\(status))")
    }
    // Absent (or malformed): a fresh key. Frames sealed under a lost key
    // can no longer be opened and surface as `spool_unreadable`.
    SecItemDelete(Self.keyQuery() as CFDictionary)
    let key = SymmetricKey(size: .bits256)
    var add = Self.keyQuery()
    add[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
    // Never migrates to another device or into a backup; no biometric
    // access control is attached.
    add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    let added = SecItemAdd(add as CFDictionary, nil)
    guard added == errSecSuccess else {
      throw FaceTypeClientSpoolError(code: "spool_error", message: "the spool key could not be stored (\(added))")
    }
    cachedKey = key
    return key
  }

  private static func keyQuery() -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keyService,
      kSecAttrAccount as String: keyAccount,
    ]
  }
}
