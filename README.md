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
