import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { MyPiClient, type NotificationFrame, type RawAgentEvent } from "@mypi/shared";
import { NotificationService } from "../src/notification-service.js";
import { startMyPiServer } from "../src/main.js";

const start = (id: number): RawAgentEvent => ({ type: "run_start", inputs: [id] });
const end = (id: number): RawAgentEvent => ({ type: "run_end", inputs: [id] });
const submitted = (id: number, reason?: string): RawAgentEvent => ({
  type: "submission", record: { id, type: "input", status: reason ? "unanswered" : "done", reason },
});
const snapshot: RawAgentEvent = { type: "snapshot", entries: [], tools: [], compactions: [], inbox: [], agent: {} };
const assistant = (stopReason: string): RawAgentEvent => ({
  type: "message_end", entry: { id: 1, conversationId: 0, kind: "assistant", model: [{ role: "assistant", stopReason }] },
});

for (const recovery of ["retry", "compaction"]) {
  it(`notifies normally after a model error recovers through ${recovery}`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-notice-recovery-"));
    const service = new NotificationService(dir, () => "session", 5);
    const frames: NotificationFrame[] = [];
    try {
      service.subscribe(undefined, (frame) => { if (frame.type === "notice") frames.push(frame); });
      const recoveryEvents: RawAgentEvent[] = recovery === "retry" ? [
        { type: "auto_retry_start", attempt: 1, at: Date.now(), errorMessage: "temporary" }, assistant("error"),
        { type: "auto_retry_end", attempt: 1 },
      ] : [
        assistant("error"), { type: "compaction_start", taskId: 8, reason: "overflow", blocking: true },
        { type: "compaction_end", taskId: 8, reason: "overflow" },
      ];
      service.events("s", [start(1), ...recoveryEvents, assistant("stop"), end(1), submitted(1)]);
      await sleep(20);
      assert.equal(frames.length, 1);
      assert.ok(frames[0].type === "notice");
      assert.equal(frames[0].body, "运行已结束，点此查看");
      service.events("s", [start(2), ...recoveryEvents, assistant("error"), end(2), submitted(2, "model_error")]);
      await sleep(20);
      assert.equal(frames.length, 2);
      assert.ok(frames[1].type === "notice");
      assert.match(frames[1].body, /模型请求失败/);
    } finally { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

it("notifies terminal failure despite a waiting follow-up, but still suppresses deliberate stops and duplicates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-notice-queue-failure-"));
  const service = new NotificationService(dir, () => "session", 5);
  const frames: NotificationFrame[] = [];
  const queued: RawAgentEvent = { type: "inbox_update", items: [{ id: 2, mode: "followUp" }] };
  try {
    service.subscribe(undefined, (frame) => { if (frame.type === "notice") frames.push(frame); });
    for (const reason of ["model_error", "no_model"]) {
      service.events(reason, [start(1), queued, assistant("error"), end(1), submitted(1, reason)]);
    }
    service.events("stopped", [start(1), queued, assistant("error"), end(1), submitted(1, "aborted")]);
    await sleep(20);
    assert.equal(frames.length, 2);
    assert.ok(frames.every((frame) => frame.type === "notice" && frame.body.startsWith("执行异常")));
    service.events("model_error", [end(1), submitted(1, "model_error"), queued]);
    await sleep(20);
    assert.equal(frames.length, 2);
  } finally { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("does not erase an earlier terminal failure when a merged successor succeeds", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-notice-merged-failure-"));
  let service = new NotificationService(dir, () => "session", 5);
  try {
    service.events("s", [start(1), end(1), submitted(1, "task_error"), start(2), assistant("error")]);
    await service.close();
    service = new NotificationService(dir, () => "session", 5);
    const frames: NotificationFrame[] = [];
    service.subscribe(undefined, (frame) => { if (frame.type === "notice") frames.push(frame); });
    service.events("s", [assistant("stop"), end(2), submitted(2)]);
    await sleep(20);
    assert.equal(frames.length, 1);
    assert.ok(frames[0].type === "notice");
    assert.match(frames[0].body, /执行任务中断/);
  } finally { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("coalesces queues, suppresses stopped runs, ignores recoverable errors and deduplicates across restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-notice-"));
  const frames: NotificationFrame[] = [];
  let service = new NotificationService(dir, () => "Test session", 5);
  try {
    service.subscribe(undefined, (frame) => frames.push(frame));
    const baseline = frames.shift()!;
    assert.equal(baseline.type, "ready");
    service.events("s", [start(1), { type: "tool_execution_end", toolCallId: "tool", toolName: "bash", result: { isError: true } }, end(1), { type: "inbox_update", items: [{ id: 2, mode: "followUp" }] }]);
    await sleep(20);
    assert.equal(frames.length, 0);
    service.events("s", [start(2), { type: "inbox_update", items: [] }, end(2), submitted(2)]);
    await sleep(20);
    assert.equal(frames.length, 1);
    const first = frames[0];
    assert.ok(first.type === "notice");
    assert.equal(first.body, "运行已结束，点此查看");
    assert.equal(first.title, "Test session");
    assert.equal(first.sessionId, "s");
    service.events("s", [start(4)]);
    service.stopSession("s");
    service.events("s", [end(4)]);
    await sleep(20);
    assert.equal(frames.length, 1);
    service.events("s", [start(5), { type: "task_failed", taskId: 9, kind: "pi.tool", message: "recoverable" }, end(5), submitted(5)]);
    await sleep(20);
    assert.equal(frames.length, 2);
    service.events("s", [start(6), end(6), submitted(6, "no_model")]);
    await sleep(20);
    assert.equal(frames.length, 3);
    assert.ok(frames[2].type === "notice");
    assert.match(frames[2].body, /未配置可用模型/);
    const cursor = frames[2].cursor;
    await service.close();
    service = new NotificationService(dir, () => "Test session", 5);
    frames.length = 0;
    service.subscribe(cursor, (frame) => frames.push(frame));
    assert.equal(frames.length, 1);
    assert.equal(frames.pop()!.type, "ready");
    service.events("s", [start(6), end(6)]);
    service.events("aborted", [start(7), end(7), submitted(7, "aborted")]);
    await sleep(20);
    assert.equal(frames.length, 0);
    service.events("s", [start(20), end(20)]);
    await sleep(20);
    service.events("s", [start(10), end(10)]);
    await sleep(20);
    assert.equal(frames.length, 2, "Identity, not submission ordering, determines duplicates");
  } finally { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("replays missed events from a persisted cursor, but never history on first enable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-notice-replay-"));
  let service = new NotificationService(dir, () => "Recovered", 5);
  try {
    const initial: NotificationFrame[] = [];
    const unsubscribe = service.subscribe(undefined, (frame) => initial.push(frame));
    unsubscribe();
    const cursor = initial[0];
    assert.ok(cursor.type === "ready");
    service.events("s", [start(8)]);
    await service.close();
    service = new NotificationService(dir, () => "Recovered", 5);
    service.events("s", [snapshot, submitted(8, "model_error")]);
    service.events("old", [snapshot]);
    await sleep(20);
    const replay: NotificationFrame[] = [];
    service.subscribe(cursor.cursor, (frame) => replay.push(frame))();
    assert.equal(replay.length, 2);
    assert.ok(replay[0].type === "notice");
    assert.match(replay[0].body, /模型请求失败/);
    const fresh: NotificationFrame[] = [];
    service.subscribe(undefined, (frame) => fresh.push(frame))();
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].type, "ready");
    const replacement: NotificationFrame[] = [];
    service.subscribe("old-daemon:1", (frame) => replacement.push(frame))();
    assert.equal(replacement.length, 1);
    assert.ok(replacement[0].type === "ready" && replacement[0].gap);
    const future: NotificationFrame[] = [];
    service.subscribe(`${cursor.cursor.split(":")[0]}:999`, (frame) => future.push(frame))();
    assert.equal(future.length, 1);
    assert.ok(future[0].type === "ready" && future[0].gap);
  } finally { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("bounds replay history and marks a cursor gap", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-notice-gap-"));
  const service = new NotificationService(dir, () => "session", 0);
  try {
    const baseline: NotificationFrame[] = [];
    service.subscribe(undefined, (frame) => baseline.push(frame))();
    assert.ok(baseline[0].type === "ready");
    for (let i = 0; i < 260; i++) service.events(`s-${i}`, [start(i + 1), end(i + 1)]);
    await sleep(100);
    const replay: NotificationFrame[] = [];
    service.subscribe(baseline[0].cursor, (frame) => replay.push(frame))();
    assert.equal(replay.filter((frame) => frame.type === "notice").length, 256);
    assert.ok(replay[0].type === "ready" && replay[0].gap);
  } finally { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("serves authenticated notification SSE, persists errors without an App and closes active streams", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-notice-daemon-"));
  let running = await startMyPiServer({ port: 0, host: "127.0.0.1", dataDir: dir, startDirs: [dir], silent: true });
  const controller = new AbortController();
  try {
    const url = `http://127.0.0.1:${running.port}`;
    const client = new MyPiClient({ baseUrl: url, token: running.token });
    const service = running.manager.notifications as unknown as { settleDelay: number };
    service.settleDelay = 5;
    assert.equal((await fetch(`${url}/v1/notifications/events`)).status, 401);
    const headers = { Authorization: `Bearer ${running.token}` };
    assert.equal((await fetch(`${url}/v1/notifications/events?cursor=bad`, { headers })).status, 400);
    assert.equal((await fetch(`${url}/v1/notifications/devices`, { method: "POST", headers })).status, 404);
    const baseline: NotificationFrame[] = [];
    running.manager.notifications.subscribe(undefined, (frame) => baseline.push(frame))();
    assert.ok(baseline[0].type === "ready");
    const session = await client.createSession({ cwd: dir, name: "Offline test", model: { provider: "missing", modelId: "unavailable" } });
    await client.sendMessage(session.id, { requestId: "test", content: "Do not call any real provider" });
    let replay: NotificationFrame[] = [];
    for (let i = 0; i < 100; i++) {
      replay = [];
      running.manager.notifications.subscribe(baseline[0].cursor, (frame) => replay.push(frame))();
      if (replay.some((frame) => frame.type === "notice")) break;
      await sleep(25);
    }
    assert.ok(replay[0].type === "notice");
    assert.match(replay[0].body, /未配置可用模型/);
    await running.close();
    running = await startMyPiServer({ port: 0, host: "127.0.0.1", dataDir: dir, startDirs: [dir], silent: true });
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/notifications/events?cursor=${encodeURIComponent(baseline[0].cursor)}`, { headers, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, /text\/event-stream/);
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /未配置可用模型/);
    assert.match(first, new RegExp(session.id));
    await running.close();
    await reader.cancel();
  } finally { controller.abort(); await running.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
