package ai.facetype.client

import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Which server-provided headers a presigned PUT carries, and the length it
 * must declare. Pure, so the policy is unit-tested.
 *
 * The body length is never taken from the server's headers: OkHttp derives
 * `Content-Length` from [SpoolBody.contentLength], which is the spooled JPEG's
 * exact size. A server-provided `Content-Length` that disagrees with it is an
 * error (the presigned URL is bound to the length), not something to send.
 */
internal object UploadPolicy {
  private val HOP_BY_HOP = setOf("host", "content-length", "transfer-encoding", "connection", "expect")

  fun forwardedHeaders(serverHeaders: Map<String, String>, exactLength: Long): List<Pair<String, String>> {
    val out = ArrayList<Pair<String, String>>()
    for ((name, value) in serverHeaders) {
      val lower = name.lowercase()
      if (lower == "content-length") {
        require(value.trim().toLongOrNull() == exactLength) {
          "server Content-Length $value does not match the spooled frame ($exactLength bytes)"
        }
        continue
      }
      if (lower in HOP_BY_HOP) continue
      out.add(name to value)
    }
    return out
  }

  fun contentType(serverHeaders: Map<String, String>): String? =
    serverHeaders.entries.firstOrNull { it.key.equals("content-type", ignoreCase = true) }?.value
}

/** A request body that decrypts the spool file while OkHttp writes it. */
internal class SpoolBody(
  private val spool: ClientSpool,
  private val id: String,
  private val length: Long,
  private val type: MediaType?,
) : RequestBody() {
  override fun contentType(): MediaType? = type

  override fun contentLength(): Long = length

  /**
   * Streams segment by segment; a segment that fails authentication, or a
   * digest mismatch at the end, throws and aborts the request, so the server
   * receives a short body that cannot complete the presigned PUT.
   */
  override fun writeTo(sink: BufferedSink) {
    val written = spool.decryptTo(id, sink.outputStream())
    if (written != length) throw IOException("spool produced $written bytes, expected $length")
  }

  /** Not replayable on redirects or retries; JavaScript owns retries. */
  override fun isOneShot(): Boolean = true
}

internal class ClientUploader(private val spool: ClientSpool) {
  private val client: OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(20, TimeUnit.SECONDS)
    .writeTimeout(60, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .followRedirects(false)
    .followSslRedirects(false)
    .retryOnConnectionFailure(false)
    .build()

  /** PUTs the spooled frame [entry] and returns the HTTP status; throws on transport or spool failure. */
  fun upload(entry: ClientSpool.Entry, url: String, headers: Map<String, String>): Int {
    val forwarded = UploadPolicy.forwardedHeaders(headers, entry.bytes)
    val body = SpoolBody(spool, entry.id, entry.bytes, UploadPolicy.contentType(headers)?.toMediaTypeOrNull())
    val builder = Request.Builder().url(url).put(body)
    for ((name, value) in forwarded) builder.addHeader(name, value)
    client.newCall(builder.build()).execute().use { response -> return response.code }
  }
}
