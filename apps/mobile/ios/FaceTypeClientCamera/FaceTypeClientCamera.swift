//
//  FaceTypeClientCamera.swift
//  FaceType AI — the `FaceTypeClientCamera` native module
//  (docs/client-native-interface.md §3).
//
//  getCapabilities, startBurst, cancelBurst, uploadFrame, deleteFrames,
//  listSpool, getFrameMeta. The Objective-C half, `FaceTypeClientCamera.m`, declares every
//  selector below with RCT_EXTERN_METHOD; the contract test checks the two
//  agree.
//
//  Promise rejection codes: the `onError` codes where one applies
//  (`camera_unavailable`, `model_unavailable`, `effects_active`), plus
//  `burst_in_progress`, `invalid_argument`, `not_found`, `spool_unreadable`,
//  `spool_error` and `upload_failed`.
//
//  WHAT THIS MODULE MUST NEVER DO
//  Touch ARKit, Face ID, LocalAuthentication or the Secure Enclave (FT-00 §3).
//

import AVFoundation
import Foundation
import React

@objc(FaceTypeClientCamera)
final class FaceTypeClientCamera: NSObject, RCTInvalidating {
  private let controller = FaceTypeClientCameraController.shared

  /// No cache, no cookies, no credential store: the presigned URL and the
  /// headers the server returned are the whole request.
  private let uploads: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCredentialStorage = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 60
    return URLSession(configuration: configuration)
  }()

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(getCapabilities:rejecter:)
  func getCapabilities(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let device = FaceTypeClientCameraController.frontCamera() else {
      reject(FaceTypeClientErrorCode.cameraUnavailable.rawValue, "This device has no front camera.", nil)
      return
    }
    var seen = Set<String>()
    var sizes: [(Int, Int)] = []
    for format in device.formats {
      let d = FaceTypeClientCameraController.dimensions(format)
      if seen.insert("\(d.0)x\(d.1)").inserted { sizes.append(d) }
    }
    sizes.sort { $0.0 * $0.1 > $1.0 * $1.1 }
    let observed = controller.observedCapabilities()
    let distortion: String = device.isGeometricDistortionCorrectionSupported
      ? (device.isGeometricDistortionCorrectionEnabled ? "on" : "off")
      : "unsupported"
    resolve([
      "platform": "ios",
      "deviceModel": FaceTypeClientDeviceInfo.model,
      "manufacturer": FaceTypeClientDeviceInfo.manufacturer,
      "osVersion": FaceTypeClientDeviceInfo.osVersion,
      "frontCamera": [
        "id": device.uniqueID,
        "sizes": sizes.map { [$0.0, $0.1] },
        // AVFoundation exposes the focal length only as per-frame EXIF, so
        // this lists what frames have actually reported (empty before any).
        "focalLengthsMm": observed.focalLengthMm.map { [$0] } ?? [Double](),
        // AVFoundation does not expose the physical sensor size.
        "sensorSizeMm": NSNull(),
        // iOS has no calibration record for video; `true` once frames have
        // actually carried AVFoundation's per-frame intrinsic matrix.
        "hasIntrinsicCalibration": observed.intrinsicMatrix,
        "distortionCorrection": distortion,
      ] as [String: Any],
      // Hash of the model file actually bundled; empty when none is.
      "mediapipeModelSha256": FaceTypeClientFrameAnalyzer.bundledModelSha256() ?? "",
    ] as [String: Any])
  }

  @objc(startBurst:resolver:rejecter:)
  func startBurst(
    _ opts: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    func number(_ key: String) -> Double? {
      guard let value = (opts[key] as? NSNumber)?.doubleValue, value.isFinite else { return nil }
      return value
    }
    guard
      let target = number("targetFrames"), target >= 1, target == target.rounded(),
      let maxDuration = number("maxDurationMs"), maxDuration > 0,
      let spacing = number("minSpacingMs"), spacing >= 0,
      let coverage = number("minCoverageMs"), coverage >= 0
    else {
      reject("invalid_argument", "startBurst needs targetFrames, maxDurationMs, minSpacingMs and minCoverageMs.", nil)
      return
    }
    controller.startBurst(
      FaceTypeClientBurstOptions(
        targetFrames: Int(target),
        maxDurationMs: maxDuration,
        minSpacingMs: spacing,
        minCoverageMs: coverage
      ),
      resolve: resolve,
      reject: reject
    )
  }

  @objc(cancelBurst:rejecter:)
  func cancelBurst(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    controller.cancelBurst { resolve(nil) }
  }

  /// PUTs the decrypted JPEG -- the exact bytes `sha256`/`bytes` describe --
  /// from memory. URLSession sends a Data body with an exact Content-Length;
  /// the plaintext never touches disk. Retries are JavaScript's.
  @objc(uploadFrame:target:resolver:rejecter:)
  func uploadFrame(
    _ frameId: String,
    target: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard
      let urlText = target["url"] as? String,
      let url = URL(string: urlText),
      let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http"
    else {
      reject("invalid_argument", "uploadFrame needs an http(s) target.url.", nil)
      return
    }
    guard (target["method"] as? String)?.uppercased() == "PUT" else {
      reject("invalid_argument", "uploadFrame only performs PUT.", nil)
      return
    }
    let body: Data
    do {
      body = try controller.spool.open(id: frameId)
    } catch let error as FaceTypeClientSpoolError {
      reject(error.code, error.message, nil)
      return
    } catch {
      reject("spool_error", "The spooled frame could not be read.", nil)
      return
    }
    var request = URLRequest(url: url)
    request.httpMethod = "PUT"
    if let headers = target["headers"] as? [String: Any] {
      for (name, value) in headers {
        // URLSession derives these from the body and the URL itself.
        let lowered = name.lowercased()
        guard lowered != "content-length", lowered != "host" else { continue }
        request.setValue("\(value)", forHTTPHeaderField: name)
      }
    }
    let task = uploads.uploadTask(with: request, from: body) { _, response, error in
      if let error {
        reject("upload_failed", error.localizedDescription, error)
        return
      }
      guard let http = response as? HTTPURLResponse else {
        reject("upload_failed", "The upload returned no HTTP response.", nil)
        return
      }
      resolve(["status": http.statusCode])
    }
    task.resume()
  }

  @objc(deleteFrames:resolver:rejecter:)
  func deleteFrames(
    _ ids: NSArray,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    controller.spool.delete(ids: ids.compactMap { $0 as? String })
    resolve(nil)
  }

  @objc(listSpool:rejecter:)
  func listSpool(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      resolve(try controller.spool.list())
    } catch let error as FaceTypeClientSpoolError {
      reject(error.code, error.message, nil)
    } catch {
      reject("spool_error", "The spool could not be listed.", nil)
    }
  }

  /// The FrameMeta sealed beside a spooled frame, for resume after a restart
  /// (contract §5.12): JavaScript never keeps landmarks or blendshapes in
  /// AsyncStorage. `not_found` for a frame no burst ever returned.
  @objc(getFrameMeta:resolver:rejecter:)
  func getFrameMeta(
    _ frameId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      resolve(try controller.spool.openMeta(id: frameId))
    } catch let error as FaceTypeClientSpoolError {
      reject(error.code, error.message, nil)
    } catch {
      reject("spool_error", "The frame metadata could not be read.", nil)
    }
  }

  /// Bridge teardown: no burst outlives the bridge that started it, and no
  /// upload keeps running for a JavaScript context that is gone.
  @objc func invalidate() {
    controller.cancelBurst {}
    uploads.invalidateAndCancel()
  }
}
