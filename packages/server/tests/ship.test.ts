import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, it } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { MyPiClient } from "@mypi/shared";
import type { LoadedModelsConfig } from "../src/auth-loader.js";
import { HarnessManager } from "../src/harness-mgr.js";
import { startMyPiServer } from "../src/main.js";
import { githubRepo } from "../src/ship.js";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mypi-ship-")));
// The "GitHub" repo: a bare repo that a fake ssh serves as git@github.com:owner/repo.git.
const remote = path.join(root, "github", "owner", "repo.git");
const ghLog = path.join(root, "gh.log");
const saved = { ...process.env };

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const commit = (cwd: string, file: string, content: string, message = `edit ${file}`) => {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", message);
};

before(() => {
  // origin is "https://github.com/owner/repo.git", which this config sends over SSH, as many owners do. The fake ssh
  // serves it from the local folder: the URL Ship checks is still github.com's.
  fs.writeFileSync(path.join(root, "gitconfig"), `[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n`);
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "bin", "fake-ssh"), [
    "#!/bin/sh",
    `[ "$1" = git@github.com ] || exit 1`,
    "for last; do :; done", // "git-upload-pack 'owner/repo.git'"
    `cd "${path.join(root, "github")}" && eval "exec git \${last#git-}"`,
    "",
  ].join("\n"), { mode: 0o755 });
  // A fake gh: logs its arguments, opens PR 7, and finds an existing PR only when one was "opened by hand".
  fs.writeFileSync(path.join(root, "bin", "gh"), [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> "${ghLog}"`,
    `if [ "$1 $2" = "pr create" ]; then`,
    `  if [ -f "${root}/pr-wait" ]; then while [ ! -f "${root}/release" ]; do sleep 0.05; done; fi`,
    `  if [ -f "${root}/pr-fail" ]; then echo 'HTTP 502' >&2; exit 1; fi`,
    `  if [ -f "${root}/pr-exists" ] || [ -f "${root}/pr-merged" ]; then echo 'a pull request for branch already exists' >&2; exit 1; fi`,
    "  echo 'Creating draft pull request'; echo 'https://github.com/owner/repo/pull/7'; exit 0",
    "fi",
    `if [ "$1 $2" = "pr view" ] && [ -f "${root}/pr-merged" ]; then echo '{"url":"https://github.com/owner/repo/pull/2","number":2,"state":"MERGED"}'; exit 0; fi`,
    `if [ "$1 $2" = "pr view" ] && [ -f "${root}/pr-exists" ]; then echo '{"url":"https://github.com/owner/repo/pull/3","number":3,"state":"OPEN"}'; exit 0; fi`,
    // The watcher's question, answered from a file the test writes.
    `if [ "$1 $2 $4" = "pr view --json" ] && [ "$5" = state,headRefOid ]; then`,
    `  if [ -f "${root}/view-wait" ]; then while [ ! -f "${root}/release" ]; do sleep 0.05; done; fi`,
    `  printf '{"state":"%s"%s}' "$(cat "${root}/pr-state" 2>/dev/null || echo OPEN)" "$([ -f "${root}/pr-head" ] && printf ',"headRefOid":"%s"' "$(cat "${root}/pr-head")")"; exit 0`,
    "fi",
    "exit 1",
    "",
  ].join("\n"), { mode: 0o755 });
  Object.assign(process.env, {
    PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    // Local paths, and SSH only through the fake: nothing can reach github.com.
    GIT_ALLOW_PROTOCOL: "file:ssh", GIT_SSH_COMMAND: path.join(root, "bin", "fake-ssh"), GIT_SSH_VARIANT: "simple",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  });
  // The "GitHub" repo, with a main branch, for every test.
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const seed = path.join(root, "seed");
  git(root, "clone", "-q", "https://github.com/owner/repo.git", seed);
  commit(seed, "README.md", "hello\n", "init");
  git(seed, "push", "-q", "origin", "HEAD:main"); // an empty repo's clone over SSH doesn't learn its branch name
});

after(() => {
  process.env = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

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
  const repo = path.join(root, "repo");
  git(root, "clone", "-q", "https://github.com/owner/repo.git", repo);
  const mainBefore = git(remote, "rev-parse", "main");

  let mgr = manager(path.join(root, "data"));
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

    // origin now points at a fork: the update would go there while the PR stays on owner/repo.
    git(repo, "remote", "set-url", "origin", "https://github.com/owner/fork.git");
    assert.match((await mgr.shipPreview(session.id)).reason!, /origin 现在指向 owner\/fork，打开的 PR 在 owner\/repo 上/);
    await assert.rejects(mgr.shipSession(session.id, {}), /打开的 PR 在 owner\/repo 上/);
    git(repo, "remote", "set-url", "origin", "https://github.com/OWNER/repo.git");
    assert.equal((await mgr.shipPreview(session.id)).reason, "已发布，之后没有新的改动", "GitHub names aren't case-sensitive");
    git(repo, "remote", "set-url", "origin", "https://github.com/owner/repo.git");

    // A catalog from before Ship recorded the input it shipped can't tell whether later input went out: done, not shipped.
    await mgr.close();
    const catalogPath = path.join(root, "data", "catalog.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    delete catalog.sessions.find((s: { id: string }) => s.id === session.id).pr.input;
    fs.writeFileSync(catalogPath, JSON.stringify(catalog));
    mgr = manager(path.join(root, "data"));
    assert.equal((await mgr.getSessionSummary(session.id)).status, "done");

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
    for (const [route, body] of [["ship", "null"], ["ship", '{"message":42}'], ["archive", '{"force":"false"}'], ["archive", "null"],
      ["ship", "[]"], ["archive", "[]"], ["ship", '{"message":'], ["messages", "{not json"]]) {
      const session = (await client.listSessions())[0];
      const res = await fetch(`http://127.0.0.1:${running.port}/v1/sessions/${session.id}/${route}`, {
        method: "POST", headers: { Authorization: `Bearer ${running.token}` }, body,
      });
      assert.equal(res.status, 400, `${route} ${body}`);
    }
    assert.deepEqual(reasons, ["这个会话直接在原目录里工作，没有自己的分支可以发布", "这个仓库没有 origin 远程，无法推送", "origin 不是 github.com 上的仓库，无法创建 PR"]);
  } finally {
    await running.close();
  }
});

