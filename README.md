# MyPi: Pi Durable Mobile Companion (Android / iOS / Web)

> **⚠️ Note**: This is a **personal, experimental toy project** built for my own workflow and tinkering. Expect rough edges, breaking changes, and zero production guarantees.

MyPi lets you run durable [Pi](https://pi.dev) coding sessions on your development machine (`@earendil-works/pi-durable`) and watch, steer, and review Git diffs from your phone over LAN Wi-Fi or Tailscale.

## Architecture

- **`packages/shared` (`@mypi/shared`)**: TypeScript wire protocol, HTTP/SSE client, and deterministic session reducer.
- **`packages/server` (`@mypi/server`)**: Background daemon on `@earendil-works/pi-durable` and Node SQLite (`~/.mypi`). Loads existing `~/.pi/agent` models and credentials in **read-only** mode. Keeps sessions running independently of the phone.
- **`apps/mobile` (`@mypi/mobile`)**: React Native / Expo client with pairing, streaming chat, tool cards, Steer/Queue/Stop, file browsing, model switching, and workspace diff review.
- **`apps/mobile/modules/mypi-monitor`**: Local Expo Android module. A native foreground service maintains the notification SSE connections and displays local Android notifications without a JS runtime or third-party push provider.

## Quick Start

### 1. Start the daemon

```bash
npm run server:start
```

The server prints LAN / Tailscale URLs, a bearer token and a pairing QR code. Keep the development computer and daemon running while tasks execute.

### 2. Run the App

```bash
# Build/install the native Android App and start Metro (Android SDK + JDK 17+ required)
npm run mobile:android

# Preview chat/diffs in Expo Go; the native Android monitoring service is not included
npm run mobile:start

# iOS and Web: chat/diffs, without the Android background monitor
npm run mobile:ios
npm run mobile:web
```

On macOS with Android Studio, use `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"` if your shell still defaults to Java 11.

Native code changes require rebuilding the App, not just reloading Metro. SDK 52 currently uses the legacy React Native architecture (`newArchEnabled: false`), matching the working local build and avoiding RN 0.76's C++ incompatibility with the installed NDK 29. Revisit this setting when upgrading React Native/Expo. For an existing generated Android project, update native configuration without deleting it:

```bash
cd apps/mobile
npx expo prebuild --platform android --no-install
```

For a standalone self-use APK without a Metro dependency:

```bash
cd apps/mobile
npx expo run:android --variant release
```

No Expo account/projectId, Firebase, APNs, Google Play services or Xiaomi push credentials are needed. Build tools still need to download npm/Maven dependencies on the first build.

### 3. Check and test

```bash
npm run check
npm test

# Native SSE framing, cursor deduplication and notification suppression tests
cd apps/mobile/android
./gradlew :mypi-monitor:testDebugUnitTest
```

## 阅读与工作区改动

- 草稿、未确认发送的消息和阅读位置按「服务器 + 会话」保存在 App 本地。返回会话后恢复；停在底部时跟随新内容，上翻后用“新消息 ↓”主动回到底部。
- 输入框上方只显示文本改动数量。打开时收起键盘，文件列表与单文件 diff 在同一底部面板内切换；可展开至接近全屏。关闭面板不会清空草稿或主动弹出键盘。
- 范围是**整个 Git 工作区相对 HEAD 的净变化**，不是本会话的产出。包含暂存、未暂存及未跟踪文本；二进制、空文件、纯权限变化和净变化为零的文件不显示。无首个 commit 时以空树为基准；重命名按原路径删除、新路径新增展示。
- 工具结束、运行结束、回到前台时合并刷新。列表自动更新；正在读的 diff 保持快照，点“有新改动 · 更新”才替换。失败保留旧结果并提示“暂未更新”。
- 单次 Git 输出上限 4 MiB，超限/超时视为刷新失败，不伪装成没有改动。草稿保存在应用沙箱的 AsyncStorage。

## Android 后台监听与本地通知

```text
开发机 daemon（持续监听 durable 事件，合并、去重）
    │  认证 SSE：/v1/notifications/events
    ▼
Android 原生前台服务（保持连接、断线重连、保存通知进度）
    │
    ▼
Android 本地通知（点击进入对应服务器 / 会话）
```

### 使用方式

1. 安装包含原生模块的 Android App，配对开发机。
2. 在会话列表点击“**后台监听与通知 → 开启**”。Android 13+ 此时才申请通知权限，拒绝后聊天和 diff 仍可使用。
3. 系统显示一条低打扰的“**MyPi · 后台监听**”常驻通知；它显示连接/重连状态，并提供“**停止监听**”入口。每台配对服务器可分别开启，常驻通知里的停止按钮会停止全部监听。
4. App 切到后台或正常划掉最近任务后，原生服务可以继续工作，不依赖 JS/SSE 聊天页面是否存活。系统回收后允许服务自动恢复，但**用户主动停止不会被自动重新开启**；若服务已暂停，回到 App 可以点“恢复”。不开机自启，不申请悬浮窗、精确闹钟或强制忽略电池优化权限。
5. 关闭监听、移除配对服务器都是本地操作，即使开发机离线也能停止；停止监听**不会停止开发机上的任务**。停用期间不积攒待显示通知，重新开启从当前事件位置开始。

### 提醒规则

- 普通结束固定为“运行已结束，点此查看”，不宣称任务成功；连续排队输入合并至队列空闲后提醒。
- 依据 durable 的 run/submission/task 事件判断终止错误，不解析模型正文。可恢复工具错误、自动重试、压缩不单独提醒；同一失败不再附带普通结束通知。
- **前台正在查看的会话不提醒**。抑制逻辑在手机端，原生活动生命周期负责识别前后台，不依赖向服务器发送 presence 心跳。
- 主动停止/重置不提醒。通知只含会话名、简短状态和导航 ID，没有代码或完整输出；锁屏默认 PRIVATE，公开版本只显示“MyPi · 有新的运行动态”。
- 服务端将事件写入 `~/.mypi/notification-events.json`（0600）；手机先保存进度再显示通知，防止重连/进程重启导致重复。首次启用不翻旧账；断网重连最多回放最近 256 条，手机仅显示一小时以内的提醒。超过保留范围会提示查看会话完整状态。
- 为避免重复，手机在保存进度后、显示通知前若恰好崩溃，这条提醒可能漏达。通知不是可靠的任务结果记录，最终状态以会话为准。

### 前台服务与小米手机的边界

- 此服务用于持续连接自己的开发机，采用 Android 的 [`connectedDevice` 前台服务类型](https://developer.android.com/develop/background-work/services/fgs/service-types#connected-device)，声明 `FOREGROUND_SERVICE_CONNECTED_DEVICE` 和网络条件所需的 `CHANGE_NETWORK_STATE`。不是通用云端轮询，也不使用 Android 15+ 有六小时时限的 `dataSync` 类型。
- **前台服务不等于绝对保活**。强行停止 App、Android“正在运行的应用”里的停止、设备重启、系统/厂商省电限制、Doze 或断网都可能中断连接或延迟提醒。没有远程推送兜底。
- 手机必须能持续连回开发机；建议 LAN/Tailscale。USB `adb reverse` 仅适合插线调试，拔线后不能继续依靠 `127.0.0.1` 收到事件。HTTP 配对 token 会通过该连接传输，请使用可信局域网、Tailscale 或 HTTPS。
- 小米 13 上先按默认设置实测。若长时间息屏后仍被限制，再按需在系统设置里允许 MyPi 后台运行、调整电池策略；不需要配置小米推送或 Google 服务。
- 原生监听配置和游标存于 App 私有 SharedPreferences，含连接开发机所需的配对 token；已关闭 Android 应用备份。移除服务器会删除对应监听凭据/进度。
- iOS、Web 和 Expo Go 不提供此后台监听功能，其他功能不受影响。

此前的 Expo Push / FCM / APNs 发送链路、登记接口和依赖已移除。旧版 `notifications.json`、本地推送偏好或已下载的凭据文件不会被自动删除，也不再使用；无需配置或迁移它们。

## 真机验收清单

- 草稿与阅读位置跨会话、页面和 App 重开恢复；上翻后有新内容不强拉到底部。
- 改动面板键盘收起、同名目录辅助信息、新增/删除文字标记、单列 diff、返回列表/关闭面板的位置保持正常。
- 阅读 diff 时修改文件，确认先提示更新而不替换正文；刷新失败仍保留旧内容。
- 开启监听后出现常驻通知；按 Home、息屏、正常划掉最近任务后，在开发机结束运行，确认仍能收到本地通知；点击可冷启动/热启动进入正确会话。
- 当前会话前台、主动停止、普通工具错误不提醒；其他会话会提醒；连续 Queue 只在最后提醒；终止异常不追加普通结束通知。
- 断网后常驻通知显示重连；恢复网络补收近期提醒、不重复；重启 daemon 后不重发旧提醒。
- 常驻通知“停止监听”后连接和常驻通知消失，回到 App 显示关闭；开发机任务不受影响。强行停止 App 后不要期待后台提醒，重新进入 App 可手动恢复。
- 拒绝/撤销通知权限不影响聊天和 diff；没有任何 Google/小米/Expo 推送配置要求。
