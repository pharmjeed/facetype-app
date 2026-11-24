//
//  FaceTypePreviewRegistry.swift
//  FaceType AI — hands the live ARSession to whichever preview is mounted.
//
//  Mirrors the Android split (`ai.facetype.capture.FaceTypePreviewRegistry`,
//  design review D1/D2, message 2026-08-25T21-54-44Z_53356c299477): a single
//  point of contact between the capture module (created once per bridge) and
//  whichever `FaceTypePreviewView` is currently mounted in the RN view tree
//  (created/torn down per screen, e.g. every time ScanScreen mounts).
//
//  Unlike ARCore, ARKit's ARSession is not coupled to the surface that
//  renders it, so `FaceTypeCapture` keeps owning session creation, geometry
//  capture and quality evidence unchanged (audit contract: same-frame
//  geometry + quality evidence never moves). This registry exists only to
//  give the currently-mounted preview a live reference to that session so it
//  can actually show the camera feed (audit F1/F2) instead of a decorative
//  placeholder. It intentionally holds at most one view: the guided protocol
//  never shows two camera previews at once.
//

import ARKit
import Foundation

enum FaceTypePreviewRegistry {
  private static let lock = NSLock()
  private static weak var currentView: FaceTypePreviewView?
  /// The session `FaceTypeCapture` last handed over, remembered so a view
  /// that (re)joins the window can be given it immediately (audit IOS-Q3).
  /// Weak on purpose: `FaceTypeCapture` is the sole owner, and once it has
  /// released the session this must read `nil` rather than resurrect a
  /// session nobody is running any more.
  private static weak var currentSession: ARSession?

  /// Must be called on the main thread (it is: the only caller is
  /// `FaceTypePreviewView.didMoveToWindow`), because it touches the view.
  ///
  /// The re-attach is the point of this method, not a nicety. A view leaving
  /// the window swaps in a blank placeholder session and clears itself from
  /// the registry; when the very same view comes back -- a navigation
  /// transition, a modal dismissing, any transient RN re-layout that detaches
  /// and reattaches the host view -- nothing else would ever hand it the live
  /// session again. `FaceTypeCapture.start()` re-attaches on its early-return
  /// path (IOS-F2), but JavaScript does not call `start()` a second time for
  /// a preview that never stopped: `App.tsx` keeps `previewSequenceStartedRef`
  /// set for as long as the scan screen is mounted. The result was a
  /// permanently black preview over a capture session that was still running
  /// perfectly -- the exact "decorative placeholder standing in for a camera"
  /// defect this file exists to prevent (audit F1/F2).
  static func register(_ view: FaceTypePreviewView) {
    lock.lock()
    currentView = view
    let session = currentSession
    lock.unlock()
    view.attach(session: session)
  }

  /// Compare-and-clear: a superseded/dropped view's own teardown must never
  /// erase the registry entry of a view that replaced it (e.g. an old
  /// screen's view finishing teardown after a new screen's view has already
  /// mounted and registered itself).
  ///
  /// Only the *view* is cleared. `currentSession` deliberately survives: a
  /// view leaving the window says nothing about whether `FaceTypeCapture` is
  /// still running a session, and forgetting it here would defeat the
  /// re-attach in `register(_:)` above.
  static func clearIfCurrent(_ view: FaceTypePreviewView) {
    lock.lock()
    defer { lock.unlock() }
    if currentView === view { currentView = nil }
  }

  /// Called by `FaceTypeCapture` whenever its ARSession is created or torn
  /// down. `nil` means "no session to show" (stopped, failed, or the module
  /// was invalidated) and the currently-mounted preview must stop displaying
  /// stale frames. Always hops to the main thread: UIKit/ARSCNView state may
  /// only be touched there, and callers (native-module methods) are not
  /// guaranteed to already be running on it.
  static func attach(session: ARSession?) {
    DispatchQueue.main.async {
      lock.lock()
      // Recorded before the view is notified and under the same lock, so a
      // view registering later sees exactly what the currently-mounted view
      // was shown -- never an earlier session that has since been replaced.
      currentSession = session
      let view = currentView
      lock.unlock()
      view?.attach(session: session)
    }
  }
}
