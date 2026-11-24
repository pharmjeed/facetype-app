package ai.facetype.client

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap

/**
 * Plain Kotlin values (as produced by [FrameMetaBuilder] and the session) to
 * bridge maps. Numbers cross as doubles, as they would in JSON; a non-finite
 * number becomes null rather than NaN, which JSON cannot carry.
 */
internal object ReactMaps {

  fun toWritableMap(map: Map<String, Any?>): WritableMap {
    val out = Arguments.createMap()
    for ((key, value) in map) {
      when (value) {
        null -> out.putNull(key)
        is Boolean -> out.putBoolean(key, value)
        is Int -> out.putInt(key, value)
        is Number -> {
          val d = value.toDouble()
          if (d.isFinite()) out.putDouble(key, d) else out.putNull(key)
        }
        is String -> out.putString(key, value)
        is Map<*, *> -> out.putMap(key, toWritableMap(stringKeys(value)))
        is List<*> -> out.putArray(key, toWritableArray(value))
        is DoubleArray -> out.putArray(key, toWritableArray(value.toList()))
        is FloatArray -> out.putArray(key, toWritableArray(value.map { it.toDouble() }))
        is IntArray -> out.putArray(key, toWritableArray(value.toList()))
        else -> out.putString(key, value.toString())
      }
    }
    return out
  }

  fun toWritableArray(list: List<*>): WritableArray {
    val out = Arguments.createArray()
    for (value in list) {
      when (value) {
        null -> out.pushNull()
        is Boolean -> out.pushBoolean(value)
        is Int -> out.pushInt(value)
        is Number -> {
          val d = value.toDouble()
          if (d.isFinite()) out.pushDouble(d) else out.pushNull()
        }
        is String -> out.pushString(value)
        is Map<*, *> -> out.pushMap(toWritableMap(stringKeys(value)))
        is List<*> -> out.pushArray(toWritableArray(value))
        is DoubleArray -> out.pushArray(toWritableArray(value.toList()))
        is FloatArray -> out.pushArray(toWritableArray(value.map { it.toDouble() }))
        is IntArray -> out.pushArray(toWritableArray(value.toList()))
        else -> out.pushString(value.toString())
      }
    }
    return out
  }

  fun stringMap(map: ReadableMap?): Map<String, String> {
    if (map == null) return emptyMap()
    val out = LinkedHashMap<String, String>()
    val iterator = map.keySetIterator()
    while (iterator.hasNextKey()) {
      val key = iterator.nextKey()
      when (map.getType(key)) {
        ReadableType.String -> out[key] = map.getString(key) ?: ""
        ReadableType.Number -> out[key] = Json.formatNumber(map.getDouble(key))
        ReadableType.Boolean -> out[key] = map.getBoolean(key).toString()
        else -> throw IllegalArgumentException("header '$key' must be a string")
      }
    }
    return out
  }

  fun stringList(array: ReadableArray?): List<String> {
    if (array == null) return emptyList()
    return (0 until array.size()).map { index ->
      require(array.getType(index) == ReadableType.String) { "ids must be strings" }
      array.getString(index) ?: ""
    }
  }

  private fun stringKeys(map: Map<*, *>): Map<String, Any?> =
    map.entries.associate { (key, value) -> key.toString() to value }
}
