import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { createModels, type FauxResponseFactory, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { NotificationFrame, RawEntryRecord, RunNotification } from "@mypi/shared";
import type { LoadedModelsConfig } from "../src/auth-loader.js";
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
    assert.deepEqual(asked.question, { text: "Which greeting?", choices: ["hello", "hi"] });
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
  } finally {
    await manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("reads the conversation's state from its last model messages", () => {
  const entry = (...model: Record<string, unknown>[]): RawEntryRecord => ({ id: 1, conversationId: 0, kind: "x", model });
  const user = { role: "user", content: "go" };
  const asking = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "ask_user", arguments: { question: " Q? ", choices: ["a", 3, " "] } }] };
  const result = { role: "toolResult", toolName: "ask_user", content: [] };
  assert.deepEqual(conversationState([]), { failed: false, finished: false });
  assert.deepEqual(conversationState([entry(user), entry(asking), entry(result)]), { question: { text: "Q?", choices: ["a"] }, failed: false, finished: true });
  assert.deepEqual(conversationState([entry(user), entry(asking), entry(result), entry(user)]), { failed: false, finished: false }, "answered");
  assert.deepEqual(conversationState([entry(user), entry({ role: "assistant", stopReason: "error", content: [] })]), { failed: true, finished: false });
  assert.deepEqual(conversationState([entry(user), entry({ role: "assistant", stopReason: "aborted", content: [] })]), { failed: false, finished: false });
  assert.deepEqual(conversationState([entry(user), entry(asking), entry({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] })]),
    { question: { text: "Q?", choices: ["a"] }, failed: false, finished: true }, "asked, went on: still unanswered");
  const twice = { role: "assistant", stopReason: "toolUse", content: [
    { type: "toolCall", name: "ask_user", arguments: { question: "A?" } }, { type: "toolCall", name: "ask_user", arguments: { question: "B?" } }] };
  assert.deepEqual(conversationState([entry(user), entry(twice)]).question, { text: "A?\n\nB?" }, "both questions");
});
