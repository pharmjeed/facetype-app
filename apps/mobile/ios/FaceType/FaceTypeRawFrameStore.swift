//
//  FaceTypeRawFrameStore.swift
//  FaceType AI — the one slot a consented field-study photograph lives in.
//
//  This is the iOS twin of
//  `android/app/src/main/java/ai/facetype/capture/rawframe/RawFrameStore.kt`,
//  and it holds to the same three rules:
//
//   1. NO FILE. A JPEG of a research participant's face is never written to
//      disk. On disk it would acquire its own lifetime, its own backup
//      exposure (a Documents/Caches file can be swept into an iCloud or
//      encrypted-local backup) and its own deletion path to get wrong — and it
//      would buy nothing, because a presigned upload needs the bytes in the
//      JavaScript heap regardless.
//   2. ONE SLOT. A field capture uploads one photograph per pose, in sequence,
//      and never holds two. `store` wipes whatever was there, so a caller that
//      forgets to discard cannot accumulate faces.
//   3. AN EXPLICIT WIPE. Dropping a `Data` leaves the bytes legible in the heap
//      until the allocator reuses the pages, and legible in any memory capture
//      taken in between. `resetBytes` overwrites them in place first.
//
//  WHAT IT IS NOT A STORE OF. Screenshots. Its only input is
//  `ARFrame.capturedImage` — the camera's own pixel buffer. Nothing here reads
//  the window, a `UIView`, the layer tree or the display, so a photograph it
//  produces cannot contain the app's interface or anything else that was merely
//  on screen.
//

import CoreGraphics
import CoreImage
import CoreVideo
import Foundation
import ImageIO

/// Metadata handed to JavaScript. Never the bytes, never a path.
struct RawFrameHandle {
  let token: String
  let byteLength: Int
  let sha256: String
  let width: Int
  let height: Int

  var payload: [String: Any] {
    [
      "token": token,
      "byteLength": byteLength,
      "sha256": sha256,
      "width": width,
      "height": height,
    ]
  }
}

final class FaceTypeRawFrameStore {

  private let lock = NSLock()
  private var token: String?
  /// The dimensions are not kept: they belong to the handle the caller already
  /// holds, and a second copy here would be state nothing reads and everything
  /// has to remember to clear.
  private var bytes: Data?

  /// One `CIContext`, because creating one per frame rebuilds a Metal/CPU
  /// render pipeline on every capture — tens of milliseconds each time, on the
  /// thread the operator is waiting on.
  private let ciContext = CIContext(options: [.useSoftwareRenderer: false])

  /// Quality 0.85: visually clean for a reference photograph, and well inside
  /// the server's 16 MiB RAW_FRAME ceiling. Higher buys a calibration reviewer
  /// nothing, and every extra byte is an extra byte of somebody's face in
  /// transit.
  private static let jpegQuality = 0.85

  /// Encode `pixelBuffer` as an upright JPEG and take ownership of the bytes.
  ///
  /// `orientation` is the same `CGImagePropertyOrientation` the Vision quality
  /// pass is given, so the photograph and the measurement agree about which way
  /// up the frame was. It is *not* un-mirrored beyond that: the front camera's
  /// buffer carries the sensor's handedness and a calibration reviewer
  /// comparing a photograph with a left-25° pose needs the participant's real
  /// left, not the one a mirror shows.
  ///
  /// Returns nil rather than throwing when this build cannot encode the buffer:
  /// a field capture that could not take a photograph still collects geometry,
  /// and the operator is told which pose has no image.
  func store(
    pixelBuffer: CVPixelBuffer,
    orientation: CGImagePropertyOrientation
  ) -> RawFrameHandle? {
    let image = CIImage(cvPixelBuffer: pixelBuffer).oriented(orientation)
    let qualityKey = CIImageRepresentationOption(
      rawValue: kCGImageDestinationLossyCompressionQuality as String
    )
    guard
      let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
      let jpeg = ciContext.jpegRepresentation(
        of: image,
        colorSpace: colorSpace,
        options: [qualityKey: Self.jpegQuality]
      ),
      !jpeg.isEmpty
    else {
      return nil
    }

    let extent = image.extent
    let pixelWidth = Int(extent.width.rounded())
    let pixelHeight = Int(extent.height.rounded())
    guard pixelWidth > 0, pixelHeight > 0 else { return nil }

    let issued = "rf-\(UUID().uuidString)"
    let digest = FaceTypeRawFrameStore.sha256Hex(jpeg)

    lock.lock()
    wipeLocked()
    token = issued
    bytes = jpeg
    lock.unlock()

    return RawFrameHandle(
      token: issued,
      byteLength: jpeg.count,
      sha256: digest,
      width: pixelWidth,
      height: pixelHeight
    )
  }

  /// The held photograph as base64, or nil if `token` is not the occupant.
  ///
  /// The base64 `String` itself cannot be wiped — it crosses the React Native
  /// bridge and Swift strings are immutable — so it is produced only at the
  /// moment of upload and retained on neither side.
  func base64(token: String) -> String? {
    lock.lock()
    defer { lock.unlock() }
    guard self.token == token, let held = bytes else { return nil }
    return held.base64EncodedString()
  }

  /// True when `token` named the occupant and it has now been wiped.
  @discardableResult
  func discard(token: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard self.token == token else { return false }
    wipeLocked()
    return true
  }

