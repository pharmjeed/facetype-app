//
//  FaceTypeClientFrameAnalyzer.swift
//  FaceType AI — per-frame QA for the client camera (docs/client-native-interface.md §2,
//  docs/capture-spec-v2.md §3–§4).
//
//  One delivered camera buffer in, one set of unsmoothed measurements and
//  per-check booleans out. MediaPipe Face Landmarker (IMAGE mode, contract
//  §5.15 -- no tracking or smoothing carried from the previous frame, the same
//  mode as Android; numFaces = 2, blendshapes and facial transformation
//  matrices on) runs on a copy of the SAME pixel buffer downscaled to a
//  1280 px long side (never upscaled); the pixel statistics (light,
//  sharpness) are read from the full-resolution buffer itself. Nothing here
//  smooths, remembers or guesses: a value that cannot be measured is `nil`,
//  and a check whose input is `nil` or non-finite fails.
//
//  WHAT THIS FILE MUST NEVER DO
//  Touch ARKit, Face ID, LocalAuthentication or the Secure Enclave (FT-00 §3).
//  MediaPipe landmarking is not recognition: it builds no template and no
//  identifier.
//

import Accelerate
import CoreVideo
import CryptoKit
import Foundation
import MediaPipeTasksVision
import UIKit

/// Every value one frame is judged on, unsmoothed. `nil` = not measurable.
struct FaceTypeClientMeasurement {
  var faces = 0
  var yaw: Double?
  var pitch: Double?
  var roll: Double?
  var interPupilPx: Double?
  /// Distance between landmarks 234 and 454, in delivered-frame pixels.
  var faceWidthPx: Double?
  /// [x, y, w, h], normalised to the upright, unmirrored delivered frame.
  var faceBox: [Double]?
  var eyeMidX: Double?
  var faceCentreY: Double?
  var irisDiameterPx: Double?
  var distanceCm: Double?
  var clipFrac: Double?
  var crushFrac: Double?
  var cheekRatio: Double?
  var smile: Double?
  var jawOpen: Double?
  var blinkL: Double?
  var blinkR: Double?
  /// Landmark eye-opening ratios (lid gap / eye width), subject's left/right.
  var openingL: Double?
  var openingR: Double?
  var sharpness: Double?
  var blendshapes: [String: Double] = [:]
  /// Flat [x, y, z] * 478, normalised as MediaPipe delivers them.
  var landmarks: [Float] = []
  var checks = FaceTypeClientChecks()
}

/// The per-frame checks of docs/client-native-interface.md §2, unsmoothed.
struct FaceTypeClientChecks {
  var oneFace = false
  var distanceOrSize = false
  var centred = false
  var facing = false
  var light = false
  var expression = false
  var eyes = false
  var sharp = false

  /// Guidance priority (capture-spec-v2 §3), then the remaining frame rules.
  /// The first failing name is the frame's reject reason.
  static let priority = [
    "oneFace", "distanceOrSize", "centred", "facing", "light", "expression", "eyes", "sharp",
  ]

  private var ordered: [(String, Bool)] {
    [
      ("oneFace", oneFace), ("distanceOrSize", distanceOrSize), ("centred", centred),
      ("facing", facing), ("light", light), ("expression", expression), ("eyes", eyes),
      ("sharp", sharp),
    ]
  }

  var firstFailure: String? { ordered.first { !$0.1 }?.0 }

  /// camelCase, for `onFrameMeasure`.
  var eventPayload: [String: Any] {
    var out: [String: Any] = [:]
    for (name, passed) in ordered { out[name] = passed }
    return out
  }

  /// snake_case, for `FrameMeta.checks`.
  var metaPayload: [String: Any] {
    [
      "one_face": oneFace, "distance_or_size": distanceOrSize, "centred": centred,
      "facing": facing, "light": light, "expression": expression, "eyes": eyes, "sharp": sharp,
    ]
  }
}

struct FaceTypeClientModelError: Error {
  let message: String
}

