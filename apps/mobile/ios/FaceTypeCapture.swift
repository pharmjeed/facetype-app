//
//  FaceTypeCapture.swift
//  FaceType AI — ARKit face geometry bridge
//
//  WHAT THIS MODULE DOES
//  Streams ARKit face *geometry* (vertices, blendshapes, head transform) to the
//  React Native layer, normalised into the StandardFaceObservation contract.
//
//  WHAT THIS MODULE MUST NEVER DO
//  Read, derive, export or attempt to access a Face ID template, the Secure
//  Enclave, or anything from LocalAuthentication. FT-00 §3 forbids it outright.
//  Those APIs are not imported here and must not be added: `make security-scan`
//  fails the build if they appear in executable code anywhere in the tree.
//
//  ARKit's face geometry is a public rendering API available to any app with
//  camera permission. It is unrelated to the biometric authentication subsystem,
//  and that distinction is the reason this module can exist at all.
//

import ARKit
import AVFoundation
import CoreVideo
import Foundation
import ImageIO
import QuartzCore
import React
import UIKit
import Vision

@objc(FaceTypeCapture)
final class FaceTypeCapture: NSObject, RCTInvalidating {

  // `RCTInvalidating` is not decoration. React Native tears a module down
  // with `if ([instance conformsToProtocol:@protocol(RCTInvalidating)])
  // [instance invalidate]`, so an `invalidate()` on a class that does not
  // declare the protocol is simply never called (audit IOS-Q2). Without it a
  // bridge reload -- every Cmd-R during development, and any programmatic
  // `RCTBridge reload` -- left this instance's ARSession running with the
  // front camera open and its lifecycle observers still registered, while
  // the fresh instance created for the new bridge started a *second*
  // ARSession competing for the same camera.
  //
  // `_session` is written from React Native's module queue (start/stop/
  // captureGeometry all run there -- `requiresMainQueueSetup` governs
  // *initialisation*, not method dispatch) and read from the main thread by
  // the `UIApplication` lifecycle observers further down. An unguarded
  // stored property touched from two threads is a data race, and the
  // damaging outcome is concrete rather than theoretical:
  // `handleDidBecomeActive` could capture a reference `stop()` was
  // concurrently clearing and `run()` a session the user had already
  // finished with, leaving the front camera live after capture ended.
  //
  // `sessionLock` is a plain (non-recursive) NSLock: any code that already
  // holds it must use `_session` directly and must never touch `session`.
  //
  // `sessionLock` alone was not enough, and 113ce30 proved it. A lock makes
  // each *access* to `_session` atomic; it does nothing about the ordering of
  // the multi-step transitions built out of those accesses. The claim in
  // `beginSession` released the lock and only then ran the camera, so a
  // `stop()`/`invalidate()` landing in that window incremented the
  // generation, took the session, paused it and cleared the preview -- while
  // the start that had already read `superseded == false` went on to
  // `run()` it, re-register the lifecycle observers teardown had just
  // removed, and hand the dead session back to the preview. The camera
  // reopened after the user (or the bridge) had ended capture.
  //
  // The fix is confinement, not a bigger lock: every lifecycle *transition*
  // runs on `sessionQueue`, a serial queue, so transitions are totally
  // ordered and cannot interleave with each other at all. A `stop()` that
  // arrives mid-start waits for the start to finish and then tears it down
  // properly; one that arrives first bumps the generation the start then
  // re-reads. No lock is held across `ARSession.run` anywhere -- the queue
  // supplies the exclusion (Codex review 2026-08-26T18-41-22Z).
  //
  // Functions confined to it are named `...OnQueue` and open with a
  // `dispatchPrecondition`, which is both the runtime check and the marker
  // `tests/contract/test_ios_capture_quality.py` uses to verify that no
  // lifecycle statement has escaped the queue.
  private let sessionQueue = DispatchQueue(label: "ai.facetype.capture.session")

  /// The one slot a consented field-study photograph lives in, between being
  /// encoded and being uploaded. Empty for every ordinary scan: the JavaScript
  /// channel that reaches these methods is not even constructed unless the
  /// participant's consent record carries an explicit raw-retention grant
  /// (`src/field/fieldCapture.ts`). See `FaceTypeRawFrameStore.swift`.
  private let rawFrames = FaceTypeRawFrameStore()
  private let sessionLock = NSLock()
  private var _session: ARSession?
  /// Bumped by every teardown. `start()` is asynchronous now -- it can be
  /// waiting on the camera permission sheet -- so "is the session I was asked
  /// to create still the session anyone wants?" is a question a plain nil
  /// check cannot answer: `stop()` followed by a fresh `start()` also leaves
  /// `_session` nil. The generation a request was issued under is captured
  /// before the prompt and re-checked, under the lock, at the moment the
  /// session would be claimed (Codex review 2026-08-26T13-14-11Z, item 1).
  private var sessionGeneration: UInt64 = 0
  /// Set once, by `invalidate()`. The bridge that owned this module is gone;
  /// no permission callback still in flight may start a camera for it.
  private var isInvalidated = false
  /// ARKit delivers delegate callbacks here rather than on the main queue.
  /// Serial, as `ARSession.delegateQueue` requires. Naming the queue is what
  /// lets teardown drain it (`stopSession`) instead of returning while a
  /// callback for the session it just released is still in flight.
  private let delegateQueue = DispatchQueue(label: "ai.facetype.capture.arsession")
  /// Read-only on purpose. `_session` is written in exactly one place -- the
  /// claim in `beginSessionOnQueue` -- and cleared in exactly one other,
  /// `stopSessionOnQueue`. A settable accessor invites a write from off the
  /// queue, which is the shape of the bug this design removes.
  private var session: ARSession? {
    sessionLock.lock()
    defer { sessionLock.unlock() }
    return _session
  }
  private let faceLock = NSLock()
  private var trackedFaces: [UUID: ARFaceAnchor] = [:]
  private var trackedFaceCount = 0
  private var latestFrame: ARFrame?
  /// `CACurrentMediaTime()` sampled at the instant `latestFrame` was accepted.
  /// Read together with `latestFrame` under `faceLock`.
  private var latestFrameRecordedAt: TimeInterval = 0
  private var sessionFailure: Error?