  /// Wipes whatever is held. Idempotent. Returns true if anything was.
  @discardableResult
  func discardAll() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let held = bytes != nil
    wipeLocked()
    return held
  }

  var isEmpty: Bool {
    lock.lock()
    defer { lock.unlock() }
    return bytes == nil
  }

  private func wipeLocked() {
    // In place, through the stored property, before the reference goes:
    // `bytes = nil` alone leaves the allocation legible until it is reused.
    //
    // Through the property and not through a local copy, because `Data` is a
    // value type: `var held = bytes; held.resetBytes(...)` would copy on write
    // and zero the copy, leaving the original exactly as legible as before.
    // Nothing else ever holds a reference to this buffer — `base64` returns a
    // `String`, not the `Data` — so the mutation happens in place rather than
    // against a second retained copy.
    if let count = bytes?.count, count > 0 {
      bytes?.resetBytes(in: 0..<count)
    }
    bytes = nil
    token = nil
  }

  /// SHA-256 over exactly the bytes that will be uploaded, so the presigned
  /// slot JavaScript requests is signed for what is actually sent.
  ///
  /// Hand-rolled rather than `CryptoKit.SHA256` so this file links against
  /// nothing the project does not already declare, and so the digest is
  /// verifiable by reading it: it is the same construction as the JavaScript
  /// fallback in `src/api/client.ts` and the Android store's `MessageDigest`
  /// call, and all three have to agree byte for byte or the presigned upload
  /// is signed for something other than what is sent.
  static func sha256Hex(_ data: Data) -> String {
    var h: [UInt32] = [
      0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a,
      0x510e_527f, 0x9b05_688c, 0x1f83_d9ab, 0x5be0_cd19,
    ]
    let k: [UInt32] = [
      0x428a_2f98, 0x7137_4491, 0xb5c0_fbcf, 0xe9b5_dba5, 0x3956_c25b, 0x59f1_11f1,
      0x923f_82a4, 0xab1c_5ed5, 0xd807_aa98, 0x1283_5b01, 0x2431_85be, 0x550c_7dc3,
      0x72be_5d74, 0x80de_b1fe, 0x9bdc_06a7, 0xc19b_f174, 0xe49b_69c1, 0xefbe_4786,
      0x0fc1_9dc6, 0x240c_a1cc, 0x2de9_2c6f, 0x4a74_84aa, 0x5cb0_a9dc, 0x76f9_88da,
      0x983e_5152, 0xa831_c66d, 0xb003_27c8, 0xbf59_7fc7, 0xc6e0_0bf3, 0xd5a7_9147,
      0x06ca_6351, 0x1429_2967, 0x27b7_0a85, 0x2e1b_2138, 0x4d2c_6dfc, 0x5338_0d13,
      0x650a_7354, 0x766a_0abb, 0x81c2_c92e, 0x9272_2c85, 0xa2bf_e8a1, 0xa81a_664b,
      0xc24b_8b70, 0xc76c_51a3, 0xd192_e819, 0xd699_0624, 0xf40e_3585, 0x106a_a070,
      0x19a4_c116, 0x1e37_6c08, 0x2748_774c, 0x34b0_bcb5, 0x391c_0cb3, 0x4ed8_aa4a,
      0x5b9c_ca4f, 0x682e_6ff3, 0x748f_82ee, 0x78a5_636f, 0x84c8_7814, 0x8cc7_0208,
      0x90be_fffa, 0xa450_6ceb, 0xbef9_a3f7, 0xc671_78f2,
    ]

    var message = [UInt8](data)
    let bitLength = UInt64(message.count) * 8
    message.append(0x80)
    while message.count % 64 != 56 { message.append(0) }
    for shift in stride(from: 56, through: 0, by: -8) {
      message.append(UInt8((bitLength >> UInt64(shift)) & 0xff))
    }

    var w = [UInt32](repeating: 0, count: 64)
    var chunk = 0
    while chunk < message.count {
      for i in 0..<16 {
        let base = chunk + i * 4
        w[i] =
          (UInt32(message[base]) << 24) | (UInt32(message[base + 1]) << 16)
          | (UInt32(message[base + 2]) << 8) | UInt32(message[base + 3])
      }
      for i in 16..<64 {
        let s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3)
        let s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10)
        w[i] = w[i - 16] &+ s0 &+ w[i - 7] &+ s1
      }

      var a = h[0], b = h[1], c = h[2], d = h[3]
      var e = h[4], f = h[5], g = h[6], hh = h[7]
      for i in 0..<64 {
        let s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
        let ch = (e & f) ^ (~e & g)
        let temp1 = hh &+ s1 &+ ch &+ k[i] &+ w[i]
        let s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
        let maj = (a & b) ^ (a & c) ^ (b & c)
        let temp2 = s0 &+ maj
        hh = g; g = f; f = e; e = d &+ temp1
        d = c; c = b; b = a; a = temp1 &+ temp2
      }
      h[0] = h[0] &+ a; h[1] = h[1] &+ b; h[2] = h[2] &+ c; h[3] = h[3] &+ d
      h[4] = h[4] &+ e; h[5] = h[5] &+ f; h[6] = h[6] &+ g; h[7] = h[7] &+ hh
      chunk += 64
    }

    return h.map { String(format: "%08x", $0) }.joined()
  }

  private static func rotr(_ value: UInt32, _ count: UInt32) -> UInt32 {
    (value >> count) | (value << (32 - count))
  }
}