final class FaceTypeClientFrameAnalyzer {
  /// The MediaPipeTasksVision pod version (Podfile) -- the same release line
  /// Android declares as `com.google.mediapipe:tasks-vision`.
  static let tasksVisionVersion = "0.10.35"
  static let modelResource = "face_landmarker"
  static let modelExtension = "task"
  /// Same pin as `faceLandmarkerModelSha256` in android/app/build.gradle and
  /// `MODEL_SHA256` in ios/scripts/fetch-face-landmarker.sh; the contract test
  /// fails if the three drift apart. The bundled file is hashed at runtime and
  /// refused unless it matches.
  static let pinnedModelSha256 = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"
  /// MediaPipe's own defaults, recorded with every frame.
  static let minFaceDetectionConfidence: Float = 0.5
  static let minFacePresenceConfidence: Float = 0.5
  static let minTrackingConfidence: Float = 0.5
  /// Long side of the downscaled analysis copy (contract §5.15; Android
  /// `ClientCameraSession.MEDIAPIPE_LONG_SIDE` is the same 1280). Landmarks are
  /// normalised, so every pixel measure below is computed in full
  /// delivered-frame pixels.
  static let analysisLongSide = 1280

  /// Measurement definitions (not gate thresholds -- the allowed fractions
  /// come from `gate.light`): a sample is clipped at Rec.709 luma >= 250 and
  /// crushed at <= 5 on the 0–255 scale.
  static let clippedLuma = 250.0
  static let crushedLuma = 5.0

  // MediaPipe face-mesh indices used below.
  static let irisCentreRight = 468   // subject's right iris centre
  static let irisCentreLeft = 473    // subject's left iris centre
  static let irisRingRight = [469, 470, 471, 472]
  static let irisRingLeft = [474, 475, 476, 477]
  static let faceWidthLandmarks = (234, 454)
  static let eyeRight = (upper: 159, lower: 145, outer: 33, inner: 133)
  static let eyeLeft = (upper: 386, lower: 374, outer: 263, inner: 362)
  // Cheek patches and their order are fixed by contract §5.4:
  // cheek_ratio = meanY(205) / meanY(425). In the stored (upright,
  // unmirrored) frame 205 is the subject's right cheek, on the image's left.
  static let cheekLeft = 205
  static let cheekRight = 425
  static let noseTip = 4

  let modelSha256: String
  private let landmarker: FaceLandmarker
  private var pool: CVPixelBufferPool?
  private var poolWidth = 0
  private var poolHeight = 0
  private(set) var analysisWidth = 0
  private(set) var analysisHeight = 0

  private init(landmarker: FaceLandmarker, modelSha256: String) {
    self.landmarker = landmarker
    self.modelSha256 = modelSha256
  }

  private static let hashLock = NSLock()
  private static var cachedModelHash: String??

  static var modelPath: String? {
    Bundle.main.path(forResource: modelResource, ofType: modelExtension)
  }