  /// How long ago `latestFrame` may have been received and still count as
  /// this pose's evidence. ARKit delivers roughly sixty frames a second, so
  /// nothing arriving for this long means delivery has stopped, not that the
  /// device is momentarily busy.
  private static let maxFrameAgeSeconds: TimeInterval = 1

  /// The quality-profile artifact this build implements
  /// (`QUALITY_PROFILE_ARTIFACT.version`, `QUALITY_PROFILE_VERSION`).
  ///
  /// Hard-coded because it is a property of what this Swift measures, not of
  /// the device or the moment.
  /// `tests/contract/test_native_quality_profile_declaration.py` fails the
  /// build if it drifts from the artifact.
  private static let qualityProfileVersion = "qp-1.0.0"

  /// ARKit face tracking requires a TrueDepth-capable device.
  @objc(isAvailable:rejecter:)
  func isAvailable(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    resolve(ARFaceTrackingConfiguration.isSupported)
  }

  @objc(start:rejecter:)
  func start(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    // The lifecycle token this call is made under. Read here, off the queue,
    // because it has to describe the state the *caller* asked in -- a
    // `stop()` that lands between this line and the block below is exactly
    // the supersession the token exists to detect.
    let generation = currentGeneration()

    // Dispatched unconditionally: `start()` makes no decision of its own any
    // more. It used to peek at `session` here to take a fast path, which was
    // safe only because the branch it chose re-took the whole decision on the
    // queue anyway -- so the peek bought nothing and cost the rule below an
    // exception for the one accessor read that lived off the queue (Codex
    // acceptance 2026-08-26T21-22-53Z). Every read of `session` is now
    // confined, with no whitelist.
    sessionQueue.async { [weak self] in
      guard let self else {
        reject("FT-REC-005", "The capture module was torn down before capture could start.", nil)
        return
      }
      self.startOnQueue(generation: generation, resolve, reject)
    }
  }

