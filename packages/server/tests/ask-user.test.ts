import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { createModels, type FauxResponseFactory, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { NotificationFrame, RawEntryRecord, RunNotification } from "@mypi/shared";
import type { LoadedModelsConfig } from "../src/auth-loader.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { conversationState } from "../src/extensions/ask-user.js";
import { HarnessManager } from "../src/harness-mgr.js";

function testModels(): { faux: ReturnType<typeof fauxProvider>; modelsConfig: LoadedModelsConfig } {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    faux,
    modelsConfig: {
      models,
      availableModels: [],
      defaultModel: { provider: "faux", modelId: "faux-1" },
      defaultThinkingLevel: "off",
      openaiAuth: { configured: false, authType: "none" },
      getOpenAIRateLimits: () => undefined,
    },
  };
}

async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it("ends a run on ask_user, shows the question, and reports done with the changes after the answer", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mypi-ask-")));
  const repo = path.join(root, "repo");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  const saved = { ...process.env };
  fs.writeFileSync(path.join(root, "gitconfig"), "");
  Object.assign(process.env, {
    HOME: path.join(root, "home"), PI_CODING_AGENT_DIR: path.join(root, "pi-agent"),
    GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file", // fixtures are local; nothing may reach a real remote
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  });
  git(root, "init", "-q", "--bare", "-b", "main", "remote.git");
  git(root, "clone", "-q", "remote.git", repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "push", "-q", "origin", "main");

  const { faux, modelsConfig } = testModels();
  const manager = new HarnessManager({ dataDir: path.join(root, "data"), startDirs: [], modelsConfig });
  const requests: string[] = [];
  const reply = (next: ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory => (context) => {
    requests.push(JSON.stringify(context.messages.at(-1)));
    return next;
  };
  const idle = async (id: string) => faux.getPendingResponseCount() === 0 && !(await manager.getSessionSummary(id)).busy;
  const notices: RunNotification[] = [];
  const unsubscribe = manager.notifications.subscribe(undefined, (frame: NotificationFrame) => {
    if (frame.type === "notice") notices.push(frame);
  });

  try {
    const session = await manager.createSession({ cwd: repo, name: "greeting" });
    assert.equal(session.status, "idle");

    faux.setResponses([
      // An empty question is refused, so the model can ask again.
      reply(fauxAssistantMessage([fauxToolCall("ask_user", { question: "  " })], { stopReason: "toolUse" })),
      reply(fauxAssistantMessage([fauxToolCall("ask_user", { question: "Which greeting?", choices: ["hello", "hi"] })], { stopReason: "toolUse" })),
    ]);
    await manager.sendMessage(session.id, { requestId: "r1", content: "Add a greeting file." });
    await waitFor(() => idle(session.id), "the first run");
    assert.match(requests[1], /question is empty/);
    assert.equal(faux.state.callCount, 2, "ask_user ends the run without another model request");
    const asked = await manager.getSessionSummary(session.id);
    assert.equal(asked.status, "needs_you");
    const { id, ...shown } = asked.question!;
    assert.deepEqual([shown, typeof id], [{ text: "Which greeting?", choices: ["hello", "hi"] }, "number"]);
    assert.equal((await manager.getSessionSummary(session.id)).question?.id, id, "the same question keeps its id");
    const question = await waitFor(() => notices[0], "the question notice");
    assert.deepEqual([question.title, question.body, question.kind, question.choices],
      ["❓ greeting", "Which greeting?\nhello / hi", "question", ["hello", "hi"]]);

    faux.setResponses([
      reply(fauxAssistantMessage([fauxToolCall("bash", { command: "printf 'hi\\n' > greeting.txt" })], { stopReason: "toolUse" })),
      reply(fauxAssistantMessage("Added greeting.txt saying hi.\n\nNothing else changed.")),
    ]);
    await manager.sendMessage(session.id, { requestId: "r2", content: "hi" });
    await waitFor(() => idle(session.id), "the second run");
    assert.match(requests[2], /"hi"/, "the answer is the next user message");
    const done = await manager.getSessionSummary(session.id);
    assert.equal(done.status, "done");
    assert.equal(done.question, undefined);
    const finished = await waitFor(() => notices[1], "the done notice");
    assert.deepEqual([finished.title, finished.body, finished.kind], ["✅ greeting", "Added greeting.txt saying hi.\n+1 −0 · 1 个文件", "done"]);

    // Asked alongside another tool call: the round doesn't end the run, but the question stands until answered.
    faux.setResponses([
      reply(fauxAssistantMessage([fauxToolCall("ask_user", { question: "Commit too?" }), fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" })),
      reply(fauxAssistantMessage("Waiting for your answer.")),
    ]);
    await manager.sendMessage(session.id, { requestId: "r3", content: "Tidy up." });
    await waitFor(() => idle(session.id), "the third run");
    const mixed = await manager.getSessionSummary(session.id);
    assert.deepEqual([mixed.status, mixed.question?.text], ["needs_you", "Commit too?"]);
    assert.deepEqual([(await waitFor(() => notices[2], "the third notice")).kind], ["question"]);
  } finally {
    unsubscribe();
    await manager.close();
    process.env = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("needs the user after a failure that leaves no reply, and when queued messages are stuck behind one", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mypi-fail-")));
  const { faux, modelsConfig } = testModels();
  const manager = new HarnessManager({ dataDir: path.join(root, "data"), startDirs: [], modelsConfig });
  const status = async (id: string) => (await manager.getSessionSummary(id)).status;
  try {
    const missing = await manager.createSession({ cwd: root, name: "no model" });
    await manager.updateSession(missing.id, { model: { provider: "missing", modelId: "missing" } });
    await manager.sendMessage(missing.id, { requestId: "m1", content: "go" });
    await waitFor(async () => (await status(missing.id)) === "needs_you", "the missing model to be reported");

    const failing = await manager.createSession({ cwd: root, name: "failing" });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    faux.setResponses([async () => {
      entered();
      await gate;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request: unrecoverable" });
    }]);
    await manager.sendMessage(failing.id, { requestId: "f1", content: "go" });
    await started;
    await manager.sendMessage(failing.id, { requestId: "f2", content: "also test", whenBusy: "followUp" });
    assert.equal(await status(failing.id), "running");
    release();
    await waitFor(async () => (await status(failing.id)) === "needs_you", "the stuck follow-up to be reported");
    assert.equal((await manager.getSessionSummary(failing.id)).busy, false, "a queue nothing will drain is not work");
    // Sent again, as a Retry does: it was read before its run failed, and the reply says so.
    const again = await manager.sendMessage(failing.id, { requestId: "f1", content: "go" });
    assert.deepEqual([again.status, again.placed], ["unanswered", true]);
  } finally {
    await manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("takes its status from the runtime's records: not a retried old request, a withdrawn follow-up, or a lost save", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mypi-input-")));
  const { faux, modelsConfig } = testModels();
  const dataDir = path.join(root, "data");
  let manager = new HarnessManager({ dataDir, startDirs: [], modelsConfig });
  const status = async (id: string) => (await manager.getSessionSummary(id)).status;
  const settled = async (id: string) => faux.getPendingResponseCount() === 0 && !(await manager.getSessionSummary(id)).busy;
  try {
    const session = await manager.createSession({ cwd: root, name: "retries" });
    await manager.updateSession(session.id, { model: { provider: "missing", modelId: "missing" } });
    await manager.sendMessage(session.id, { requestId: "old", content: "go" });
    await waitFor(async () => (await status(session.id)) === "needs_you", "the missing model");
    await manager.updateSession(session.id, { model: { provider: "faux", modelId: "faux-1" } });
    faux.setResponses([fauxAssistantMessage("Did it.")]);
    await manager.sendMessage(session.id, { requestId: "new", content: "again" });
    await waitFor(async () => (await status(session.id)) === "done", "the newer run");

    // A client retrying the old request (its response was lost) gets the old submission back; the status stays.
    const calls = faux.state.callCount;
    await manager.sendMessage(session.id, { requestId: "old", content: "go" });
    assert.deepEqual([await status(session.id), faux.state.callCount], ["done", calls]);

    // A follow-up withdrawn before it ran isn't what the session is about.
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    faux.setResponses([async () => {
      entered();
      await gate;
      return fauxAssistantMessage("Did the third.");
    }]);
    await manager.sendMessage(session.id, { requestId: "third", content: "third" });
    await started;
    const queued = await manager.sendMessage(session.id, { requestId: "fourth", content: "fourth", whenBusy: "followUp" });
    assert.equal((await manager.abortSubmission(session.id, queued.submissionId)).status, "aborted");
    release();
    await waitFor(() => settled(session.id), "the third run");
    assert.equal(await status(session.id), "done");

    // A restart reads the same records, and so does a catalog that never had a pointer.
    await manager.close();
    manager = new HarnessManager({ dataDir, startDirs: [], modelsConfig });
    assert.equal(await status(session.id), "done");

    // After a reset, the old requests are history, retried or not.
    await manager.resetSession(session.id);
    await manager.sendMessage(session.id, { requestId: "new", content: "again" });
    assert.equal(await status(session.id), "idle");

    // A question isn't compacted away: its ask is the only record of it.
    faux.setResponses([fauxAssistantMessage([fauxToolCall("ask_user", { question: "Old or new API?" })], { stopReason: "toolUse" })]);
    await manager.sendMessage(session.id, { requestId: "ask", content: "which?" });
    await waitFor(async () => (await status(session.id)) === "needs_you", "the question");
    await assert.rejects(manager.compactSession(session.id), /回答后再压缩/);
  } finally {
    await manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("reads the input that ran last, in the order the runtime placed it, and never compacts a waiting question away", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mypi-order-")));
  const { faux, modelsConfig } = testModels();
  const manager = new HarnessManager({ dataDir: path.join(root, "data"), startDirs: [], modelsConfig });
  const status = async (id: string) => (await manager.getSessionSummary(id)).status;
  const settled = async (id: string) => faux.getPendingResponseCount() === 0 && !(await manager.getSessionSummary(id)).busy;
  const gate = () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const open = new Promise<void>((resolve) => { release = resolve; });
    return { started, release, wait: async () => { entered(); await open; } };
  };
  const missing = { model: { provider: "missing", modelId: "missing" } };
  try {
    // A steer is placed before an older follow-up: the follow-up ran last, and failed.
    const steered = await manager.createSession({ cwd: root, name: "steered" });
    const first = gate();
    faux.setResponses([
      async () => { await first.wait(); return fauxAssistantMessage([fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" }); },
      async () => { await manager.updateSession(steered.id, missing); return fauxAssistantMessage("Did the steer."); },
    ]);
    await manager.sendMessage(steered.id, { requestId: "a", content: "go" });
    await first.started;
    await manager.sendMessage(steered.id, { requestId: "b", content: "later", whenBusy: "followUp" });
    await manager.sendMessage(steered.id, { requestId: "c", content: "now", whenBusy: "steer" });
    first.release();
    await waitFor(() => settled(steered.id), "both runs");
    assert.equal(await status(steered.id), "needs_you", "the follow-up's failure, not the steer's success");

    // A reset requested while a follow-up waits is placed first: the follow-up ran in the new context, and failed.
    const reset = await manager.createSession({ cwd: root, name: "reset" });
    const second = gate();
    faux.setResponses([async () => { await second.wait(); return fauxAssistantMessage("First."); }]);
    await manager.sendMessage(reset.id, { requestId: "a", content: "go" });
    await second.started;
    await manager.sendMessage(reset.id, { requestId: "b", content: "after", whenBusy: "followUp" });
    await manager.resetSession(reset.id);
    await manager.updateSession(reset.id, missing);
    second.release();
    await waitFor(async () => !(await manager.getSessionSummary(reset.id)).busy && (await status(reset.id)) !== "running", "the reset");
    assert.equal(await status(reset.id), "needs_you");

    // Asked alongside another tool, then a reply long enough that a compaction would summarize the ask away.
    const asking = await manager.createSession({ cwd: root, name: "asking" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("ask_user", { question: "Old or new API?" }), fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" }),
      fauxAssistantMessage(`Waiting for your decision. ${"detail ".repeat(30_000)}`),
    ]);
    await manager.sendMessage(asking.id, { requestId: "a", content: "go" });
    await waitFor(() => settled(asking.id), "the run");
    assert.equal((await manager.getSessionSummary(asking.id)).question?.text, "Old or new API?");
    // Started on the harness, as an automatic compaction is, past the endpoint's own check: the hook declines it.
    faux.setResponses([fauxAssistantMessage("Summary of the work so far.")]);
    const sessions = (manager as unknown as { activeSessions: Map<string, Promise<{ harness: Harness; root: Conversation }>> }).activeSessions;
    const managed = await sessions.get(asking.id)!;
    await managed.harness.waitForTask(await managed.root.compact(undefined, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
    const after = await manager.getSessionSummary(asking.id);
    assert.deepEqual([after.status, after.question?.text, faux.getPendingResponseCount()], ["needs_you", "Old or new API?", 1]);
  } finally {
    await manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("reads the conversation's state from its last model messages", () => {
  let next = 1;
  const entry = (...model: Record<string, unknown>[]): RawEntryRecord => ({ id: next++, conversationId: 0, kind: "x", model });
  const user = { role: "user", content: "go" };
  const asking = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "ask_user", arguments: { question: " Q? ", choices: ["a", 3, " "] } }] };
  const result = { role: "toolResult", toolName: "ask_user", content: [] };
  assert.deepEqual(conversationState([]), { failed: false, finished: false });
  next = 1;
  assert.deepEqual(conversationState([entry(user), entry(asking), entry(result)]), { question: { text: "Q?", choices: ["a"], id: 2 }, failed: false, finished: true });
  assert.deepEqual(conversationState([entry(user), entry(asking), entry(result), entry(user)]), { failed: false, finished: false }, "answered");
  assert.deepEqual(conversationState([entry(user), entry({ role: "assistant", stopReason: "error", content: [] })]), { failed: true, finished: false });
  assert.deepEqual(conversationState([entry(user), entry({ role: "assistant", stopReason: "aborted", content: [] })]), { failed: false, finished: false });
  next = 1;
  assert.deepEqual(conversationState([entry(user), entry(asking), entry({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] })]),
    { question: { text: "Q?", choices: ["a"], id: 2 }, failed: false, finished: true }, "asked, went on: still unanswered, the asking entry's id");
  const twice = { role: "assistant", stopReason: "toolUse", content: [
    { type: "toolCall", name: "ask_user", arguments: { question: "A?" } }, { type: "toolCall", name: "ask_user", arguments: { question: "B?" } }] };
  next = 1;
  assert.deepEqual(conversationState([entry(user), entry(twice)]).question, { text: "A?\n\nB?", id: 2 }, "both questions");
});
