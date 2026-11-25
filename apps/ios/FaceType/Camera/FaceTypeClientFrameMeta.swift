//
//  FaceTypeClientFrameMeta.swift
//  FaceType AI — the per-frame `FrameMeta` object (docs/client-native-interface.md §4,
//  docs/capture-spec-v2.md §5).
//
//  Every key of contract §4 is always present. A value this platform cannot
//  read is JSON `null` with a sibling `<key>_missing_reason` saying why --
//  never a plausible-looking default. Two iOS-only keys are added because
//  AVFoundation reports these instead of the contract's fields:
//  `lens_position` (unitless 0–1, where Android has diopters) and
//  `awb_gains` (the device white-balance gains).
//

import AVFoundation
import CoreMedia
import Foundation
import ImageIO
import simd

/// Facts about the configured capture pipeline that hold for a whole session.
struct FaceTypeClientCameraSnapshot {
  let cameraId: String
  let deviceType: String
  let formatWidth: Int
  let formatHeight: Int
  let rotationAppliedDeg: Double
  let mirrored: Bool
  let stabilization: String
  let hdr: String
  let distortionCorrection: String
  let intrinsicDeliveryEnabled: Bool
  /// Nominal focal length in upright delivered-frame pixels, from the
  /// active format's (distortion-corrected) horizontal field of view.
  let nominalFocalPx: Double?
}

struct FaceTypeClientIntrinsics {
  let fx: Double
  let fy: Double
  let cx: Double
  let cy: Double
  let s: Double
  let refW: Double
  let refH: Double
  let source: String

  var payload: [String: Any] {
    ["fx": fx, "fy": fy, "cx": cx, "cy": cy, "s": s, "ref_w": refW, "ref_h": refH, "source": source]
  }

  /// The 3x3 matrix AVFoundation attaches to a sample buffer when
  /// `isCameraIntrinsicMatrixDeliveryEnabled` is on (column-major
  /// matrix_float3x3: fx 0 cx / s fy cy / 0 0 1, origin top-left).
  ///
  /// Which frame it is expressed in is decided from the data rather than
  /// assumed: the principal point sits near the centre of the frame it
  /// belongs to, and the delivered frame is rotated a quarter turn from the
  /// sensor, so comparing (cx, cy) with both centres tells them apart
  /// unambiguously for a 16:9 stream. `ref_w`/`ref_h` record the answer.
  static func fromAttachment(_ sampleBuffer: CMSampleBuffer, width: Int, height: Int) -> FaceTypeClientIntrinsics? {
    guard
      let raw = CMGetAttachment(
        sampleBuffer,
        key: kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix,
        attachmentModeOut: nil
      ),
      let data = raw as? Data,
      data.count >= MemoryLayout<matrix_float3x3>.size
    else { return nil }
    var matrix = matrix_float3x3()
    _ = withUnsafeMutableBytes(of: &matrix) { data.copyBytes(to: $0) }
    let fx = Double(matrix.columns.0.x)
    let fy = Double(matrix.columns.1.y)
    let cx = Double(matrix.columns.2.x)
    let cy = Double(matrix.columns.2.y)
    let s = Double(matrix.columns.1.x)
    guard [fx, fy, cx, cy, s].allSatisfy(\.isFinite), fx > 0, fy > 0 else { return nil }
    let w = Double(width)
    let h = Double(height)
    let asDelivered = abs(cx - w / 2) + abs(cy - h / 2)
    let asSensor = abs(cx - h / 2) + abs(cy - w / 2)
    let reference = asSensor < asDelivered ? (h, w) : (w, h)
    return FaceTypeClientIntrinsics(
      fx: fx, fy: fy, cx: cx, cy: cy, s: s,
      refW: reference.0, refH: reference.1,
      source: "intrinsic_matrix"
    )
  }

  static func nominal(_ focalPx: Double, width: Int, height: Int) -> FaceTypeClientIntrinsics {
    FaceTypeClientIntrinsics(
      fx: focalPx, fy: focalPx,
      cx: Double(width) / 2, cy: Double(height) / 2, s: 0,
      refW: Double(width), refH: Double(height),
      source: "nominal"
    )
  }
}

/// iOS system video effects. Portrait, Studio Light and reactions alter the
/// pixels, so frames are never stored while one is active; Center Stage is
/// switched off where the app controls it and otherwise only recorded.
struct FaceTypeClientEffects {
  var portrait: Bool?
  var studioLight: Bool?
  var centerStage: Bool?
  var reactions: Bool?

  var blocking: Bool { portrait == true || studioLight == true || reactions == true }

