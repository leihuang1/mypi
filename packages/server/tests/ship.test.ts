import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, it } from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { MyPiClient } from "@mypi/shared";
import type { LoadedModelsConfig } from "../src/auth-loader.js";
import { HarnessManager } from "../src/harness-mgr.js";
import { startMyPiServer } from "../src/main.js";
import { githubRepo } from "../src/ship.js";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mypi-ship-")));
const remote = path.join(root, "remote.git");
const ghLog = path.join(root, "gh.log");
const saved = { ...process.env };

before(() => {
  // origin is "https://github.com/owner/repo.git", which this config rewrites to a local bare repo.
  fs.writeFileSync(path.join(root, "gitconfig"), `[url "${remote}"]\n\tinsteadOf = https://github.com/owner/repo.git\n`);
  // A fake gh: logs its arguments, opens PR 7, and finds an existing PR only when one was "opened by hand".
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "bin", "gh"), [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> "${ghLog}"`,
    `if [ "$1 $2" = "pr create" ]; then`,
    `  if [ -f "${root}/pr-exists" ]; then echo 'a pull request for branch already exists' >&2; exit 1; fi`,
    "  echo 'Creating draft pull request'; echo 'https://github.com/owner/repo/pull/7'; exit 0",
    "fi",
    `if [ "$1 $2" = "pr view" ] && [ -f "${root}/pr-exists" ]; then echo '{"url":"https://github.com/owner/repo/pull/3","number":3,"state":"OPEN"}'; exit 0; fi`,
    "exit 1",
    "",
  ].join("\n"), { mode: 0o755 });
  Object.assign(process.env, {
    PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    // Local paths only: a URL that escaped the rewrite fails here instead of reaching github.com.
    GIT_ALLOW_PROTOCOL: "file",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  });
});

after(() => {
  process.env = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const commit = (cwd: string, file: string, content: string, message = `edit ${file}`) => {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", message);
};
const ghCalls = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, "utf8").trim().split("\n") : []);

function manager(dataDir: string): HarnessManager {
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
  return new HarnessManager({ dataDir, startDirs: [], modelsConfig });
}

it("reads owner/name from github.com remotes only", () => {
  for (const url of ["https://github.com/owner/repo.git", "https://x@github.com/owner/repo", "git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo.git/"]) {
    assert.equal(githubRepo(url), "owner/repo", url);
  }
  for (const url of ["https://gitlab.com/owner/repo.git", "/tmp/repo.git", "https://github.com/owner", "https://github.com.evil/owner/repo"]) {
    assert.equal(githubRepo(url), undefined, url);
  }
});

it("ships the session branch as a draft PR, updates it, and never force-pushes or leaves mypi/", async () => {
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const repo = path.join(root, "repo");
  git(root, "clone", "-q", "https://github.com/owner/repo.git", repo);
  commit(repo, "README.md", "hello\n", "init");
  git(repo, "push", "-q", "origin", "main");
  const mainBefore = git(remote, "rev-parse", "main");

  const mgr = manager(path.join(root, "data"));
  try {
    const session = await mgr.createSession({ cwd: repo, name: "greeting" });
    const wt = session.worktreePath!;
    const branch = session.branch!;
    assert.deepEqual(await mgr.shipPreview(session.id), {
      ready: false, reason: "还没有可以发布的改动", branch, baseRef: "origin/main",
      uncommitted: 0, unpushed: 0, suggestedMessage: "greeting", pr: undefined,
    });

    // The agent committed one file and left another uncommitted.
    commit(wt, "a.txt", "a\n", "agent: add a");
    fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
    const preview = await mgr.shipPreview(session.id);
    assert.equal(preview.ready, true);
    assert.deepEqual([preview.uncommitted, preview.unpushed], [1, 1]);

    const shipped = await mgr.shipSession(session.id, { message: "Add greeting files\n\nDetails." });
    assert.deepEqual(shipped.pr, { url: "https://github.com/owner/repo/pull/7", number: 7, state: "open" });
    assert.deepEqual([shipped.committed, shipped.pushed], [true, true]);
    assert.equal(git(wt, "log", "-1", "--format=%B"), "Add greeting files\n\nDetails.");
    assert.equal(git(remote, "rev-parse", `refs/heads/${branch}`), git(wt, "rev-parse", "HEAD"), "pushed to the same name");
    assert.equal(git(remote, "rev-parse", "main"), mainBefore, "main untouched");
    assert.equal(git(wt, "rev-parse", "--abbrev-ref", "@{upstream}"), `origin/${branch}`);
    const create = ghCalls().filter((call) => call.startsWith("pr create"));
    assert.equal(create.length, 1);
    assert.match(create[0], new RegExp(`^pr create --draft --repo owner/repo --base main --head ${branch} --title Add greeting files --body `));
    assert.deepEqual([shipped.session.status, shipped.session.prUrl, shipped.session.prState], ["shipped", shipped.pr.url, "open"]);
    assert.equal((await mgr.shipPreview(session.id)).reason, "已发布，之后没有新的改动");

    // More work: Ship pushes it to the same PR without opening another.
    commit(wt, "c.txt", "c\n");
    const again = await mgr.shipSession(session.id, {});
    assert.deepEqual([again.pr.number, again.committed, again.pushed], [7, false, true]);
    assert.equal(ghCalls().filter((call) => call.startsWith("pr create")).length, 1);
    assert.equal(git(remote, "rev-parse", `refs/heads/${branch}`), git(wt, "rev-parse", "HEAD"));

    // Someone pushed to the PR branch on GitHub: Ship refuses instead of force-pushing.
    const other = path.join(root, "other");
    git(root, "clone", "-q", "-b", branch, "https://github.com/owner/repo.git", other);
    commit(other, "d.txt", "from the laptop\n");
    git(other, "push", "-q", "origin", branch);
    const theirs = git(remote, "rev-parse", `refs/heads/${branch}`);
    commit(wt, "e.txt", "e\n");
    await assert.rejects(mgr.shipSession(session.id, {}), (err: Error & { status?: number }) => err.status === 409 && /不会强推/.test(err.message));
    assert.equal(git(remote, "rev-parse", `refs/heads/${branch}`), theirs);

    // The agent switched branches: Ship won't push whatever is checked out.
    git(wt, "checkout", "-q", "-b", "side");
    assert.match((await mgr.shipPreview(session.id)).reason!, /当前在 side 上/);
    await assert.rejects(mgr.shipSession(session.id, {}), /当前在 side 上/);
    assert.equal(git(remote, "branch", "--list", "side"), "");
  } finally {
    await mgr.close();
  }
});

it("adopts a PR that already exists for the branch", async () => {
  const repo = path.join(root, "repo2");
  git(root, "clone", "-q", "https://github.com/owner/repo.git", repo);
  const mgr = manager(path.join(root, "data2"));
  fs.writeFileSync(path.join(root, "pr-exists"), "");
  try {
    const session = await mgr.createSession({ cwd: repo });
    commit(session.worktreePath!, "f.txt", "f\n");
    const shipped = await mgr.shipSession(session.id, { message: "f" });
    assert.deepEqual(shipped.pr, { url: "https://github.com/owner/repo/pull/3", number: 3, state: "open" });
  } finally {
    fs.rmSync(path.join(root, "pr-exists"));
    await mgr.close();
  }
});

it("explains why a session can't ship, over HTTP as a 409", async () => {
  const plain = path.join(root, "plain");
  const local = path.join(root, "local");
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(plain);
  git(root, "init", "-q", "-b", "main", local);
  commit(local, "a.txt", "a\n");
  git(root, "clone", "-q", remote, elsewhere); // origin is a plain path, not github.com
  const running = await startMyPiServer({ port: 0, host: "127.0.0.1", dataDir: path.join(root, "data3"), startDirs: [root], silent: true });
  try {
    const client = new MyPiClient({ baseUrl: `http://127.0.0.1:${running.port}`, token: running.token });
    const reasons = [];
    for (const cwd of [plain, local, elsewhere]) {
      const session = await client.createSession({ cwd });
      const preview = await client.getShipPreview(session.id);
      assert.equal(preview.ready, false);
      reasons.push(preview.reason);
      const res = await fetch(`http://127.0.0.1:${running.port}/v1/sessions/${session.id}/ship`, {
        method: "POST", headers: { Authorization: `Bearer ${running.token}` }, body: "{}",
      });
      assert.equal(res.status, 409);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "conflict");
    }
    assert.deepEqual(reasons, ["这个会话直接在原目录里工作，没有自己的分支可以发布", "这个仓库没有 origin 远程，无法推送", "origin 不是 github.com 上的仓库，无法创建 PR"]);
  } finally {
    await running.close();
  }
});
