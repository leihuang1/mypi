# MyPi: Pi Durable Mobile Companion (Android / iOS / Web)

> **⚠️ Note**: This is a **personal, experimental toy project** built for my own workflow and tinkering. Expect rough edges, breaking changes, and zero production guarantees.

MyPi lets you run durable [Pi](https://pi.dev) coding sessions on your development machine (`@earendil-works/pi-durable`) and seamlessly watch, steer, and review Git diffs from your **Android** or **iOS** phone over LAN Wi‑Fi or Tailscale.

## Architecture

- **`packages/shared` (`@mypi/shared`)**: Isomorphic TypeScript wire protocol (`/v1`), `MyPiClient` (HTTP + auto-reconnecting SSE), and deterministic `SessionLiveState` reducer (`snapshot → deltas`).
- **`packages/server` (`@mypi/server`)**: Lightweight background daemon built on `@earendil-works/pi-durable` (`1.3.0`) and Node SQLite (`~/.mypi`). Automatically loads your existing `~/.pi/agent` models & credentials in **read-only** mode so your existing `pi` CLI stays completely untouched.
- **`apps/mobile` (`@mypi/mobile`)**: React Native (Expo) client for Android, iOS, and Web featuring:
  - Server Pairing (QR / `mypi://connect` URI / LAN & Tailscale URL + Bearer Token)
  - Remote Directory Picker & Durable Session Creator
  - Live Streaming Chat, Thinking Blocks, & Collapsible Tool Cards (`read`, `write`, `edit`, `bash`)
  - Mid-run **Steer** (`whenBusy: "steer"`), **Queue** (`followUp`), and **Abort** controls
  - Per-server/session drafts and reading position, with opt-in jump to new messages
  - Compact **Workspace Changes** entry → file list → single-column diff sheet
  - Opt-in daemon-backed **system push notifications** for run endings and terminal execution errors

---

## Quick Start

### 1. Start the Durable Daemon on your Dev Machine

```bash
npm run server:start
```

On startup, `mypi-server` prints your LAN / Tailscale URLs, Bearer Token, a terminal QR code, and a `mypi://connect?...` pairing URI.

### 2. Launch the Mobile App (Android / iOS / Web)

```bash
# Start Expo dev server (scan with Expo Go on Android/iOS)
npm run mobile:start

# Or launch directly on connected Android device / emulator
npm run mobile:android

# Or launch on iOS Simulator
npm run mobile:ios

# Or preview in desktop/mobile browser
npm run mobile:web
```

### 3. Typecheck & Run Tests

```bash
npm run check
npm test
```

## 阅读与工作区改动

- 草稿、未确认发送的消息和阅读位置按「服务器 + 会话」保存在 App 本地；返回会话后恢复。停在底部时跟随新内容，上翻后用“新消息 ↓”主动回到底部。
- 输入框上方只显示文本改动数量。打开时收起键盘，文件列表与单文件 diff 在同一底部面板内切换；可展开至接近全屏。关闭面板不会清空草稿或主动弹出键盘。
- 范围是**整个 Git 工作区相对 HEAD 的净变化**，不是本会话的产出。包含暂存、未暂存及未跟踪文本；二进制、空文件、纯权限变化和净变化为零的文件不显示。无首个 commit 时以空树为基准；重命名按原路径删除、新路径新增展示。
- 工具结束、运行结束、回到前台时合并刷新。文件列表自动更新；正在读的 diff 保持快照，点“有新改动 · 更新”才替换。失败保留旧结果并提示“暂未更新”。
- 单次 Git 输出上限 4 MiB，超限/超时视为刷新失败，不伪装成没有改动。草稿保存在应用沙箱的 AsyncStorage，不会上传到推送服务。

## 后台系统通知配置（真机）

通知由开发机上的 MyPi daemon 持续监听并交给 **Expo Push → FCM / APNs**，不需要手机 App 常驻。daemon 启动时会恢复已有会话和监听器；开发机需要保持运行并能访问 `https://exp.host`。仅收到推送不要求手机能连回开发机，点击查看会话则仍需 LAN/Tailscale 连通。

推送需要你自己的 Expo/Firebase（iOS 为 Apple）凭据，仓库不包含真实凭据。**普通 Expo Go / Web 预览不能作为本项目后台推送的验收环境；请安装配置过凭据的原生构建。**

### Android

1. 在 [Expo](https://expo.dev) 创建/关联项目（可在 `apps/mobile` 运行 `npx eas-cli init`），取得 EAS project UUID。通过 `MYPI_EAS_PROJECT_ID` 环境变量，或 `apps/mobile/app.json` 的 `expo.extra.eas.projectId` 配置。
2. 在 Firebase 创建 Android 应用，包名 **`dev.mypi.app`**，下载 `google-services.json` 放到 `apps/mobile/google-services.json`（已 gitignore），或用 `MYPI_GOOGLE_SERVICES_FILE` 指定本地路径。
   EAS 云构建建议把公开的 projectId 写入 `app.json`，并在 EAS 项目设置中建立 **file 类型**环境变量 `MYPI_GOOGLE_SERVICES_FILE`，上传 `google-services.json`；本地 gitignore 的文件不会自动上传到云端。
3. 按 [Expo FCM v1 配置说明](https://docs.expo.dev/push-notifications/fcm-credentials/) 将 Firebase 服务账户私钥上传到 Expo/EAS 的 FCM v1 credentials。**服务账户私钥不要提交到 Git，也不要打包到 App。**
4. 构建并安装，任选其一：

   ```bash
   cd apps/mobile
   export MYPI_EAS_PROJECT_ID="你的项目 UUID"

   # EAS 内部分发 APK；云端也需可用的 projectId / google-services.json
   npx eas-cli build --platform android --profile preview

   # 或本地原生构建（需要 Android SDK / JDK 17+；prebuild 不使用 --clean）
   npx expo prebuild --platform android
   npx expo run:android --variant release
   ```

5. 在会话列表点击“后台通知 → 开启”，此时才申请系统权限并向当前服务器登记。拒绝权限不会影响聊天和 diff；每台配对服务器独立开关。系统中撤销权限后，App 下次回到前台会同步停用推送登记。

### iOS

使用同一个 EAS projectId，配置 `dev.mypi.app` 的 APNs 凭据和签名，在 Apple 开发者账户注册真机，然后用 EAS 构建安装。Expo notifications 插件已加入配置；详见 [Expo 推送设置](https://docs.expo.dev/push-notifications/push-notifications-setup/)。

### 通知行为与边界

- 普通结束固定为“运行已结束，点此查看”，不宣称任务成功；排队输入连续运行时合并至队列空闲后提醒。
- 依据 durable 的 run/submission/task 事件判断终止错误，不解析模型正文。普通工具错误、自动重试、压缩不单独推送；同一失败不再附带普通结束提醒。异常只发送简短错误类别，详情留在会话里。
- 推送包含会话名、简短状态和导航 ID，**没有代码、完整输出、服务器地址或配对 token**。Android 通知频道默认使用 PRIVATE 锁屏可见性；iOS 预览显示遵循系统设置。
- 前台正在查看的会话不提醒；App 会发送短期 presence 心跳，前台通知处理器也会再次抑制。进程被系统直接杀掉时，presence 最多 75 秒过期；这段时间内结束的运行可能被抑制。
- 主动停止/重置不提醒；事件去重与设备登记保存在 daemon 的 `notifications.json`（权限 0600），重启不会重复发送已处理的事件。Expo 回执用于清理失效 token。
- 为避免重复，发送前先持久化去重记录；**推送为尽力而为、至多发送一次**。网络超时、系统省电策略或推送网关故障可能导致漏达，不对发送结果不明的请求盲目重发。可在 daemon 日志检查 `[mypi-push]`。若 Expo 项目开启增强推送安全性，在 daemon 环境设置 `EXPO_ACCESS_TOKEN`。

## 真机验收清单

- 在会话 A 输入草稿并上翻，切到 B、文件页或退出再回到 A，确认草稿和阅读位置；后台继续输出时只出现“新消息 ↓”。
- 打开改动面板：键盘收起；同名文件有目录辅助信息；新增/删除有文字标记；单列 diff 可展开、返回列表保持位置；关闭后草稿/聊天位置不变。
- 阅读 diff 期间修改文件，确认先提示更新而不替换正文；断开服务器后刷新，旧列表和旧 diff 仍可读。
- 在别的会话/手机后台等待结束，点击通知进入对应服务器的会话；前台同会话、主动停止、普通工具错误不提醒；连续 Queue 只在最后提醒。
- 模型不可用等终止错误只收到异常通知，不跟随普通结束通知；重启 daemon 后不重复提醒。
- 拒绝通知权限后仍能聊天、浏览文件和查看 diff。
