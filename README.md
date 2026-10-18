# MyPi — Pi Durable Mobile Companion

Run [Pi](https://pi.dev) coding sessions on your development machine and follow them from your phone over LAN or Tailscale. Built with React Native / Expo and `@earendil-works/pi-durable`.

> Personal, experimental software. Expect rough edges and no production guarantees.

## Features

- Streaming chat, thinking blocks, tool output, and Steer / Queue / Stop controls.
- File browsing, model selection, and per-session drafts and reading position.
- Workspace change lists with full-screen, single-column Git diffs.
- Android background monitoring with local notifications. No third-party push account or credentials required.

## Getting Started

**Requirements:** Node.js 22.19+, npm, and Pi models/credentials configured in `~/.pi/agent`. Native Android builds also require the Android SDK and JDK 17+ (`JAVA_HOME`).

### 1. Start the daemon

```bash
npm ci
npm run server:start
```

The daemon reads your existing Pi configuration without modifying it, stores its own data in `~/.mypi`, and prints a pairing QR code, URLs, and bearer token.

### 2. Install the Android App

For everyday use, build and install a standalone App with no Metro dependency:

```bash
cd apps/mobile
EXPO_OFFLINE=1 npx expo run:android --variant release
```

Connect a phone with USB debugging enabled or use an emulator. The APK is generated at `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`.

### 3. Pair and create a session

Scan the daemon's QR code or enter its URL and token, then choose a project directory and create a session. Keep the development machine and daemon running.

Use a trusted LAN, Tailscale, or HTTPS; the bearer token grants access to the daemon. USB localhost forwarding is for wired debugging only.

## Git Diffs

In a Git workspace, tap the changed-file count above the chat input, then select a file to open its full-screen diff. The entry is hidden when there are no supported changes.

Diffs show **uncommitted text changes across the entire workspace relative to HEAD**, including staged, unstaged, and untracked files—not just edits made by the current session. Binary and empty changes are excluded. An opened diff stays unchanged until you explicitly refresh it.

## Android Notifications

Enable background monitoring from the session list and grant notification permission. A native foreground service keeps a connection to the daemon; its persistent notification includes a stop action.

Run endings and terminal errors trigger local notifications that open the relevant session. Queued runs are combined; deliberate stops and the session currently being viewed do not alert.

The phone must be able to reach the daemon. Delivery is best-effort: force-stop, reboot, connectivity loss, or battery restrictions can interrupt monitoring. Reopen the App and resume monitoring if needed. This feature requires the native Android App; it is unavailable in Expo Go, iOS, and Web.

## Development

Run these commands from the repository root:

```bash
npm run mobile:android  # Native debug build; requires Metro for the UI
npm run mobile:start    # Expo Go preview, without background monitoring
npm run mobile:ios      # iOS Simulator
npm run mobile:web      # Browser preview

npm run check
npm test
```

Launch scripts skip Expo metadata network requests. Native changes require rebuilding the App. After generating the Android project, run native tests with:

```bash
cd apps/mobile/android
./gradlew :mypi-monitor:testDebugUnitTest
```

## Repository Layout

- `packages/shared` — wire protocol, HTTP/SSE client, and session reducer.
- `packages/server` — durable session daemon and workspace Git operations.
- `apps/mobile` — React Native UI; `modules/mypi-monitor` contains the Android foreground service.
