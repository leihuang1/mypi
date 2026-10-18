package dev.mypi.monitor

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import org.json.JSONObject

class MonitorService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private lateinit var store: MonitorStore
  private val connections = mutableMapOf<String, MonitorConnection>()

  companion object {
    private const val STATUS_CHANNEL = "mypi-monitor"
    private const val RUN_CHANNEL = "mypi-runs"
    private const val STATUS_ID = 1
    private const val STOP = "dev.mypi.monitor.STOP"
    internal var instance: MonitorService? = null
    internal var visible = false
    internal var viewedServer: String? = null
    internal var viewedSession: String? = null
    internal var onStateChanged: (() -> Unit)? = null
    internal var lastError: String? = null
    private val statuses = mutableMapOf<String, String>()

    internal fun createChannels(context: Context) {
      if (Build.VERSION.SDK_INT >= 26) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(STATUS_CHANNEL, "后台监听状态", NotificationManager.IMPORTANCE_LOW).apply {
          description = "与开发机保持连接；可随时停止"
          lockscreenVisibility = Notification.VISIBILITY_PRIVATE
          setSound(null, null)
        })
        manager.createNotificationChannel(NotificationChannel(RUN_CHANNEL, "运行动态", NotificationManager.IMPORTANCE_DEFAULT).apply {
          description = "运行结束与无法继续的执行异常"
          lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        })
      }
    }

    internal fun notificationsAllowed(context: Context): Boolean {
      val manager = context.getSystemService(NotificationManager::class.java)
      return manager.areNotificationsEnabled() && (Build.VERSION.SDK_INT < 26 ||
        listOf(STATUS_CHANNEL, RUN_CHANNEL).all { manager.getNotificationChannel(it)?.importance != NotificationManager.IMPORTANCE_NONE })
    }

    internal fun state(context: Context): Map<String, Any?> = mapOf(
      "enabledServerIds" to MonitorStore(context).servers().map { it.id },
      "running" to (instance != null),
      "connections" to statuses.toMap(),
      "notificationsAllowed" to notificationsAllowed(context),
      "error" to lastError,
    )

    internal fun refresh(context: Context) {
      if (MonitorStore(context).servers().isEmpty()) {
        context.stopService(Intent(context, MonitorService::class.java))
      } else {
        val intent = Intent(context, MonitorService::class.java)
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
      }
      onStateChanged?.invoke()
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    store = MonitorStore(this)
    createChannels(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    try {
      if (intent?.action == STOP || !notificationsAllowed(this)) {
        store.saveServers(emptyList())
        stopSelf()
        return START_NOT_STICKY
      }
      if (store.servers().isEmpty()) {
        stopSelf()
        return START_NOT_STICKY
      }
      val notification = statusNotification()
      if (Build.VERSION.SDK_INT >= 29) startForeground(STATUS_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
      else startForeground(STATUS_ID, notification)
      instance = this
      lastError = null
      refreshConnections()
      return START_STICKY
    } catch (_: Exception) {
      lastError = "后台监听未能启动，请回到 App 重试并检查通知权限"
      stopSelf()
      onStateChanged?.invoke()
      return START_NOT_STICKY
    }
  }

  private fun refreshConnections() {
    val servers = store.servers().associateBy { it.id }
    for ((id, connection) in connections.toMap()) {
      if (servers[id] != connection.server) {
        connections.remove(id)
        statuses.remove(id)
        connection.close()
      }
    }
    for ((id, server) in servers) {
      if (connections.containsKey(id)) continue
      lateinit var connection: MonitorConnection
      connection = MonitorConnection(server, { store.cursor(id) }, { raw ->
        // Decode on the reader thread: malformed/oversized streams reconnect with backoff.
        val frame = JSONObject(raw)
        val type = frame.getString("type")
        require(type in listOf("notice", "ready", "heartbeat"))
        if (type != "heartbeat") require(NoticeCursor.parse(frame.getString("cursor")) != null)
        if (type == "notice") {
          require(frame.getString("sessionId").matches(Regex("[a-zA-Z0-9_-]{1,100}")))
          require(frame.getString("title").length <= 200 && frame.getString("body").length <= 1000)
          require(frame.getLong("createdAt") > 0)
        }
        handler.post {
          if (connections[id] === connection) receive(server, frame)
        }
      }, { status ->
        handler.post {
          if (connections[id] === connection) {
            statuses[id] = status
            updateStatus()
          }
        }
      })
      connections[id] = connection
      statuses[id] = "正在连接"
      connection.start()
    }
    updateStatus()
  }

  private fun receive(server: MonitorServer, frame: JSONObject) {
    if (!notificationsAllowed(this)) {
      lastError = "通知权限已关闭，后台监听已停止"
      stopSelf()
      return
    }
    val type = frame.getString("type")
    if (type == "heartbeat") return
    val cursor = frame.getString("cursor")
    if (!advancesCursor(store.cursor(server.id), cursor, type == "ready", frame.optBoolean("gap"))) return
    try {
      // Persist before showing an alert so process restarts cannot repeat an already consumed event.
      store.saveCursor(server.id, cursor)
      if (type == "ready") {
        statuses[server.id] = "已连接"
        if (frame.optBoolean("gap")) lastError = "部分旧提醒已过期，请打开会话查看完整状态"
        updateStatus()
      } else {
        val session = frame.getString("sessionId")
        val createdAt = frame.getLong("createdAt")
        if (shouldNotify(visible, viewedServer, viewedSession, server.id, session, createdAt, System.currentTimeMillis())) {
          showNotice(server.id, session, cursor, frame.getString("title"), frame.getString("body"), createdAt)
        }
      }
    } catch (_: Exception) {
      lastError = "无法保存或显示通知，后台监听已停止，请回到 App 检查"
      stopSelf()
    }
  }

  private fun builder(channel: String): Notification.Builder =
    if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, channel) else Notification.Builder(this)

  private fun openApp(uri: Uri? = null): PendingIntent {
    val intent = packageManager.getLaunchIntentForPackage(packageName)!!.apply {
      if (uri != null) { action = Intent.ACTION_VIEW; data = uri }
      addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  private fun statusNotification(): Notification {
    val connected = statuses.values.count { it == "已连接" }
    val detail = statuses.values.firstOrNull { it != "已连接" }
    val stop = PendingIntent.getService(this, 1, Intent(this, MonitorService::class.java).setAction(STOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    return builder(STATUS_CHANNEL)
      .setSmallIcon(R.drawable.mypi_notification)
      .setContentTitle("MyPi · 后台监听")
      .setContentText(detail ?: "正在监听 $connected 台开发机")
      .setContentIntent(openApp())
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setPriority(Notification.PRIORITY_LOW)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .addAction(Notification.Action.Builder(null, "停止监听", stop).build())
      .build()
  }

  private fun updateStatus() {
    if (instance !== this) return
    getSystemService(NotificationManager::class.java).notify(STATUS_ID, statusNotification())
    onStateChanged?.invoke()
  }

  private fun showNotice(serverId: String, sessionId: String, cursor: String, title: String, body: String, createdAt: Long) {
    val uri = Uri.Builder().scheme("mypi").authority("session")
      .appendQueryParameter("serverId", serverId).appendQueryParameter("sessionId", sessionId)
      .appendQueryParameter("eventId", cursor).build()
    val publicVersion = builder(RUN_CHANNEL).setSmallIcon(R.drawable.mypi_notification)
      .setContentTitle("MyPi").setContentText("有新的运行动态").build()
    val notification = builder(RUN_CHANNEL)
      .setSmallIcon(R.drawable.mypi_notification)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(Notification.BigTextStyle().bigText(body))
      .setContentIntent(openApp(uri))
      .setAutoCancel(true)
      .setOnlyAlertOnce(true)
      .setWhen(createdAt)
      .setGroup("mypi-runs")
      .setCategory(Notification.CATEGORY_STATUS)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setPublicVersion(publicVersion)
      .setDefaults(Notification.DEFAULT_ALL)
      .build()
    getSystemService(NotificationManager::class.java).notify("$serverId:$cursor", 2, notification)
  }

  override fun onDestroy() {
    instance = null
    for (connection in connections.values) connection.close()
    connections.clear()
    statuses.clear()
    handler.removeCallbacksAndMessages(null)
    stopForeground(STOP_FOREGROUND_REMOVE)
    onStateChanged?.invoke()
    super.onDestroy()
  }
}
