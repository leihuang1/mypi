package dev.mypi.monitor

import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject

class MyPiMonitorModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext) { "App context unavailable" }

  override fun definition() = ModuleDefinition {
    Name("MyPiMonitor")
    Events("onState")

    OnCreate {
      MonitorService.onStateChanged = { sendEvent("onState", MonitorService.state(context)) }
    }
    OnDestroy {
      MonitorService.onStateChanged = null
      MonitorService.visible = false
      MonitorService.viewedServer = null
      MonitorService.viewedSession = null
    }
    OnActivityEntersForeground { MonitorService.visible = true }
    OnActivityEntersBackground { MonitorService.visible = false }
    OnActivityDestroys { MonitorService.visible = false }

    AsyncFunction("getState") {
      MonitorService.state(context)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("enable") { json: String ->
      require(json.length <= 16_384) { "Server configuration too large" }
      check(appContext.currentActivity != null) { "请在 App 中开启后台监听" }
      MonitorService.createChannels(context)
      check(MonitorService.notificationsAllowed(context)) { "请在系统设置中允许 MyPi 的运行动态和后台监听通知" }
      val server = MonitorServer.parse(JSONObject(json))
      val store = MonitorStore(context)
      val previous = store.servers()
      store.saveServers(previous.filter { it.id != server.id } + server)
      try { MonitorService.refresh(context) }
      catch (error: Exception) { store.saveServers(previous); throw error }
      MonitorService.state(context)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("disable") { id: String ->
      val store = MonitorStore(context)
      store.saveServers(store.servers().filter { it.id != id })
      // Stopping never requires a network connection or background-start permission.
      if (MonitorService.instance != null) MonitorService.refresh(context)
      MonitorService.state(context)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("syncServers") { json: String ->
      require(json.length <= 256 * 1024) { "Server configuration too large" }
      val array = JSONArray(json)
      val servers = (0 until array.length()).map { MonitorServer.parse(array.getJSONObject(it)) }.associateBy { it.id }
      val store = MonitorStore(context)
      val previous = store.servers()
      val next = previous.mapNotNull { servers[it.id] }
      if (previous != next) {
        store.saveServers(next)
        if (MonitorService.instance != null) MonitorService.refresh(context)
      }
      MonitorService.state(context)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setViewing") { server: String?, session: String?, active: Boolean ->
      MonitorService.viewedServer = server
      MonitorService.viewedSession = session
      MonitorService.visible = active && appContext.currentActivity?.hasWindowFocus() == true
    }.runOnQueue(Queues.MAIN)
  }
}
