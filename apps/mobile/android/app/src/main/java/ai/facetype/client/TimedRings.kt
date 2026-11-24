package ai.facetype.client

import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Per-frame capture results keyed by `SENSOR_TIMESTAMP`, so each analysed image
 * is described by the result of ITS exposure and not by whichever result
 * arrived last.
 *
 * The camera thread [put]s; the analysis thread [await]s the entry whose key
 * equals the image timestamp (a result can arrive after its image). Bounded:
 * the oldest entry is dropped beyond [capacity].
 */
internal class TimestampedRing<T>(private val capacity: Int = 64) {
  private val lock = ReentrantLock()
  private val arrived = lock.newCondition()
  private val entries = LinkedHashMap<Long, T>()

  fun put(timestampNs: Long, value: T) = lock.withLock {
    entries[timestampNs] = value
    while (entries.size > capacity) {
      val oldest = entries.keys.iterator()
      oldest.next()
      oldest.remove()
    }
    arrived.signalAll()
  }

  /** The value for exactly [timestampNs], waiting up to [timeoutMs] for it; null if it never came. */
  fun await(timestampNs: Long, timeoutMs: Long): T? = lock.withLock {
    var remaining = TimeUnit.MILLISECONDS.toNanos(timeoutMs)
    var value = entries[timestampNs]
    while (value == null && remaining > 0L) {
      remaining = arrived.awaitNanos(remaining)
      value = entries[timestampNs]
    }
    value
  }

  fun clear() = lock.withLock { entries.clear() }
}

/**
 * Recent gyroscope magnitudes (deg/s) by sensor-event timestamp.
 *
 * [nearest] answers with the sample closest to a frame's exposure time when
 * both clocks share a base (camera `SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME`,
 * the same `elapsedRealtimeNanos` base sensor events use), within
 * [maxGapNs]; otherwise null.
 */
internal class GyroRing(private val capacity: Int = 256) {
  private val times = LongArray(capacity)
  private val values = DoubleArray(capacity)
  private var count = 0
  private var next = 0

  @Synchronized
  fun add(timestampNs: Long, degPerS: Double) {
    times[next] = timestampNs
    values[next] = degPerS
    next = (next + 1) % capacity
    if (count < capacity) count++
  }

  @Synchronized
  fun nearest(timestampNs: Long, maxGapNs: Long): Double? {
    var best: Double? = null
    var bestGap = Long.MAX_VALUE
    for (i in 0 until count) {
      val gap = Math.abs(times[i] - timestampNs)
      if (gap < bestGap) {
        bestGap = gap
        best = values[i]
      }
    }
    return if (bestGap <= maxGapNs) best else null
  }

  @Synchronized
  fun latest(): Pair<Long, Double>? {
    if (count == 0) return null
    val index = (next - 1 + capacity) % capacity
    return times[index] to values[index]
  }

  @Synchronized
  fun clear() {
    count = 0
    next = 0
  }
}

/**
 * Rate of frames actually delivered to the analyser, from their sensor
 * timestamps over a sliding window. Null until [minFrames] have arrived.
 */
internal class DeliveredRate(private val window: Int = 30, private val minFrames: Int = 5) {
  private val stamps = ArrayDeque<Long>()

  fun add(sensorTsNs: Long) {
    if (stamps.isNotEmpty() && sensorTsNs <= stamps.last()) return
    stamps.addLast(sensorTsNs)
    while (stamps.size > window) stamps.removeFirst()
  }

  fun fps(): Double? {
    if (stamps.size < minFrames) return null
    val span = stamps.last() - stamps.first()
    if (span <= 0) return null
    return (stamps.size - 1) * 1e9 / span
  }

  fun clear() = stamps.clear()
}