  static func read(_ device: AVCaptureDevice) -> FaceTypeClientEffects {
    var effects = FaceTypeClientEffects()
    effects.portrait = device.isPortraitEffectActive
    effects.centerStage = device.isCenterStageActive
    if #available(iOS 16.0, *) {
      effects.studioLight = device.isStudioLightActive
    }
    if #available(iOS 17.0, *) {
      effects.reactions = !device.reactionEffectsInProgress.isEmpty
    }
    return effects
  }

  var payload: [String: Any] {
    var out: [String: Any] = [:]
    func put(_ key: String, _ value: Bool?, _ reason: String) {
      if let value {
        out[key] = value
      } else {
        out[key] = NSNull()
        out["\(key)_missing_reason"] = reason
      }
    }
    put("portrait", portrait, "not_exposed_on_this_os")
    put("studio_light", studioLight, "requires_ios_16")
    put("center_stage", centerStage, "not_exposed_on_this_os")
    put("reactions", reactions, "requires_ios_17")
    return out
  }
}

/// Everything read about one delivered frame besides the face measurements.
struct FaceTypeClientFrameContext {
  let ptsNs: Int64?
  let receivedMonotonicNs: UInt64
  let wallMs: Int64
  let width: Int
  let height: Int
  let deliveredFps: Double?
  let frameDurationNs: Int64?
  let intrinsics: FaceTypeClientIntrinsics?
  let exposureTimeNs: Int64?
  let iso: Double?
  let focalLengthMm: Double?
  let focusMode: String
  let focusState: String
  let lensPosition: Double
  let awbMode: String
  let awbState: String
  let awbGains: [String: Double]
  let zoomRatio: Double
  let effects: FaceTypeClientEffects
  let gyroDegPerS: Double?
  let orientationDeg: Int?

  var ptsMs: Double {
    if let ptsNs { return Double(ptsNs) / 1_000_000 }
    return Double(receivedMonotonicNs) / 1_000_000
  }
}

enum FaceTypeClientDeviceInfo {
  static let manufacturer = "Apple"

  /// The hardware identifier (e.g. "iPhone14,5"), not the marketing name.
  static let model: String = {
    if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
      return simulated
    }
    var info = utsname()
    uname(&info)
    let bytes = Mirror(reflecting: info.machine).children
      .compactMap { $0.value as? Int8 }
      .prefix { $0 != 0 }
      .map { UInt8(bitPattern: $0) }
    return String(decoding: bytes, as: UTF8.self)
  }()

  static let osVersion: String = {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
  }()

  static let appVersion: String = {
    let info = Bundle.main.infoDictionary ?? [:]
    let short = info["CFBundleShortVersionString"] as? String ?? "unknown"
    let build = info["CFBundleVersion"] as? String ?? "unknown"
    return "\(short) (\(build))"
  }()
}

/// `null` + `<key>_missing_reason` for anything that could not be read.
struct FaceTypeClientMetaBuilder {
  private(set) var object: [String: Any] = [:]

  mutating func set(_ key: String, _ value: Any) {
    object[key] = value
  }

  mutating func put(_ key: String, _ value: Any?, missing reason: String) {
    if let value {
      object[key] = value
    } else {
      object[key] = NSNull()
      object["\(key)_missing_reason"] = reason
    }
  }

  mutating func number(_ key: String, _ value: Double?, missing reason: String) {
    put(key, finiteValue(value), missing: reason)
  }
}

enum FaceTypeClientFrameMeta {
  /// The capture protocol this native code implements (docs/capture-spec-v2.md).
  static let protocolVersion = "capture-spec-v2"
  static let pixelFormat = "32BGRA"
  static let encoder = "CoreImage.CIContext.jpegRepresentation"

