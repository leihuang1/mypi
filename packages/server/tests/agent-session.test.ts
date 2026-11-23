import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { createModels, type FauxResponseFactory, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { LoadedModelsConfig } from "../src/auth-loader.js";
import { HarnessManager } from "../src/harness-mgr.js";

async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it("runs a session with Pi's context, skills and ponytail, a credential-free shell and the push guard", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mypi-agent-")));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write(path.join(home, ".agents/skills/diagnose/SKILL.md"), "---\nname: diagnose\ndescription: Debug loop.\n---\n");
  const ponytail = path.join(home, ".pi/agent/git/github.com/DietrichGebert/ponytail");
  write(path.join(ponytail, "hooks/ponytail-config.js"), "module.exports = { getDefaultMode: () => 'full' };");
  write(path.join(ponytail, "hooks/ponytail-instructions.js"), "module.exports = { getPonytailInstructions: (m) => 'PONYTAIL RULES ' + m };");
  write(path.join(repo, "AGENTS.md"), "Always run the tests before you finish.");
  fs.mkdirSync(path.join(repo, ".git")); // the repo root marker; the blocked push never runs git

  const saved = { ...process.env };
  Object.assign(process.env, { HOME: home, GH_TOKEN: "ghp_daemon_token" });
  delete process.env.PI_CODING_AGENT_DIR;

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
  const manager = new HarnessManager({ dataDir: path.join(root, "data"), startDirs: [repo], modelsConfig });

  // Each request records what the model saw: the system entries, and the last message (a tool result).
  const seen: { system: string; last: string }[] = [];
  const reply = (next: ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory => (context) => {
    seen.push({
      system: JSON.stringify(context.messages.filter((m) => (m.role as string) === "system")),
      last: JSON.stringify(context.messages.at(-1)),
    });
    return next;
  };
  const bash = (command: string) => fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
  const idle = async (id: string) => faux.getPendingResponseCount() === 0 && !(await manager.getSessionSummary(id)).busy;

  try {
    const session = await manager.createSession({ cwd: repo });
    assert.equal(session.ponytail, true);

    faux.setResponses([
      reply(bash("git add -A && git commit -qm wip && git push origin HEAD")),
      reply(bash('echo "token=${GH_TOKEN-} count=$GIT_CONFIG_COUNT gh=$GH_CONFIG_DIR"')),
      reply(fauxAssistantMessage("done")),
    ]);
    await manager.sendMessage(session.id, { requestId: "r1", content: "Commit and push." });
    await waitFor(() => idle(session.id), "the first run");

    const [first, afterPush, afterEnv] = seen;
    assert.ok(first.system.includes("Always run the tests before you finish."), "AGENTS.md is in the prompt");
    assert.ok(first.system.includes(path.join(repo, "AGENTS.md")));
    assert.ok(first.system.includes("<name>diagnose</name>"), "skills are listed");
    assert.ok(first.system.includes("PONYTAIL RULES full"), "ponytail is on by default");
    assert.ok(afterPush.last.includes("`git push` is blocked"), "the guard blocked the push");
    assert.match(afterEnv.last, /token= count=2 gh=\S+agent-gh/);

    // Turning ponytail off takes effect at the next request.
    const off = await manager.updateSession(session.id, { ponytail: false });
    assert.equal(off.ponytail, false);
    seen.length = 0;
    faux.setResponses([reply(fauxAssistantMessage("ok"))]);
    await manager.sendMessage(session.id, { requestId: "r2", content: "Again." });
    await waitFor(() => idle(session.id), "the second run");
    const systemEntries = JSON.parse(seen[0].system) as { sections?: Record<string, string | null> }[];
    assert.equal(systemEntries.at(-1)?.sections?.ponytail, null, "the ponytail section was withdrawn");

    // A stopping daemon kills the tool processes it started.
    const pids = path.join(root, "pids");
    faux.setResponses([reply(bash(`sleep 30 & echo "$$ $!" > ${pids}; wait`)), reply(fauxAssistantMessage("stopped"))]);
    await manager.sendMessage(session.id, { requestId: "r3", content: "Wait." });
    await waitFor(() => fs.existsSync(pids) && fs.readFileSync(pids, "utf8").trim().includes(" "), "the tool processes");
    const [shell, sleeper] = fs.readFileSync(pids, "utf8").trim().split(" ").map(Number);
    manager.killToolProcesses();
    await waitFor(() => !isAlive(shell) && !isAlive(sleeper), "the tool processes to die", 3000);
    await waitFor(() => idle(session.id), "the third run");
  } finally {
    await manager.close();
    process.env = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
