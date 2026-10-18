package dev.mypi.monitor

import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

internal class MonitorConnection(
  val server: MonitorServer,
  private val cursor: () -> String?,
  private val onFrame: (String) -> Unit,
  private val onStatus: (String) -> Unit,
) {
  @Volatile private var stopped = false
  @Volatile private var connection: HttpURLConnection? = null
  private val thread = Thread({ listen() }, "mypi-monitor-${server.id}").apply { isDaemon = true }

  fun start() = thread.start()

  fun close() {
    stopped = true
    connection?.disconnect()
    thread.interrupt()
  }

  private fun listen() {
    var delay = 1_000L
    while (!stopped) {
      val started = System.nanoTime()
      try {
        onStatus("正在连接")
        val query = cursor()?.let { "?cursor=${URLEncoder.encode(it, "UTF-8")}" } ?: ""
        val current = URL("${server.url}/v1/notifications/events$query").openConnection() as HttpURLConnection
        connection = current
        current.connectTimeout = 10_000
        current.readTimeout = 45_000
        current.instanceFollowRedirects = false // Never forward the pairing token to another host.
        current.setRequestProperty("Authorization", "Bearer ${server.token}")
        current.setRequestProperty("Accept", "text/event-stream")
        if (stopped) break
        val code = current.responseCode
        check(code == 200) {
          when (code) {
            401, 403 -> "配对凭据失效，请重新配对"
            404 -> "请更新开发机上的 MyPi 服务端"
            else -> "服务端暂不可用（$code）"
          }
        }
        check(current.contentType?.startsWith("text/event-stream") == true) { "服务端不支持通知监听" }
        current.inputStream.bufferedReader(Charsets.UTF_8).use { reader -> readSse(reader, onFrame) }
        if (!stopped) onStatus("连接已断开，正在重连")
      } catch (error: Exception) {
        if (!stopped) {
          val status = if (error is IllegalStateException) error.message ?: "连接异常" else "网络不可用，正在重连"
          onStatus(status)
        }
      } finally {
        connection?.disconnect()
        connection = null
      }
      if (stopped) break
      if ((System.nanoTime() - started) / 1_000_000 > 30_000) delay = 1_000
      try { Thread.sleep(delay) } catch (_: InterruptedException) { break }
      delay = (delay * 2).coerceAtMost(30_000)
    }
  }
}