  /// SHA-256 of the model file actually bundled, or `nil` if none is.
  static func bundledModelSha256() -> String? {
    hashLock.lock()
    defer { hashLock.unlock() }
    if let cached = cachedModelHash { return cached }
    var digest: String?
    if let path = modelPath,
      let data = try? Data(contentsOf: URL(fileURLWithPath: path), options: .mappedIfSafe)
    {
      digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    cachedModelHash = .some(digest)
    return digest
  }

  static func make() -> Result<FaceTypeClientFrameAnalyzer, FaceTypeClientModelError> {
    guard let path = modelPath, let digest = bundledModelSha256() else {
      return .failure(FaceTypeClientModelError(message: "face_landmarker.task is not in the app bundle"))
    }
    guard digest == pinnedModelSha256 else {
      return .failure(
        FaceTypeClientModelError(message: "bundled face_landmarker.task hashes to \(digest), not the pinned model")
      )
    }
    let options = FaceLandmarkerOptions()
    options.baseOptions.modelAssetPath = path
    options.runningMode = .image
    options.numFaces = 2
    options.minFaceDetectionConfidence = minFaceDetectionConfidence
    options.minFacePresenceConfidence = minFacePresenceConfidence
    options.minTrackingConfidence = minTrackingConfidence
    options.outputFaceBlendshapes = true
    options.outputFacialTransformationMatrixes = true
    do {
      let landmarker = try FaceLandmarker(options: options)
      return .success(FaceTypeClientFrameAnalyzer(landmarker: landmarker, modelSha256: digest))
    } catch {
      return .failure(FaceTypeClientModelError(message: "FaceLandmarker could not be created: \(error.localizedDescription)"))
    }
  }

  /// `FrameMeta.mediapipe_options`.
  var optionsPayload: [String: Any] {
    [
      "tasks_vision_version": Self.tasksVisionVersion,
      "running_mode": "image",
      "num_faces": 2,
      "min_face_detection_confidence": Double(Self.minFaceDetectionConfidence),
      "min_face_presence_confidence": Double(Self.minFacePresenceConfidence),
      "min_tracking_confidence": Double(Self.minTrackingConfidence),
      "output_face_blendshapes": true,
      "output_facial_transformation_matrixes": true,
      "delegate": "cpu",
      "input": "downscaled_copy_of_the_delivered_buffer",
      "analysis_long_side": Self.analysisLongSide,
      "analysis_w": analysisWidth,
      "analysis_h": analysisHeight,
    ]
  }

  // MARK: - analysis

  /// Confined to the caller's serial video queue (the analyser reuses one
  /// pixel-buffer pool). IMAGE mode: each call judges this buffer alone.
  func analyse(
    _ pixelBuffer: CVPixelBuffer,
    gate: FaceTypeClientGateConfig,
    focalPx: Double?
  ) -> FaceTypeClientMeasurement {
    var m = measure(pixelBuffer, gate: gate, focalPx: focalPx)
    m.checks = Self.evaluate(
      m,
      gate: gate,
      frameWidth: CVPixelBufferGetWidth(pixelBuffer),
      focalKnown: focalPx != nil
    )
    return m
  }

  private func measure(
    _ pixelBuffer: CVPixelBuffer,
    gate: FaceTypeClientGateConfig,
    focalPx: Double?
  ) -> FaceTypeClientMeasurement {
    var m = FaceTypeClientMeasurement()
    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)

    guard CVPixelBufferGetPixelFormatType(pixelBuffer) == kCVPixelFormatType_32BGRA,
      width > 0, height > 0,
      let small = downscaledCopy(of: pixelBuffer, width: width, height: height),
      let image = try? MPImage(pixelBuffer: small)
    else { return m }

    guard let result = try? landmarker.detect(image: image) else { return m }

    m.faces = result.faceLandmarks.count
    guard m.faces > 0 else { return m }

    let W = Double(width)
    let H = Double(height)
    // With two faces the checks still fail on `oneFace`; the measures describe
    // the largest face so guidance can still say something sensible.
    var index = 0
    var largest = -1.0
    for (i, face) in result.faceLandmarks.enumerated() {
      guard let box = Self.box(face) else { continue }
      if box[2] * box[3] > largest {
        largest = box[2] * box[3]
        index = i
      }
    }
    let face = result.faceLandmarks[index]
    guard face.count >= 478, let box = Self.box(face) else { return m }

    func point(_ i: Int) -> (x: Double, y: Double) { (Double(face[i].x) * W, Double(face[i].y) * H) }
    func distance(_ a: Int, _ b: Int) -> Double {
      let p = point(a)
      let q = point(b)
      return ((p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y)).squareRoot()
    }

    var flat: [Float] = []
    flat.reserveCapacity(478 * 3)
    for landmark in face.prefix(478) {
      flat.append(landmark.x)
      flat.append(landmark.y)
      flat.append(landmark.z)
    }
    // A non-finite coordinate cannot be stored as JSON; record none rather
    // than a partly invented set.
    m.landmarks = flat.allSatisfy(\.isFinite) ? flat : []
    m.faceBox = box
    m.faceCentreY = finiteValue(box[1] + box[3] / 2)
    m.eyeMidX = finiteValue((Double(face[Self.irisCentreRight].x) + Double(face[Self.irisCentreLeft].x)) / 2)
    m.interPupilPx = finiteValue(distance(Self.irisCentreRight, Self.irisCentreLeft))
    m.faceWidthPx = finiteValue(distance(Self.faceWidthLandmarks.0, Self.faceWidthLandmarks.1))

    // Iris diameter: the two opposite pairs of each 4-point iris ring
    // (469–471, 470–472 and 474–476, 475–477), averaged.
    let diameters = [
      distance(Self.irisRingRight[0], Self.irisRingRight[2]),
      distance(Self.irisRingRight[1], Self.irisRingRight[3]),
      distance(Self.irisRingLeft[0], Self.irisRingLeft[2]),
      distance(Self.irisRingLeft[1], Self.irisRingLeft[3]),
    ]
    let iris = diameters.reduce(0, +) / Double(diameters.count)
    if iris.isFinite, iris > 0 {
      m.irisDiameterPx = iris
      if let fx = focalPx {
        // Pinhole estimate: f[px] * iris[mm] / iris[px], in cm. An estimate
        // with a recorded method, never presented as a measurement.
        m.distanceCm = finiteValue(fx * gate.distance.irisMm / iris / 10)
      }
    }

    func opening(_ eye: (upper: Int, lower: Int, outer: Int, inner: Int)) -> Double? {
      let widthPx = distance(eye.outer, eye.inner)
      guard widthPx > 0 else { return nil }
      return finiteValue(distance(eye.upper, eye.lower) / widthPx)
    }
    m.openingR = opening(Self.eyeRight)
    m.openingL = opening(Self.eyeLeft)

    if index < result.facialTransformationMatrixes.count {
      let pose = Self.pose(result.facialTransformationMatrixes[index])
      m.yaw = pose?.yaw
      m.pitch = pose?.pitch
      m.roll = pose?.roll
    }

    if index < result.faceBlendshapes.count {
      for category in result.faceBlendshapes[index].categories {
        guard let name = category.categoryName, !name.isEmpty else { continue }
        let score = Double(category.score)
        if score.isFinite { m.blendshapes[name] = score }
      }
    }
    if let left = m.blendshapes["mouthSmileLeft"], let right = m.blendshapes["mouthSmileRight"] {
      m.smile = max(left, right)
    }
    m.jawOpen = m.blendshapes["jawOpen"]
    m.blinkL = m.blendshapes["eyeBlinkLeft"]
    m.blinkR = m.blendshapes["eyeBlinkRight"]

    measurePixels(pixelBuffer, width: width, height: height, point: point, box: box, into: &m)
    return m
  }

