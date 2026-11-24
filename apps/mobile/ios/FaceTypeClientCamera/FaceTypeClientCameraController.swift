//
//  FaceTypeClientCameraController.swift
//  FaceType AI — the client camera's single owner of frames
//  (docs/client-native-interface.md, docs/capture-spec-v2.md §2 and §4).
//
//  Owns the AVCaptureSession, the per-frame QA, JPEG encoding, burst
//  selection and the encrypted spool; JavaScript only guides and presents.
//
//  STREAM. Front camera (`.builtInWideAngleCamera`, else
//  `.builtInTrueDepthCamera` used purely as a camera), the highest of the
//  config's preferred sizes (floor `stream.minSize`), BGRA video data output
//  that discards late frames, rotated by the connection to upright portrait
//  and NOT mirrored, stabilisation off, HDR off, geometric distortion
//  correction on where supported, Center Stage off where the app controls
//  it, camera intrinsic matrix delivery on where supported. Portrait, Studio
//  Light and reaction effects block storing while active (`effects_active`).
//
//  SAME BUFFER. Each delivered buffer is measured (MediaPipe on a downscaled
//  copy, pixel statistics on the buffer itself) and, if it becomes a burst
//  candidate, JPEG-encoded from that same buffer at full delivered
//  resolution, upright and unmirrored, before the delegate returns it.
//
//  WHAT THIS FILE MUST NEVER DO
//  Use ARKit, Face ID, LocalAuthentication or the Secure Enclave (FT-00 §3).
//
//  THREADS. Session lifecycle runs on `sessionQueue`; every frame, the
//  analyser, the gate and the burst live on `videoQueue`; UI and RN events on
//  main. `lock` guards only `generation`, `sink` and the observed-capability
//  flags. No queue ever waits synchronously on `sessionQueue`, so the
//  `videoQueue.sync` calls made from it cannot deadlock.
//

import AVFoundation
import CoreImage
import CoreMedia
import CoreMotion
import CryptoKit
import Foundation
import ImageIO
import React
import UIKit

/// The `onError` codes of docs/client-native-interface.md §2 -- no others.
enum FaceTypeClientErrorCode: String {
  case permissionDenied = "permission_denied"
  case cameraUnavailable = "camera_unavailable"
  case cameraInterrupted = "camera_interrupted"
  case modelUnavailable = "model_unavailable"
  case effectsActive = "effects_active"
  case internalError = "internal"
}

/// The mounted `FaceTypeClientCameraView`. Called on the main thread only.
protocol FaceTypeClientCameraEventSink: AnyObject {
  func clientCameraMeasured(_ payload: [String: Any])
  func clientCameraBurstProgress(_ payload: [String: Any])
  func clientCameraError(code: String, message: String)
  func clientCameraAttachPreview(_ session: AVCaptureSession?)
}

final class FaceTypeClientCameraController: NSObject {
  static let shared = FaceTypeClientCameraController()

  /// `onFrameMeasure` and `onBurstProgress` are capped at 15 Hz.
  static let eventIntervalNs: UInt64 = 1_000_000_000 / 15
  /// Upright portrait from the sensor's native landscape orientation.
  static let portraitRotationDeg: Double = 90
  /// A throughput cap, not a gate: more than 30 fps only costs analysis time.
  static let maxRequestedFps: Double = 30

  let spool = FaceTypeClientSpool()

  private let sessionQueue = DispatchQueue(label: "ai.facetype.client-camera.session")
  private let videoQueue = DispatchQueue(label: "ai.facetype.client-camera.video", qos: .userInitiated)

  // `lock`-guarded.
  private let lock = NSLock()
  private var generation: UInt64 = 0
  private weak var sink: FaceTypeClientCameraEventSink?
  private var observedIntrinsicMatrix = false
  private var observedFocalLengthMm: Double?

  // `sessionQueue`-confined.
  private var session: AVCaptureSession?
  private var observers: [NSObjectProtocol] = []
  private let motion = CMMotionManager()

  // `videoQueue`-confined.
  private struct Running {
    let session: AVCaptureSession
    let device: AVCaptureDevice
    let output: AVCaptureVideoDataOutput
    let camera: FaceTypeClientCameraSnapshot
  }

  private var running: Running?
  private var analyzer: FaceTypeClientFrameAnalyzer?
  private var gate: FaceTypeClientGate?
  private var burst: FaceTypeClientBurst?
  private var lastMeasureNs: UInt64 = 0
  private var lastPtsNs: Int64?
  private var fps: Double?
  private var effectsBlocking = false
  private var frameSequence: UInt64 = 0
  private let ciContext = CIContext(options: [.cacheIntermediates: false])

