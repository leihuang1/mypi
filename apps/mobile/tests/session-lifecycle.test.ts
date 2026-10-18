import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionSummary } from "@mypi/shared";
import { loadScreenHandlers } from "./screen-handlers.js";

const sessionA: SessionSummary = {
  id: "a", name: "A", cwd: "/repo/a",
  model: { provider: "openai", modelId: "gpt-5" }, thinkingLevel: "high",
  createdAt: 1000, updatedAt: 1000, busy: false, entryCount: 0,
};
const sessionB = { ...sessionA, id: "b", name: "B", cwd: "/repo/b" };

function navigation() {
  const state: Record<string, any> = {
    activeServerId: "server-1",
    activeServerIdRef: { current: "server-1" },
    currentNavEpoch: 1,
    navEpochRef: { current: 1 },
    screenRef: { current: "new-session" },
    sessions: [sessionB],
    activeSession: null,
  };
  state.setSessions = (update: (sessions: SessionSummary[]) => SessionSummary[]) => {
    state.sessions = update(state.sessions);
  };
  state.setActiveSession = (update: any) => {
    state.activeSession = typeof update === "function" ? update(state.activeSession) : update;
  };
  state.navigateToScreen = (screen: string) => {
    state.screenRef.current = screen;
    state.navEpochRef.current++;
  };
  return loadScreenHandlers(new URL("../App.tsx", import.meta.url),
    ["handleSessionCreated", "handleSessionUpdated"], state);
}

describe("actual app navigation callbacks", () => {
  it("opens a created session only while the original creation screen is still active", () => {
    const normal = navigation();
    normal.handleSessionCreated(sessionA);
    assert.equal(normal.activeSession.id, "a");
    assert.equal(normal.screenRef.current, "session-detail");

    const late = navigation();
    late.navEpochRef.current = 3;
    late.screenRef.current = "session-detail";
    late.activeSession = sessionB;
    late.handleSessionCreated(sessionA);
    assert.equal(late.activeSession.id, "b");
    assert.equal(late.sessions[0].id, "a");

    const reopened = navigation();
    reopened.navEpochRef.current = 3;
    reopened.handleSessionCreated(sessionA);
    assert.equal(reopened.activeSession, null);
    assert.equal(reopened.screenRef.current, "new-session");
  });

  it("ignores old-server create and update responses", () => {
    const state = navigation();
    state.activeServerIdRef.current = "server-2";
    state.handleSessionCreated(sessionA);
    state.handleSessionUpdated({ ...sessionB, name: "old-server result" });
    assert.equal(state.activeSession, null);
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].name, "B");
  });

  it("updates the list but not active B when a delayed update of A arrives", () => {
    const state = navigation();
    state.sessions = [sessionA, sessionB];
    state.activeSession = sessionB;
    state.handleSessionUpdated({ ...sessionA, name: "Renamed A" });
    assert.equal(state.activeSession.id, "b");
    assert.equal(state.sessions[0].name, "Renamed A");
  });
});