  /// Per-check booleans with the contract's entry limits; no state, no
  /// smoothing. A `nil` or non-finite input fails its check.
  static func evaluate(
    _ m: FaceTypeClientMeasurement,
    gate: FaceTypeClientGateConfig,
    frameWidth: Int,
    focalKnown: Bool
  ) -> FaceTypeClientChecks {
    func within(_ value: Double?, _ range: [Double]) -> Bool {
      guard let value, value.isFinite, range.count == 2 else { return false }
      return value >= range[0] && value <= range[1]
    }
    var c = FaceTypeClientChecks()
    // Any detected second face blocks storing.
    c.oneFace = m.faces == 1

    // Size always; distance in addition when the focal length is known.
    var sizeOK = false
    if let widthPx = m.faceWidthPx, frameWidth > 0 {
      sizeOK = widthPx >= gate.size.minFaceWidthPx
        && widthPx / Double(frameWidth) <= gate.size.maxFaceWidthFrac
    }
    let distanceOK = focalKnown ? within(m.distanceCm, gate.distance.enterCm) : true
    c.distanceOrSize = sizeOK && distanceOK

    if let box = m.faceBox, box.count == 4 {
      let margin = gate.centre.edgeMarginFrac
      let insideEdges = box[0] >= margin && box[1] >= margin
        && box[0] + box[2] <= 1 - margin && box[1] + box[3] <= 1 - margin
      c.centred = insideEdges
        && within(m.eyeMidX, gate.centre.eyeMidX)
        && within(m.faceCentreY, gate.centre.faceCentreY)
    }

    if let yaw = m.yaw, let pitch = m.pitch, yaw.isFinite, pitch.isFinite {
      c.facing = abs(yaw) <= gate.pose.enterDeg && abs(pitch) <= gate.pose.enterDeg
    }

    if let clip = m.clipFrac, let crush = m.crushFrac {
      c.light = clip <= gate.light.maxClipFrac && crush <= gate.light.maxCrushFrac
        && within(m.cheekRatio, gate.light.cheekRatio)
    }

    if let smile = m.smile, let jaw = m.jawOpen, smile.isFinite, jaw.isFinite {
      c.expression = smile <= gate.expression.maxSmile && jaw <= gate.expression.maxJawOpen
    }

    // The blink scores per frame; the relative-opening rule needs the burst
    // and is applied in FaceTypeClientBurstRules. A missing score never
    // counts as an open eye.
    if let l = m.blinkL, let r = m.blinkR, l.isFinite, r.isFinite,
      let openL = m.openingL, let openR = m.openingR, openL > 0, openR > 0
    {
      c.eyes = l <= gate.eyes.maxBlink && r <= gate.eyes.maxBlink
    }

    // No absolute floor (A7.78-B): a frame only has to be measurable here;
    // `sharpness.minRelativeToBurstMax` is applied across the burst.
    if let s = m.sharpness, s.isFinite, s > 0 { c.sharp = true }
    return c
  }