  /// The whole of `start()`'s decision, in queue order.
  private func startOnQueue(
    generation: UInt64,
    _ resolve: @escaping RCTPromiseResolveBlock,
    _ reject: @escaping RCTPromiseRejectBlock
  ) {
    dispatchPrecondition(condition: .onQueue(sessionQueue))

    guard isStillWanted(generation: generation) else {
      rejectSupersededStart(reject)
      return
    }

    // IOS-F2 (Codex review 2026-08-25T23-44-37Z): a session already exists
    // (JS called start() again without an intervening stop(), e.g. a React
    // remount that re-runs the preview-ready sequence). A newly (re)mounted
    // `FaceTypePreviewView` registers itself with a blank, un-run `ARSession`
    // of its own -- it has no way to know the module's session is still
    // live -- so without reattaching here that new view would stay blank
    // forever even though capture never actually stopped.
    //
    // Reported as success only because a live session is in hand: this
    // branch is reachable solely through the binding. A start that leaves no
    // running session must report failure, because
    // `runPreviewReadySequence` treats a resolved `startProvider()` as
    // licence to mint an idempotency key and call `createScan` -- a resolved
    // lie puts a scan record on the server for a session that never existed
    // (Codex review 2026-08-26T19-46-50Z).
    if let running = session {
      FaceTypePreviewRegistry.attach(session: running)
      resolve(nil)
      return
    }

    guard ARFaceTrackingConfiguration.isSupported else {
      reject("FT-REC-005", "Face geometry is not supported on this device.", nil)
      return
    }

    // Camera authorisation is checked explicitly rather than left to ARKit
    // (audit IOS-Q7). `session.run(_:options:)` raises the system prompt as
    // a side effect and returns immediately, so without this gate `start()`
    // resolved *before* the user had answered: JavaScript flipped
    // `previewReady` to true, the capture button enabled over a black
    // preview, and a denial surfaced only as a generic failure on the first
    // capture attempt, with no way back. Android already fails closed on
    // exactly this condition (`PermissionsAndroid.request` in App.tsx's
    // `consent()`); iOS had no equivalent. The rejection carries the same
    // `CAMERA_PERMISSION_DENIED` code that path throws, so both platforms
    // land on one branch in `resolveCaptureErrorCode`.
    //
    // Asking makes `start()` asynchronous, and an asynchronous start can
    // outlive the thing that asked for it. `generation`, read at the top of
    // this method, is the lifecycle token that closes that gap: it is
    // re-checked when the session would actually be claimed, so a `stop()`
    // or `invalidate()` that happens while the sheet is on screen cannot be
    // followed by this callback quietly opening the camera anyway.
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      beginSessionOnQueue(generation: generation, resolve, reject)
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
        guard let self else {
          reject("FT-REC-005", "The capture module was torn down while asking for the camera.", nil)
          return
        }
        // The whole outcome is decided on the queue, in order, including the
        // denial. A denial that arrives after the scan was torn down is not
        // this session's news: reporting CAMERA_PERMISSION_DENIED then would
        // send JavaScript -- and the user -- to Settings over a request that
        // had already been abandoned. Supersession is checked first for
        // exactly that reason (Codex review 2026-08-26T18-41-22Z).
        self.sessionQueue.async {
          guard self.isStillWanted(generation: generation) else {
            self.rejectSupersededStart(reject)
            return
          }
          guard granted else {
            reject("CAMERA_PERMISSION_DENIED", "Camera access was denied.", nil)
            return
          }
          self.beginSessionOnQueue(generation: generation, resolve, reject)
        }
      }
    case .denied, .restricted:
      reject("CAMERA_PERMISSION_DENIED", "Camera access is not permitted for this app.", nil)
    @unknown default:
      reject("CAMERA_PERMISSION_DENIED", "Camera authorisation could not be determined.", nil)
    }
  }

  /// Creates and runs the ARSession. Only reachable once camera access has
  /// actually been granted, so a non-nil `session` always means a feed the
  /// preview can really display rather than one still waiting on a prompt.
  ///
  /// `generation` is the lifecycle token `start()` read before it asked for
  /// permission. Any teardown since then has bumped it, and this call must
  /// then do nothing at all: the alternative is a camera that opens after the
  /// user backed out of the scan, or after React Native tore the bridge down.
  ///
  /// Callers are already on the queue (`startOnQueue`, and the permission
  /// callback's own hop), so there is no dispatching wrapper to go through.
  /// Confined to `sessionQueue`.
  ///
  /// Everything from the claim to `resolve` runs without interruption from
  /// another lifecycle transition, because every other transition is confined
  /// to this same serial queue. That -- not the lock -- is what makes the
  /// claim/stop/run sequence safe, and it is why `run` can be called with no
  /// lock held.
  private func beginSessionOnQueue(
    generation: UInt64,
    _ resolve: @escaping RCTPromiseResolveBlock,
    _ reject: @escaping RCTPromiseRejectBlock
  ) {
    dispatchPrecondition(condition: .onQueue(sessionQueue))
    // Cheap early exit. It is not the real guard -- the atomic claim below
    // is -- but it avoids configuring a session for a request that is already
    // void, which is the common case when the prompt was answered late.
    guard isStillWanted(generation: generation) else {
      rejectSupersededStart(reject)
      return
    }

    let supportedFaceCount = ARFaceTrackingConfiguration.supportedNumberOfTrackedFaces
    guard supportedFaceCount > 0 else {
      reject("FT-REC-005", "This device cannot track a face with ARKit.", nil)
      return
    }
    let configuration = ARFaceTrackingConfiguration()
    configuration.maximumNumberOfTrackedFaces = min(
      2,
      supportedFaceCount
    )
    configuration.isLightEstimationEnabled = true

    let session = ARSession()
    session.delegate = self
    session.delegateQueue = delegateQueue

    // The claim. The lock makes this read-modify-write atomic; the queue is
    // what keeps everything after it -- the `run`, the observers, the preview
    // handover -- from being interleaved with a teardown. Both failure modes
    // are decided here because neither can be settled by a check made
    // earlier:
    //
    //  - `superseded`: a stop()/invalidate() landed while the permission
    //    sheet was up. The camera must not be started for a request nobody
    //    is waiting on any more.
    //  - `alreadyRunning`: two starts both passed the `session == nil` guard
    //    in start() while the sheet was up. The loser hands the winner's
    //    session to the preview rather than running a second ARSession on
    //    the same front camera.
    //
    // `_session` directly, not `session`: the accessor takes this same
    // non-recursive lock.
    sessionLock.lock()
    let superseded = isInvalidated || sessionGeneration != generation
    let alreadyRunning = _session
    if !superseded, alreadyRunning == nil { _session = session }
    sessionLock.unlock()

    if superseded {
      session.delegate = nil
      rejectSupersededStart(reject)
      return
    }
    if let alreadyRunning {
      session.delegate = nil
      FaceTypePreviewRegistry.attach(session: alreadyRunning)
      resolve(nil)
      return
    }

    clearTrackedState()
    session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
    registerLifecycleObservers()
    // Hands the running session to whichever `FaceTypePreviewView` is
    // currently mounted, so the user sees the real camera feed this session
    // is now producing instead of the placeholder ScanScreen shows until
    // this resolves (audit F1/F2).
    FaceTypePreviewRegistry.attach(session: session)
    resolve(nil)
  }

  /// Capture one guided pose and return it in the standard observation shape.
  @objc(captureGeometry:resolver:rejecter:)
  func captureGeometry(
    _ pose: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let (frame, recordedAt, faces, faceCount, failure) = trackedFaceSnapshot()
    if let failure {
      reject("FT-REC-005", "The ARKit capture session failed.", failure)
      return
    }
    guard let frame else {
      reject("FT-SCAN-014", "No camera frame is available for quality measurement.", nil)
      return
    }
    // Same-frame evidence is only meaningful if the frame is also *current*
    // (audit IOS-Q11). `latestFrame` is whatever the delegate last recorded
    // and nothing bounded its age, so once ARKit stopped delivering frames
    // -- a system interruption, an app-initiated pause, a resume that has
    // not produced its first frame yet -- this method still answered,
    // measuring seconds-old geometry against seconds-old pixels and
    // reporting the pair as this pose's evidence.
    //
    // The age is measured between two readings of one clock: `recordedAt` is
    // `CACurrentMediaTime()` sampled by `record(_:from:)` at the instant the
    // frame was accepted, and the subtraction below samples the same function
    // again. An earlier version compared against `ARFrame.timestamp`, which
    // only works if that property is expressed in this clock's epoch --
    // documentation this repository has no device evidence for, and a wrong
    // epoch would turn the gate into either a permanent reject or a no-op
    // (Codex review 2026-08-26T13-14-11Z, item 5). `recordedAt == 0` means
    // nothing was ever recorded, which the `frame` guard above already
    // covers; it is re-checked here so the arithmetic can never run on it.
    guard recordedAt > 0 else {
      reject("FT-SCAN-014", "No camera frame has been received yet.", nil)
      return
    }
    let frameAge = CACurrentMediaTime() - recordedAt
    guard frameAge >= 0, frameAge <= FaceTypeCapture.maxFrameAgeSeconds else {
      reject(
        "FT-SCAN-014",
        "The most recent camera frame is stale; frame delivery has stopped.",
        nil
      )
      return
    }
    guard let anchor = faces.first else {
      reject("FT-SCAN-005", "No face is currently tracked.", nil)
      return
    }
    guard faceCount == 1 else {
      reject("FT-SCAN-004", "More than one face is in the frame.", nil)
      return
    }

    let geometry = anchor.geometry
    var landmarks: [Float] = []
    landmarks.reserveCapacity(geometry.vertices.count * 3)
    for vertex in geometry.vertices {
      // ARFaceGeometry vertices are face-local. Put them in the same world
      // frame as headPose so the worker can remove that transform correctly.
      let world = anchor.transform * SIMD4<Float>(vertex.x, vertex.y, vertex.z, 1)
      landmarks.append(world.x * 1000)   // metres -> millimetres
      landmarks.append(world.y * 1000)
      landmarks.append(world.z * 1000)
    }

    let textureCoordinates = geometry.textureCoordinates.flatMap { [$0.x, $0.y] }
    let triangleIndices = geometry.triangleIndices.map(Int.init)

    // ARKit does not expose per-vertex confidence; tracking state is the
    // available signal, and it is reported honestly rather than faked per point.
    // ARKit exposes tracking availability, not a calibrated per-vertex
    // probability. A tracked vertex is available (1); untracked capture was
    // already rejected above.
    let confidenceValue: Float = anchor.isTracked ? 1 : 0
    let confidence = [Float](repeating: confidenceValue, count: geometry.vertices.count)

    let transform = anchor.transform
    let headPose: [Float] = [
      transform.columns.0.x, transform.columns.1.x, transform.columns.2.x, transform.columns.3.x * 1000,
      transform.columns.0.y, transform.columns.1.y, transform.columns.2.y, transform.columns.3.y * 1000,
      transform.columns.0.z, transform.columns.1.z, transform.columns.2.z, transform.columns.3.z * 1000,
      0, 0, 0, 1,
    ]

    var blendshapes: [String: Float] = [:]
    for (location, value) in anchor.blendShapes {
      blendshapes[location.rawValue] = value.floatValue
    }

    let (yaw, pitch) = FaceTypeCapture.yawPitchDegrees(transform)
    let neutrality: Float
    let measuredQuality: FaceFrameQuality
    do {
      neutrality = try FaceTypeCapture.neutrality(blendshapes)
      // Vision and the luma sampler inspect the current CVPixelBuffer only.
      // No pixel buffer, image, thumbnail or derived frame leaves this scope.
      measuredQuality = try FaceFrameQualityEstimator.measure(
        frame.capturedImage,
        orientation: FaceTypeCapture.imageOrientation()
      )
    } catch FaceFrameQualityError.multipleFaces {
      reject("FT-SCAN-004", "More than one face is in the frame.", nil)
      return
    } catch {
      reject("FT-SCAN-014", "Frame quality could not be measured.", error)
      return
    }

    resolve([
      "observationId": "obs_arkit_\(pose)_\(Int(Date().timeIntervalSince1970 * 1000))",
      // This path measures all five FT-03 §3 signals -- Vision reports which
      // facial regions it localised, which is the occlusion evidence Android
      // has no equivalent of (ADR-010/ADR-011). Declaring FULL is a claim the
      // server checks against its own closed mapping, never a grant.
      "qualityProfile": "FULL",
      // The artifact that gives the name its meaning. A declaration without
      // one resolves to UNKNOWN, which gates identically for FULL but is
      // eligible for nothing -- so omitting it quietly disqualified every
      // iOS capture from the governed lanes.
      "qualityProfileVersion": Self.qualityProfileVersion,
      "landmarkTopology": "arkit-face-geometry",
      "topologyVersion": "arkit-face-geometry-uv-v1",
      "landmarks": landmarks,
      "landmarkConfidence": confidence,
      "textureCoordinates": textureCoordinates,
      "triangleIndices": triangleIndices,
      "headPose": headPose,
      "blendshapes": blendshapes,
      "quality": [
        "blur": measuredQuality.blur,
        "exposure": measuredQuality.exposure,
        "occlusion": measuredQuality.occlusion,
        "neutrality": neutrality,
        "faceCount": Float(faceCount),
        "yawDeg": yaw,
        "pitchDeg": pitch,
      ],
      // ARKit's face-geometry API is documented as metric, but this repository
      // has no calibrated-device evidence proving that reported scale is
      // accurate on real hardware (audit P0-02 item 3) — no target-object
      // measurement, no device-specific calibration record. Claiming `true`
      // unconditionally would tell the pipeline every device's millimetres
      // are trustworthy on documentation alone. Report honestly unreliable
      // until a specific, evidenced calibrated condition sets this per capture.
      "metricScaleReliable": false,
    ])
  }

  @objc(stop:rejecter:)
  func stop(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    stopSession()
    resolve(nil)
  }

  // MARK: - field-study raw frames (apps/mobile/docs/field-study.md)
  //
  // Only the calibration lane reaches these, and only for a participant who
  // explicitly opted in to having photographs kept. They export the AR
  // session's own camera image; nothing here reads the window, a view or the
  // display, so there is no screenshot path to review. The bytes never touch
  // the filesystem — see `FaceTypeRawFrameStore.swift`.

  /// Encode the current camera frame as a JPEG and hold it for one upload.
  ///
  /// Same freshness bound as `captureGeometry`: a photograph of a frame that
  /// arrived seconds ago is not a photograph of this pose, and reporting one as
  /// though it were is exactly the kind of quiet mismatch the staleness check
  /// exists to prevent.
  @objc(captureRawFrame:rejecter:)
  func captureRawFrame(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let (frame, recordedAt, _, _, failure) = trackedFaceSnapshot()
    if let failure {
      reject("FT-REC-005", "The ARKit capture session failed.", failure)
      return
    }
    guard let frame, recordedAt > 0 else {
      reject("FT-SCAN-014", "No camera frame is available to photograph.", nil)
      return
    }
    let frameAge = CACurrentMediaTime() - recordedAt
    guard frameAge >= 0, frameAge <= FaceTypeCapture.maxFrameAgeSeconds else {
      reject(
        "FT-SCAN-014",
        "The most recent camera frame is stale; frame delivery has stopped.",
        nil
      )
      return
    }
    guard
      let handle = rawFrames.store(
        pixelBuffer: frame.capturedImage,
        orientation: FaceTypeCapture.imageOrientation()
      )
    else {
      reject("FT-SCAN-014", "The camera frame could not be encoded.", nil)
      return
    }
    // Metadata only. The bytes stay in the store until JavaScript has an
    // upload slot signed for exactly this length and digest.
    resolve(handle.payload)
  }

  @objc(readRawFrame:resolver:rejecter:)
  func readRawFrame(
    _ token: String,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    guard let encoded = rawFrames.base64(token: token) else {
      reject("FT-REC-005", "That raw frame is no longer held.", nil)
      return
    }
    resolve(encoded)
  }

  /// Resolves whether or not the frame was still there: a caller cleaning up
  /// must never be left with an error it cannot act on.
  @objc(discardRawFrame:resolver:rejecter:)
  func discardRawFrame(
    _ token: String,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    rawFrames.discard(token: token)
    resolve(nil)
  }

  @objc(discardAllRawFrames:rejecter:)
  func discardAllRawFrames(
    _ resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    rawFrames.discardAll()
    resolve(nil)
  }

  /// React Native calls this during bridge teardown/hot reload, but only
  /// because this class declares `RCTInvalidating` above -- the bridge
  /// dispatches on `conformsToProtocol:`, not on `respondsToSelector:`.
  /// Keeping it outside RCT_EXTERN_METHOD means JavaScript still cannot
  /// invoke lifecycle cleanup itself.
  @objc func invalidate() {
    stopSession(invalidating: true)
  }

  /// The generation any in-flight `start()` must still match to be allowed to
  /// open a camera.
  private func currentGeneration() -> UInt64 {
    sessionLock.lock()
    defer { sessionLock.unlock() }
    return sessionGeneration
  }

  private func isStillWanted(generation: UInt64) -> Bool {
    sessionLock.lock()
    defer { sessionLock.unlock() }
    return !isInvalidated && sessionGeneration == generation
  }

  private func rejectSupersededStart(_ reject: @escaping RCTPromiseRejectBlock) {
    reject(
      "FT-REC-005",
      "Capture was stopped before the camera permission request finished.",
      nil
    )
  }

  /// Synchronous on purpose, twice over. `stop()` resolves its promise as
  /// soon as this returns and React Native's `invalidate()` must not return
  /// while the camera is still live, so callers need the teardown to have
  /// actually happened. And `sync` on the serial queue is what waits out a
  /// start that is already in flight, turning claim-versus-stop from a race
  /// into an order: either this runs first and the start finds itself
  /// superseded, or the start completes and this tears down what it built.
  private func stopSession(invalidating: Bool = false) {
    sessionQueue.sync { stopSessionOnQueue(invalidating: invalidating) }
  }

  private func stopSessionOnQueue(invalidating: Bool) {
    dispatchPrecondition(condition: .onQueue(sessionQueue))
    removeLifecycleObservers()
    // No consented photograph outlives the session it was taken in, whether
    // this teardown came from `stop()` or from a bridge invalidation.
    rawFrames.discardAll()
    // Releasing ownership is one critical section. Bumping the generation
    // inside it is what makes a permission callback still waiting on the
    // sheet find out it has been superseded; clearing `_session` in the same
    // breath means a lifecycle notification arriving mid-stop either sees a
    // live session (and this method's pause below then stops it) or sees
    // nil -- never a reference halfway through being cleared. `_session`
    // directly: `session`'s accessor takes this same non-recursive lock.
    sessionLock.lock()
    sessionGeneration &+= 1
    if invalidating { isInvalidated = true }
    let ending = _session
    _session = nil
    sessionLock.unlock()

    // Outside the lock deliberately. `pause()` is an ARKit call, and the
    // drain below blocks on the delegate queue, whose callbacks take
    // `sessionLock` themselves -- holding it here would deadlock.
    ending?.delegate = nil
    ending?.pause()
    // Ownership was released above, so any callback ARKit had already
    // dispatched will find itself disowned and drop out. Draining the queue
    // means teardown does not *return* while one is still running, which is
    // what lets `invalidate()` promise the module is quiet once it is done.
    delegateQueue.sync {}

    clearTrackedState()
    // Clears whatever preview is currently mounted so no stale frame from
    // this ended session is left on screen (audit F1/F2).
    FaceTypePreviewRegistry.attach(session: nil)
  }

  // MARK: - app lifecycle (background/foreground)

  /// ARKit already interrupts and later resumes tracking automatically
  /// around a transient system event (`sessionWasInterrupted`/
  /// `sessionInterruptionEnded`), so this is not required for correctness.
  /// It exists for the same reason the product spec treats the camera as
  /// sensitive: pausing the session as soon as the app stops being active —
  /// rather than waiting for the OS to notice — is the earliest point this
  /// process can stop reading camera frames, and resuming explicitly on
  /// return (rather than relying on an automatic resume that iOS does not
  /// guarantee for an app-initiated pause) is what lets capture continue
  /// working after a background/foreground cycle instead of silently
  /// failing closed on "no camera frame is available" until the user backs
  /// out of the scan and restarts it.
  private func registerLifecycleObservers() {
    let center = NotificationCenter.default
    center.addObserver(
      self,
      selector: #selector(handleWillResignActive),
      name: UIApplication.willResignActiveNotification,
      object: nil
    )
    center.addObserver(
      self,
      selector: #selector(handleDidBecomeActive),
      name: UIApplication.didBecomeActiveNotification,
      object: nil
    )
  }

  private func removeLifecycleObservers() {
    let center = NotificationCenter.default
    center.removeObserver(self, name: UIApplication.willResignActiveNotification, object: nil)
    center.removeObserver(self, name: UIApplication.didBecomeActiveNotification, object: nil)
  }

  @objc private func handleWillResignActive() {
    sessionQueue.async { [weak self] in self?.pauseOnQueue() }
  }

  private func pauseOnQueue() {
    dispatchPrecondition(condition: .onQueue(sessionQueue))
    // Read under the lock, act outside it. Holding a lock across an ARKit
    // call is what this design exists to avoid; the queue already guarantees
    // no other transition can run between the two.
    sessionLock.lock()
    let running = _session
    sessionLock.unlock()
    running?.pause()
    // The app is going to the background with, possibly, a participant's face
    // encoded in memory. The field-study protocol requires that it not survive
    // that transition, and JavaScript cannot be relied on to hear about it.
    rawFrames.discardAll()
    // Dropping the retained ARFrame matters as much as pausing (audit
    // IOS-Q11): holding it keeps a camera pixel buffer alive for as long as
    // the app is backgrounded, and leaves a pre-background frame sitting in
    // `latestFrame` as the answer `captureGeometry` would give to the first
    // capture after the app returns. The staleness bound in
    // `captureGeometry` would catch that, but holding nothing is the honest
    // state: this process has stopped reading the camera.
    clearTrackedState()
  }

  @objc private func handleDidBecomeActive() {
    sessionQueue.async { [weak self] in self?.resumeOnQueue() }
  }

  private func resumeOnQueue() {
    dispatchPrecondition(condition: .onQueue(sessionQueue))
    // This used to hold `sessionLock` across the `run()` below, so that a
    // concurrent `stop()` could not clear `_session` between the read and the
    // resume. That was the wrong tool: it is a lock held across an ARKit call,
    // and it did nothing for the far worse claim/stop/run window in
    // `beginSession`. Queue confinement solves both -- a `stop()` cannot run
    // between these two statements because it runs on this same serial queue
    // -- so the lock is now released before the ARKit call.
    sessionLock.lock()
    let running = _session
    sessionLock.unlock()
    guard let running, let configuration = running.configuration else { return }
    // No `.resetTracking`/`.removeExistingAnchors`: this resumes the same
    // session, it does not start a new capture attempt.
    running.run(configuration, options: [])
  }

  private func clearTrackedState(failure: Error? = nil) {
    faceLock.lock()
    trackedFaces.removeAll()
    trackedFaceCount = 0
    latestFrame = nil
    latestFrameRecordedAt = 0
    sessionFailure = failure
    faceLock.unlock()
  }

  @objc static func requiresMainQueueSetup() -> Bool { true }

  // MARK: - helpers

  private static func yawPitchDegrees(_ transform: simd_float4x4) -> (Float, Float) {
    // The wire matrix is row-major. These are the same Y-X-Z terms consumed by
    // StandardFaceObservation.yaw_pitch_roll_deg and by the Android bridge.
    let yaw = atan2(
      -transform.columns.0.z,
      sqrt(pow(transform.columns.0.x, 2) + pow(transform.columns.0.y, 2))
    )
    let pitch = atan2(transform.columns.1.z, transform.columns.2.z)
    return (yaw * 180 / .pi, pitch * 180 / .pi)
  }

  /// Expression is a nuisance variable, never a personality feature (FT-01 §15).
  private static func neutrality(_ blendshapes: [String: Float]) throws -> Float {
    let expressive = [
      "jawOpen", "mouthSmileLeft", "mouthSmileRight", "browInnerUp",
      "mouthFrownLeft", "mouthFrownRight", "browDownLeft", "browDownRight",
      "eyeSquintLeft", "eyeSquintRight", "cheekPuff", "mouthPucker",
    ]
    let activations = try expressive.map { key -> Float in
      guard let value = blendshapes[key], value.isFinite, (0 ... 1).contains(value) else {
        throw FaceFrameQualityError.invalidBlendshapes
      }
      return abs(value)
    }
    let present = activations.filter { $0 > 0 }
    let peak = activations.max() ?? 0
    let mean = present.isEmpty ? 0 : present.reduce(0, +) / Float(present.count)
    return min(max(1 - (0.7 * peak + 0.3 * mean), 0), 1)
  }

  private static func imageOrientation() -> CGImagePropertyOrientation {
    // Info.plist locks the capture UI to portrait. The TrueDepth feed is
    // mirrored relative to its landscape-right sensor orientation.
    return .leftMirrored
  }

  private func trackedFaceSnapshot() -> (ARFrame?, TimeInterval, [ARFaceAnchor], Int, Error?) {
    faceLock.lock()
    defer { faceLock.unlock() }
    let faces = trackedFaces.values.filter(\.isTracked)
    return (latestFrame, latestFrameRecordedAt, faces, trackedFaceCount, sessionFailure)
  }

  /// Runs `body` only while `session` is still the session this module owns,
  /// with the ownership test and the mutation inside a single critical
  /// section so a teardown cannot slip between them.
  ///
  /// Lock order is `sessionLock` then `faceLock` and never the reverse;
  /// `body` may take `faceLock` and must never take `sessionLock`.
  private func ifStillOwned(_ session: ARSession, _ body: () -> Void) {
    sessionLock.lock()
    defer { sessionLock.unlock() }
    guard _session === session else { return }
    body()
  }

  private func record(_ frame: ARFrame, from session: ARSession) {
    ifStillOwned(session) {
      faceLock.lock()
      defer { faceLock.unlock() }
      latestFrame = frame
      // Sampled here, from the same clock the staleness check reads, so the
      // bound measures "nothing has arrived for this long" without assuming
      // anything about which epoch `ARFrame.timestamp` is expressed in
      // (Codex review 2026-08-26T13-14-11Z, item 5).
      latestFrameRecordedAt = CACurrentMediaTime()
      let faces = frame.anchors.compactMap { $0 as? ARFaceAnchor }
      trackedFaces = Dictionary(uniqueKeysWithValues: faces.map { ($0.identifier, $0) })
      trackedFaceCount = trackedFaces.values.filter(\.isTracked).count
      sessionFailure = nil
    }
  }
}

