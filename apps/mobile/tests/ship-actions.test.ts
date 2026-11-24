import assert from "node:assert/strict";
import { it } from "node:test";
import type { ArchiveRequest, ShipPreview, ShipRequest } from "@mypi/shared";
import { loadScreenHandlers } from "./screen-handlers.js";

type Button = { text: string; onPress?: () => void };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
// Objects the handlers build come from the screen's VM context, with its own Object prototype.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function screen(client: Record<string, unknown>, session: Record<string, unknown> = { id: "s1", branch: "mypi/s1", updatedAt: 1 }) {
  const alerts: { title: string; message: string; buttons: Button[] }[] = [];
  const updates: any[] = [];
  const opened: string[] = [];
  const sent: { content: string; whenBusy?: string }[] = [];
  const views: Record<string, any> = {};
  const state: Record<string, any> = {
    session,
    client: { sendMessage: async (_id: string, request: { content: string; whenBusy?: string }) => { sent.push(request); }, ...client },
    topSheet: null, controlBusy: false, shipPreview: null, shipMessage: "", sending: false, failedDraft: null, error: null,
    mountedRef: { current: true }, currentSessionIdRef: { current: "s1" }, isNearBottomRef: { current: false },
    controlBusyRef: { current: false }, previewGenRef: { current: 0 }, sessionRef: { current: session },
    summaryGenRef: { current: 0 }, lastSummaryAtRef: { current: 0 }, answeredRef: { current: null }, viewKey: "v",
    // The parent: it rerenders the screen later, so it doesn't touch the screen's refs.
    onSessionUpdated: (summary: any) => { updates.push(summary); state.session = summary; },
    timers: [] as (() => void)[],
    setTimeout: (fn: () => void) => { state.timers.push(fn); return 0; },
    Alert: { alert: (title: string, message: string, buttons: Button[]) => alerts.push({ title, message, buttons }) },
    Linking: { openURL: async (url: string) => { opened.push(url); } },
    saveSessionView: (key: string, patch: object) => { views[key] = { ...views[key], ...patch }; },
    getSessionView: (key: string) => views[key] ?? {},
    persistSessionViews: async () => {},
  };
  for (const name of ["topSheet", "shipPreview", "shipMessage", "controlBusy", "sending", "failedDraft"]) {
    state[`set${name[0].toUpperCase()}${name.slice(1)}`] = (value: unknown) => {
      state[name] = typeof value === "function" ? (value as (prev: unknown) => unknown)(state[name]) : value;
    };
  }
  state.setConnError = (value: unknown) => { state.error = value; };
  const handlers = loadScreenHandlers(
    new URL("../src/screens/SessionDetailScreen.tsx", import.meta.url),
    ["claimControl", "releaseControl", "applySummary", "appliedLocally", "refreshSummary", "openPr", "submitMessage",
      "openShip", "handleShip", "handleArchive", "handleAnswer"],
    state,
  );
  return { state: handlers, alerts, updates, opened, sent };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
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
      return { pr, committed: true, pushed: true, session: { id: "s1", prUrl: pr.url, updatedAt: 2 } };
    },
  });
  await state.openShip();
  assert.equal(state.topSheet, "ship");
  assert.equal(state.shipMessage, "Fix login", "prefilled with the agent's summary");
  state.shipMessage = "  Fix the login redirect  ";
  await state.handleShip();
  assert.deepEqual(plain(shipped), [{ message: "Fix the login redirect" }]);
  assert.deepEqual(plain(updates), [{ id: "s1", prUrl: pr.url, updatedAt: 2 }]);
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
        ? { archived: true, uncommitted: 1, ignored: 1, unpushed: 2, session: { id: "s1", branch: "mypi/s1", archivedAt: 1, updatedAt: 3 } }
        : { archived: false, uncommitted: 1, ignored: 1, unpushed: 2, session: { id: "s1", branch: "mypi/s1", updatedAt: 1 } };
    },
  });
  state.topSheet = "ship";
  await state.handleArchive();
  assert.deepEqual(plain(calls), [{ force: false }]);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /1 个未提交的改动会被丢弃\n1 个被忽略的文件（如 .env）会被删除\n2 个未推送的提交会留在本地分支 mypi\/s1 上（游离 HEAD 上的提交在 mypi\/s1-detached）/);
  assert.equal(state.topSheet, "ship", "nothing happened yet");
  alerts[0].buttons.find((b) => b.text === "归档")!.onPress!();
  await tick();
  assert.deepEqual(plain(calls), [{ force: false }, { force: true }]);
  assert.equal(state.topSheet, null);
});

it("answers the agent's question with the chosen text, and the question goes once it's sent", async () => {
  const { state, sent, updates } = screen({}, { id: "s1", updatedAt: 1, status: "needs_you", question: { text: "Tabs?", choices: ["tabs"] } });
  await state.handleAnswer("tabs");
  assert.deepEqual(plain(sent.map((r) => [r.content, r.whenBusy])), [["tabs", "steer"]]);
  assert.deepEqual([updates.at(-1).status, updates.at(-1).question], ["running", undefined], "no stale chips at the next run_end");
  state.sending = true;
  await state.handleAnswer("spaces");
  assert.equal(sent.length, 1, "not while a message is being sent");
});

