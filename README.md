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

The app saves the server under the daemon's name: `MYPI_NAME`, or the hostname if unset. To rename a saved server, change `MYPI_NAME`, restart the daemon and scan its QR code again.

Use a trusted LAN, Tailscale, or HTTPS; the bearer token grants access to the daemon. USB localhost forwarding is for wired debugging only.

### Always-on Mac (optional)

To keep the daemon running on another Mac, clone the repo there (for example to `~/services/mypi`), run `npm ci`, and log in to Pi on that machine. Then install the LaunchAgent from inside its logged-in GUI session:

```bash
zsh scripts/mini/install-launchagent.sh   # starts now and at login; logs in ~/Library/Logs/mypi/daemon.log
```

Host-specific settings go in `~/.mypi/daemon.env` on that machine (for example `MYPI_NAME=mini`), which the LaunchAgent loads at each start.

From your laptop, `npm run deploy:mini` pulls the latest default branch on that host over SSH, reinstalls dependencies only when `package-lock.json` changed, and restarts the daemon. Running sessions resume after the restart. Set `MYPI_MINI_HOST` (default `mac-mini`, an `~/.ssh/config` alias) and `MYPI_MINI_DIR` (default `services/mypi`) to match your setup.

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

`npm run server:dev` runs a watch-mode daemon on port 4781 with data in `~/.mypi-dev`, so experiments stay separate from a daemon on the default port 4780.

Launch scripts skip Expo metadata network requests. Native changes require rebuilding the App. After generating the Android project, run native tests with:

```bash
cd apps/mobile/android
./gradlew :mypi-monitor:testDebugUnitTest
```

## Repository Layout

- `packages/shared` — wire protocol, HTTP/SSE client, and session reducer.
- `packages/server` — durable session daemon and workspace Git operations.
- `apps/mobile` — React Native UI; `modules/mypi-monitor` contains the Android foreground service.
