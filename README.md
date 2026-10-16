# MyPi: Pi Durable Mobile Companion (Android / iOS / Web)

MyPi lets you run durable [Pi](https://pi.dev) coding sessions on your development machine (`@earendil-works/pi-durable`) and seamlessly watch, steer, and review Git diffs from your **Android** or **iOS** phone over LAN Wi‑Fi or Tailscale.

## Architecture

- **`packages/shared` (`@mypi/shared`)**: Isomorphic TypeScript wire protocol (`/v1`), `MyPiClient` (HTTP + auto-reconnecting SSE), and deterministic `SessionLiveState` reducer (`snapshot → deltas`).
- **`packages/server` (`@mypi/server`)**: Lightweight background daemon built on `@earendil-works/pi-durable` (`1.3.0`) and Node SQLite (`~/.mypi`). Automatically loads your existing `~/.pi/agent` models & credentials in **read-only** mode so your existing `pi` CLI stays completely untouched.
- **`apps/mobile` (`@mypi/mobile`)**: React Native (Expo) client for Android, iOS, and Web featuring:
  - Server Pairing (QR / `mypi://connect` URI / LAN & Tailscale URL + Bearer Token)
  - Remote Directory Picker & Durable Session Creator
  - Live Streaming Chat, Thinking Blocks, & Collapsible Tool Cards (`read`, `write`, `edit`, `bash`)
  - Mid-run **Steer** (`whenBusy: "steer"`), **Queue** (`followUp`), and **Abort** controls
  - Built-in **Git Diff Review Panel** (`git status` + syntax-colored unified diff viewer)

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