  // MARK: - helpers

  private static func box(_ face: [NormalizedLandmark]) -> [Double]? {
    guard !face.isEmpty else { return nil }
    var minX = Double.infinity
    var minY = Double.infinity
    var maxX = -Double.infinity
    var maxY = -Double.infinity
    for landmark in face {
      let x = Double(landmark.x)
      let y = Double(landmark.y)
      guard x.isFinite, y.isFinite else { return nil }
      minX = min(minX, x)
      minY = min(minY, y)
      maxX = max(maxX, x)
      maxY = max(maxY, y)
    }
    guard maxX > minX, maxY > minY else { return nil }
    return [minX, minY, maxX - minX, maxY - minY]
  }

  /// Yaw/pitch/roll in degrees from the facial transformation matrix.
  ///
  /// MediaPipe packs the matrix COLUMN-major (`MatrixDataProtoFromMatrix`,
  /// mediapipe/framework/formats/matrix.cc), while
  /// `TransformMatrix.value(atRow:column:)` indexes the packed data as
  /// `data[row * rows + column]` (MPPFaceLandmarkerResult.mm, v0.10.35) --
  /// i.e. it returns the transpose. Element (r, c) is therefore read directly
  /// as `data[c * rows + r]` (contract §5.1).
  private static func pose(_ matrix: TransformMatrix) -> (yaw: Double, pitch: Double, roll: Double)? {
    // `rows`/`columns` are NSUInteger (UInt in Swift); the pointer subscript takes Int.
    let rows = Int(matrix.rows)
    guard rows >= 3, Int(matrix.columns) >= 3 else { return nil }
    let data = matrix.data
    return pose(columnMajor: { row, column in Double(data[column * rows + row]) })
  }

