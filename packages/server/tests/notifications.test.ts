import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { MyPiClient, type RawAgentEvent } from "@mypi/shared";
import { NotificationService } from "../src/notification-service.js";
import { startMyPiServer } from "../src/main.js";

const start = (id: number): RawAgentEvent => ({ type: "run_start", inputs: [id] });
const end = (id: number): RawAgentEvent => ({ type: "run_end", inputs: [id] });
const submitted = (id: number, reason?: string): RawAgentEvent => ({
  type: "submission", record: { id, type: "input", status: reason ? "unanswered" : "done", reason },
});
const registration = { deviceId: "device-test-123", serverId: "server-local", pushToken: "ExpoPushToken[example]", enabled: true };
const snapshot: RawAgentEvent = { type: "snapshot", entries: [], tools: [], compactions: [], inbox: [], agent: {} };

it("coalesces queued runs, suppresses visible/stopped runs, ignores recoverable errors and deduplicates after restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-notice-"));
  const pushes: any[] = [];
  const gateway: typeof fetch = async (_url, options) => {
    pushes.push(JSON.parse(String(options?.body)));
    return Response.json({ data: { status: "ok", id: `ticket-${pushes.length}` } });
  };
  let service = new NotificationService(dir, () => "Test session", gateway, 5);
  try {
    assert.throws(() => service.register({ ...registration, pushToken: "https://attacker.invalid" }));
    service.register(registration);
    service.events("s", [start(1), { type: "tool_execution_end", toolCallId: "tool", toolName: "bash", result: { isError: true } }, end(1), { type: "inbox_update", items: [{ id: 2, mode: "followUp" }] }]);
    await sleep(20);
    assert.equal(pushes.length, 0);
    service.events("s", [start(2), { type: "inbox_update", items: [] }, end(2), submitted(2)]);
    await sleep(20);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].body, "运行已结束，点此查看");
    assert.equal(pushes[0].title, "Test session");
    assert.deepEqual(pushes[0].data, { serverId: "server-local", sessionId: "s", eventId: "s:2" });
    service.presence(registration.deviceId, "s");
    service.events("s", [start(3), end(3)]);
    await sleep(20);
    assert.equal(pushes.length, 1);
    service.presence(registration.deviceId, null);
    service.events("s", [start(4)]);
    service.stopSession("s");
    service.events("s", [end(4)]);
    await sleep(20);
    assert.equal(pushes.length, 1);
    service.events("s", [start(5), { type: "task_failed", taskId: 9, kind: "pi.tool", message: "recoverable" }, end(5), submitted(5)]);
    await sleep(20);
    assert.equal(pushes.length, 2);
    assert.equal(pushes[1].body, "运行已结束，点此查看");
    service.events("s", [start(6), end(6), submitted(6, "no_model")]);
    await sleep(20);
    assert.equal(pushes.length, 3);
    assert.match(pushes[2].body, /未配置可用模型/);
    await service.close();
    service = new NotificationService(dir, () => "Test session", gateway, 5);
    service.events("s", [start(6), end(6)]);
    await sleep(20);
    assert.equal(pushes.length, 3);
    service.events("s", [start(7), end(7), submitted(7, "aborted")]);
    await sleep(20);
    assert.equal(pushes.length, 3);
    service.events("s", [start(20), end(20)]);
    await sleep(20);
    service.events("s", [start(10), end(10)]);
    await sleep(20);
    assert.equal(pushes.length, 5, "Deduplicate by identity, not submission ordering");
  } finally { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("recovers a pending or recently settled run after daemon restart without replaying historical idle sessions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-notice-restart-"));
  const pushes: any[] = [];
  const gateway: typeof fetch = async (_url, options) => {
    pushes.push(JSON.parse(String(options?.body)));
    return Response.json({ data: { status: "ok", id: "receipt" } });
  };
  let service = new NotificationService(dir, () => "Recovered", gateway, 1000);
  try {
    service.register(registration);
    service.events("old", [snapshot]);
    service.events("s", [start(8)]);
    await service.close();
    service = new NotificationService(dir, () => "Recovered", gateway, 5);
    service.events("s", [snapshot, submitted(8, "model_error")]);
    service.events("old", [snapshot]);
    await sleep(20);
    assert.equal(pushes.length, 1);
    assert.match(pushes[0].body, /模型请求失败/);
  } finally { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("daemon observes terminal errors with no mobile SSE connection and resumes observers on startup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-notice-daemon-"));
  let running = await startMyPiServer({ port: 0, host: "127.0.0.1", dataDir: dir, startDirs: [dir], silent: true });
  const pushes: any[] = [];
  try {
    const service = running.manager.notifications as unknown as { send: typeof fetch; settleDelay: number };
    service.settleDelay = 5;
    service.send = async (_url, options) => {
      pushes.push(JSON.parse(String(options?.body)));
      return Response.json({ data: { status: "ok", id: "receipt" } });
    };
    const client = new MyPiClient({ baseUrl: `http://127.0.0.1:${running.port}`, token: running.token });
    await client.registerNotifications(registration);
    const session = await client.createSession({ cwd: dir, name: "Offline test", model: { provider: "missing", modelId: "unavailable" } });
    await client.sendMessage(session.id, { requestId: "test", content: "Do not call any real provider" });
    for (let i = 0; i < 100 && !pushes.length; i++) await sleep(50);
    assert.equal(pushes.length, 1);
    assert.match(pushes[0].body, /未配置可用模型/);
    assert.equal(pushes[0].data.sessionId, session.id);
    await running.close();
    running = await startMyPiServer({ port: 0, host: "127.0.0.1", dataDir: dir, startDirs: [dir], silent: true });
    const active = (running.manager as unknown as { activeSessions: Map<string, unknown> }).activeSessions;
    assert.ok(active.has(session.id), "Observer starts without any App request");
  } finally { await running.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
