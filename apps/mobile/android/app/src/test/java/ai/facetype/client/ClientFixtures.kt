package ai.facetype.client

/** Shared fixtures for the client-camera JVM tests. */
internal object ClientFixtures {

  /** The contract's gate config (docs/client-native-interface.md §1) with its documented values. */
  const val GATE_CONFIG_JSON = """
  {
    "version": "client-gate-1",
    "stream": { "preferredSizes": [[3840, 2160], [1920, 1080], [1280, 720]], "minSize": [1280, 720],
                "preferredMinFps": 15, "jpegQuality": 95 },
    "faces": { "maxFaces": 2 },
    "pose": { "enterDeg": 8, "exitDeg": 12, "rollMessageDeg": 15 },
    "distance": { "enterCm": [35, 60], "exitCm": [32, 65], "irisMm": 11.7 },
    "size": { "minFaceWidthPx": 220, "preferredFaceWidthPx": 350, "maxFaceWidthFrac": 0.7 },
    "centre": { "eyeMidX": [0.4, 0.6], "faceCentreY": [0.35, 0.65], "edgeMarginFrac": 0.05 },
    "light": { "maxClipFrac": 0.01, "maxCrushFrac": 0.02, "cheekRatio": [0.5, 2] },
    "expression": { "maxSmile": 0.3, "maxJawOpen": 0.05 },
    "eyes": { "maxBlink": 0.5, "minRelativeOpening": 0.7 },
    "sharpness": { "minRelativeToBurstMax": 0.5 },
    "burst": { "targetFrames": 10, "maxDurationMs": 8000, "minSpacingMs": 66, "minCoverageMs": 1000, "holdMs": 500 },
    "labels": { "pose.enterDeg": "default", "expression.maxSmile": "research", "size.minFaceWidthPx": "validated" }
  }
  """

  val config: ClientGateConfig by lazy { ClientGateConfig.parse(GATE_CONFIG_JSON) }

  /** A frontal face geometry that passes every per-frame check in a 1080 x 1920 upright frame. */
  fun goodGeometry(
    yaw: Double = 1.0,
    pitch: Double = -2.0,
    faceWidthPx: Double = 400.0,
    faceBox: DoubleArray = doubleArrayOf(0.3, 0.3, 0.4, 0.35),
    eyeMidX: Double = 0.5,
    faceCentreY: Double = 0.475,
    openingL: Double? = 0.30,
    openingR: Double? = 0.31,
    iris: Double? = 30.0,
  ) = FaceGeometry(
    yawDeg = yaw,
    pitchDeg = pitch,
    rollDeg = 3.0,
    interPupilPx = 180.0,
    faceWidthPx = faceWidthPx,
    faceBox = faceBox,
    faceBoxPx = doubleArrayOf(324.0, 576.0, 756.0, 1248.0),
    eyeMidX = eyeMidX,
    faceCentreY = faceCentreY,
    irisDiameterPx = iris,
    eyeOpeningL = openingL,
    eyeOpeningR = openingR,
  )

  fun goodMeasurement(
    faces: Int = 1,
    geometry: FaceGeometry? = goodGeometry(),
    focalKnown: Boolean = true,
    distanceCm: Double? = 45.0,
    clip: Double? = 0.0,
    crush: Double? = 0.0,
    cheek: Double? = 1.1,
    smile: Double? = 0.05,
    jaw: Double? = 0.01,
    blinkL: Double? = 0.1,
    blinkR: Double? = 0.12,
    sharpness: Double? = 0.9,
  ) = FrameMeasurement(
    faces = faces,
    uprightWidth = 1080,
    uprightHeight = 1920,
    geometry = geometry,
    focalKnown = focalKnown,
    distanceCm = distanceCm,
    clipFrac = clip,
    crushFrac = crush,
    cheekRatio = cheek,
    smile = smile,
    jawOpen = jaw,
    blinkL = blinkL,
    blinkR = blinkR,
    sharpness = sharpness,
    gyroDegPerS = 1.5,
  )
}
