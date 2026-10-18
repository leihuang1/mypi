package dev.mypi.monitor

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

internal data class MonitorServer(val id: String, val name: String, val url: String, val token: String) {
  fun json() = JSONObject().put("id", id).put("name", name).put("url", url).put("token", token)

  companion object {
    fun parse(json: JSONObject): MonitorServer {
      val id = json.getString("id")
      val name = json.getString("name")
      val url = json.getString("url").trimEnd('/')
      val token = json.getString("token")
      val uri = URI(url)
      require(id.matches(Regex("[a-zA-Z0-9_-]{1,100}"))) { "Invalid server ID" }
      require(name.length <= 200 && token.isNotBlank() && token.length <= 4096 &&
        !token.contains('\n') && !token.contains('\r')) { "Invalid server credentials" }
      require(uri.scheme in listOf("http", "https") && !uri.host.isNullOrBlank() &&
        uri.userInfo == null && uri.query == null && uri.fragment == null) { "Invalid server URL" }
      return MonitorServer(id, name, url, token)
    }
  }
}

internal class MonitorStore(context: Context) {
  private val preferences = context.getSharedPreferences("mypi-monitor", Context.MODE_PRIVATE)

  fun servers(): List<MonitorServer> {
    val json = JSONArray(preferences.getString("servers", "[]"))
    return (0 until json.length()).map { MonitorServer.parse(json.getJSONObject(it)) }
  }

  fun saveServers(servers: List<MonitorServer>) {
    require(servers.map { it.id }.distinct().size == servers.size) { "Duplicate server ID" }
    val previous = servers().associateBy { it.id }
    val next = servers.associateBy { it.id }
    val editor = preferences.edit().putString("servers", JSONArray(servers.map { it.json() }).toString())
    for ((id, old) in previous) {
      val current = next[id]
      if (current == null || current.url != old.url || current.token != old.token) editor.remove("cursor:$id")
    }
    check(editor.commit()) { "无法保存监听设置" }
  }

  fun cursor(id: String): String? = preferences.getString("cursor:$id", null)

  fun saveCursor(id: String, cursor: String) {
    check(preferences.edit().putString("cursor:$id", cursor).commit()) { "无法保存通知进度" }
  }
}