it("keeps one request at a time, the latest preview, and the newest summary", async () => {
  const shipping = deferred<unknown>();
  const previews = [deferred<ShipPreview>(), deferred<ShipPreview>()];
  let ships = 0;
  const { state, alerts, updates } = screen({
    getShipPreview: () => previews.shift()!.promise,
    shipSession: () => { ships++; return shipping.promise; },
  });
  const [first, second] = previews;

  // Opened, closed and opened again: the first, slower answer doesn't replace the second or the user's edit.
  const opening = state.openShip();
  void state.openShip();
  const reopening = state.openShip();
  second.resolve({ ...preview, suggestedMessage: "Second" });
  await reopening;
  state.shipMessage = "Edited";
  first.resolve({ ...preview, suggestedMessage: "First" });
  await opening;
  assert.deepEqual([state.topSheet, state.shipMessage, state.shipPreview.suggestedMessage], ["ship", "Edited", "Second"]);

  // Two taps in one render send one Ship.
  void state.handleShip();
  void state.handleShip();
  assert.equal(ships, 1);
  shipping.resolve({ pr: { url: "u", number: 1, state: "open" }, committed: false, pushed: true, session: { id: "s1", updatedAt: 5 } });
  await tick();
  assert.equal(state.controlBusyRef.current, false);

  // A summary read before the Ship finished is older: it doesn't take the PR away.
  state.applySummary({ id: "s1", updatedAt: 4 });
  assert.equal(updates.at(-1).updatedAt, 5);

  // The browser won't open: say so.
  state.Linking.openURL = async () => { throw new Error("no browser"); };
  state.openPr("https://github.com/o/r/pull/1");
  await tick();
  assert.equal(alerts.at(-1)!.title, "无法打开链接");
});

it("closes the Ship sheet when its preview can't be read", async () => {
  const { state } = screen({ getShipPreview: async () => { throw new Error("会话已归档，只能查看"); } });
  await state.openShip();
  assert.equal(state.topSheet, null);
  assert.match(String(state.error), /会话已归档，只能查看/);
});

it("keeps an answered question gone and a newer one shown, in whatever order summaries arrive", async () => {
  const asked = { id: "s1", updatedAt: 1, status: "needs_you", question: { text: "Tabs?", choices: ["tabs"] } };

  // The agent asked the next question before the answer's response arrived: that question stays.
  let ack!: () => void;
  const late = screen({ sendMessage: () => new Promise<void>((resolve) => { ack = resolve; }) }, asked);
  const answering = late.state.handleAnswer("tabs");
  await tick();
  late.state.applySummary({ id: "s1", updatedAt: 2, status: "needs_you", question: { text: "Deploy now?" } });
  ack();
  await answering;
  assert.equal(late.updates.at(-1).question?.text, "Deploy now?");

  // A snapshot from before the answer arrives after it: its question isn't brought back.
  const { state, updates } = screen({}, asked);
  await state.handleAnswer("tabs");
  assert.equal(updates.at(-1).question, undefined);
  assert.deepEqual(plain(state.applySummary({ ...asked })), { id: "s1", updatedAt: 1, status: "running" });
  assert.equal(updates.at(-1).question, undefined);

  // Two summaries before a rerender: the older second one is dropped.
  state.applySummary({ id: "s1", updatedAt: 3, name: "New" });
  assert.equal(state.applySummary({ id: "s1", updatedAt: 2, name: "Old" }), undefined);
  assert.equal(updates.at(-1).name, "New");
});

it("reads the summary again when a read fails, and says so when it keeps failing", async () => {
  let fail = 1;
  const { state, updates } = screen({
    getSession: async () => {
      if (fail-- > 0) throw new Error("503");
      return { id: "s1", updatedAt: 2, status: "needs_you", question: { text: "Port?" } };
    },
  });
  state.refreshSummary();
  await tick();
  assert.equal(state.timers.length, 1, "a retry is scheduled");
  state.timers.shift()!();
  await tick();
  assert.equal(updates.at(-1).question.text, "Port?");

  fail = 99;
  state.refreshSummary();
  for (let i = 0; i < 4; i++) {
    await tick();
    state.timers.shift()!();
  }
  await tick();
  assert.match(String(state.error), /读不到会话的最新状态/);
});

it("ignores the preview of a Ship sheet that was closed", async () => {
  const pending = deferred<ShipPreview>();
  const { state } = screen({ getShipPreview: () => pending.promise });
  const opening = state.openShip();
  await state.openShip(); // closes it
  state.topSheet = "rename";
  pending.reject(new Error("timeout"));
  await opening;
  assert.deepEqual([state.topSheet, state.error], ["rename", null]);
});
