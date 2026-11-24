//
//  FaceTypePreviewView.swift
//  FaceType AI — the real ARKit camera preview (`FaceTypePreviewView` in
//  JavaScript, via `NativeFaceTypePreview.tsx`).
//
//  Before this file existed, `ScanScreen` on iOS never mounted a native
//  preview at all (`usingNativePreview` was `Platform.OS === 'android' &&
//  provider?.kind === 'arcore'`, unconditionally `false` on iOS) — the user
//  saw only pose-instruction text over an empty frame while ARKit ran
//  invisibly in the background. That is exactly the "decorative placeholder
//  standing in for a camera that never opened" defect the Android GLSurfaceView
//  preview was built to close (audit F1/F2; design review D1-D3, message
//  2026-08-25T21-54-44Z_53356c299477). This is the iOS half of that fix.
//
//  WHAT THIS VIEW DOES
//  Wraps an `ARSCNView` purely for display. It never `.run(`s, `.pause()`s or
//  closes an `ARSession` FaceTypeCapture owns: `FaceTypeCapture` remains the
//  sole owner of session lifecycle, geometry capture and quality evidence
//  (unchanged by this file, so the existing same-frame contract holds). This
//  view only ever shows whatever session `FaceTypePreviewRegistry` hands it
//  via `attach(session:)`, which `FaceTypeCapture` calls right after it
//  starts (real feed) or stops (blank) the session. The only `ARSession` this
//  file constructs itself is a fresh, un-`.run()` one used as a blank
//  placeholder (initial state, and while detached from the window) -- it is
//  never started, so it never reads a camera frame.
//
//  This is a deliberate divergence from the Android design: ARCore's Session
//  needs a GL context and camera texture that only the rendering surface can
//  supply, so ARCore's `FaceTypePreviewView` owns the Session outright. ARKit
//  has no such coupling -- any `ARSCNView` can display any running
//  `ARSession` -- so keeping `FaceTypeCapture` as the single owner is both
//  simpler and lower-risk here: it changes nothing about how geometry or
//  quality evidence is produced, only what the user can see while it happens.
//
//  WHAT THIS FILE MUST NEVER DO
//  Read, derive, export or attempt to access a Face ID template, the Secure
//  Enclave, or anything from LocalAuthentication (FT-00 §3). It draws the
//  same public ARKit camera feed `FaceTypeCapture` already reads geometry
//  from and nothing else.
//

import ARKit
import React
import UIKit

final class FaceTypePreviewView: UIView {
  private let sceneView = ARSCNView()
  private var didEmitReady = false

  @objc var onPreviewReady: RCTDirectEventBlock?
  @objc var onPreviewError: RCTDirectEventBlock?

  override init(frame: CGRect) {
    super.init(frame: frame)
    sceneView.frame = bounds
    sceneView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    // Lighting/camera-grain post-processing exist to make virtual content
    // blend in; there is no virtual content here, only the raw camera feed,
    // so both are wasted GPU work.
    sceneView.automaticallyUpdatesLighting = false
    if #available(iOS 13.0, *) {
      sceneView.rendersCameraGrain = false
    }
    // No session is assigned yet. An ARSCNView with no running session
    // renders nothing, which is exactly the correct "camera not started yet"
    // state between mount and `FaceTypeCapture.start()`.
    addSubview(sceneView)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("FaceTypePreviewView does not support storyboard instantiation.")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    sceneView.frame = bounds
    emitReadyIfPossible()
  }

  /// GLSurfaceView.onAttachedToWindow is what makes Android's registration
  /// "on screen right now" rather than merely "constructed"; UIKit's
  /// equivalent moment is the view actually joining a window.
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      FaceTypePreviewRegistry.register(self)
      emitReadyIfPossible()
    } else {
      // Leaving the tree: stop showing frames, but do not touch the
      // ARSession itself. `FaceTypeCapture` still owns it and this view
      // detaching (e.g. a transient re-layout during navigation) is not the
      // same event as `FaceTypeCapture.stop()` actually ending capture.
      //
      // The live session is not lost by this: `FaceTypePreviewRegistry`
      // remembers it, and hands it straight back if this same view rejoins
      // the window (audit IOS-Q3). Before that, a detach/reattach cycle left
      // the preview showing the blank placeholder below forever.
      //
      // IOS-F1 (Codex review 2026-08-25T23-44-37Z): `sceneView.session` is
      // whatever `FaceTypeCapture.start()` assigned via `attach(session:)` --
      // the module's own live session, not one this view created. Calling
      // `.pause()` on it here would pause the *owner's* session from a
      // display-only detach, contradicting the single-owner contract this
      // file documents above. Detaching display must replace the shown
      // session with a fresh, inert one instead of touching the live one.
      FaceTypePreviewRegistry.clearIfCurrent(self)
      sceneView.session = ARSession()
    }
  }

  /// Called on the main thread by `FaceTypePreviewRegistry`. `nil` clears the
  /// displayed feed (session stopped, failed, or the module was invalidated)
  /// so a superseded/ended session's last frame is never left on screen.
  func attach(session: ARSession?) {
    sceneView.session = session ?? ARSession()
  }

  /// Mirrors Android's `onSurfaceCreated` → `onPreviewReady` contract: "this
  /// view has a real surface a session can be attached to", not "a session is
  /// already running". `FaceTypeCapture.start()` is what JS calls next, only
  /// after receiving this event (design review D3) — starting the camera
  /// stays gated on consent already having advanced to this screen, never on
  /// this view merely existing.
  private func emitReadyIfPossible() {
    guard !didEmitReady, window != nil, bounds.width > 0, bounds.height > 0 else { return }
    didEmitReady = true
    guard ARFaceTrackingConfiguration.isSupported else {
      onPreviewError?(["message": "Face geometry is not supported on this device."])
      return
    }
    onPreviewReady?([:])
  }
}
