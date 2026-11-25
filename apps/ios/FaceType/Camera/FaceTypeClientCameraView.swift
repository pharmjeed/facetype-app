//
//  FaceTypeClientCameraView.swift
//  FaceType AI — `FaceTypeClientCameraView` (docs/client-native-interface.md §2).
//
//  Props: `active`, `gateConfig` (JSON); events: `onFrameMeasure` (<= 15 Hz),
//  `onBurstProgress`, `onError`. The camera runs only while the view is in a
//  window, `active` is true and `gateConfig` decoded; any of the three going
//  away stops it.
//
//  The preview layer is display only. It is mirrored like a selfie view, as
//  the system does for the front camera; the frames that are measured and
//  stored are not mirrored. `faceBox`/`eyeMidX` in `onFrameMeasure` are in
//  the stored (unmirrored) frame's coordinates.
//

import AVFoundation
import UIKit

final class FaceTypeClientCameraView: UIView, FaceTypeClientCameraEventSink {
  @objc var active: Bool = false {
    didSet { reconcile() }
  }

  @objc var gateConfig: String? {
    didSet { gateConfigDidChange() }
  }

  @objc var onFrameMeasure: RCTDirectEventBlock?
  @objc var onBurstProgress: RCTDirectEventBlock?
  @objc var onError: RCTDirectEventBlock?

  private let controller = FaceTypeClientCameraController.shared
  private var gate: FaceTypeClientGate?
  /// The activation this view holds, if its camera is running.
  private var activation: UInt64?

  override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

  private var previewLayer: AVCaptureVideoPreviewLayer {
    // `layerClass` guarantees the type.
    layer as! AVCaptureVideoPreviewLayer
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    previewLayer.videoGravity = .resizeAspectFill
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("FaceTypeClientCameraView does not support storyboard instantiation.")
  }

  deinit {
    if let activation { controller.deactivate(token: activation) }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    reconcile()
  }

  private func gateConfigDidChange() {
    guard let text = gateConfig, !text.isEmpty else {
      gate = nil
      reconcile()
      return
    }
    switch FaceTypeClientGate.parse(text) {
    case .success(let parsed):
      gate = parsed
      if activation != nil { controller.updateGate(parsed) }
    case .failure(let error):
      // Native never substitutes thresholds of its own: no config, no camera.
      gate = nil
      clientCameraError(code: FaceTypeClientErrorCode.internalError.rawValue, message: error.message)
    }
    reconcile()
  }

  private func reconcile() {
    let shouldRun = active && window != nil && gate != nil
    if shouldRun, activation == nil, let gate {
      activation = controller.activate(self, gate: gate)
    } else if !shouldRun, let token = activation {
      activation = nil
      controller.deactivate(token: token)
      previewLayer.session = nil
    }
  }

  // MARK: - FaceTypeClientCameraEventSink (main thread)

  func clientCameraMeasured(_ payload: [String: Any]) {
    onFrameMeasure?(payload as [AnyHashable: Any])
  }

  func clientCameraBurstProgress(_ payload: [String: Any]) {
    onBurstProgress?(payload as [AnyHashable: Any])
  }

  func clientCameraError(code: String, message: String) {
    onError?(["code": code, "message": message])
  }

  func clientCameraAttachPreview(_ session: AVCaptureSession?) {
    guard activation != nil || session == nil else { return }
    previewLayer.session = session
    guard let connection = previewLayer.connection else { return }
    if #available(iOS 17.0, *) {
      if connection.isVideoRotationAngleSupported(FaceTypeClientCameraController.portraitRotationDeg) {
        connection.videoRotationAngle = FaceTypeClientCameraController.portraitRotationDeg
      }
    } else if connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }
  }
}
