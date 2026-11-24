package ai.facetype.client

import java.math.BigDecimal

/**
 * A minimal JSON reader/writer with no Android dependency.
 *
 * WHY NOT `org.json`. It is part of the Android framework, so on the JVM test
 * classpath it is the "not mocked" stub: every gate-config and FrameMeta test
 * would need a second, real JSON library on the classpath only for tests, and
 * the code under test would then run against a different implementation from
 * the one on the handset. This file is the same bytes on both.
 *
 * Values: `null`, [Boolean], [Double] (every JSON number is read as a double,
 * exactly as JavaScript reads it), [String], [List] and [Map] (insertion
 * ordered). The writer additionally accepts [Int], [Long] and [Float].
 *
 * [canonical] is the form `gateConfigHash()` hashes on the TypeScript side:
 * object keys sorted (UTF-16 code-unit order, which is what both
 * `Array.prototype.sort` and Kotlin's `String.compareTo` use), no whitespace,
 * and numbers printed the way `JSON.stringify` prints them.
 */
internal object Json {

  fun parse(text: String): Any? {
    val parser = Parser(text)
    parser.skipWhitespace()
    val value = parser.readValue()
    parser.skipWhitespace()
    require(parser.atEnd()) { "trailing characters at offset ${parser.position}" }
    return value
  }

  /** Compact JSON, object keys in insertion order. */
  fun stringify(value: Any?): String = StringBuilder().also { write(it, value, sortKeys = false) }.toString()

  /** Compact JSON, object keys sorted: the canonical form the gate-config hash is taken over. */
  fun canonical(value: Any?): String = StringBuilder().also { write(it, value, sortKeys = true) }.toString()

  /**
   * `Number.prototype.toString()` for a finite double.
   *
   * Integral values below 1e21 print without a fraction ("8", not "8.0");
   * values in [1e-6, 1e21) print as plain decimals; everything else uses the
   * JavaScript exponent form ("1e-7", "1.5e+21").
   */
  fun formatNumber(value: Double): String {
    require(value.isFinite()) { "JSON cannot carry a non-finite number" }
    if (value == 0.0) return "0"
    val magnitude = Math.abs(value)
    if (value == Math.rint(value) && magnitude < 1e21) {
      return BigDecimal(value).toBigInteger().toString()
    }
    val decimal = BigDecimal(java.lang.Double.toString(value)).stripTrailingZeros()
    if (magnitude >= 1e-6 && magnitude < 1e21) return decimal.toPlainString()
    // Exponent form: d[.ddd]e(+|-)n
    val digits = decimal.unscaledValue().abs().toString()
    val exponent = digits.length - 1 - decimal.scale()
    val mantissa = if (digits.length == 1) digits else digits[0] + "." + digits.substring(1)
    val sign = if (value < 0) "-" else ""
    val exponentSign = if (exponent >= 0) "+" else "-"
    return "$sign${mantissa}e$exponentSign${Math.abs(exponent)}"
  }

  private fun write(out: StringBuilder, value: Any?, sortKeys: Boolean) {
    when (value) {
      null -> out.append("null")
      is Boolean -> out.append(if (value) "true" else "false")
      is Int -> out.append(value.toString())
      is Long -> out.append(value.toString())
      is Float -> {
        require(value.isFinite()) { "JSON cannot carry a non-finite number" }
        // The float's own shortest decimal, not the widened double's tail.
        out.append(formatNumber(java.lang.Float.toString(value).toDouble()))
      }
      is Double -> out.append(formatNumber(value))
      is Number -> out.append(formatNumber(value.toDouble()))
      is String -> writeString(out, value)
      is Map<*, *> -> {
        out.append('{')
        val keys = value.keys.map { it as? String ?: throw IllegalArgumentException("object keys must be strings") }
        val ordered = if (sortKeys) keys.sorted() else keys
        var first = true
        for (key in ordered) {
          if (!first) out.append(',')
          first = false
          writeString(out, key)
          out.append(':')
          write(out, value[key], sortKeys)
        }
        out.append('}')
      }
      is List<*> -> {
        out.append('[')
        value.forEachIndexed { index, item ->
          if (index > 0) out.append(',')
          write(out, item, sortKeys)
        }
        out.append(']')
      }
      is DoubleArray -> write(out, value.toList(), sortKeys)
      is FloatArray -> write(out, value.toList(), sortKeys)
      is IntArray -> write(out, value.toList(), sortKeys)
      is LongArray -> write(out, value.toList(), sortKeys)
      else -> throw IllegalArgumentException("cannot write ${value::class.java.name} as JSON")
    }
  }