/// Every callback below is identity-checked against the session this module
/// currently owns, via `ifStillOwned` (Codex review 2026-08-26T13-14-11Z,
/// item 2). None of them used to be, and ARKit does not promise that a
/// callback it has already dispatched will not arrive after the session was
/// paused and its delegate cleared. Two concrete failures followed:
///
///  - a frame from an abandoned session landing in `latestFrame` *after*
///    teardown cleared it, and then being served as the current pose's
///    evidence -- geometry and pixels from a session the user had finished
///    with, reported as this capture;
///  - a `didFailWithError` or `sessionWasInterrupted` from the old session
///    poisoning `sessionFailure` for the session that replaced it, so a
///    freshly restarted capture rejected FT-REC-005 for a failure that had
///    already been dealt with.
///
/// The check and the write share one critical section, so "still owned"
/// cannot become false between them.
extension FaceTypeCapture: ARSessionDelegate {
  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    // frame.anchors and capturedImage are one ARKit timestamp, so geometry,
    // face count and quality evidence cannot be mixed across camera frames.
    record(frame, from: session)
  }

  func session(_ session: ARSession, didFailWithError error: Error) {
    ifStillOwned(session) { clearTrackedState(failure: error) }
  }

  func sessionWasInterrupted(_ session: ARSession) {
    ifStillOwned(session) {
      clearTrackedState(
        failure: NSError(
          domain: "ai.facetype.capture",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "The ARKit session was interrupted."]
        )
      )
    }
  }
}