const exists = (cwd: string, ref: string) => {
  try {
    git(cwd, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
};

it("archives a session once its PR is merged, even after GitHub deleted its branch, unless it holds new work", async () => {
  const repo = path.join(root, "repo4");
  git(root, "clone", "-q", "https://github.com/owner/repo.git", repo);
  const mgr = manager(path.join(root, "data4"));
  try {
    const merged = await mgr.createSession({ cwd: repo });
    commit(merged.worktreePath!, "g.txt", "g\n");
    await mgr.shipSession(merged.id, { message: "g" });
    const mergedHead = git(merged.worktreePath!, "rev-parse", "HEAD");
    const busy = await mgr.createSession({ cwd: repo });
    commit(busy.worktreePath!, "h.txt", "h\n");
    await mgr.shipSession(busy.id, { message: "h" });
    fs.writeFileSync(path.join(busy.worktreePath!, "h.txt"), "more\n");

    // Squash-merged on GitHub, which then deleted the branch; a later fetch pruned it here.
    git(remote, "update-ref", "-d", `refs/heads/${merged.branch}`);
    git(repo, "fetch", "-q", "--prune", "origin");
    assert.equal(exists(repo, `refs/remotes/origin/${merged.branch}`), false);
    fs.writeFileSync(path.join(root, "pr-state"), "MERGED");
    // Without the head GitHub merged, Ship's old head proves nothing: kept, and asked again.
    await mgr.checkPullRequests();
    assert.deepEqual([(await mgr.getSessionSummary(merged.id)).status, fs.existsSync(merged.worktreePath!)], ["done", true]);
    fs.writeFileSync(path.join(root, "pr-head"), mergedHead);
    await mgr.checkPullRequests();

    const after = await mgr.getSessionSummary(merged.id);
    assert.deepEqual([after.status, after.prState], ["archived", "merged"]);
    assert.equal(fs.existsSync(merged.worktreePath!), false);
    assert.equal(exists(repo, `refs/heads/${merged.branch}`), false);
    assert.ok(ghCalls().includes(`pr view ${after.prUrl} --json state,headRefOid`));

    const kept = await mgr.getSessionSummary(busy.id);
    assert.deepEqual([kept.status, kept.prState], ["done", "merged"], "new uncommitted work keeps it");
    assert.ok(fs.existsSync(busy.worktreePath!));
    git(busy.worktreePath!, "checkout", "--", "h.txt");
    await mgr.checkPullRequests();
    assert.equal((await mgr.getSessionSummary(busy.id)).status, "archived");
    assert.equal(fs.existsSync(busy.worktreePath!), false);
  } finally {
    fs.rmSync(path.join(root, "pr-state"));
    fs.rmSync(path.join(root, "pr-head"), { force: true });
    await mgr.close();
  }
});

it("archives on request: warns about work first, keeps unpushed commits on the branch, then is read-only", async () => {
  const repo = path.join(root, "repo5");
  git(root, "clone", "-q", "https://github.com/owner/repo.git", repo);
  const mgr = manager(path.join(root, "data5"));
  try {
    const session = await mgr.createSession({ cwd: repo });
    const wt = session.worktreePath!;
    commit(wt, "i.txt", "i\n");
    fs.writeFileSync(path.join(wt, "j.txt"), "j\n");
    const warned = await mgr.archiveSession(session.id, {});
    assert.deepEqual([warned.archived, warned.uncommitted, warned.unpushed, warned.session.status], [false, 1, 1, "idle"]);
    assert.ok(fs.existsSync(wt));

    const archived = await mgr.archiveSession(session.id, { force: true });
    assert.deepEqual([archived.archived, archived.session.status], [true, "archived"]);
    assert.ok(archived.session.archivedAt);
    assert.equal(fs.existsSync(wt), false);
    assert.ok(exists(repo, `refs/heads/${session.branch}`), "the unpushed commit stays on its branch");
    assert.equal(git(repo, "log", "-1", "--format=%s", session.branch!), "edit i.txt");

    // A change already under way holds Archive off until it's done.
    const other = await mgr.createSession({ cwd: repo });
    const resetting = mgr.resetSession(other.id);
    await assert.rejects(mgr.archiveSession(other.id, { force: true }), /正在更新/);
    await resetting;
    assert.equal((await mgr.archiveSession(other.id, {})).archived, true);

    // Locked with nothing in it: an error, not a confirmation that would seem to be about losing work.
    const locked = await mgr.createSession({ cwd: repo });
    git(repo, "worktree", "lock", locked.worktreePath!);
    await assert.rejects(mgr.archiveSession(locked.id, {}), (err: Error & { status?: number }) => err.status === 409 && /锁住/.test(err.message));
    assert.ok(fs.existsSync(locked.worktreePath!), "put back where it was");
    git(repo, "worktree", "unlock", locked.worktreePath!);

    const readOnly = (err: Error & { status?: number }) => err.status === 409 && /已归档/.test(err.message);
    await assert.rejects(mgr.sendMessage(session.id, { requestId: "r", content: "more" }), readOnly);
    await assert.rejects(mgr.shipSession(session.id, {}), readOnly);
    await assert.rejects(mgr.updateSession(session.id, { name: "x" }), readOnly);
    await assert.rejects(mgr.compactSession(session.id), readOnly);
    await assert.rejects(mgr.resetSession(session.id), readOnly);
    assert.equal((await mgr.archiveSession(session.id, {})).archived, true, "archiving again is a no-op");
    const { updatedAt } = await mgr.getSessionSummary(session.id);
    await mgr.abortSession(session.id);
    assert.equal((await mgr.getSessionSummary(session.id)).updatedAt, updatedAt, "Stop changes nothing");

    // A commit on a detached HEAD isn't on the session branch: a forced archive keeps it on a branch of its own.
    const detached = await mgr.createSession({ cwd: repo });
    git(detached.worktreePath!, "checkout", "-q", "--detach");
    commit(detached.worktreePath!, "dh.txt", "dh\n", "detached work");
    assert.equal((await mgr.archiveSession(detached.id, { force: "yes" as unknown as boolean })).archived, false, "only true confirms");
    assert.equal((await mgr.archiveSession(detached.id, { force: true })).archived, true);
    assert.equal(git(repo, "log", "-1", "--format=%s", `${detached.branch}-detached`), "detached work");

    const clean = await mgr.createSession({ cwd: repo });
    assert.equal((await mgr.archiveSession(clean.id, {})).archived, true);
    assert.equal(exists(repo, `refs/heads/${clean.branch}`), false, "nothing on it: the branch goes too");
  } finally {
    await mgr.close();
  }
});

it("pushes only the branch, only where fetch comes from, without hooks or half-done merges", async () => {
  const repo = path.join(root, "repo6");
  git(root, "clone", "-q", "https://github.com/owner/repo.git", repo);
  const mgr = manager(path.join(root, "data6"));
  const hook = (dir: string, name: string, body: string) => fs.writeFileSync(path.join(dir, "hooks", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  try {
    const session = await mgr.createSession({ cwd: repo });
    const wt = session.worktreePath!;
    const branch = session.branch!;
    const onRemote = (ref: string) => exists(remote, ref);
    commit(wt, "k.txt", "k\n");

    // A pushurl sends pushes elsewhere than the PR's repo.
    git(repo, "config", "remote.origin.pushurl", path.join(root, "elsewhere.git"));
    assert.match((await mgr.shipPreview(session.id)).reason!, /推送地址和拉取地址不同/);
    await assert.rejects(mgr.shipSession(session.id, {}), /推送地址和拉取地址不同/);
    git(repo, "config", "--unset", "remote.origin.pushurl");

    // An insteadOf may change how origin is reached, not which repo: here it would push to a fork, or to a host alias
    // that isn't GitHub, while the PR opens on owner/repo.
    for (const target of ["git@github.com:owner/fork.git", "git@mypi-test-not-github:owner/repo.git"]) {
      git(repo, "config", `url.${target}.insteadOf`, "https://github.com/owner/repo.git");
      assert.match((await mgr.shipPreview(session.id)).reason!, /insteadOf 改写到了 owner\/repo 以外/);
      await assert.rejects(mgr.shipSession(session.id, {}), /insteadOf 改写/);
      git(repo, "config", "--remove-section", `url.${target}`);
    }
    assert.equal((await mgr.shipPreview(session.id)).ready, true, "the SSH rewrite to the same repo is fine");

    // A cherry-pick of several commits, stopped after the first was resolved and committed by hand.
    const sequencer = git(wt, "rev-parse", "--path-format=absolute", "--git-path", "sequencer");
    fs.mkdirSync(sequencer);
    assert.match((await mgr.shipPreview(session.id)).reason!, /cherry-pick 或 revert 序列/);
    fs.rmSync(sequencer, { recursive: true });

    // An unresolved merge isn't committed.
    git(wt, "checkout", "-q", "-b", "side");
    commit(wt, "k.txt", "side\n");
    git(wt, "checkout", "-q", branch);
    commit(wt, "k.txt", "mine\n");
    assert.throws(() => git(wt, "merge", "-q", "side"));
    assert.match((await mgr.shipPreview(session.id)).reason!, /冲突/);
    await assert.rejects(mgr.shipSession(session.id, {}), /冲突/);
    git(wt, "merge", "--abort");

    // The owner's push.followTags, post-commit auto-push and message-rewriting hook don't apply.
    git(repo, "config", "push.followTags", "true");
    git(wt, "tag", "-a", "-m", "release", "v-release");
    hook(path.join(repo, ".git"), "post-commit", "git push -q origin HEAD:refs/heads/main");
    hook(path.join(repo, ".git"), "prepare-commit-msg", 'echo "hook message" > "$1"');
    const mainBefore = git(remote, "rev-parse", "main");
    fs.writeFileSync(path.join(wt, "l.txt"), "l\n");
    await mgr.shipSession(session.id, { message: "Add k and l" });
    assert.equal(git(wt, "log", "-1", "--format=%s"), "Add k and l");
    assert.equal(git(remote, "rev-parse", "main"), mainBefore);
    assert.equal(onRemote("refs/tags/v-release"), false, "no tags");
    assert.equal(git(remote, "rev-parse", `refs/heads/${branch}`), git(wt, "rev-parse", "HEAD"));

    // GitHub refuses the push (a ruleset): a refusal with its reason, not a server error.
    hook(remote, "pre-receive", "echo 'repository rule violations found' >&2; exit 1");
    commit(wt, "m.txt", "m\n");
    await assert.rejects(mgr.shipSession(session.id, {}), (err: Error & { status?: number }) =>
      err.status === 409 && /拒绝.*repository rule violations found/.test(err.message));
    fs.rmSync(path.join(remote, "hooks", "pre-receive"));
  } finally {
    await mgr.close();
  }
});

it("finishes a Ship whose PR wasn't opened, adopts only an open PR, and holds new work until it's done", async () => {
  const repo = path.join(root, "repo7");
  git(root, "clone", "-q", "https://github.com/owner/repo.git", repo);
  const mgr = manager(path.join(root, "data7"));
  const flag = (name: string, on: boolean) => on ? fs.writeFileSync(path.join(root, name), "") : fs.rmSync(path.join(root, name), { force: true });
  try {
    const session = await mgr.createSession({ cwd: repo });
    const wt = session.worktreePath!;
    const branch = session.branch!;
    commit(wt, "n.txt", "n\n");
    // The commit is also on another branch on GitHub: Ship still pushes it to the PR's.
    git(wt, "push", "-q", "origin", `HEAD:refs/heads/backup-${session.id}`);

    flag("pr-fail", true);
    await assert.rejects(mgr.shipSession(session.id, {}), /gh pr create failed/);
    assert.equal(git(remote, "rev-parse", `refs/heads/${branch}`), git(wt, "rev-parse", "HEAD"), "pushed before gh failed");
    assert.equal((await mgr.shipPreview(session.id)).ready, true, "the PR is still to open");
    flag("pr-fail", false);

    // The branch's only PR was merged long ago: not this work's review.
    flag("pr-merged", true);
    await assert.rejects(mgr.shipSession(session.id, {}), /gh pr create failed/);
    flag("pr-merged", false);

    // While Ship waits on GitHub, nothing may start new work or take the worktree away.
    flag("pr-wait", true);
    const shipping = mgr.shipSession(session.id, { message: "n" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const refused = (err: Error & { status?: number }) => err.status === 409 && /正在发布/.test(err.message);
    await assert.rejects(mgr.sendMessage(session.id, { requestId: "r", content: "more" }), refused);
    await assert.rejects(mgr.deleteSession(session.id), refused);
    await assert.rejects(mgr.resetSession(session.id), refused);
    assert.equal((await mgr.shipPreview(session.id)).reason, "正在发布中");
    flag("release", true);
    const shipped = await shipping;
    assert.deepEqual([shipped.pr.number, shipped.pushed, shipped.session.status], [7, false, "shipped"]);
    assert.ok((await mgr.listSessions()).some((s) => s.id === session.id));

    // GitHub deleted the branch; this clone's tracking ref still has it. Ship recreates it, and says it pushed.
    git(remote, "update-ref", "-d", `refs/heads/${branch}`);
    const again = await mgr.shipSession(session.id, { message: "n" });
    assert.deepEqual([again.pushed, git(remote, "rev-parse", `refs/heads/${branch}`)], [true, git(wt, "rev-parse", "HEAD")]);

    // A message being admitted holds Ship off in the preview too, as POST does.
    const admitting = (mgr as unknown as { admitting: Map<string, number> }).admitting;
    admitting.set(session.id, 1);
    assert.equal((await mgr.shipPreview(session.id)).reason, "会话正在更新，稍后再试");
    admitting.delete(session.id);
  } finally {
    for (const name of ["pr-fail", "pr-merged", "pr-wait", "release"]) flag(name, false);
    await mgr.close();
  }
});

it("cleans up only what is safe: not while the agent works, not a closed PR's force-pushed work, not a reopened PR", async () => {
  const repo = path.join(root, "repo8");
  git(root, "clone", "-q", "https://github.com/owner/repo.git", repo);
  const flag = (name: string, value?: string) => value === undefined
    ? fs.rmSync(path.join(root, name), { force: true }) : fs.writeFileSync(path.join(root, name), value);
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const mgr = new HarnessManager({ dataDir: path.join(root, "data8"), startDirs: [], modelsConfig: {
    models, availableModels: [], defaultModel: { provider: "faux", modelId: "faux-1" }, defaultThinkingLevel: "off",
    openaiAuth: { configured: false, authType: "none" }, getOpenAIRateLimits: () => undefined,
  } });
  let release = () => {};
  try {
    // The agent is working when the PR is merged: its worktree stays, and Archive refuses.
    const working = await mgr.createSession({ cwd: repo });
    commit(working.worktreePath!, "w.txt", "w\n");
    await mgr.shipSession(working.id, { message: "w" });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    faux.setResponses([async () => { await gate; return fauxAssistantMessage("-5 degrees fixed\n\nDetails."); }]);
    await mgr.sendMessage(working.id, { requestId: "w1", content: "also" });
    flag("pr-state", "MERGED");
    await mgr.checkPullRequests();
    assert.ok(fs.existsSync(working.worktreePath!));
    await assert.rejects(mgr.archiveSession(working.id, { force: true }), /还在工作/);
    release();
    for (let i = 0; i < 500 && (await mgr.getSessionSummary(working.id)).busy; i++) await new Promise((r) => setTimeout(r, 20));
    // Ship suggests the reply's first line as the notice shows it: "-5" stays negative.
    assert.equal((await mgr.shipPreview(working.id)).suggestedMessage, "-5 degrees fixed");

    // Closed after its commits were force-pushed away on GitHub: Ship's old head is no backup, so nothing goes.
    const replaced = await mgr.createSession({ cwd: repo });
    commit(replaced.worktreePath!, "r.txt", "only here\n");
    await mgr.shipSession(replaced.id, { message: "r" });
    git(remote, "update-ref", `refs/heads/${replaced.branch}`, git(remote, "rev-parse", "main"));
    git(repo, "fetch", "-q", "origin");
    flag("pr-state", "CLOSED");
    await mgr.checkPullRequests();
    assert.ok(fs.existsSync(replaced.worktreePath!));
    assert.ok(exists(repo, `refs/heads/${replaced.branch}`));

    // Closed while this clone's tracking ref is stale (the laptop force-pushed it away): the worktree may go, the branch stays.
    const stale = await mgr.createSession({ cwd: repo });
    commit(stale.worktreePath!, "s.txt", "only here too\n");
    await mgr.shipSession(stale.id, { message: "s" });
    git(remote, "update-ref", `refs/heads/${stale.branch}`, git(remote, "rev-parse", "main"));
    await mgr.checkPullRequests();
    assert.equal((await mgr.getSessionSummary(stale.id)).status, "archived");
    assert.equal(git(repo, "log", "-1", "--format=%s", stale.branch!), "edit s.txt");

    // Closed while work blocked cleanup, then reopened: it's asked again, and stays.
    const reopened = await mgr.createSession({ cwd: repo });
    commit(reopened.worktreePath!, "o.txt", "o\n");
    await mgr.shipSession(reopened.id, { message: "o" });
    fs.writeFileSync(path.join(reopened.worktreePath!, "o.txt"), "editing\n");
    await mgr.checkPullRequests();
    assert.equal((await mgr.getSessionSummary(reopened.id)).prState, "closed");
    flag("pr-state", "OPEN");
    git(reopened.worktreePath!, "checkout", "--", "o.txt");
    await mgr.checkPullRequests();
    const after = await mgr.getSessionSummary(reopened.id);
    assert.deepEqual([after.prState, after.status], ["open", "shipped"]);

    // The daemon shuts down while gh answers "merged": nothing is removed on the way out.
    flag("pr-state", "MERGED");
    flag("view-wait", "");
    const checking = mgr.checkPullRequests();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const closing = mgr.close();
    flag("release", "");
    await Promise.all([checking, closing]);
    assert.ok(fs.existsSync(reopened.worktreePath!));
  } finally {
    release(); // a failed check mustn't leave close() waiting on the agent
    for (const name of ["pr-state", "view-wait", "release"]) flag(name);
    await mgr.close();
  }
});

it("keeps every commit GitHub didn't merge, on every way out, and drops answers that are out of date", async () => {
  const repo = path.join(root, "repo9");
  git(root, "clone", "-q", "https://github.com/owner/repo.git", repo);
  const dataDir = path.join(root, "data9");
  const flag = (name: string, value?: string) => value === undefined
    ? fs.rmSync(path.join(root, name), { force: true }) : fs.writeFileSync(path.join(root, name), value);
  const mgr = manager(dataDir);
  const held = async (during: () => Promise<unknown>) => {
    flag("view-wait", "");
    const checking = mgr.checkPullRequests();
    await new Promise((resolve) => setTimeout(resolve, 300)); // gh is holding its answer
    await during();
    flag("release", "");
    await checking;
    flag("view-wait");
    flag("release");
  };
  try {
    // Archived by hand while its PR is open: the worktree goes, the pushed but unmerged branch stays.
    const manual = await mgr.createSession({ cwd: repo });
    commit(manual.worktreePath!, "m.txt", "m\n");
    await mgr.shipSession(manual.id, { message: "m" });
    assert.equal((await mgr.archiveSession(manual.id, {})).archived, true);
    assert.equal(git(repo, "log", "-1", "--format=%s", manual.branch!), "edit m.txt");

    // Delete waits for a change already under way, like Archive.
    const other = await mgr.createSession({ cwd: repo });
    const resetting = mgr.resetSession(other.id);
    await assert.rejects(mgr.deleteSession(other.id), /正在更新/);
    await resetting;
    await mgr.deleteSession(other.id);

    // The laptop replaced the PR's commits and GitHub merged that. This clone's tracking ref still has the old ones,
    // which proves nothing: the branch stays, through archiving and through Delete.
    const replaced = await mgr.createSession({ cwd: repo });
    commit(replaced.worktreePath!, "a.txt", "only on the mini\n");
    await mgr.shipSession(replaced.id, { message: "a" });
    const laptop = path.join(root, "laptop9");
    git(root, "clone", "-q", "https://github.com/owner/repo.git", laptop);
    git(laptop, "checkout", "-q", "-b", replaced.branch!);
    commit(laptop, "b.txt", "the replacement\n");
    git(laptop, "push", "-q", "--force", "origin", replaced.branch!);
    const merged = git(laptop, "rev-parse", "HEAD");
    git(repo, "fetch", "-q", "--refmap=", "origin", `refs/heads/${replaced.branch}:refs/test/merged`); // its object only
    flag("pr-state", "MERGED");
    flag("pr-head", merged);
    await mgr.checkPullRequests();
    assert.equal((await mgr.getSessionSummary(replaced.id)).status, "archived");
    await mgr.deleteSession(replaced.id);
    assert.equal(git(repo, "log", "-1", "--format=%s", replaced.branch!), "edit a.txt");
    flag("pr-head");

    // Deleted while gh answers: the answer isn't applied, and the session isn't reopened.
    const gone = await mgr.createSession({ cwd: repo });
    commit(gone.worktreePath!, "g.txt", "g\n");
    await mgr.shipSession(gone.id, { message: "g" });
    await held(() => mgr.deleteSession(gone.id));
    await assert.rejects(mgr.getSessionSummary(gone.id), /not found/);
    assert.equal(fs.existsSync(path.join(dataDir, "sessions", gone.id)), false);

    // Shipped again while gh answers about the PR as it was: that answer is about a PR record that's been replaced.
    const again = await mgr.createSession({ cwd: repo });
    commit(again.worktreePath!, "h.txt", "h\n");
    await mgr.shipSession(again.id, { message: "h" });
    commit(again.worktreePath!, "i.txt", "i\n");
    flag("pr-state", "CLOSED");
    await held(() => mgr.shipSession(again.id, { message: "i" }));
    const summary = await mgr.getSessionSummary(again.id);
    assert.deepEqual([summary.status, summary.prState, fs.existsSync(again.worktreePath!)], ["shipped", "open", true]);
  } finally {
    for (const name of ["pr-state", "pr-head", "view-wait", "release"]) flag(name);
    await mgr.close();
  }
});