  /// THE ONE FORMULA (contract §5.14, identical to Android
  /// `FaceGeometryCalc.poseDegrees`): R = Ry(yaw) · Rx(pitch) · Rz(roll), with
  /// each column of the 3x3 rotation block normalised first (MediaPipe's
  /// transform may carry a uniform scale):
  /// `yaw = atan2(R[0][2], R[2][2])`, `pitch = asin(clamp(-R[1][2], -1, 1))`,
  /// `roll = atan2(R[1][0], R[1][1])`. `docs/fixtures/pose_golden.json`
  /// (tools/pose_golden.py) holds the golden matrices both platforms must
  /// reproduce to 0.01°.
  static func pose(columnMajor element: (Int, Int) -> Double) -> (yaw: Double, pitch: Double, roll: Double)? {
    var r = [[Double]](repeating: [0, 0, 0], count: 3)
    for row in 0..<3 {
      for column in 0..<3 { r[row][column] = element(row, column) }
    }
    for column in 0..<3 {
      let norm = (r[0][column] * r[0][column] + r[1][column] * r[1][column] + r[2][column] * r[2][column])
        .squareRoot()
      guard norm.isFinite, norm >= 1e-9 else { return nil }
      for row in 0..<3 { r[row][column] /= norm }
    }
    let degrees = 180.0 / Double.pi
    let yaw = atan2(r[0][2], r[2][2]) * degrees
    let pitch = asin(min(1, max(-1, -r[1][2]))) * degrees
    let roll = atan2(r[1][0], r[1][1]) * degrees
    guard yaw.isFinite, pitch.isFinite, roll.isFinite else { return nil }
    return (yaw, pitch, roll)
  }