private struct FaceFrameQuality {
  let blur: Float
  let exposure: Float
  let occlusion: Float
}

private enum FaceFrameQualityError: Error {
  case invalidBlendshapes
  case multipleFaces
  case noFaceQuality
  case noLandmarks
  case noLumaPlane
}

private enum FaceFrameQualityEstimator {
  static func measure(
    _ pixelBuffer: CVPixelBuffer,
    orientation: CGImagePropertyOrientation
  ) throws -> FaceFrameQuality {
    let captureQualityRequest = VNDetectFaceCaptureQualityRequest()
    let landmarksRequest = VNDetectFaceLandmarksRequest()
    let handler = VNImageRequestHandler(
      cvPixelBuffer: pixelBuffer,
      orientation: orientation,
      options: [:]
    )
    try handler.perform([captureQualityRequest, landmarksRequest])

    let qualityFaces = captureQualityRequest.results ?? []
    guard qualityFaces.count <= 1 else { throw FaceFrameQualityError.multipleFaces }
    // Vision exposes this as `Float?` in the iOS 17 SDK used by Xcode 15.4;
    // it is already a Swift scalar rather than an NSNumber.
    guard let visionQuality = qualityFaces.first?.faceCaptureQuality else {
      throw FaceFrameQualityError.noFaceQuality
    }

    let landmarkFaces = landmarksRequest.results ?? []
    guard landmarkFaces.count <= 1 else { throw FaceFrameQualityError.multipleFaces }
    guard let landmarks = landmarkFaces.first?.landmarks else {
      throw FaceFrameQualityError.noLandmarks
    }

    // Occlusion evidence is the fraction of stable facial regions Vision could
    // not localise. This does not pretend to be a pixel segmentation mask.
    let regions: [VNFaceLandmarkRegion2D?] = [
      landmarks.faceContour,
      landmarks.leftEye,
      landmarks.rightEye,
      landmarks.leftEyebrow,
      landmarks.rightEyebrow,
      landmarks.nose,
      landmarks.outerLips,
    ]
    let availableRegions = regions.filter { ($0?.pointCount ?? 0) > 0 }.count
    let occlusion = 1 - Float(availableRegions) / Float(regions.count)

    return FaceFrameQuality(
      // Apple's normalized, face-specific capture-quality evidence replaces
      // the previous invented blur constant. Device calibration remains a gate.
      blur: min(max(visionQuality, 0), 1),
      exposure: try exposureScore(pixelBuffer),
      occlusion: min(max(occlusion, 0), 1)
    )
  }

