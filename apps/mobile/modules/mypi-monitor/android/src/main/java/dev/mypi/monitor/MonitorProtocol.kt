package dev.mypi.monitor

import java.io.Reader

internal data class NoticeCursor(val epoch: String, val sequence: Long) {
  companion object {
    fun parse(value: String): NoticeCursor? {
      val parts = value.split(':')
      if (parts.size != 2 || !parts[0].matches(Regex("[a-zA-Z0-9-]{1,80}"))) return null
      val sequence = parts[1].toLongOrNull() ?: return null
      if (sequence < 0) return null
      return NoticeCursor(parts[0], sequence)
    }
  }
}

internal fun advancesCursor(previous: String?, incoming: String, baseline: Boolean, reset: Boolean = false): Boolean {
  val next = NoticeCursor.parse(incoming) ?: return false
  if (baseline && reset) return true
  val old = previous?.let { NoticeCursor.parse(it) }
  if (old == null || old.epoch != next.epoch) return baseline
  return if (baseline) next.sequence >= old.sequence else next.sequence > old.sequence
}

internal fun shouldNotify(
  visible: Boolean, viewedServer: String?, viewedSession: String?,
  server: String, session: String, createdAt: Long, now: Long,
): Boolean = !(visible && viewedServer == server && viewedSession == session) &&
  createdAt > 0 && now - createdAt <= 60 * 60 * 1000L

// Bound the line and event before JSON parsing, including a stream without any newline.
internal fun readSse(reader: Reader, onData: (String) -> Unit) {
  val line = StringBuilder()
  val data = StringBuilder()
  while (true) {
    val char = reader.read()
    if (char == -1) return // A partial event is replayed after reconnect; never acknowledge it.
    if (char != '\n'.code) {
      line.append(char.toChar())
      require(line.length <= 16_384) { "Notification stream line too large" }
      continue
    }
    val text = line.toString().removeSuffix("\r")
    line.setLength(0)
    if (text.isEmpty()) {
      if (data.isNotEmpty()) onData(data.toString().removeSuffix("\n"))
      data.setLength(0)
    } else if (text.startsWith("data:")) {
      data.append(text.substring(5).removePrefix(" ")).append('\n')
      require(data.length <= 16_384) { "Notification stream event too large" }
    }
  }
}
