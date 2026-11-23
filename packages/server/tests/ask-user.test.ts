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
    HOME: path.join(root, "home"),
    GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  });
  git(root, "init", "-q", "--bare", "-b", "main", "remote.git");
  git(root, "clone", "-q", "remote.git", repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "push", "-q", "origin", "main");

  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const modelsConfig: LoadedModelsConfig = {
    models,
    availableModels: [],
    defaultModel: { provider: "faux", modelId: "faux-1" },
    defaultThinkingLevel: "off",
    openaiAuth: { configured: false, authType: "none" },
    getOpenAIRateLimits: () => undefined,
  };
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
      reply(fauxAssistantMessage([fauxToolCall("ask_user", { question: "Which greeting?", choices: ["hello", "hi"] })], { stopReason: "toolUse" })),
    ]);
    await manager.sendMessage(session.id, { requestId: "r1", content: "Add a greeting file." });
    await waitFor(() => idle(session.id), "the first run");
    assert.equal(requests.length, 1, "ask_user ends the run without another model request");
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
    assert.match(requests[1], /"hi"/, "the answer is the next user message");
    const done = await manager.getSessionSummary(session.id);
    assert.equal(done.status, "done");
    assert.equal(done.question, undefined);
    const finished = await waitFor(() => notices[1], "the done notice");
    assert.deepEqual([finished.title, finished.body, finished.kind], ["✅ greeting", "Added greeting.txt saying hi.\n+1 −0 · 1 个文件", "done"]);
  } finally {
    unsubscribe();
    await manager.close();
    process.env = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("reads the conversation's state from its last model messages", () => {
  const entry = (...model: Record<string, unknown>[]): RawEntryRecord => ({ id: 1, conversationId: 0, kind: "x", model });
  const user = { role: "user", content: "go" };
  const asking = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "ask_user", arguments: { question: " Q? ", choices: ["a", 3, " "] } }] };
  const result = { role: "toolResult", toolName: "ask_user", content: [] };
  assert.deepEqual(conversationState([]), { failed: false, started: false });
  assert.deepEqual(conversationState([entry(user), entry(asking), entry(result)]), { question: { text: "Q?", choices: ["a"] }, failed: false, started: true });
  assert.deepEqual(conversationState([entry(user), entry(asking), entry(result), entry(user)]), { failed: false, started: true }, "answered");
  assert.deepEqual(conversationState([entry(user), entry({ role: "assistant", stopReason: "error", content: [] })]), { failed: true, started: true });
  assert.deepEqual(conversationState([entry(user), entry(asking), entry({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] })]),
    { question: undefined, failed: false, started: true }, "asked, then went on");
});
