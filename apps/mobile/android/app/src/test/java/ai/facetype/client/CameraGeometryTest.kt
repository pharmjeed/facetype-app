package ai.facetype.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class CameraGeometryTest {

  private val pixelArray = PixelSize(4000, 3000)
  private val active = SensorRect(0.0, 0.0, 4000.0, 3000.0)

  @Test
  fun `nominal focal length in pixels comes from mm over the physical pixel-array size`() {
    // 3.6 mm lens on a 5.6 x 4.2 mm sensor of 4000 x 3000 px: 714.2857 px/mm... fx = 2571.43 px.
    val k = CameraGeometry.nominalSensorIntrinsics(3.6, doubleArrayOf(5.6, 4.2), pixelArray, active)!!
    assertEquals(3.6 * 4000 / 5.6, k.fx, 1e-9)
    assertEquals(3.6 * 3000 / 4.2, k.fy, 1e-9)
    assertEquals(2000.0, k.cx, 0.0)
    assertEquals(1500.0, k.cy, 0.0)
    assertEquals(CameraGeometry.SOURCE_NOMINAL, k.source)
    assertNull(CameraGeometry.nominalSensorIntrinsics(null, doubleArrayOf(5.6, 4.2), pixelArray, active))
    assertNull(CameraGeometry.nominalSensorIntrinsics(3.6, null, pixelArray, active))
    assertNull(CameraGeometry.nominalSensorIntrinsics(3.6, doubleArrayOf(0.0, 4.2), pixelArray, active))
  }

  @Test
  fun `a 16 by 9 stream of a 4 by 3 sensor is a centred crop, then a scale`() {
    val region = CameraGeometry.streamRegion(active, active, 1.0, 3840, 2160)
    assertEquals(0.0, region.left, 1e-9)
    assertEquals(375.0, region.top, 1e-9)
    assertEquals(4000.0, region.width, 1e-9)
    assertEquals(2250.0, region.height, 1e-9)
    val sensor = Intrinsics(2600.0, 2600.0, 2010.0, 1490.0, 0.0, 4000, 3000, CameraGeometry.SOURCE_CALIBRATION)
    val stream = CameraGeometry.toStream(sensor, region, 3840, 2160)
    assertEquals(2600.0 * 0.96, stream.fx, 1e-9)
    assertEquals(2600.0 * 0.96, stream.fy, 1e-9)
    assertEquals(2010.0 * 0.96, stream.cx, 1e-9)
    assertEquals((1490.0 - 375.0) * 0.96, stream.cy, 1e-9)
    assertEquals(3840, stream.refWidth)
  }

  @Test
  fun `crop region and zoom ratio shrink the field of view and grow the focal length`() {
    // Digital crop to the central half by SCALER_CROP_REGION.
    val cropped = CameraGeometry.streamRegion(SensorRect(1000.0, 750.0, 2000.0, 1500.0), active, null, 1920, 1440)
    assertEquals(2000.0, cropped.width, 1e-9)
    val sensor = Intrinsics(2600.0, 2600.0, 2000.0, 1500.0, 0.0, 4000, 3000, CameraGeometry.SOURCE_NOMINAL)
    assertEquals(2600.0 * 1920 / 2000, CameraGeometry.toStream(sensor, cropped, 1920, 1440).fx, 1e-9)
    // Same field of view by CONTROL_ZOOM_RATIO = 2 with a full crop region.
    val zoomed = CameraGeometry.streamRegion(active, active, 2.0, 1920, 1440)
    assertEquals(1000.0, zoomed.left, 1e-9)
    assertEquals(750.0, zoomed.top, 1e-9)
    assertEquals(2000.0, zoomed.width, 1e-9)
  }

  @Test
  fun `crop regions are offset by their frame and calibration by the pre-correction array`() {
    val preCorrection = SensorRect(8.0, 6.0, 3984.0, 2988.0)
    val k = CameraGeometry.calibratedSensorIntrinsics(floatArrayOf(2600f, 2601f, 1990f, 1494f, 0f), preCorrection, pixelArray)!!
    assertEquals(1998.0, k.cx, 1e-3)
    assertEquals(1500.0, k.cy, 1e-3)
    assertNull(CameraGeometry.calibratedSensorIntrinsics(floatArrayOf(0f, 0f, 0f, 0f, 0f), preCorrection, pixelArray))
    val region = CameraGeometry.streamRegion(SensorRect(0.0, 0.0, 3984.0, 2988.0), preCorrection, null, 3984, 2988)
    assertEquals(8.0, region.left, 1e-9)
    assertEquals(6.0, region.top, 1e-9)
  }

  @Test
  fun `upright rotation swaps axes and moves the principal point`() {
    val stream = Intrinsics(1000.0, 1010.0, 950.0, 530.0, 0.0, 1920, 1080, CameraGeometry.SOURCE_CALIBRATION)
    val r90 = CameraGeometry.toUpright(stream, 90)
    assertEquals(1010.0, r90.fx, 0.0)
    assertEquals(1000.0, r90.fy, 0.0)
    assertEquals(1080.0 - 530.0, r90.cx, 0.0)
    assertEquals(950.0, r90.cy, 0.0)
    assertEquals(1080, r90.refWidth)
    assertEquals(1920, r90.refHeight)
    assertEquals(0.0, r90.skew!!, 0.0)
    val r270 = CameraGeometry.toUpright(stream, 270)
    assertEquals(530.0, r270.cx, 0.0)
    assertEquals(1920.0 - 950.0, r270.cy, 0.0)
    val r180 = CameraGeometry.toUpright(stream, 180)
    assertEquals(1920.0 - 950.0, r180.cx, 0.0)
    assertEquals(1080.0 - 530.0, r180.cy, 0.0)
    assertEquals(stream, CameraGeometry.toUpright(stream, 0))
    // A non-zero skew is not representable after a quarter turn.
    assertNull(CameraGeometry.toUpright(stream.copy(skew = 1.5), 90).skew)
  }

  @Test
  fun `distance from the iris uses the focal length in delivered pixels`() {
    // f = 1500 px, iris 11.7 mm imaged at 39 px -> 450 mm.
    assertEquals(45.0, CameraGeometry.distanceCm(1500.0, 39.0, 11.7)!!, 1e-9)
    assertNull(CameraGeometry.distanceCm(null, 39.0, 11.7))
    assertNull(CameraGeometry.distanceCm(1500.0, null, 11.7))
    assertNull(CameraGeometry.distanceCm(1500.0, 0.0, 11.7))
    assertNull(CameraGeometry.distanceCm(Double.NaN, 39.0, 11.7))
  }

  @Test
  fun `the resolver prefers per-frame calibration, then static, then nominal`() {
    val static = cameraStatic(calibration = floatArrayOf(2500f, 2500f, 2000f, 1500f, 0f))
    val noResult = IntrinsicsResolver.resolve(static, null, 1920, 1080, 270)
    assertEquals(CameraGeometry.SOURCE_CALIBRATION, noResult.upright!!.source)
    // 1920x1080 of 4000x3000: region 4000x2250, scale 0.48; rotated 270 -> fx' = fy.
    assertEquals(2500.0 * 0.48, noResult.upright!!.fx, 1e-6)
    assertEquals(1080, noResult.upright!!.refWidth)

    val nominal = IntrinsicsResolver.resolve(cameraStatic(calibration = null), null, 1920, 1080, 0)
    assertEquals(CameraGeometry.SOURCE_NOMINAL, nominal.upright!!.source)
    assertEquals(3.6 * 4000 / 5.6 * 0.48, nominal.upright!!.fx, 1e-6)

    val unknown = IntrinsicsResolver.resolve(
      cameraStatic(calibration = null).copy(physicalSizeMm = null), null, 1920, 1080, 0,
    )
    assertNull(unknown.upright)
    assertEquals("focal_length_or_sensor_size_unknown", unknown.missingReason)
    assertNotNull(unknown.streamRegion)
  }

  @Test
  fun `the stream size is the first preferred size the camera lists, above the floor`() {
    val preferred = listOf(PixelSize(3840, 2160), PixelSize(1920, 1080), PixelSize(1280, 720))
    val floor = PixelSize(1280, 720)
    fun choose(vararg sizes: PixelSize) = StreamSizeChooser.choose(sizes.toList(), preferred, floor)
    assertEquals(PixelSize(3840, 2160), choose(PixelSize(4000, 3000), PixelSize(3840, 2160), PixelSize(1920, 1080)))
    assertEquals(PixelSize(1920, 1080), choose(PixelSize(4000, 3000), PixelSize(1920, 1080), PixelSize(1280, 720)))
    // No preferred size listed: largest 16:9 above the floor, then largest of any aspect.
    assertEquals(PixelSize(2560, 1440), choose(PixelSize(3264, 2448), PixelSize(2560, 1440), PixelSize(1600, 1200)))
    assertEquals(PixelSize(3264, 2448), choose(PixelSize(3264, 2448), PixelSize(1600, 1200)))
    assertNull(choose(PixelSize(1024, 768), PixelSize(640, 480)))
  }

  private fun cameraStatic(calibration: FloatArray?) = CameraStaticInfo(
    cameraId = "1",
    sensorOrientation = 270,
    focalLengthsMm = listOf(3.6),
    physicalSizeMm = doubleArrayOf(5.6, 4.2),
    pixelArray = pixelArray,
    activeArray = active,
    preCorrectionArray = active,
    intrinsicCalibration = calibration,
    lensDistortion = null,
    distortionModes = listOf("off"),
    timestampSource = "realtime",
    logicalMultiCamera = false,
    physicalCameraIds = emptyList(),
  )
}