  // MARK: - view lifecycle (main thread)

  /// Starts (or keeps) the camera for `sink`. Returns the token the view
  /// later hands to `deactivate`.
  @discardableResult
  func activate(_ sink: FaceTypeClientCameraEventSink, gate: FaceTypeClientGate) -> UInt64 {
    lock.lock()
    generation &+= 1
    let token = generation
    self.sink = sink
    lock.unlock()
    videoQueue.async { self.gate = gate }
    sessionQueue.async { self.startOnQueue(generation: token) }
    return token
  }

  func updateGate(_ gate: FaceTypeClientGate) {
    videoQueue.async { self.gate = gate }
  }

  /// Stops the camera if `token` is still the current activation; a view
  /// that was superseded by a newer one cannot stop the newer one's camera.
  func deactivate(token: UInt64) {
    lock.lock()
    guard generation == token else {
      lock.unlock()
      return
    }
    generation &+= 1
    sink = nil
    lock.unlock()
    sessionQueue.async { self.stopOnQueue(burstStatus: .cancelled) }
  }

  private func isCurrent(_ token: UInt64) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return generation == token
  }

  // MARK: - session lifecycle (sessionQueue)

  private func startOnQueue(generation token: UInt64) {
    dispatchPrecondition(condition: .onQueue(sessionQueue))
    guard isCurrent(token) else { return }
    if let session {
      // Already running for an earlier activation: hand it to the new view.
      emitPreview(session)
      return
    }
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      configureAndRunOnQueue(generation: token)
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { granted in
        self.sessionQueue.async {
          // Decided in queue order: a prompt answered after the screen went
          // away must neither open the camera nor report a denial.
          guard self.isCurrent(token) else { return }
          if granted {
            self.configureAndRunOnQueue(generation: token)
          } else {
            self.emitError(.permissionDenied, "Camera access was denied.")
          }
        }
      }
    case .denied, .restricted:
      emitError(.permissionDenied, "Camera access is not permitted for this app.")
    @unknown default:
      emitError(.permissionDenied, "Camera authorisation could not be determined.")
    }
  }

  private func configureAndRunOnQueue(generation token: UInt64) {
    dispatchPrecondition(condition: .onQueue(sessionQueue))
    guard isCurrent(token), session == nil else { return }

    // The model first: without it no frame can be judged, so the camera
    // never opens for nothing.
    var analyzer = videoQueue.sync { self.analyzer }
    if analyzer == nil {
      switch FaceTypeClientFrameAnalyzer.make() {
      case .success(let made):
        analyzer = made
      case .failure(let error):
        emitError(.modelUnavailable, error.message)
        return
      }
    }
    guard let gate = videoQueue.sync(execute: { self.gate }) else {
      emitError(.internalError, "No gate config is set.")
      return
    }
    guard let device = Self.frontCamera() else {
      emitError(.cameraUnavailable, "This device has no front camera.")
      return
    }
    guard let format = Self.selectFormat(device, gate.config) else {
      emitError(.cameraUnavailable, "The front camera offers no format at or above the configured floor.")
      return
    }
    let input: AVCaptureDeviceInput
    do {
      input = try AVCaptureDeviceInput(device: device)
    } catch {
      emitError(.cameraUnavailable, "The front camera could not be opened: \(error.localizedDescription)")
      return
    }

    let captureSession = AVCaptureSession()
    captureSession.beginConfiguration()
    if captureSession.canSetSessionPreset(.inputPriority) {
      captureSession.sessionPreset = .inputPriority
    }
    guard captureSession.canAddInput(input) else {
      captureSession.commitConfiguration()
      emitError(.cameraUnavailable, "The front camera cannot be added to a capture session.")
      return
    }
    captureSession.addInput(input)

    do {
      try Self.configure(device, format: format)
    } catch {
      captureSession.commitConfiguration()
      emitError(.cameraUnavailable, "The front camera could not be configured: \(error.localizedDescription)")
      return
    }

    let output = AVCaptureVideoDataOutput()
    output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    output.alwaysDiscardsLateVideoFrames = true
    guard captureSession.canAddOutput(output) else {
      captureSession.commitConfiguration()
      emitError(.cameraUnavailable, "The video output cannot be added to the capture session.")
      return
    }
    captureSession.addOutput(output)
    guard let connection = output.connection(with: .video) else {
      captureSession.commitConfiguration()
      emitError(.cameraUnavailable, "The video output has no connection to the front camera.")
      return
    }
    let rotation = Self.configure(connection)
    captureSession.commitConfiguration()

    Self.disableCenterStageWhereAllowed()

    let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
    let camera = FaceTypeClientCameraSnapshot(
      cameraId: "\(device.deviceType.rawValue)/\(device.uniqueID)",
      deviceType: device.deviceType.rawValue,
      formatWidth: Int(dimensions.width),
      formatHeight: Int(dimensions.height),
      rotationAppliedDeg: rotation,
      mirrored: connection.isVideoMirrored,
      stabilization: connection.isVideoStabilizationSupported
        ? FaceTypeClientFrameMeta.stabilizationName(connection.activeVideoStabilizationMode)
        : "unsupported",
      hdr: format.isVideoHDRSupported ? (device.isVideoHDREnabled ? "on" : "off") : "unsupported",
      distortionCorrection: device.isGeometricDistortionCorrectionSupported
        ? (device.isGeometricDistortionCorrectionEnabled ? "on" : "off")
        : "unsupported",
      intrinsicDeliveryEnabled: connection.isCameraIntrinsicMatrixDeliveryEnabled,
      nominalFocalPx: Self.nominalFocalPx(device, format: format)
    )

    output.setSampleBufferDelegate(self, queue: videoQueue)
    videoQueue.sync {
      self.analyzer = analyzer
      self.running = Running(session: captureSession, device: device, output: output, camera: camera)
      self.lastPtsNs = nil
      self.fps = nil
      self.effectsBlocking = false
      self.lastMeasureNs = 0
    }
    self.session = captureSession
    addObservers(captureSession)
    startMotion()
    captureSession.startRunning()

    // `startRunning` blocks; the view may have gone away meanwhile.
    guard isCurrent(token) else {
      stopOnQueue(burstStatus: .cancelled)
      return
    }
    emitPreview(captureSession)
  }

  private func stopOnQueue(burstStatus: FaceTypeClientBurstStatus) {
    dispatchPrecondition(condition: .onQueue(sessionQueue))
    removeObservers()
    stopMotion()
    let ending = session
    session = nil
    if let ending {
      ending.stopRunning()
      for output in ending.outputs {
        (output as? AVCaptureVideoDataOutput)?.setSampleBufferDelegate(nil, queue: nil)
      }
    }
    // Drains any frame still in flight and settles a burst that was running.
    videoQueue.sync {
      self.running = nil
      self.finishBurstOnVideoQueue(burstStatus)
    }
    DispatchQueue.main.async {
      // Only clear a preview showing the session that just ended.
      self.lock.lock()
      let sink = self.sink
      self.lock.unlock()
      if ending != nil { sink?.clientCameraAttachPreview(nil) }
    }
  }

  private func addObservers(_ session: AVCaptureSession) {
    let center = NotificationCenter.default
    observers.append(
      center.addObserver(forName: .AVCaptureSessionWasInterrupted, object: session, queue: nil) {
        [weak self] _ in
        self?.emitError(.cameraInterrupted, "The camera was interrupted.")
        self?.videoQueue.async { self?.finishBurstOnVideoQueue(.partial) }
      }
    )
    observers.append(
      center.addObserver(forName: .AVCaptureSessionRuntimeError, object: session, queue: nil) {
        [weak self] note in
        guard let self else { return }
        let error = note.userInfo?[AVCaptureSessionErrorKey] as? AVError
        self.videoQueue.async { self.finishBurstOnVideoQueue(.partial) }
        if error?.code == .mediaServicesWereReset {
          self.sessionQueue.async {
            if let current = self.session, current === session, !current.isRunning {
              current.startRunning()
            }
          }
        } else {
          self.emitError(.cameraUnavailable, "The capture session failed: \(error?.localizedDescription ?? "unknown error").")
        }
      }
    )
  }

  private func removeObservers() {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers.removeAll()
  }

  private func startMotion() {
    if motion.isDeviceMotionAvailable {
      motion.deviceMotionUpdateInterval = 1.0 / 60
      motion.startDeviceMotionUpdates()
    } else if motion.isGyroAvailable {
      motion.gyroUpdateInterval = 1.0 / 60
      motion.startGyroUpdates()
    }
  }

  private func stopMotion() {
    motion.stopDeviceMotionUpdates()
    motion.stopGyroUpdates()
  }

  // MARK: - device and connection configuration

  static func frontCamera() -> AVCaptureDevice? {
    let discovery = AVCaptureDevice.DiscoverySession(
      deviceTypes: [.builtInWideAngleCamera, .builtInTrueDepthCamera],
      mediaType: .video,
      position: .front
    )
    return discovery.devices.first { $0.deviceType == .builtInWideAngleCamera } ?? discovery.devices.first
  }

  static func dimensions(_ format: AVCaptureDevice.Format) -> (Int, Int) {
    let d = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
    return (Int(d.width), Int(d.height))
  }

  /// The highest of `stream.preferredSizes` this camera offers, in the
  /// config's order; otherwise the largest format at or above
  /// `stream.minSize`; otherwise none. Among formats of one size: reaching
  /// `preferredMinFps`, then not supporting Portrait/Studio Light/reactions,
  /// then full-range 4:2:0, then the higher frame rate (up to 30).
  static func selectFormat(_ device: AVCaptureDevice, _ config: FaceTypeClientGateConfig) -> AVCaptureDevice.Format? {
    let video = device.formats.filter {
      CMFormatDescriptionGetMediaType($0.formatDescription) == kCMMediaType_Video
    }
    func maxFps(_ f: AVCaptureDevice.Format) -> Double {
      f.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 0
    }
    func supportsEffects(_ f: AVCaptureDevice.Format) -> Bool {
      var any = f.isPortraitEffectSupported
      if #available(iOS 16.0, *) { any = any || f.isStudioLightSupported }
      if #available(iOS 17.0, *) { any = any || f.reactionEffectsSupported }
      return any
    }
    func rank(_ f: AVCaptureDevice.Format) -> (Int, Int, Int, Double) {
      let fullRange = CMFormatDescriptionGetMediaSubType(f.formatDescription)
        == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
      return (
        maxFps(f) >= config.stream.preferredMinFps ? 1 : 0,
        supportsEffects(f) ? 0 : 1,
        fullRange ? 1 : 0,
        min(maxFps(f), maxRequestedFps)
      )
    }
    for (width, height) in config.preferredSizes {
      let matches = video.filter { dimensions($0) == (width, height) }
      if let best = matches.max(by: { rank($0) < rank($1) }) { return best }
    }
    let floor = config.minSize
    let acceptable = video.filter {
      let d = dimensions($0)
      return d.0 >= floor.0 && d.1 >= floor.1
    }
    return acceptable.max { a, b in
      let da = dimensions(a)
      let db = dimensions(b)
      if da.0 * da.1 != db.0 * db.1 { return da.0 * da.1 < db.0 * db.1 }
      return rank(a) < rank(b)
    }
  }

  private static func configure(_ device: AVCaptureDevice, format: AVCaptureDevice.Format) throws {
    try device.lockForConfiguration()
    defer { device.unlockForConfiguration() }
    device.activeFormat = format
    let cap = CMTime(value: 1, timescale: CMTimeScale(maxRequestedFps))
    if format.videoSupportedFrameRateRanges.contains(where: {
      $0.minFrameRate <= maxRequestedFps && maxRequestedFps <= $0.maxFrameRate
    }) {
      device.activeVideoMinFrameDuration = cap
    }
    // HDR off. The automatic flag must be cleared before the explicit one
    // may be set, and the explicit one only exists on HDR-capable formats.
    device.automaticallyAdjustsVideoHDREnabled = false
    if format.isVideoHDRSupported {
      device.isVideoHDREnabled = false
    }
    if device.isGeometricDistortionCorrectionSupported {
      device.isGeometricDistortionCorrectionEnabled = true
    }
    if device.isFocusModeSupported(.continuousAutoFocus) {
      device.focusMode = .continuousAutoFocus
    }
    if device.isExposureModeSupported(.continuousAutoExposure) {
      device.exposureMode = .continuousAutoExposure
    }
    if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
      device.whiteBalanceMode = .continuousAutoWhiteBalance
    }
  }

  /// Returns the rotation actually applied, in degrees.
  private static func configure(_ connection: AVCaptureConnection) -> Double {
    // Stored frames are never mirrored. The automatic flag must be cleared
    // before `isVideoMirrored` may be set at all.
    if connection.isVideoMirroringSupported {
      connection.automaticallyAdjustsVideoMirroring = false
      connection.isVideoMirrored = false
    }
    var rotation: Double = 0
    if #available(iOS 17.0, *) {
      if connection.isVideoRotationAngleSupported(portraitRotationDeg) {
        connection.videoRotationAngle = portraitRotationDeg
      }
      rotation = Double(connection.videoRotationAngle)
    } else if connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
      rotation = portraitRotationDeg
    }
    if connection.isVideoStabilizationSupported {
      connection.preferredVideoStabilizationMode = .off
    }
    if connection.isCameraIntrinsicMatrixDeliverySupported {
      connection.isCameraIntrinsicMatrixDeliveryEnabled = true
    }
    return rotation
  }

  /// Center Stage is a process-wide setting. Taking `.app` control is what
  /// allows the app to switch it off; if control stays with the user, the
  /// state is only recorded per frame.
  private static func disableCenterStageWhereAllowed() {
    if AVCaptureDevice.centerStageControlMode == .user {
      AVCaptureDevice.centerStageControlMode = .app
    }
    if AVCaptureDevice.centerStageControlMode != .user {
      AVCaptureDevice.isCenterStageEnabled = false
    }
  }

  /// Focal length in upright delivered-frame pixels from the format's
  /// horizontal field of view, which spans the landscape width -- the
  /// upright frame's height.
  private static func nominalFocalPx(_ device: AVCaptureDevice, format: AVCaptureDevice.Format) -> Double? {
    let fieldOfView = device.isGeometricDistortionCorrectionEnabled
      ? Double(format.geometricDistortionCorrectedVideoFieldOfView)
      : Double(format.videoFieldOfView)
    guard fieldOfView > 0, fieldOfView < 180 else { return nil }
    let landscapeWidth = Double(dimensions(format).0)
    let focal = (landscapeWidth / 2) / tan(fieldOfView * Double.pi / 360) * Double(device.videoZoomFactor)
    return finiteValue(focal)
  }

  // MARK: - burst (any thread in, videoQueue inside)

  func startBurst(
    _ options: FaceTypeClientBurstOptions,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    videoQueue.async {
      guard self.burst == nil else {
        reject("burst_in_progress", "A burst is already running.", nil)
        return
      }
      guard self.running != nil else {
        reject(FaceTypeClientErrorCode.cameraUnavailable.rawValue, "The camera is not running.", nil)
        return
      }
      guard self.analyzer != nil, let gate = self.gate else {
        reject(FaceTypeClientErrorCode.modelUnavailable.rawValue, "The face landmarker is not loaded.", nil)
        return
      }
      guard !self.effectsBlocking else {
        reject(FaceTypeClientErrorCode.effectsActive.rawValue, "A system video effect is active.", nil)
        return
      }
      let burst = FaceTypeClientBurst(
        options: options,
        gate: gate.config,
        startedNs: DispatchTime.now().uptimeNanoseconds,
        resolve: resolve
      )
      self.burst = burst
      let token = burst.token
      let deadline = DispatchTime.now() + .milliseconds(Int(options.maxDurationMs.rounded(.up)))
      self.videoQueue.asyncAfter(deadline: deadline) {
        // Also ends a burst whose frames stopped arriving altogether.
        if self.burst?.token == token { self.finishBurstOnVideoQueue(.partial) }
      }
      self.emitProgress(burst, force: true)
    }
  }

  func cancelBurst(_ done: @escaping () -> Void) {
    videoQueue.async {
      self.finishBurstOnVideoQueue(.cancelled)
      done()
    }
  }

  private func finishBurstOnVideoQueue(_ requested: FaceTypeClientBurstStatus) {
    dispatchPrecondition(condition: .onQueue(videoQueue))
    guard let burst else { return }
    self.burst = nil
    let outcome = burst.outcome(requested)
    spool.delete(ids: outcome.discarded.map(\.id))

    var frames: [[String: Any]] = []
    var unsealed: [String] = []
    for candidate in outcome.selected {
      var meta = candidate.meta
      if var checks = meta["checks"] as? [String: Any] {
        // Every returned frame passed both burst-relative rules.
        checks["sharp_relative_to_burst_max"] = true
        checks["eyes_relative_opening"] = true
        meta["checks"] = checks
      }
      // The final FrameMeta is sealed beside its JPEG for `getFrameMeta`
      // (contract §5.12). A frame whose metadata could not be kept is not
      // returned: after a restart it could never be resumed.
      do {
        try spool.storeMeta(id: candidate.id, meta: meta)
      } catch {
        unsealed.append(candidate.id)
        continue
      }
      frames.append([
        "id": candidate.id,
        "width": candidate.width,
        "height": candidate.height,
        "sha256": candidate.sha256,
        "bytes": candidate.bytes,
        "meta": meta,
      ])
    }
    var status = outcome.status
    if !unsealed.isEmpty {
      spool.delete(ids: unsealed)
      emitError(.internalError, "Frame metadata could not be written to the encrypted spool.")
      if status == .complete { status = .partial }
    }

    burst.resolve([
      "status": status.rawValue,
      "topRejectReason": outcome.topRejectReason ?? NSNull(),
      "frames": frames,
    ] as [String: Any])
    let now = DispatchTime.now().uptimeNanoseconds
    let accepted = frames.count
    emitSink { sink in
      sink.clientCameraBurstProgress([
        "accepted": accepted,
        "target": burst.options.targetFrames,
        "elapsedMs": Int(burst.elapsedMs(now: now).rounded()),
        "topRejectReason": outcome.topRejectReason ?? NSNull(),
      ])
    }
    // One success tick, only for a complete burst (contract §5.13).
    if status == .complete {
      DispatchQueue.main.async {
        let haptic = UINotificationFeedbackGenerator()
        haptic.prepare()
        haptic.notificationOccurred(.success)
      }
    }
  }

  private func emitProgress(_ burst: FaceTypeClientBurst, force: Bool) {
    let now = DispatchTime.now().uptimeNanoseconds
    guard force || now &- burst.lastProgressNs >= Self.eventIntervalNs else { return }
    burst.lastProgressNs = now
    let payload: [String: Any] = [
      "accepted": burst.acceptedCount,
      "target": burst.options.targetFrames,
      "elapsedMs": Int(burst.elapsedMs(now: now).rounded()),
      "topRejectReason": burst.topRejectReason ?? NSNull(),
    ]
    emitSink { $0.clientCameraBurstProgress(payload) }
  }

  // MARK: - capabilities

  func observedCapabilities() -> (intrinsicMatrix: Bool, focalLengthMm: Double?) {
    lock.lock()
    defer { lock.unlock() }
    return (observedIntrinsicMatrix, observedFocalLengthMm)
  }

  // MARK: - per frame (videoQueue)

  private func process(_ sampleBuffer: CMSampleBuffer, run: Running) {
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer),
      let analyzer, let gate
    else { return }
    let receivedNs = DispatchTime.now().uptimeNanoseconds
    let wallMs = Int64((Date().timeIntervalSince1970 * 1000).rounded())
    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)

    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    let ptsNs: Int64? = pts.isNumeric
      ? CMTimeConvertScale(pts, timescale: 1_000_000_000, method: .default).value
      : nil
    var frameDurationNs: Int64?
    let duration = CMSampleBufferGetDuration(sampleBuffer)
    if duration.isNumeric, duration.value > 0 {
      frameDurationNs = CMTimeConvertScale(duration, timescale: 1_000_000_000, method: .default).value
    }
    if let ptsNs, let last = lastPtsNs, ptsNs > last {
      let delta = ptsNs - last
      if frameDurationNs == nil { frameDurationNs = delta }
      let instant = 1e9 / Double(delta)
      fps = fps.map { 0.9 * $0 + 0.1 * instant } ?? instant
    }
    lastPtsNs = ptsNs ?? lastPtsNs

    let effects = FaceTypeClientEffects.read(run.device)
    if effects.blocking != effectsBlocking {
      effectsBlocking = effects.blocking
      if effects.blocking {
        emitError(.effectsActive, "A system video effect (Portrait, Studio Light or a reaction) is active.")
      }
    }

    let intrinsics = FaceTypeClientIntrinsics.fromAttachment(sampleBuffer, width: width, height: height)
    let focalPx = intrinsics?.fx ?? run.camera.nominalFocalPx
    let exif = FaceTypeClientFrameMeta.exif(sampleBuffer)
    let focalLengthMm = (exif?[kCGImagePropertyExifFocalLength as String] as? NSNumber)?.doubleValue
    if intrinsics != nil || focalLengthMm != nil {
      lock.lock()
      if intrinsics != nil { observedIntrinsicMatrix = true }
      if let focalLengthMm { observedFocalLengthMm = focalLengthMm }
      lock.unlock()
    }

    let ptsMs = Double(ptsNs ?? Int64(receivedNs)) / 1_000_000
    let measurement = analyzer.analyse(
      pixelBuffer,
      gate: gate.config,
      focalPx: focalPx
    )
    let gyro = gyroDegPerS()
    let exposureNs = Self.exposureTimeNs(exif: exif, device: run.device)
    frameSequence &+= 1

    if let burst {
      if burst.elapsedMs(now: receivedNs) >= burst.options.maxDurationMs {
        finishBurstOnVideoQueue(.partial)
      } else {
        if effects.blocking {
          burst.countReject("effects_active")
        } else if let failure = measurement.checks.firstFailure {
          burst.countReject(failure)
        } else if burst.isSpaced(ptsMs) {
          let context = frameContext(
            sampleBuffer: sampleBuffer, device: run.device, exif: exif,
            ptsNs: ptsNs, receivedNs: receivedNs, wallMs: wallMs, width: width, height: height,
            frameDurationNs: frameDurationNs, intrinsics: intrinsics, focalLengthMm: focalLengthMm,
            exposureNs: exposureNs, effects: effects, gyro: gyro
          )
          if storeCandidate(pixelBuffer, burst: burst, context: context, camera: run.camera,
                            gate: gate, analyzer: analyzer, measurement: measurement)
          {
            if burst.isComplete {
              finishBurstOnVideoQueue(.complete)
            } else {
              emitProgress(burst, force: true)
            }
          }
        }
        if self.burst === burst { emitProgress(burst, force: false) }
      }
    }

    if receivedNs &- lastMeasureNs >= Self.eventIntervalNs {
      lastMeasureNs = receivedNs
      let payload = Self.measurePayload(
        measurement, frameId: String(frameSequence), tsMs: ptsMs, gyro: gyro, exposureNs: exposureNs
      )
      emitSink { $0.clientCameraMeasured(payload) }
    }
  }

  /// Encodes, hashes and seals one candidate from the buffer it was measured
  /// on. Returns false (and counts the reason) if any step fails.
  private func storeCandidate(
    _ pixelBuffer: CVPixelBuffer,
    burst: FaceTypeClientBurst,
    context: FaceTypeClientFrameContext,
    camera: FaceTypeClientCameraSnapshot,
    gate: FaceTypeClientGate,
    analyzer: FaceTypeClientFrameAnalyzer,
    measurement: FaceTypeClientMeasurement
  ) -> Bool {
    guard let sharpness = measurement.sharpness,
      let openingL = measurement.openingL,
      let openingR = measurement.openingR,
      let jpeg = encodeJPEG(pixelBuffer, quality: gate.config.jpegQuality)
    else {
      burst.countReject("internal")
      return false
    }
    let id = UUID().uuidString.lowercased()
    do {
      try spool.store(id: id, jpeg: jpeg)
    } catch {
      burst.countReject("internal")
      emitError(.internalError, "A frame could not be written to the encrypted spool.")
      return false
    }
    let sha256 = SHA256.hash(data: jpeg).map { String(format: "%02x", $0) }.joined()
    let meta = FaceTypeClientFrameMeta.build(
      frameId: id, context: context, camera: camera, gate: gate,
      analyzer: analyzer, measurement: measurement
    )
    burst.add(
      FaceTypeClientBurstCandidate(
        id: id,
        ptsMs: context.ptsMs,
        width: CVPixelBufferGetWidth(pixelBuffer),
        height: CVPixelBufferGetHeight(pixelBuffer),
        sha256: sha256,
        bytes: jpeg.count,
        meta: meta,
        sharpness: sharpness,
        openingL: openingL,
        openingR: openingR
      )
    )
    return true
  }

  /// JPEG at the config quality from the delivered buffer itself: full
  /// resolution, upright as the connection delivered it, never mirrored or
  /// re-oriented, and with no metadata carried over from the buffer.
  private func encodeJPEG(_ pixelBuffer: CVPixelBuffer, quality: Int) -> Data? {
    let image = CIImage(cvPixelBuffer: pixelBuffer, options: [.properties: [String: Any]()])
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    let qualityKey = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
    guard
      let jpeg = ciContext.jpegRepresentation(
        of: image,
        colorSpace: colorSpace,
        options: [qualityKey: Double(quality) / 100]
      ),
      !jpeg.isEmpty
    else { return nil }
    return jpeg
  }

  private func frameContext(
    sampleBuffer: CMSampleBuffer,
    device: AVCaptureDevice,
    exif: [String: Any]?,
    ptsNs: Int64?,
    receivedNs: UInt64,
    wallMs: Int64,
    width: Int,
    height: Int,
    frameDurationNs: Int64?,
    intrinsics: FaceTypeClientIntrinsics?,
    focalLengthMm: Double?,
    exposureNs: Int64?,
    effects: FaceTypeClientEffects,
    gyro: Double?
  ) -> FaceTypeClientFrameContext {
    var iso = (exif?[kCGImagePropertyExifISOSpeedRatings as String] as? [NSNumber])?.first?.doubleValue
    if iso == nil, device.iso.isFinite, device.iso > 0 { iso = Double(device.iso) }
    let gains = device.deviceWhiteBalanceGains
    return FaceTypeClientFrameContext(
      ptsNs: ptsNs,
      receivedMonotonicNs: receivedNs,
      wallMs: wallMs,
      width: width,
      height: height,
      deliveredFps: fps,
      frameDurationNs: frameDurationNs,
      intrinsics: intrinsics,
      exposureTimeNs: exposureNs,
      iso: iso,
      focalLengthMm: focalLengthMm,
      focusMode: FaceTypeClientFrameMeta.focusModeName(device.focusMode),
      focusState: device.isAdjustingFocus ? "scanning" : "stable",
      lensPosition: Double(device.lensPosition),
      awbMode: FaceTypeClientFrameMeta.whiteBalanceModeName(device.whiteBalanceMode),
      awbState: device.isAdjustingWhiteBalance ? "adjusting" : "stable",
      awbGains: [
        "red": Double(gains.redGain), "green": Double(gains.greenGain), "blue": Double(gains.blueGain),
      ],
      zoomRatio: Double(device.videoZoomFactor),
      effects: effects,
      gyroDegPerS: gyro,
      orientationDeg: orientationDeg()
    )
  }

  /// Exposure time of this frame in ns: the sample buffer's own EXIF
  /// ExposureTime first, the device's current `exposureDuration` where a frame
  /// carries none, `nil` when neither is readable. Sent with every
  /// `onFrameMeasure` (contract §5.11) and stored as `exposure_time_ns`.
  static func exposureTimeNs(exif: [String: Any]?, device: AVCaptureDevice) -> Int64? {
    if let seconds = (exif?[kCGImagePropertyExifExposureTime as String] as? NSNumber)?.doubleValue,
      seconds.isFinite, seconds > 0
    {
      return Int64((seconds * 1e9).rounded())
    }
    let duration = device.exposureDuration
    guard duration.isNumeric, duration.value > 0 else { return nil }
    return CMTimeConvertScale(duration, timescale: 1_000_000_000, method: .default).value
  }

  private func gyroDegPerS() -> Double? {
    let rate = motion.deviceMotion?.rotationRate ?? motion.gyroData?.rotationRate
    guard let rate else { return nil }
    let radians = (rate.x * rate.x + rate.y * rate.y + rate.z * rate.z).squareRoot()
    return finiteValue(radians * 180 / Double.pi)
  }

  /// How far the phone is turned from upright portrait (0/90/180/270),
  /// from gravity. The connection always delivers portrait, so anything but
  /// 0 means the stored image is rotated relative to the scene.
  private func orientationDeg() -> Int? {
    guard let gravity = motion.deviceMotion?.gravity else { return nil }
    let angle = atan2(gravity.x, -gravity.y) * 180 / Double.pi
    guard angle.isFinite else { return nil }
    let quarter = Int((angle / 90).rounded())
    return ((quarter * 90) % 360 + 360) % 360
  }

  static func measurePayload(
    _ m: FaceTypeClientMeasurement,
    frameId: String,
    tsMs: Double,
    gyro: Double?,
    exposureNs: Int64?
  ) -> [String: Any] {
    func n(_ value: Double?) -> Any { finiteValue(value) ?? NSNull() }
    return [
      "frameId": frameId,
      "tsMs": tsMs,
      "faces": m.faces,
      "yaw": n(m.yaw),
      "pitch": n(m.pitch),
      "roll": n(m.roll),
      "interPupilPx": n(m.interPupilPx),
      "faceBox": m.faceBox ?? NSNull(),
      "eyeMidX": n(m.eyeMidX),
      "faceCentreY": n(m.faceCentreY),
      "faceWidthPx": n(m.faceWidthPx),
      "distanceCm": n(m.distanceCm),
      "clipFrac": n(m.clipFrac),
      "crushFrac": n(m.crushFrac),
      "cheekRatio": n(m.cheekRatio),
      "smile": n(m.smile),
      "jawOpen": n(m.jawOpen),
      "blinkL": n(m.blinkL),
      "blinkR": n(m.blinkR),
      "sharpness": n(m.sharpness),
      "gyroDegPerS": n(gyro),
      // Contract §5.11: guidance shows «اجعل الضوء أمامك» above 1/30 s.
      "exposureTimeNs": exposureNs.map { NSNumber(value: $0) } ?? NSNull(),
      "checks": m.checks.eventPayload,
    ]
  }

  // MARK: - events (main thread)

  private func emitSink(_ body: @escaping (FaceTypeClientCameraEventSink) -> Void) {
    DispatchQueue.main.async {
      self.lock.lock()
      let sink = self.sink
      self.lock.unlock()
      if let sink { body(sink) }
    }
  }

  private func emitError(_ code: FaceTypeClientErrorCode, _ message: String) {
    emitSink { $0.clientCameraError(code: code.rawValue, message: message) }
  }

  private func emitPreview(_ session: AVCaptureSession) {
    emitSink { $0.clientCameraAttachPreview(session) }
  }
}

extension FaceTypeClientCameraController: AVCaptureVideoDataOutputSampleBufferDelegate {
  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    // Only frames of the session this controller is currently running.
    guard let run = running, output === run.output else { return }
    process(sampleBuffer, run: run)
  }
}
