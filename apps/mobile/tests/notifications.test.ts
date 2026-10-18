import assert from "node:assert/strict";
import { it } from "node:test";
import { loadScreenHandlers } from "./screen-handlers.js";
import { parseNotificationLink } from "../src/store/notification-link.js";

function controls(running = false, enabled = false, granted = false) {
  const calls: string[] = [];
  const current = { running, enabledServerIds: enabled ? ["server"] : [] };
  const handlers = loadScreenHandlers(new URL("../src/store/use-notifications.ts", import.meta.url), ["toggle", "unregister"], {
    server: { id: "server", url: "http://fixture", token: "fixture" },
    changing: { current: false },
    Platform: { OS: "android", Version: 33 },
    monitor: {
      getState: async () => current,
      enable: async (_json: string) => { calls.push("enable"); return current; },
      disable: async (_id: string) => { calls.push("disable"); return current; },
    },
    PermissionsAndroid: {
      PERMISSIONS: { POST_NOTIFICATIONS: "notifications" }, RESULTS: { GRANTED: "granted" },
      check: async () => granted,
      request: async () => { calls.push("permission"); return "denied"; },
    },
    setBusy: (_busy: boolean) => {},
    setState: (_next: unknown) => {},
    setError: (_error: string | null) => {},
  });
  return { calls, handlers };
}

it("requests permission only on enable and never starts a service after denial", async () => {
  const { calls, handlers } = controls();
  assert.deepEqual(calls, []);
  await handlers.toggle();
  assert.deepEqual(calls, ["permission"]);
  assert.equal(handlers.changing.current, false);
});

it("disables locally without permission prompts and resumes stopped monitoring only on request", async () => {
  const active = controls(true, true);
  await active.handlers.toggle();
  assert.deepEqual(active.calls, ["disable"]);
  const stopped = controls(false, true, true);
  await stopped.handlers.toggle();
  assert.deepEqual(stopped.calls, ["enable"]);
  await stopped.handlers.unregister({ id: "server" });
  assert.deepEqual(stopped.calls, ["enable", "disable"]);
});

it("notification links identify only a paired server/session, not an arbitrary URL", () => {
  assert.deepEqual(parseNotificationLink("mypi://session?serverId=server-1&sessionId=abc&eventId=daemon%3A5"), { serverId: "server-1", sessionId: "abc" });
  for (const url of ["https://example.com/session?serverId=x&sessionId=y", "mypi://connect?url=http://server", "mypi://session?serverId=x&sessionId=../secrets", "invalid"]) {
    assert.equal(parseNotificationLink(url), null);
  }
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
