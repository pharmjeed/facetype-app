package ai.facetype.client

import java.security.MessageDigest

/**
 * The gate configuration JavaScript passes in (`docs/client-native-interface.md` §1).
 *
 * Native code hard-codes no threshold: every number the per-frame checks and the
 * burst use is read from here, and [hash] (SHA-256 of the canonical JSON) is
 * stamped on every stored frame so a frame always says which rules admitted it.
 *
 * Parsing is strict. A missing or non-finite field is an [IllegalArgumentException]
 * rather than a default: a silently defaulted threshold would admit frames under
 * a rule nobody configured, while the hash still claimed the configured one.
 */
internal data class ClientGateConfig(
  val version: String,
  val stream: Stream,
  val faces: Faces,
  val pose: Pose,
  val distance: Distance,
  val size: Size,
  val centre: Centre,
  val light: Light,
  val expression: Expression,
  val eyes: Eyes,
  val sharpness: Sharpness,
  val burst: Burst,
  val labels: Map<String, String>,
  /** SHA-256 hex of [Json.canonical] of the parsed document. */
  val hash: String,
) {
  data class Stream(
    val preferredSizes: List<PixelSize>,
    val minSize: PixelSize,
    val preferredMinFps: Double,
    val jpegQuality: Int,
  )

  data class Faces(val maxFaces: Int)

  data class Pose(val enterDeg: Double, val exitDeg: Double, val rollMessageDeg: Double)

  data class Distance(val enterCm: ClosedRange, val exitCm: ClosedRange, val irisMm: Double)

  data class Size(val minFaceWidthPx: Double, val preferredFaceWidthPx: Double, val maxFaceWidthFrac: Double)

  data class Centre(val eyeMidX: ClosedRange, val faceCentreY: ClosedRange, val edgeMarginFrac: Double)

  data class Light(val maxClipFrac: Double, val maxCrushFrac: Double, val cheekRatio: ClosedRange)

  data class Expression(val maxSmile: Double, val maxJawOpen: Double)

  data class Eyes(val maxBlink: Double, val minRelativeOpening: Double)

  data class Sharpness(val minRelativeToBurstMax: Double)

  data class Burst(
    val targetFrames: Int,
    val maxDurationMs: Long,
    val minSpacingMs: Long,
    val minCoverageMs: Long,
    val holdMs: Long,
  )

  /** An inclusive numeric interval `[min, max]`. */
  data class ClosedRange(val min: Double, val max: Double) {
    /** False for any non-finite [value]: a missing measurement never passes. */
    fun contains(value: Double?): Boolean =
      value != null && value.isFinite() && value >= min && value <= max
  }

  companion object {
    const val VERSION = "client-gate-1"

    fun parse(json: String): ClientGateConfig {
      val root = Json.parse(json) as? Map<*, *>
        ?: throw IllegalArgumentException("gate config must be a JSON object")
      val version = root["version"] as? String
        ?: throw IllegalArgumentException("gate config has no version")
      require(version == VERSION) { "unsupported gate config version '$version'" }

      val stream = obj(root, "stream")
      val faces = obj(root, "faces")
      val pose = obj(root, "pose")
      val distance = obj(root, "distance")
      val size = obj(root, "size")
      val centre = obj(root, "centre")
      val light = obj(root, "light")
      val expression = obj(root, "expression")
      val eyes = obj(root, "eyes")
      val sharpness = obj(root, "sharpness")
      val burst = obj(root, "burst")
      val labelsRaw = root["labels"] as? Map<*, *> ?: emptyMap<String, String>()

      val preferredSizes = (stream["preferredSizes"] as? List<*>)
        ?.map { pixelSize(it, "stream.preferredSizes") }
        ?: throw IllegalArgumentException("stream.preferredSizes is missing")
      require(preferredSizes.isNotEmpty()) { "stream.preferredSizes is empty" }

      val jpegQuality = int(stream, "jpegQuality", "stream")
      require(jpegQuality in 1..100) { "stream.jpegQuality must be 1..100" }
      val maxFaces = int(faces, "maxFaces", "faces")
      require(maxFaces >= 2) { "faces.maxFaces must be at least 2 so a second face can be seen" }

      val config = ClientGateConfig(
        version = version,
        stream = Stream(
          preferredSizes = preferredSizes,
          minSize = pixelSize(stream["minSize"], "stream.minSize"),
          preferredMinFps = positive(stream, "preferredMinFps", "stream"),
          jpegQuality = jpegQuality,
        ),
        faces = Faces(maxFaces),
        pose = Pose(
          enterDeg = positive(pose, "enterDeg", "pose"),
          exitDeg = positive(pose, "exitDeg", "pose"),
          rollMessageDeg = positive(pose, "rollMessageDeg", "pose"),
        ),
        distance = Distance(
          enterCm = range(distance, "enterCm", "distance"),
          exitCm = range(distance, "exitCm", "distance"),
          irisMm = positive(distance, "irisMm", "distance"),
        ),
        size = Size(
          minFaceWidthPx = positive(size, "minFaceWidthPx", "size"),
          preferredFaceWidthPx = positive(size, "preferredFaceWidthPx", "size"),
          maxFaceWidthFrac = fraction(size, "maxFaceWidthFrac", "size"),
        ),
        centre = Centre(
          eyeMidX = range(centre, "eyeMidX", "centre"),
          faceCentreY = range(centre, "faceCentreY", "centre"),
          edgeMarginFrac = fraction(centre, "edgeMarginFrac", "centre"),
        ),
        light = Light(
          maxClipFrac = fraction(light, "maxClipFrac", "light"),
          maxCrushFrac = fraction(light, "maxCrushFrac", "light"),
          cheekRatio = range(light, "cheekRatio", "light"),
        ),
        expression = Expression(
          maxSmile = fraction(expression, "maxSmile", "expression"),
          maxJawOpen = fraction(expression, "maxJawOpen", "expression"),
        ),
        eyes = Eyes(
          maxBlink = fraction(eyes, "maxBlink", "eyes"),
          minRelativeOpening = fraction(eyes, "minRelativeOpening", "eyes"),
        ),
        sharpness = Sharpness(
          minRelativeToBurstMax = fraction(sharpness, "minRelativeToBurstMax", "sharpness"),
        ),
        burst = Burst(
          targetFrames = int(burst, "targetFrames", "burst").also {
            require(it >= 1) { "burst.targetFrames must be positive" }
          },
          maxDurationMs = positive(burst, "maxDurationMs", "burst").toLong(),
          minSpacingMs = nonNegative(burst, "minSpacingMs", "burst").toLong(),
          minCoverageMs = nonNegative(burst, "minCoverageMs", "burst").toLong(),
          holdMs = nonNegative(burst, "holdMs", "burst").toLong(),
        ),
        labels = labelsRaw.entries.associate { (key, value) ->
          (key as? String ?: "") to (value as? String ?: "")
        },
        hash = sha256Hex(Json.canonical(root).toByteArray(Charsets.UTF_8)),
      )
      return config
    }

    fun sha256Hex(data: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(data))

    fun hex(bytes: ByteArray): String {
      val out = StringBuilder(bytes.size * 2)
      for (byte in bytes) {
        val value = byte.toInt() and 0xff
        out.append(HEX[value ushr 4]).append(HEX[value and 0x0f])
      }
      return out.toString()
    }

    private const val HEX = "0123456789abcdef"

    private fun obj(root: Map<*, *>, key: String): Map<*, *> =
      root[key] as? Map<*, *> ?: throw IllegalArgumentException("gate config has no '$key' object")

    private fun number(map: Map<*, *>, key: String, path: String): Double {
      val value = (map[key] as? Number)?.toDouble()
        ?: throw IllegalArgumentException("$path.$key is missing or not a number")
      require(value.isFinite()) { "$path.$key is not finite" }
      return value
    }

    private fun positive(map: Map<*, *>, key: String, path: String): Double =
      number(map, key, path).also { require(it > 0) { "$path.$key must be positive" } }

    private fun nonNegative(map: Map<*, *>, key: String, path: String): Double =
      number(map, key, path).also { require(it >= 0) { "$path.$key must not be negative" } }

    private fun fraction(map: Map<*, *>, key: String, path: String): Double =
      number(map, key, path).also { require(it in 0.0..1.0) { "$path.$key must be within [0, 1]" } }

    private fun int(map: Map<*, *>, key: String, path: String): Int {
      val value = number(map, key, path)
      require(value == Math.rint(value)) { "$path.$key must be an integer" }
      return value.toInt()
    }

    private fun range(map: Map<*, *>, key: String, path: String): ClosedRange {
      val list = map[key] as? List<*> ?: throw IllegalArgumentException("$path.$key must be [min, max]")
      require(list.size == 2) { "$path.$key must be [min, max]" }
      val min = (list[0] as? Number)?.toDouble() ?: throw IllegalArgumentException("$path.$key[0] is not a number")
      val max = (list[1] as? Number)?.toDouble() ?: throw IllegalArgumentException("$path.$key[1] is not a number")
      require(min.isFinite() && max.isFinite() && min <= max) { "$path.$key must be a finite [min, max]" }
      return ClosedRange(min, max)
    }

    private fun pixelSize(value: Any?, path: String): PixelSize {
      val list = value as? List<*> ?: throw IllegalArgumentException("$path must be [width, height]")
      require(list.size == 2) { "$path must be [width, height]" }
      val width = (list[0] as? Number)?.toDouble() ?: throw IllegalArgumentException("$path width is not a number")
      val height = (list[1] as? Number)?.toDouble() ?: throw IllegalArgumentException("$path height is not a number")
      require(width > 0 && height > 0 && width == Math.rint(width) && height == Math.rint(height)) {
        "$path must be positive integers"
      }
      return PixelSize(width.toInt(), height.toInt())
    }
  }
}

/** A width x height pair in pixels. */
internal data class PixelSize(val width: Int, val height: Int) {
  val area: Long get() = width.toLong() * height.toLong()

  /** The same size with the longer side first (camera2 lists sizes in sensor landscape). */
  fun landscape(): PixelSize = if (width >= height) this else PixelSize(height, width)

  fun toList(): List<Int> = listOf(width, height)
}
