import assert from "node:assert/strict";
import { it } from "node:test";
import { loadScreenHandlers } from "./screen-handlers.js";

it("asks permission only on explicit enable and keeps other functionality available after denial", async () => {
  let asks = 0;
  let registrations = 0;
  const state = loadScreenHandlers(
    new URL("../src/store/use-notifications.ts", import.meta.url),
    ["sync", "toggle"],
    {
      server: { id: "server", url: "http://fixture", token: "fixture" },
      servers: [{ id: "server", url: "http://fixture", token: "fixture" }],
      preferences: { deviceId: "test-device", enabled: {} as Record<string, boolean> },
      enabled: false,
      changing: { current: false },
      syncJob: { current: Promise.resolve() },
      syncing: false,
      cancelled: false,
      Platform: { OS: "android" },
      Notifications: {
        AndroidImportance: { DEFAULT: 3 }, AndroidNotificationVisibility: { PRIVATE: 0 },
        setNotificationChannelAsync: async () => {},
        getPermissionsAsync: async () => ({ granted: false, canAskAgain: true }),
        requestPermissionsAsync: async () => { asks++; return { granted: false }; },
      },
      pushToken: async () => { throw new Error("Must not request token without permission"); },
      MyPiClient: class { async registerNotifications() { registrations++; } },
      setBusy: (_busy: boolean) => {},
      setPreferences: (_next: unknown) => {},
      setError: (_error: string | null) => {},
    },
  );
  await state.sync();
  assert.equal(asks, 0);
  assert.equal(registrations, 0);
  await state.toggle();
  assert.equal(asks, 1);
  assert.equal(registrations, 0);
  assert.equal(state.changing.current, false);
  assert.equal(state.preferences.enabled.server, undefined);
});

it("opening a notification fetches its own server/session and ignores a response after navigation changes", async () => {
  let resolveSession!: (value: unknown) => void;
  const navigation: string[] = [];
  const state = loadScreenHandlers(new URL("../App.tsx", import.meta.url), ["handleNotificationOpen"], {
    servers: [{ id: "server-b", url: "http://b", token: "fixture" }],
    navEpochRef: { current: 0 },
    activeServerIdRef: { current: "server-a" },
    MyPiClient: class {
      async getDevice() { return { uid: "device-b" }; }
      getSession(id: string) { assert.equal(id, "session-b"); return new Promise((resolve) => { resolveSession = resolve; }); }
    },
    setActiveServerId: async (_id: string) => {},
    resetServerScopedState: () => {},
    setActiveId: (_id: string) => {},
    setDevice: (_device: unknown) => {},
    setActiveSession: (_session: unknown) => {},
    navigateToScreen: (screen: string) => navigation.push(screen),
  });
  const pending = state.handleNotificationOpen("server-b", "session-b");
  state.navEpochRef.current++;
  resolveSession({ id: "session-b" });
  await pending;
  assert.equal(navigation.length, 0);
  const second = state.handleNotificationOpen("server-b", "session-b");
  resolveSession({ id: "session-b" });
  await second;
  assert.equal(state.activeServerIdRef.current, "server-b");
  assert.deepEqual(navigation, ["session-detail"]);
});
