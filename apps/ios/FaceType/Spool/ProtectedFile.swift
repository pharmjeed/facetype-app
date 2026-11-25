//
//  ProtectedFile.swift
//  One small JSON state file (manifest, attempt queue, language) in Application Support, written atomically
//  with complete file protection and excluded from backup. The spooled JPEGs themselves stay in the encrypted
//  native spool (FaceTypeClientSpool); nothing image- or landmark-shaped is written here.
//

import Foundation

final class ProtectedFile {
  let url: URL

  init(name: String, directory: URL? = nil) {
    let base =
      directory
      ?? (try? FileManager.default.url(
        for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
      ?? FileManager.default.temporaryDirectory
    var folder = base.appendingPathComponent("client_state", isDirectory: true)
    if !FileManager.default.fileExists(atPath: folder.path) {
      try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try? folder.setResourceValues(values)
    }
    url = folder.appendingPathComponent(name)
  }

  func read() -> Data? { try? Data(contentsOf: url) }

  func write(_ data: Data) throws {
    try data.write(to: url, options: [.atomic, .completeFileProtection])
  }

  func remove() { try? FileManager.default.removeItem(at: url) }
}