  static func build(
    frameId: String,
    context c: FaceTypeClientFrameContext,
    camera: FaceTypeClientCameraSnapshot,
    gate: FaceTypeClientGate,
    analyzer: FaceTypeClientFrameAnalyzer,
    measurement m: FaceTypeClientMeasurement
  ) -> [String: Any] {
    var meta = FaceTypeClientMetaBuilder()
    let noFace = "no_face_measured_on_this_frame"

    meta.set("frame_id", frameId)
    meta.set("ts_monotonic_ns", NSNumber(value: c.receivedMonotonicNs))
    meta.set("ts_wall_ms", NSNumber(value: c.wallMs))
    meta.put("sensor_ts_ns", c.ptsNs.map { NSNumber(value: $0) }, missing: "sample_buffer_has_no_presentation_time")
    meta.set("stream_w", c.width)
    meta.set("stream_h", c.height)
    meta.number("delivered_fps", c.deliveredFps, missing: "fewer_than_two_frames_observed")
    meta.put("orientation_deg", c.orientationDeg, missing: "device_motion_unavailable")
    meta.set("mirrored", camera.mirrored)
    meta.set("rotation_applied_deg", camera.rotationAppliedDeg)
    meta.set("lens_facing", "front")
    meta.set("physical_camera_id", camera.cameraId)
    meta.set("device_manufacturer", FaceTypeClientDeviceInfo.manufacturer)
    meta.set("device_model", FaceTypeClientDeviceInfo.model)
    meta.set("os_version", "iOS \(FaceTypeClientDeviceInfo.osVersion)")
    meta.set("app_version", FaceTypeClientDeviceInfo.appVersion)
    meta.set("protocol_version", protocolVersion)
    meta.set("gate_config_hash", gate.hash)
    meta.set("mediapipe_model_sha256", analyzer.modelSha256)
    meta.set("mediapipe_options", analyzer.optionsPayload)

    meta.put("exposure_time_ns", c.exposureTimeNs.map { NSNumber(value: $0) }, missing: "exposure_not_reported")
    meta.number("iso", c.iso, missing: "iso_not_reported")
    meta.put("frame_duration_ns", c.frameDurationNs.map { NSNumber(value: $0) }, missing: "frame_duration_not_reported")
    meta.set("focus_mode", c.focusMode)
    meta.set("focus_state", c.focusState)
    meta.put("focus_distance_diopter", nil, missing: "avfoundation_reports_a_unitless_lens_position_see_lens_position")
    meta.set("lens_position", c.lensPosition)
    meta.set("awb_mode", c.awbMode)
    meta.set("awb_state", c.awbState)
    meta.set("awb_gains", c.awbGains)
    meta.set("pixel_format", pixelFormat)
    meta.set("encoder", encoder)
    meta.set("jpeg_quality", gate.config.jpegQuality)

    meta.number("focal_length_mm", c.focalLengthMm, missing: "no_exif_focal_length_on_this_frame")
    meta.put("sensor_size_mm", nil, missing: "not_exposed_by_avfoundation")
    meta.put("pixel_array", nil, missing: "not_exposed_by_avfoundation")
    meta.put("active_array", nil, missing: "not_exposed_by_avfoundation")
    meta.put("crop_region", nil, missing: "not_exposed_by_avfoundation")
    meta.set("zoom_ratio", c.zoomRatio)

    let intrinsics = c.intrinsics
      ?? camera.nominalFocalPx.map { FaceTypeClientIntrinsics.nominal($0, width: c.width, height: c.height) }
    meta.put("intrinsics", intrinsics?.payload, missing: "no_intrinsic_matrix_and_no_field_of_view")
    meta.set(
      "distortion",
      [
        "coeffs": NSNull(),
        "coeffs_missing_reason": "avfoundation_video_frames_carry_no_distortion_model",
        "correction_state": camera.distortionCorrection,
      ] as [String: Any]
    )
    meta.set("stabilization_state", camera.stabilization)
    meta.set("hdr_state", camera.hdr)
    meta.set("effects", c.effects.payload)

    meta.number("yaw", m.yaw, missing: "no_facial_transformation_matrix")
    meta.number("pitch", m.pitch, missing: "no_facial_transformation_matrix")
    meta.number("roll", m.roll, missing: "no_facial_transformation_matrix")
    meta.number("inter_pupil_px", m.interPupilPx, missing: noFace)
    meta.number("face_width_px", m.faceWidthPx, missing: noFace)
    meta.put("face_box", m.faceBox, missing: noFace)
    meta.put("landmarks_478", m.landmarks.isEmpty ? nil : m.landmarks, missing: noFace)
    meta.number(
      "distance_estimate_cm",
      m.distanceCm,
      missing: intrinsics == nil ? "focal_length_unknown" : "iris_not_measured"
    )
    meta.set("distance_method", "iris_\(gate.config.distance.irisMm)mm")
    meta.set("blendshapes", m.blendshapes)
    meta.number("sharpness", m.sharpness, missing: "face_crop_not_measurable")
    meta.number("clip_frac", m.clipFrac, missing: "cheek_or_nose_patch_not_measurable")
    meta.number("crush_frac", m.crushFrac, missing: "cheek_or_nose_patch_not_measurable")
    meta.number("cheek_ratio", m.cheekRatio, missing: "cheek_patch_not_measurable")
    meta.number("gyro_deg_s", c.gyroDegPerS, missing: "gyroscope_unavailable")
    meta.set("checks", m.checks.metaPayload)
    return meta.object
  }

  // MARK: - AVFoundation enum names

  static func focusModeName(_ mode: AVCaptureDevice.FocusMode) -> String {
    switch mode {
    case .locked: return "locked"
    case .autoFocus: return "auto"
    case .continuousAutoFocus: return "continuous_auto"
    @unknown default: return "unknown"
    }
  }

  static func whiteBalanceModeName(_ mode: AVCaptureDevice.WhiteBalanceMode) -> String {
    switch mode {
    case .locked: return "locked"
    case .autoWhiteBalance: return "auto"
    case .continuousAutoWhiteBalance: return "continuous_auto"
    @unknown default: return "unknown"
    }
  }

  static func stabilizationName(_ mode: AVCaptureVideoStabilizationMode) -> String {
    switch mode {
    case .off: return "off"
    case .standard: return "standard"
    case .cinematic: return "cinematic"
    case .cinematicExtended: return "cinematic_extended"
    case .auto: return "auto"
    default: return "mode_\(mode.rawValue)"
    }
  }

  /// Per-frame EXIF the capture pipeline attaches to video sample buffers.
  static func exif(_ sampleBuffer: CMSampleBuffer) -> [String: Any]? {
    CMGetAttachment(sampleBuffer, key: kCGImagePropertyExifDictionary, attachmentModeOut: nil) as? [String: Any]
  }
}