  /// A BGRA copy of `source`, scaled so its long side is
  /// `analysisLongSide` (or `source` itself when it is already that small).
  private func downscaledCopy(of source: CVPixelBuffer, width: Int, height: Int) -> CVPixelBuffer? {
    let longSide = max(width, height)
    guard longSide > Self.analysisLongSide else {
      analysisWidth = width
      analysisHeight = height
      return source
    }
    let scale = Double(Self.analysisLongSide) / Double(longSide)
    let targetWidth = max(1, Int((Double(width) * scale).rounded()))
    let targetHeight = max(1, Int((Double(height) * scale).rounded()))
    if pool == nil || poolWidth != targetWidth || poolHeight != targetHeight {
      let attributes: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: targetWidth,
        kCVPixelBufferHeightKey as String: targetHeight,
        kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
      ]
      var created: CVPixelBufferPool?
      CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes as CFDictionary, &created)
      pool = created
      poolWidth = targetWidth
      poolHeight = targetHeight
    }
    guard let activePool = pool else { return nil }
    var output: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, activePool, &output) == kCVReturnSuccess,
      let destination = output
    else { return nil }

    guard CVPixelBufferLockBaseAddress(source, .readOnly) == kCVReturnSuccess else { return nil }
    defer { CVPixelBufferUnlockBaseAddress(source, .readOnly) }
    guard CVPixelBufferLockBaseAddress(destination, []) == kCVReturnSuccess else { return nil }
    defer { CVPixelBufferUnlockBaseAddress(destination, []) }
    guard let sourceBase = CVPixelBufferGetBaseAddress(source),
      let destinationBase = CVPixelBufferGetBaseAddress(destination)
    else { return nil }

    var src = vImage_Buffer(
      data: sourceBase,
      height: vImagePixelCount(height),
      width: vImagePixelCount(width),
      rowBytes: CVPixelBufferGetBytesPerRow(source)
    )
    var dst = vImage_Buffer(
      data: destinationBase,
      height: vImagePixelCount(targetHeight),
      width: vImagePixelCount(targetWidth),
      rowBytes: CVPixelBufferGetBytesPerRow(destination)
    )
    // Channel-order agnostic: scales any interleaved 4 x 8-bit buffer.
    guard vImageScale_ARGB8888(&src, &dst, nil, vImage_Flags(kvImageNoFlags)) == kvImageNoError else {
      return nil
    }
    analysisWidth = targetWidth
    analysisHeight = targetHeight
    return destination
  }

  /// Light (cheeks + nose) and sharpness (central face crop), read from the
  /// full-resolution delivered buffer on a sparse grid.
  private func measurePixels(
    _ buffer: CVPixelBuffer,
    width: Int,
    height: Int,
    point: (Int) -> (x: Double, y: Double),
    box: [Double],
    into m: inout FaceTypeClientMeasurement
  ) {
    guard CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else { return }
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }
    let bytes = base.assumingMemoryBound(to: UInt8.self)
    let rowBytes = CVPixelBufferGetBytesPerRow(buffer)

    func luma(_ x: Int, _ y: Int) -> Double {
      let p = bytes + y * rowBytes + x * 4
      // BGRA byte order; Rec.709 luma.
      return 0.0722 * Double(p[0]) + 0.7152 * Double(p[1]) + 0.2126 * Double(p[2])
    }

    // Light: three square patches, 15% of the face width on a side.
    if let faceWidth = m.faceWidthPx, faceWidth > 0 {
      let half = 0.075 * faceWidth
      struct Patch { var sum = 0.0; var count = 0; var clipped = 0; var crushed = 0 }
      func patch(_ landmark: Int) -> Patch? {
        let centre = point(landmark)
        let x0 = max(0, Int((centre.x - half).rounded(.down)))
        let x1 = min(width - 1, Int((centre.x + half).rounded(.up)))
        let y0 = max(0, Int((centre.y - half).rounded(.down)))
        let y1 = min(height - 1, Int((centre.y + half).rounded(.up)))
        guard x1 > x0, y1 > y0 else { return nil }
        let step = max(1, (x1 - x0) / 24)
        var out = Patch()
        var y = y0
        while y <= y1 {
          var x = x0
          while x <= x1 {
            let value = luma(x, y)
            out.sum += value
            out.count += 1
            if value >= Self.clippedLuma { out.clipped += 1 }
            if value <= Self.crushedLuma { out.crushed += 1 }
            x += step
          }
          y += step
        }
        return out.count >= 16 ? out : nil
      }
      if let left = patch(Self.cheekLeft), let right = patch(Self.cheekRight), let nose = patch(Self.noseTip) {
        let total = Double(left.count + right.count + nose.count)
        m.clipFrac = finiteValue(Double(left.clipped + right.clipped + nose.clipped) / total)
        m.crushFrac = finiteValue(Double(left.crushed + right.crushed + nose.crushed) / total)
        let rightMean = right.sum / Double(right.count)
        if rightMean > 0 {
          m.cheekRatio = finiteValue((left.sum / Double(left.count)) / rightMean)
        }
      }
    }

    // Sharpness: contrast-normalised Laplacian energy (Laplacian variance /
    // intensity variance) over the central half of the face box, on a grid
    // about 128 samples wide so the value does not depend on stream size.
    let centreX = (box[0] + box[2] / 2) * Double(width)
    let centreY = (box[1] + box[3] / 2) * Double(height)
    let halfW = box[2] * Double(width) / 4
    let halfH = box[3] * Double(height) / 4
    let x0 = max(0, Int(centreX - halfW))
    let x1 = min(width - 1, Int(centreX + halfW))
    let y0 = max(0, Int(centreY - halfH))
    let y1 = min(height - 1, Int(centreY + halfH))
    guard x1 > x0, y1 > y0 else { return }
    let step = max(1, (x1 - x0) / 128)
    var count = 0.0
    var lapSum = 0.0
    var lapSquares = 0.0
    var sum = 0.0
    var squares = 0.0
    var y = y0 + step
    while y < y1 - step {
      var x = x0 + step
      while x < x1 - step {
        let c = luma(x, y)
        let laplacian = 4 * c - luma(x - step, y) - luma(x + step, y) - luma(x, y - step) - luma(x, y + step)
        lapSum += laplacian
        lapSquares += laplacian * laplacian
        sum += c
        squares += c * c
        count += 1
        x += step
      }
      y += step
    }
    guard count >= 64 else { return }
    let lapVariance = lapSquares / count - (lapSum / count) * (lapSum / count)
    let variance = squares / count - (sum / count) * (sum / count)
    guard variance > 1e-9, lapVariance >= 0 else { return }
    m.sharpness = finiteValue(lapVariance / variance)
  }
}

/// `nil` for anything that cannot be serialised as a JSON number. (Not named
/// `finite`: Darwin already exports C's `finite(double) -> Int32`, which an
/// unlabelled `Double` argument would resolve to.)
func finiteValue(_ value: Double?) -> Double? {
  guard let value, value.isFinite else { return nil }
  return value
}