  private static func exposureScore(_ pixelBuffer: CVPixelBuffer) throws -> Float {
    guard CVPixelBufferGetPlaneCount(pixelBuffer) > 0 else {
      throw FaceFrameQualityError.noLumaPlane
    }
    guard CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly) == kCVReturnSuccess else {
      throw FaceFrameQualityError.noLumaPlane
    }
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
    guard let address = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else {
      throw FaceFrameQualityError.noLumaPlane
    }

    let width = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
    let height = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
    let bytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
    let luma = address.assumingMemoryBound(to: UInt8.self)
    let samplingStride = 8
    let pixelFormat = CVPixelBufferGetPixelFormatType(pixelBuffer)
    let isVideoRange = pixelFormat == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    let blackValue = isVideoRange ? 16 : 0
    let whiteValue = isVideoRange ? 235 : 255
    var sum = 0.0
    var clipped = 0
    var samples = 0
    for row in Swift.stride(from: 0, to: height, by: samplingStride) {
      let rowStart = luma.advanced(by: row * bytesPerRow)
      for column in Swift.stride(from: 0, to: width, by: samplingStride) {
        let value = Int(rowStart[column])
        sum += Double(value)
        // ARKit can supply either full-range (`420f`) or video-range (`420v`)
        // bi-planar luma. Clipping at either format's endpoints loses evidence.
        if value <= blackValue || value >= whiteValue { clipped += 1 }
        samples += 1
      }
    }
    guard samples > 0 else { throw FaceFrameQualityError.noLumaPlane }

    let black = Double(blackValue)
    let white = Double(whiteValue)
    let midpoint = (black + white) / 2
    let halfRange = (white - black) / 2
    let mean = sum / Double(samples)
    let balance = max(0, 1 - abs(mean - midpoint) / halfRange)
    let unclipped = 1 - Double(clipped) / Double(samples)
    return Float(min(balance, unclipped))
  }
}