  /** `JSON.stringify` string escaping: quote, backslash and C0 controls only. */
  private fun writeString(out: StringBuilder, value: String) {
    out.append('"')
    for (char in value) {
      when (char) {
        '"' -> out.append("\\\"")
        '\\' -> out.append("\\\\")
        '\b' -> out.append("\\b")
        '\u000C' -> out.append("\\f")
        '\n' -> out.append("\\n")
        '\r' -> out.append("\\r")
        '\t' -> out.append("\\t")
        else -> if (char < ' ') {
          out.append("\\u").append(String.format("%04x", char.code))
        } else {
          out.append(char)
        }
      }
    }
    out.append('"')
  }

  private class Parser(private val text: String) {
    var position = 0
      private set

    fun atEnd(): Boolean = position >= text.length

    fun skipWhitespace() {
      while (position < text.length && text[position] in " \t\r\n") position++
    }

    fun readValue(): Any? {
      require(!atEnd()) { "unexpected end of JSON" }
      return when (val char = text[position]) {
        '{' -> readObject()
        '[' -> readArray()
        '"' -> readString()
        't' -> literal("true", true)
        'f' -> literal("false", false)
        'n' -> literal("null", null)
        else -> if (char == '-' || char in '0'..'9') readNumber() else {
          throw IllegalArgumentException("unexpected '$char' at offset $position")
        }
      }
    }

    private fun literal(word: String, value: Any?): Any? {
      require(text.startsWith(word, position)) { "invalid literal at offset $position" }
      position += word.length
      return value
    }

    private fun readObject(): Map<String, Any?> {
      val result = LinkedHashMap<String, Any?>()
      position++ // {
      skipWhitespace()
      if (peek() == '}') {
        position++
        return result
      }
      while (true) {
        skipWhitespace()
        require(peek() == '"') { "expected an object key at offset $position" }
        val key = readString()
        skipWhitespace()
        require(peek() == ':') { "expected ':' at offset $position" }
        position++
        skipWhitespace()
        result[key] = readValue()
        skipWhitespace()
        when (peek()) {
          ',' -> position++
          '}' -> {
            position++
            return result
          }
          else -> throw IllegalArgumentException("expected ',' or '}' at offset $position")
        }
      }
    }

    private fun readArray(): List<Any?> {
      val result = ArrayList<Any?>()
      position++ // [
      skipWhitespace()
      if (peek() == ']') {
        position++
        return result
      }
      while (true) {
        skipWhitespace()
        result.add(readValue())
        skipWhitespace()
        when (peek()) {
          ',' -> position++
          ']' -> {
            position++
            return result
          }
          else -> throw IllegalArgumentException("expected ',' or ']' at offset $position")
        }
      }
    }

    private fun readString(): String {
      position++ // opening quote
      val out = StringBuilder()
      while (true) {
        require(!atEnd()) { "unterminated string" }
        val char = text[position++]
        when {
          char == '"' -> return out.toString()
          char == '\\' -> {
            require(!atEnd()) { "unterminated escape" }
            when (val escaped = text[position++]) {
              '"' -> out.append('"')
              '\\' -> out.append('\\')
              '/' -> out.append('/')
              'b' -> out.append('\b')
              'f' -> out.append('\u000C')
              'n' -> out.append('\n')
              'r' -> out.append('\r')
              't' -> out.append('\t')
              'u' -> {
                require(position + 4 <= text.length) { "truncated unicode escape" }
                out.append(text.substring(position, position + 4).toInt(16).toChar())
                position += 4
              }
              else -> throw IllegalArgumentException("invalid escape '\\$escaped'")
            }
          }
          char < ' ' -> throw IllegalArgumentException("unescaped control character in string")
          else -> out.append(char)
        }
      }
    }

    private fun readNumber(): Double {
      val start = position
      if (peek() == '-') position++
      while (!atEnd() && (text[position].isDigit() || text[position] in ".eE+-")) position++
      val token = text.substring(start, position)
      val value = token.toDoubleOrNull() ?: throw IllegalArgumentException("invalid number '$token'")
      require(value.isFinite()) { "number out of range '$token'" }
      return value
    }

    private fun peek(): Char = if (atEnd()) '\u0000' else text[position]
  }
}
