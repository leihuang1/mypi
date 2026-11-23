import assert from "node:assert/strict";
import { it } from "node:test";
import type { ArchiveRequest, ShipPreview, ShipRequest } from "@mypi/shared";
import { loadScreenHandlers } from "./screen-handlers.js";

type Button = { text: string; onPress?: () => void };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
// Objects the handlers build come from the screen's VM context, with its own Object prototype.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function screen(client: Record<string, unknown>) {
  const alerts: { title: string; message: string; buttons: Button[] }[] = [];
  const updates: unknown[] = [];
  const opened: string[] = [];
  const sent: { content: string; whenBusy?: string }[] = [];
  const state: Record<string, any> = {
    session: { id: "s1", branch: "mypi/s1" },
    client,
    topSheet: null, controlBusy: false, shipPreview: null, shipMessage: "", sending: false, failedDraft: null, error: null,
    mountedRef: { current: true }, currentSessionIdRef: { current: "s1" }, isNearBottomRef: { current: false },
    onSessionUpdated: (summary: unknown) => updates.push(summary),
    Alert: { alert: (title: string, message: string, buttons: Button[]) => alerts.push({ title, message, buttons }) },
    Linking: { openURL: async (url: string) => { opened.push(url); } },
    submitMessage: async (request: { content: string; whenBusy?: string }) => { sent.push(request); },
  };
  for (const name of ["topSheet", "shipPreview", "shipMessage", "controlBusy"]) {
    state[`set${name[0].toUpperCase()}${name.slice(1)}`] = (value: unknown) => { state[name] = value; };
  }
  state.setConnError = (value: unknown) => { state.error = value; };
  const handlers = loadScreenHandlers(
    new URL("../src/screens/SessionDetailScreen.tsx", import.meta.url),
    ["openShip", "handleShip", "handleArchive", "handleAnswer"],
    state,
  );
  return { state: handlers, alerts, updates, opened, sent };
}

const preview: ShipPreview = {
  ready: true, branch: "mypi/s1", baseRef: "origin/main", uncommitted: 1, unpushed: 2, suggestedMessage: "Fix login",
};

it("ships with the message the user left, and offers to open the PR", async () => {
  const shipped: ShipRequest[] = [];
  const pr = { url: "https://github.com/o/r/pull/7", number: 7, state: "open" };
  const { state, alerts, updates, opened } = screen({
    getShipPreview: async () => preview,
    shipSession: async (_id: string, req: ShipRequest) => {
      shipped.push(req);
      return { pr, committed: true, pushed: true, session: { id: "s1", prUrl: pr.url } };
    },
  });
  await state.openShip();
  assert.equal(state.topSheet, "ship");
  assert.equal(state.shipMessage, "Fix login", "prefilled with the agent's summary");
  state.shipMessage = "  Fix the login redirect  ";
  await state.handleShip();
  assert.deepEqual(plain(shipped), [{ message: "Fix the login redirect" }]);
  assert.deepEqual(updates, [{ id: "s1", prUrl: pr.url }]);
  assert.equal(state.topSheet, null);
  assert.equal(alerts[0].title, "已发布到 PR #7");
  alerts[0].buttons.find((b) => b.text === "打开 PR")!.onPress!();
  assert.deepEqual(opened, [pr.url]);

  // Not ready: nothing is sent.
  state.shipPreview = { ...preview, ready: false, reason: "还没有可以发布的改动" };
  await state.handleShip();
  assert.equal(shipped.length, 1);
});

it("archives at once when there's no work, and asks first when there is", async () => {
  const calls: ArchiveRequest[] = [];
  const { state, alerts } = screen({
    archiveSession: async (_id: string, req: ArchiveRequest) => {
      calls.push(req);
      return req.force
        ? { archived: true, uncommitted: 1, unpushed: 2, session: { id: "s1", archivedAt: 1 } }
        : { archived: false, uncommitted: 1, unpushed: 2, session: { id: "s1" } };
    },
  });
  state.topSheet = "ship";
  await state.handleArchive();
  assert.deepEqual(plain(calls), [{ force: false }]);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /1 个未提交的改动会被丢弃\n2 个未推送的提交会留在分支 mypi\/s1 上/);
  assert.equal(state.topSheet, "ship", "nothing happened yet");
  alerts[0].buttons.find((b) => b.text === "归档")!.onPress!();
  await tick();
  assert.deepEqual(plain(calls), [{ force: false }, { force: true }]);
  assert.equal(state.topSheet, null);
});

it("answers the agent's question with the chosen text", async () => {
  const { state, sent } = screen({});
  await state.handleAnswer("tabs");
  assert.deepEqual(plain(sent.map((r) => [r.content, r.whenBusy])), [["tabs", "steer"]]);
  state.sending = true;
  await state.handleAnswer("spaces");
  assert.equal(sent.length, 1, "not while a message is being sent");
});
