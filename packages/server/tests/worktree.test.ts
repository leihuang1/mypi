import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, it } from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { LoadedModelsConfig } from "../src/auth-loader.js";
import { inspectGitDirectory } from "../src/git-service.js";
import { HarnessManager } from "../src/harness-mgr.js";
import { agentShellEnv } from "../src/extensions/guard.js";
import { createSessionWorktree, removeSessionWorktree, worktreeWork } from "../src/worktree-service.js";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mypi-worktree-")));
const saved = { ...process.env };

before(() => {
  // The fixtures' git must not see this machine's config (signing, helpers, default branch).
  fs.writeFileSync(path.join(root, "gitconfig"), "");
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file", // fixtures are local; nothing may reach a real remote
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com",
  });
});

after(() => {
  process.env = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const hasBranch = (cwd: string, branch: string) => {
  try {
    git(cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
};
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

/** A bare `origin`, a clone of it, and an upstream commit the clone hasn't fetched yet. */
function fixture(name: string) {
  const dir = path.join(root, name);
  const remote = path.join(dir, "remote.git");
  const seed = path.join(dir, "seed");
  const repo = path.join(dir, "repo");
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  git(dir, "clone", "-q", remote, seed);
  write(path.join(seed, "README.md"), "hello\n");
  write(path.join(seed, "packages/app/index.js"), "export const a = 1;\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "main");
  git(dir, "clone", "-q", remote, repo);
  const upstream = (file: string, content: string) => {
    write(path.join(seed, file), content);
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", `upstream ${file}`);
    git(seed, "push", "-q", "origin", "main");
    return git(seed, "rev-parse", "HEAD");
  };
  return { dir, remote, repo, upstream };
}

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

it("starts a git session on its own branch and worktree from a fresh origin, leaving the checkout alone", async () => {
  const { dir, repo, upstream } = fixture("session");
  const fresh = upstream("NEWS.md", "news\n");
  const mgr = manager(path.join(dir, "data"));
  try {
    const session = await mgr.createSession({ cwd: path.join(repo, "packages/app") });
    const worktreePath = path.join(dir, "data", "worktrees", `repo-${session.id}`);
    assert.equal(session.branch, `mypi/${session.id}`);
    assert.equal(session.baseRef, "origin/main");
    assert.equal(session.repoPath, repo);
    assert.equal(session.worktreePath, worktreePath);
    assert.equal(session.cwd, path.join(worktreePath, "packages/app"), "the same folder, inside the worktree");
    assert.equal(git(worktreePath, "rev-parse", "HEAD"), fresh, "branched from origin/main after a fetch");
    assert.equal(git(worktreePath, "symbolic-ref", "--short", "HEAD"), session.branch);
    assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "main");
    assert.equal(git(repo, "status", "--porcelain"), "", "the checkout is untouched");
    assert.equal(fs.existsSync(path.join(repo, "NEWS.md")), false);
    assert.ok(mgr.getRecentDirs().includes(path.join(repo, "packages/app")), "recent folders list the source folder");
    assert.ok(!mgr.getRecentDirs().some((d) => d.startsWith(path.join(dir, "data"))));

    await assert.rejects(mgr.updateSession(session.id, { cwd: repo }), /own worktree/);
    fs.symlinkSync(repo, path.join(worktreePath, "back"));
    await assert.rejects(mgr.updateSession(session.id, { cwd: path.join(worktreePath, "back") }), /own worktree/, "a symlink out");
    fs.unlinkSync(path.join(worktreePath, "back"));
    fs.mkdirSync(path.join(worktreePath, "..cache"));
    assert.equal((await mgr.updateSession(session.id, { cwd: path.join(worktreePath, "..cache") })).cwd, path.join(worktreePath, "..cache"));
    assert.equal((await mgr.updateSession(session.id, { cwd: worktreePath })).cwd, worktreePath);

    // The agent commits one change and leaves another uncommitted; then origin moves on.
    write(path.join(worktreePath, "packages/app/index.js"), "export const a = 2;\n");
    git(worktreePath, "commit", "-qam", "agent change");
    write(path.join(worktreePath, "notes.md"), "todo\n");
    upstream("README.md", "hello again\n");
    git(repo, "fetch", "-q", "origin");
    const diff = await inspectGitDirectory(worktreePath, session.baseRef);
    assert.deepEqual(diff.files.map((f) => f.path), ["notes.md", "packages/app/index.js"], "the session's changes only");
    assert.equal(diff.baseRef, "origin/main");
    assert.equal(diff.branch, session.branch);
    assert.deepEqual((await inspectGitDirectory(worktreePath)).files.map((f) => f.path), ["notes.md"], "without a base: HEAD");

    // Deleting a session with work keeps its worktree and branch.
    await mgr.deleteSession(session.id);
    assert.ok(fs.existsSync(worktreePath));
    assert.ok(hasBranch(repo, session.branch!));

    // A session without work leaves nothing behind.
    const clean = await mgr.createSession({ cwd: repo });
    assert.equal(clean.cwd, clean.worktreePath);
    await mgr.deleteSession(clean.id);
    assert.equal(fs.existsSync(clean.worktreePath!), false);
    assert.equal(hasBranch(repo, clean.branch!), false);
  } finally {
    await mgr.close();
  }
});

it("works in place outside git, when asked to, and in a repo without commits", async () => {
  const dir = path.join(root, "in-place");
  const plain = path.join(dir, "plain");
  const unborn = path.join(dir, "unborn");
  fs.mkdirSync(plain, { recursive: true });
  fs.mkdirSync(unborn);
  git(unborn, "init", "-q");
  const { repo } = fixture("opt-out");
  const mgr = manager(path.join(dir, "data"));
  try {
    for (const [cwd, worktree] of [[plain, undefined], [unborn, undefined], [repo, false]] as const) {
      const session = await mgr.createSession({ cwd, worktree });
      assert.equal(session.cwd, cwd);
      assert.equal(session.branch, undefined);
      assert.equal(session.worktreePath, undefined);
      assert.equal((await mgr.updateSession(session.id, { cwd: dir })).cwd, dir, "no worktree, no lock");
    }
    assert.equal(fs.existsSync(path.join(dir, "data", "worktrees")), false);
  } finally {
    await mgr.close();
  }
});

it("branches from the current branch without origin, and from the last fetch when origin can't be reached", async () => {
  const local = path.join(root, "local");
  fs.mkdirSync(local);
  git(local, "init", "-q", "-b", "trunk");
  write(path.join(local, "a.txt"), "a\n");
  git(local, "add", "-A");
  git(local, "commit", "-qm", "init");
  const wt = await createSessionWorktree(local, path.join(root, "local-worktrees"), "aaaa1111");
  assert.equal(wt?.baseRef, "trunk");
  assert.deepEqual(await worktreeWork(wt!), { exists: true, uncommitted: 0, ignored: 0, unpushed: 0 });
  write(path.join(wt!.path, "b.txt"), "b\n");
  git(wt!.path, "add", "-A");
  git(wt!.path, "commit", "-qm", "work");
  assert.deepEqual(await worktreeWork(wt!), { exists: true, uncommitted: 0, ignored: 0, unpushed: 1 }, "counted against the base, not all history");
  assert.equal((await removeSessionWorktree(wt!)).removed, false);

  // The worktree folder is gone, but its branch still has the commit: keep the branch.
  fs.rmSync(wt!.path, { recursive: true, force: true });
  assert.deepEqual(await worktreeWork(wt!), { exists: false, uncommitted: 0, ignored: 0, unpushed: 1 });
  assert.equal((await removeSessionWorktree(wt!)).removed, false);
  assert.ok(hasBranch(local, wt!.branch));

  const { repo, upstream } = fixture("offline");
  const fetched = git(repo, "rev-parse", "origin/main");
  upstream("late.md", "late\n");
  git(repo, "remote", "set-url", "origin", path.join(root, "missing.git"));
  const offline = await createSessionWorktree(repo, path.join(root, "offline-worktrees"), "bbbb2222");
  assert.equal(offline?.baseRef, "origin/main");
  assert.equal(git(offline!.path, "rev-parse", "HEAD"), fetched);
  assert.equal((await removeSessionWorktree(offline!)).removed, true);
});

it("keeps work that git status doesn't show, and survives the checkout or the base going away", async () => {
  const { dir, repo, remote, upstream } = fixture("hidden");
  upstream(".gitignore", ".env\nnode_modules/\n");
  const wtRoot = path.join(dir, "worktrees");
  const listed = (wtPath: string) => git(repo, "worktree", "list", "--porcelain").includes(`worktree ${wtPath}\n`);

  // Regenerable output may go with the worktree; an ignored .env may not.
  const a = (await createSessionWorktree(repo, wtRoot, "a1"))!;
  write(path.join(a.path, "packages/app/node_modules/x/index.js"), "x\n");
  assert.equal((await worktreeWork(a)).ignored, 0);
  write(path.join(a.path, ".env"), "TOKEN=only-copy\n");
  assert.equal((await worktreeWork(a)).ignored, 1);
  assert.equal((await removeSessionWorktree(a)).removed, false);
  assert.ok(fs.existsSync(path.join(a.path, ".env")));
  assert.equal((await removeSessionWorktree(a, { force: true })).removed, true, "Archive, once the user agreed");

  // A detached commit in a folder deleted by hand: git still has its HEAD, so it counts, and nothing is pruned.
  const b = (await createSessionWorktree(repo, wtRoot, "b2"))!;
  git(b.path, "checkout", "-q", "--detach");
  write(path.join(b.path, "detached.md"), "d\n");
  git(b.path, "add", "-A");
  git(b.path, "commit", "-qm", "detached");
  fs.rmSync(b.path, { recursive: true, force: true });
  assert.equal((await worktreeWork(b)).unpushed, 1);
  assert.equal((await removeSessionWorktree(b)).removed, false);
  assert.ok(listed(b.path), "its registration, and the commit's last ref, stay");

  // A locked worktree stays, even when forced, and isn't reported removed.
  const c = (await createSessionWorktree(repo, wtRoot, "c3"))!;
  git(repo, "worktree", "lock", c.path);
  assert.deepEqual(await removeSessionWorktree(c, { force: true }).then((r) => [r.removed, r.branchDeleted]), [false, false]);
  assert.ok(listed(c.path) && hasBranch(repo, c.branch));
  git(repo, "worktree", "unlock", c.path);

  // A session started inside another session's worktree outlives it.
  const d = (await createSessionWorktree(c.path, wtRoot, "d4"))!;
  assert.equal((await removeSessionWorktree(c)).removed, true);
  assert.equal((await removeSessionWorktree(d)).removed, true);
  assert.equal(hasBranch(repo, d.branch), false);

  // The base branch is deleted: the diff falls back to the commit the session started at, not to "no changes".
  const e = (await createSessionWorktree(repo, wtRoot, "e5"))!;
  write(path.join(e.path, "agent.md"), "agent\n");
  git(e.path, "add", "-A");
  git(e.path, "commit", "-qm", "agent");
  git(repo, "update-ref", "-d", "refs/remotes/origin/main");
  const diff = await inspectGitDirectory(e.path, e.baseRef, e.baseCommit);
  assert.deepEqual([diff.files.map((f) => f.path), diff.baseRef], [["agent.md"], "origin/main"]);
  git(repo, "fetch", "-q", "origin");

  // origin's default branch changed after the clone.
  git(remote, "branch", "trunk", "main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/trunk");
  assert.equal((await createSessionWorktree(repo, wtRoot, "f6"))!.baseRef, "origin/trunk");

  // The daemon was started with another repository selected; hooks don't run in the new checkout.
  write(path.join(repo, ".git/hooks/post-checkout"), "#!/bin/sh\nexit 1\n");
  fs.chmodSync(path.join(repo, ".git/hooks/post-checkout"), 0o755);
  const other = fixture("other").repo;
  Object.assign(process.env, { GIT_DIR: path.join(other, ".git"), GIT_WORK_TREE: other });
  let g;
  let shell;
  try {
    g = (await createSessionWorktree(repo, wtRoot, "g7"))!;
    shell = agentShellEnv(path.join(dir, "data"), process.env);
  } finally {
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;
  }
  assert.equal(g.repoPath, repo);
  assert.ok(hasBranch(repo, g.branch) && !hasBranch(other, g.branch));
  assert.ok("GIT_DIR" in shell && shell.GIT_DIR === undefined && shell.GIT_WORK_TREE === undefined, "nor does the agent's shell");
});

it("lets git check once more before removing: a file written after the count stays", async () => {
  const { dir, repo } = fixture("late");
  const wt = (await createSessionWorktree(repo, path.join(dir, "worktrees"), "l1"))!;
  // A git that writes a file into the worktree right after reporting it clean, like an editor saving at that moment.
  const bin = path.join(dir, "bin");
  write(path.join(bin, "git"), `#!/bin/sh\n/usr/bin/git "$@"\nrc=$?\ncase "$*" in *"status --porcelain"*) echo late > "${wt.path}/late.txt";; esac\nexit $rc\n`);
  fs.chmodSync(path.join(bin, "git"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  try {
    assert.equal((await removeSessionWorktree(wt)).removed, false);
  } finally {
    process.env.PATH = savedPath;
  }
  assert.equal(fs.readFileSync(path.join(wt.path, "late.txt"), "utf8"), "late\n");
  // A catalog entry from before gitDir and baseCommit were recorded still works, from the checkout.
  git(wt.path, "add", "-A");
  git(wt.path, "commit", "-qm", "late");
  assert.equal((await worktreeWork({ ...wt, gitDir: undefined, baseCommit: undefined })).unpushed, 1);
});
