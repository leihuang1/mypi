package dev.mypi.monitor

import org.junit.Assert.*
import org.junit.Test
import java.io.StringReader

class MonitorProtocolTest {
  @Test fun onlyCompleteSseEventsAreDelivered() {
    val events = mutableListOf<String>()
    readSse(StringReader(": heartbeat\r\ndata: {\"type\":\"ready\"}\r\n\r\ndata: first\ndata: second\n\ndata: unfinished"), events::add)
    assertEquals(listOf("{\"type\":\"ready\"}", "first\nsecond"), events)
  }

  @Test fun oversizedLinesAreRejected() {
    assertThrows(IllegalArgumentException::class.java) {
      readSse(StringReader("data: " + "x".repeat(20_000))) {}
    }
  }

  @Test fun persistedCursorsPreventDuplicateAlertsAcrossReconnects() {
    assertTrue(advancesCursor(null, "daemon:5", true))
    assertFalse(advancesCursor(null, "daemon:5", false))
    assertFalse(advancesCursor("daemon:5", "daemon:5", false))
    assertTrue(advancesCursor("daemon:5", "daemon:5", true))
    assertFalse(advancesCursor("daemon:5", "daemon:4", true))
    assertFalse(advancesCursor("daemon:5", "daemon:4", false))
    assertTrue(advancesCursor("daemon:5", "daemon:6", false))
    assertFalse(advancesCursor("daemon:5", "replacement:1", false))
    assertTrue(advancesCursor("daemon:5", "replacement:1", true))
    assertFalse(advancesCursor("daemon:5", "daemon:-1", true))
    assertFalse(advancesCursor("daemon:5", "invalid", true))
    assertTrue(advancesCursor("daemon:5", "daemon:1", true, true))
    assertFalse(advancesCursor("daemon:5", "daemon:1", false, true))
  }

  @Test fun onlyTheVisibleSessionIsSuppressedAndStaleEventsAreNotShown() {
    val now = 10_000_000L
    assertFalse(shouldNotify(true, "server", "session", "server", "session", now, now))
    assertTrue(shouldNotify(false, "server", "session", "server", "session", now, now))
    assertTrue(shouldNotify(true, "other", "session", "server", "session", now, now))
    assertTrue(shouldNotify(true, "server", "other", "server", "session", now, now))
    assertFalse(shouldNotify(false, null, null, "server", "session", now - 3_600_001, now))
  }
}
