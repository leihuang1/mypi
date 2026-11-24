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
function fixture(name: string, format: string[] = []) {
  const dir = path.join(root, name);
  const remote = path.join(dir, "remote.git");
  const seed = path.join(dir, "seed");
  const repo = path.join(dir, "repo");
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "--bare", "-b", "main", ...format, remote);
  git(dir, "clone", "-q", remote, seed);
  write(path.join(seed, "README.md"), "hello\n");
  write(path.join(seed, "packages/app/index.js"), "export const a = 1;\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "main");
  git(dir, "clone", "-q", ...format.filter((f) => f.startsWith("--ref-format")), remote, repo);
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

it("loses nothing written after the count: late files go to trash, a late commit keeps its branch", async () => {
  const { dir, repo } = fixture("late");
  const root = path.join(dir, "worktrees");
  const wt = (await createSessionWorktree(repo, root, "l1"))!;
  // A git that changes the worktree right after reporting on it, like an editor saving or the owner committing then.
  const bin = path.join(dir, "bin");
  const late = (after: string, then: string) => {
    write(path.join(bin, "git"), `#!/bin/sh\n/usr/bin/git "$@"\nrc=$?\ncase "$*" in *"${after}"*) ${then};; esac\nexit $rc\n`);
    fs.chmodSync(path.join(bin, "git"), 0o755);
  };
  const withShim = async <T>(run: () => Promise<T>): Promise<T> => {
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      return await run();
    } finally {
      process.env.PATH = savedPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  };

  // An untracked file and an ignored .env, both saved just after status: the folder goes to trash with them.
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), ".env\n");
  late("status --porcelain", `echo late > "${wt.path}/late.txt"; echo SECRET=1 > "${wt.path}/.env"`);
  assert.equal((await withShim(() => removeSessionWorktree(wt))).removed, true);
  const [trashed] = fs.readdirSync(path.join(root, ".mypi-trash"));
  assert.deepEqual(["late.txt", ".env"].map((f) => fs.readFileSync(path.join(root, ".mypi-trash", trashed, f), "utf8")), ["late\n", "SECRET=1\n"]);

  // A commit made after the count: the branch moved, so it isn't deleted.
  const wt2 = (await createSessionWorktree(repo, root, "l2"))!;
  late("rev-list --count", `cd "${wt2.path}" && echo c > c.txt && /usr/bin/git add c.txt && /usr/bin/git commit -qm late`);
  const result = await withShim(() => removeSessionWorktree(wt2));
  assert.deepEqual([result.removed, result.branchDeleted], [true, false]);
  assert.equal(git(repo, "log", "-1", "--format=%s", wt2.branch), "late");
  // Even when the branch moves just after its tip was checked (the folder is in trash by then: another process moves
  // it): the delete is conditional on that tip.
  const wt5 = (await createSessionWorktree(repo, root, "l5"))!;
  const b5 = `refs/heads/${wt5.branch}`;
  late("merge-base --is-ancestor", `cd "${repo}" && n=$(/usr/bin/git commit-tree -p ${b5} -m later "${b5}^{tree}") && /usr/bin/git update-ref ${b5} $n`);
  assert.equal((await withShim(() => removeSessionWorktree(wt5))).branchDeleted, false);
  assert.equal(git(repo, "log", "-1", "--format=%s", wt5.branch), "later");

  // A commit on a detached HEAD at the last moment, just before git's metadata for the worktree is moved aside: the
  // HEAD is read after that, so the commit gets its recovery branch.
  const wt6 = (await createSessionWorktree(repo, root, "l6"))!;
  git(wt6.path, "checkout", "-q", "--detach");
  late("--git-common-dir", `cd "${wt6.path}" && echo d > d.txt && /usr/bin/git add d.txt && /usr/bin/git commit -qm "detached late"`);
  assert.equal((await withShim(() => removeSessionWorktree(wt6))).removed, true);
  assert.equal(git(repo, "log", "-1", "--format=%s", `${wt6.branch}-detached`), "detached late");

  // The branch checked out in the owner's checkout just before it would be deleted: git refuses, and it stays.
  const wt7 = (await createSessionWorktree(repo, root, "l7"))!;
  // History of its own (moved away and back), which a branch deleted and made again wouldn't have.
  const b7 = `refs/heads/${wt7.branch}`;
  const at7 = git(repo, "rev-parse", b7);
  git(repo, "update-ref", "-m", "away", b7, git(repo, "commit-tree", `${b7}^{tree}`, "-m", "elsewhere"));
  git(repo, "update-ref", "-m", "back", b7, at7);
  const history = git(repo, "reflog", "show", "--format=%gs", b7);
  late("merge-base --is-ancestor", `cd "${repo}" && /usr/bin/git checkout -q ${wt7.branch}`);
  assert.equal((await withShim(() => removeSessionWorktree(wt7))).branchDeleted, false);
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), wt7.branch, "the owner's checkout still has its branch");
  assert.equal(git(repo, "reflog", "show", "--format=%gs", `refs/heads/${wt7.branch}`), history, "never deleted, so its history is too");
  git(repo, "checkout", "-q", "-");

  // The branch checked out in the owner's checkout in the moment between that check and the delete: it's put back.
  const wt15 = (await createSessionWorktree(repo, root, "l15"))!;
  write(path.join(bin, "git"), `#!/bin/sh\ncase "$*" in *"--no-deref -d"*) (cd "${repo}" && /usr/bin/git checkout -q ${wt15.branch});; esac\nexec /usr/bin/git "$@"\n`);
  fs.chmodSync(path.join(bin, "git"), 0o755);
  assert.equal((await withShim(() => removeSessionWorktree(wt15))).branchDeleted, false);
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), wt15.branch);
  assert.ok(hasBranch(repo, wt15.branch), "the owner's checkout has its branch back");
  git(repo, "checkout", "-q", "-");

  // Locked (or given a submodule) just as git's metadata is moved: checked again there, and put back.
  const wt16 = (await createSessionWorktree(repo, root, "l16"))!;
  const rename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).includes("mypi-retired")) fs.writeFileSync(path.join(String(from), "locked"), "");
    rename(from, to);
  }) as typeof fs.renameSync;
  try {
    const locked = await removeSessionWorktree(wt16, { force: true });
    assert.deepEqual([locked.removed, /锁住/.test(locked.blocked ?? "")], [false, true]);
  } finally {
    fs.renameSync = rename;
  }
  assert.ok(git(repo, "worktree", "list", "--porcelain").includes(wt16.path), "still registered");
  assert.ok(fs.existsSync(path.join(wt16.path, "README.md")));
  git(repo, "worktree", "unlock", wt16.path);

  // A folder made again at the old path after the move: nothing to roll back, and its file is left alone.
  const wt8 = (await createSessionWorktree(repo, root, "l8"))!;
  late("merge-base --is-ancestor", `mkdir -p "${wt8.path}" && echo new > "${wt8.path}/new.txt"`);
  assert.equal((await withShim(() => removeSessionWorktree(wt8))).removed, true);
  assert.equal(fs.readFileSync(path.join(wt8.path, "new.txt"), "utf8"), "new\n");

  // Staged just after the count, its file then deleted: the content is only in the index, which the worktree's
  // renamed metadata keeps, and with it git's prune and gc, however eager.
  const wt11 = (await createSessionWorktree(repo, root, "l11"))!;
  late("status --porcelain", `cd "${wt11.path}" && echo staged > s.txt && /usr/bin/git add s.txt && unlink s.txt`);
  assert.equal((await withShim(() => removeSessionWorktree(wt11))).removed, true);
  const worktreesDir = path.join(repo, ".git", "worktrees");
  const retiredOf = (wt: { path: string }) =>
    path.join(worktreesDir, fs.readdirSync(worktreesDir).find((name) => name.startsWith(`${path.basename(wt.path)}-mypi-retired-`))!);
  git(repo, "worktree", "prune");
  git(repo, "gc", "-q", "--prune=now");
  const inIndex = (wt: { path: string }, ...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: path.join(retiredOf(wt), "index") } });
  assert.equal(inIndex(wt11, "cat-file", "-p", ":s.txt"), "staged\n");
  // Git lists it where the checkout went, detached and locked, not as the session's worktree.
  assert.match(git(repo, "worktree", "list", "--porcelain"),
    new RegExp(`\\.mypi-trash/${path.basename(wt11.path)}-\\d{13}\\nHEAD [0-9a-f]+\\ndetached\\nlocked`));

  // A conflict staged just after the count: kept as it is, in the renamed metadata's index.
  const wt17 = (await createSessionWorktree(repo, root, "l17"))!;
  late("status --porcelain", `cd "${wt17.path}" && b=$(echo x | /usr/bin/git hash-object -w --stdin) && ` +
    `printf "100644 $b 1\\tc.txt\\n100644 $b 2\\tc.txt\\n" | /usr/bin/git update-index --index-info`);
  assert.equal((await withShim(() => removeSessionWorktree(wt17))).removed, true);
  assert.match(inIndex(wt17, "ls-files", "--stage"), / 1\tc\.txt\n.* 2\tc\.txt/s);

  // The catalog's path is now a symlink to where the checkout was moved: the checkout itself goes to trash.
  const wt10 = (await createSessionWorktree(repo, root, "l10"))!;
  const movedTo = path.join(dir, "moved-l10");
  git(repo, "worktree", "move", wt10.path, movedTo);
  fs.symlinkSync(movedTo, wt10.path);
  late("status --porcelain", `echo late > "${movedTo}/late.txt"`);
  assert.equal((await withShim(() => removeSessionWorktree(wt10))).removed, true);
  const entry = fs.readdirSync(path.join(dir, ".mypi-trash")).find((name) => name.startsWith("moved-l10-"))!;
  assert.equal(fs.readFileSync(path.join(dir, ".mypi-trash", entry, "late.txt"), "utf8"), "late\n");

  // Two missing worktrees with this folder name, and a spelling that no longer resolves: an error, not "nothing".
  const wt12 = (await createSessionWorktree(repo, root, "l12"))!;
  git(repo, "worktree", "add", "-q", "--detach", path.join(dir, "elsewhere", path.basename(wt12.path)));
  fs.renameSync(wt12.path, path.join(dir, "gone-1"));
  fs.renameSync(path.join(dir, "elsewhere"), path.join(dir, "gone-2"));
  const unresolvable = { ...wt12, path: path.join(dir, "no-such-link", path.basename(wt12.path)) };
  await assert.rejects(worktreeWork(unresolvable), /Several missing worktrees/);

  // Submodule repositories live in the worktree's git metadata: removing them could lose commits pushed nowhere, so
  // the removal is refused, confirmed or not.
  const sub = path.join(dir, "sub");
  git(dir, "init", "-q", sub);
  write(path.join(sub, "s.txt"), "s\n");
  git(sub, "add", "-A");
  git(sub, "commit", "-qm", "sub");
  const wt9 = (await createSessionWorktree(repo, root, "l9"))!;
  git(wt9.path, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "mod");
  git(wt9.path, "commit", "-qm", "add mod");
  const refused = await removeSessionWorktree(wt9, { force: true });
  assert.deepEqual([refused.removed, /子模块/.test(refused.blocked ?? "")], [false, true]);
  assert.ok(fs.existsSync(path.join(wt9.path, "mod", "s.txt")));

  // What a removal kept goes a week later at the next removal: its metadata with its copy in trash. (Aged here by
  // renaming the metadata as if made eight days ago.)
  const weekAgo = Date.now() - 8 * 86_400_000;
  const removedAndAged = async (name: string) => {
    const wt = (await createSessionWorktree(repo, root, name))!;
    assert.equal((await removeSessionWorktree(wt)).removed, true);
    const aged = retiredOf(wt).replace(/-\d{13}$/, `-${weekAgo}`);
    fs.renameSync(retiredOf(wt), aged);
    return { meta: aged, copy: path.dirname(fs.readFileSync(path.join(aged, "gitdir"), "utf8").trim()) };
  };
  const expiring = await removedAndAged("la");
  // Taken back by the owner, repaired (its copy works again) or unlocked: theirs now, and it stays.
  const repaired = await removedAndAged("lb");
  // What `git worktree repair` writes there with worktree.useRelativePaths (run with no paths, it would take back
  // every copy at once).
  fs.writeFileSync(path.join(repaired.copy, ".git"), `gitdir: ${path.relative(repaired.copy, repaired.meta)}\n`);
  assert.equal(git(repaired.copy, "rev-parse", "--is-inside-work-tree"), "true");
  // Repaired, and its `.git` can't be read when expiry looks: it can't tell, so it stays.
  const unreadable = await removedAndAged("lf");
  fs.writeFileSync(path.join(unreadable.copy, ".git"), `gitdir: ${unreadable.meta}\n`);
  fs.chmodSync(path.join(unreadable.copy, ".git"), 0o000);
  const unlocked = await removedAndAged("lc");
  git(repo, "worktree", "unlock", unlocked.copy);
  // Moved out of trash, still locked (what `git worktree move -f -f` does: the folder, and its path in the metadata).
  const movedOut = await removedAndAged("le");
  const outside = path.join(dir, "taken-back");
  fs.renameSync(movedOut.copy, outside);
  fs.writeFileSync(path.join(movedOut.meta, "gitdir"), `${path.join(outside, ".git")}\n`);
  // A copy that can't be emptied: its metadata stays while anything of it does.
  const stuck = await removedAndAged("ld");
  write(path.join(stuck.copy, "inner", "f.txt"), "f\n");
  fs.chmodSync(path.join(stuck.copy, "inner"), 0o400);
  // Anything else in the trash is the owner's, whatever its name, and so is metadata not marked as a removal's.
  write(path.join(root, ".mypi-trash", `owner-backup-${weekAgo}`, "only.txt"), "mine\n");
  write(path.join(root, ".mypi-trash", `notes-${weekAgo}`), "mine\n");
  const wt3 = (await createSessionWorktree(repo, root, "l3"))!;
  const ownerMeta = path.join(worktreesDir, `mine-${weekAgo}`);
  write(path.join(ownerMeta, "gitdir"), `${path.join(dir, "mine", ".git")}\n`);
  try {
    assert.equal((await removeSessionWorktree(wt3)).branchDeleted, true, "nothing but the base on it");
  } finally {
    fs.chmodSync(path.join(stuck.copy, "inner"), 0o700);
    fs.chmodSync(path.join(unreadable.copy, ".git"), 0o644);
  }
  assert.deepEqual([fs.existsSync(expiring.meta), fs.existsSync(expiring.copy)], [false, false], "expired");
  assert.deepEqual([repaired, unlocked].flatMap((k) => [fs.existsSync(k.meta), fs.existsSync(k.copy)]), [true, true, true, true]);
  assert.deepEqual([fs.existsSync(movedOut.meta), fs.existsSync(outside)], [true, true]);
  assert.deepEqual([fs.existsSync(unreadable.meta), fs.existsSync(unreadable.copy)], [true, true], "unreadable .git");
  assert.equal(git(repaired.copy, "rev-parse", "--is-inside-work-tree"), "true", "the repaired copy still works");
  assert.ok(fs.existsSync(stuck.meta), "kept while its copy is there");
  assert.equal(fs.readFileSync(path.join(root, ".mypi-trash", `owner-backup-${weekAgo}`, "only.txt"), "utf8"), "mine\n");
  assert.ok(fs.existsSync(path.join(root, ".mypi-trash", `notes-${weekAgo}`)));
  assert.ok(fs.existsSync(ownerMeta));
  fs.rmSync(ownerMeta, { recursive: true });
  // Trash that can be written to but not listed: removal still finishes, and isn't registered again.
  const wt14 = (await createSessionWorktree(repo, root, "l14"))!;
  fs.chmodSync(path.join(root, ".mypi-trash"), 0o300);
  try {
    assert.equal((await removeSessionWorktree(wt14)).removed, true);
  } finally {
    fs.chmodSync(path.join(root, ".mypi-trash"), 0o755);
  }
  assert.equal(git(repo, "worktree", "list", "--porcelain").includes(`${wt14.path}\n`), false);

  // A catalog entry from before gitDir and baseCommit were recorded still works, from the checkout.
  const wt4 = (await createSessionWorktree(repo, root, "l4"))!;
  write(path.join(wt4.path, "x.txt"), "x\n");
  git(wt4.path, "add", "-A");
  git(wt4.path, "commit", "-qm", "x");
  assert.equal((await worktreeWork({ ...wt4, gitDir: undefined, baseCommit: undefined })).unpushed, 1);
});

it("puts git's metadata back as it was, unlocked, after a failure before the move", async () => {
  const { dir, repo } = fixture("restore");
  const root = path.join(dir, "worktrees");
  const wt = (await createSessionWorktree(repo, root, "r1"))!;
  fs.writeFileSync(path.join(root, ".mypi-trash"), ""); // a file: the trash folder can't be made
  await assert.rejects(removeSessionWorktree(wt), /EEXIST|ENOTDIR/);
  assert.equal(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD"), wt.branch, "the checkout works as before");
  const listed = git(repo, "worktree", "list", "--porcelain").split("\n\n").find((e) => e.includes(wt.path))!;
  assert.match(listed, new RegExp(`branch refs/heads/${wt.branch}`));
  assert.doesNotMatch(listed, /locked/);
});

it("puts git's metadata back if its lock can't be written right after the rename", async () => {
  const { dir, repo } = fixture("lock-fails");
  // It can't be made (EACCES), or it's made and writing it fails (ENOSPC): either way nothing of it is left.
  for (const [n, failing] of [[1, "openSync"], [2, "writeSync"]] as const) {
    const wt = (await createSessionWorktree(repo, path.join(dir, "worktrees"), `k${n}`))!;
    const real = fs[failing] as (...args: unknown[]) => unknown;
    let lockFd: number | undefined;
    const openSync = fs.openSync;
    fs.openSync = ((file: fs.PathLike, ...rest: unknown[]) => {
      const fd = (openSync as (...args: unknown[]) => number)(file, ...rest);
      if (String(file).includes("-mypi-retired-") && String(file).endsWith("/locked")) lockFd = fd;
      return fd;
    }) as typeof fs.openSync;
    (fs as unknown as Record<string, unknown>)[failing] = (...args: unknown[]) => {
      const lock = failing === "openSync" ? String(args[0]).includes("-mypi-retired-") && String(args[0]).endsWith("/locked")
        : args[0] === lockFd;
      if (lock) throw Object.assign(new Error(`${failing === "openSync" ? "EACCES" : "ENOSPC"}: failed`), { code: "E" });
      return failing === "openSync" ? (openSync as (...a: unknown[]) => number)(...args) : real(...args);
    };
    try {
      await assert.rejects(removeSessionWorktree(wt), /EACCES|ENOSPC/);
    } finally {
      fs.openSync = openSync;
      (fs as unknown as Record<string, unknown>)[failing] = real;
    }
    assert.equal(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD"), wt.branch, "the checkout works as before");
    const entry = git(repo, "worktree", "list", "--porcelain").split("\n\n").find((b) => b.split("\n")[0].endsWith(`/${path.basename(wt.path)}`));
    assert.ok(entry && !entry.includes("locked"), `${failing}: ${entry}`);
    // And a later try, once it can, removes it.
    assert.equal((await removeSessionWorktree(wt)).removed, true, failing);
  }
});

it("never deletes through a symbolic ref: a session branch that's an alias of main", async () => {
  const { dir, repo } = fixture("symbolic");
  const wt = (await createSessionWorktree(repo, path.join(dir, "worktrees"), "s1"))!;
  git(repo, "symbolic-ref", `refs/heads/${wt.branch}`, "refs/heads/main");
  assert.equal((await removeSessionWorktree(wt)).branchDeleted, false);
  assert.ok(hasBranch(repo, "main"), "main is still there");
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
});

it("says how to put back a commit made on the branch while it was being deleted, and only then", async () => {
  const { dir, repo, upstream } = fixture("root-commit");
  const wt = (await createSessionWorktree(repo, path.join(dir, "worktrees"), "c1"))!;
  const tip = git(repo, "rev-parse", wt.branch);
  // A checkout of it that was still under way when it was deleted, then a commit there: one without history.
  const bin = path.join(dir, "bin");
  write(path.join(bin, "git"), `#!/bin/sh\n/usr/bin/git "$@"\nrc=$?\ncase "$*" in *"--no-deref -d"*) cd "${repo}" && ` +
    `/usr/bin/git symbolic-ref HEAD refs/heads/${wt.branch} && echo w > w.txt && /usr/bin/git add w.txt && /usr/bin/git rm -qf README.md && ` +
    `/usr/bin/git commit -qm owner;; esac\nexit $rc\n`);
  fs.chmodSync(path.join(bin, "git"), 0o755);
  const warned: string[] = [];
  const [savedPath, warn] = [process.env.PATH, console.warn];
  process.env.PATH = `${bin}:${savedPath}`;
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
  try {
    assert.equal((await removeSessionWorktree(wt)).branchDeleted, false);
  } finally {
    process.env.PATH = savedPath;
    console.warn = warn;
  }
  assert.equal(git(repo, "log", "-1", "--format=%s", wt.branch), "owner", "the owner's commit is there");
  const owner = git(repo, "rev-parse", wt.branch);
  const advice = warned.map((w) => /`(git update-ref .*)`$/.exec(w)?.[1]).find(Boolean);
  assert.ok(advice, warned.join("\n"));
  // And that command does it: the same files (README.md stays deleted) and message, on top of the tip.
  execFileSync("sh", ["-c", advice!], { cwd: repo, stdio: "pipe" });
  assert.equal(git(repo, "rev-parse", `${wt.branch}~1`), tip);
  assert.equal(git(repo, "rev-parse", `${wt.branch}^{tree}`), git(repo, "rev-parse", `${owner}^{tree}`));
  assert.equal(git(repo, "log", "-1", "--format=%s", wt.branch), "owner");
  git(repo, "checkout", "-q", "-f", "main");

  // Moved back to an older commit just before the delete: the delete is refused, and there's nothing to put back.
  upstream("r.txt", "r\n");
  const wt2 = (await createSessionWorktree(repo, path.join(dir, "worktrees"), "c2"))!;
  const b2 = `refs/heads/${wt2.branch}`;
  write(path.join(bin, "git"), `#!/bin/sh\ncase "$*" in *"--no-deref -d"*) (cd "${repo}" && /usr/bin/git update-ref ${b2} ${b2}~1);; esac\nexec /usr/bin/git "$@"\n`);
  warned.length = 0;
  process.env.PATH = `${bin}:${savedPath}`;
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
  try {
    assert.equal((await removeSessionWorktree(wt2)).branchDeleted, false);
  } finally {
    process.env.PATH = savedPath;
    console.warn = warn;
  }
  assert.equal(git(repo, "rev-parse", wt2.branch), git(repo, "rev-parse", `${wt2.baseCommit}~1`));
  assert.deepEqual(warned.filter((w) => w.includes("made again")), []);

  // Deleted, then made again by an amended commit (it has a parent, just not the old tip): its history is fine.
  const wt3 = (await createSessionWorktree(repo, path.join(dir, "worktrees"), "c3"))!;
  const tip3 = git(repo, "rev-parse", wt3.branch);
  write(path.join(bin, "git"), `#!/bin/sh\n/usr/bin/git "$@"\nrc=$?\ncase "$*" in *"--no-deref -d"*) cd "${repo}" && ` +
    `n=$(/usr/bin/git commit-tree -p ${tip3}~1 -m amended "${tip3}^{tree}") && /usr/bin/git update-ref refs/heads/${wt3.branch} $n;; esac\nexit $rc\n`);
  warned.length = 0;
  process.env.PATH = `${bin}:${savedPath}`;
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
  try {
    assert.equal((await removeSessionWorktree(wt3)).branchDeleted, false);
  } finally {
    process.env.PATH = savedPath;
    console.warn = warn;
  }
  assert.equal(git(repo, "log", "-1", "--format=%s", wt3.branch), "amended");
  assert.deepEqual(warned.filter((w) => w.includes("made again")), []);
});

it("keeps an old detached commit even if git's prune and gc run just as the metadata is renamed", async () => {
  const { dir, repo } = fixture("old-detached");
  const wt = (await createSessionWorktree(repo, path.join(dir, "worktrees"), "o1"))!;
  git(wt.path, "checkout", "-q", "--detach");
  write(path.join(wt.path, "o.txt"), "o\n");
  git(wt.path, "add", "-A");
  git(wt.path, "commit", "-qm", "old detached");
  const old = git(wt.path, "rev-parse", "HEAD");
  // Three weeks old, past gc's two-week grace for objects nothing reaches.
  const common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const aged = new Date(Date.now() - 21 * 86_400_000);
  fs.utimesSync(path.join(common, "objects", old.slice(0, 2), old.slice(2)), aged, aged);
  const rename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    rename(from, to);
    if (String(to).includes("mypi-retired")) {
      execFileSync("git", ["worktree", "prune"], { cwd: repo, stdio: "pipe" });
      execFileSync("git", ["gc", "-q"], { cwd: repo, stdio: "pipe" });
    }
  }) as typeof fs.renameSync;
  try {
    assert.equal((await removeSessionWorktree(wt, { force: true })).removed, true);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(git(repo, "rev-parse", `${wt.branch}-detached`), old);
  assert.equal(git(repo, "log", "-1", "--format=%s", old), "old detached");
  // Confirmed, so nothing of it is kept: no locked entry left behind in git's list.
  assert.equal(git(repo, "worktree", "list", "--porcelain").includes(path.basename(wt.path)), false);
});

it("keeps a detached commit and a moved branch in SHA-256 and reftable repositories too", async () => {
  for (const format of [["--object-format=sha256"], ["--ref-format=reftable"]]) {
    const { dir, repo } = fixture(`format-${format[0].slice(2, 5)}`, format);
    const root = path.join(dir, "worktrees");
    const wt = (await createSessionWorktree(repo, root, "f1"))!;
    git(wt.path, "checkout", "-q", "--detach");
    write(path.join(wt.path, "d.txt"), "d\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-qm", "detached");
    const detached = git(wt.path, "rev-parse", "HEAD");
    assert.equal((await removeSessionWorktree(wt, { force: true })).removed, true, format[0]);
    assert.equal(git(repo, "rev-parse", `${wt.branch}-detached`), detached, format[0]);

    // The branch moves just before it's deleted: what git deleted is put back, whatever the id's length.
    const wt2 = (await createSessionWorktree(repo, root, "f2"))!;
    const bin = path.join(dir, "bin");
    const ref = `refs/heads/${wt2.branch}`;
    write(path.join(bin, "git"), `#!/bin/sh\ncase "$*" in *"--no-deref -d"*) cd "${repo}" && n=$(/usr/bin/git commit-tree -p ${ref} -m later "${ref}^{tree}") && /usr/bin/git update-ref ${ref} $n;; esac\nexec /usr/bin/git "$@"\n`);
    fs.chmodSync(path.join(bin, "git"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      assert.equal((await removeSessionWorktree(wt2)).branchDeleted, false, format[0]);
    } finally {
      process.env.PATH = savedPath;
    }
    assert.equal(git(repo, "log", "-1", "--format=%s", wt2.branch), "later", format[0]);
  }
});

it("keeps ignored files in build folders, finds a removed worktree under another spelling, and owns only its own rollback", async () => {
  const { dir, repo, upstream } = fixture("second");
  upstream(".gitignore", "build/\n*.log\nnode_modules/\n");
  const wtRoot = path.join(dir, "worktrees");
  const a = (await createSessionWorktree(repo, wtRoot, "a1"))!;
  write(path.join(a.path, "build/.env"), "ONLY=here\n");
  write(path.join(a.path, "experiments/training.log"), "results\n");
  write(path.join(a.path, "node_modules/x/index.js"), "x\n");
  assert.equal((await worktreeWork(a)).ignored, 2, "build/ and the log are work; node_modules isn't");

  // The catalog has a spelling git doesn't (a symlinked data folder; on macOS /var is /private/var).
  const alias = path.join(dir, "alias");
  fs.symlinkSync(wtRoot, alias);
  const b = (await createSessionWorktree(repo, wtRoot, "b2"))!;
  const aliased = { ...b, path: path.join(alias, path.basename(b.path)) };
  git(b.path, "checkout", "-q", "--detach");
  write(path.join(b.path, "d.md"), "d\n");
  git(b.path, "add", "-A");
  git(b.path, "commit", "-qm", "detached");
  fs.rmSync(b.path, { recursive: true, force: true });
  assert.equal((await worktreeWork(aliased)).unpushed, 1, "its HEAD is still found");
  assert.equal((await removeSessionWorktree(aliased, { force: true })).removed, true);
  assert.equal(git(repo, "log", "-1", "--format=%s", `${b.branch}-detached`), "detached");

  // The whole worktrees folder deleted, under a symlinked path: found through the nearest folder still there. Then the
  // symlink too: found by its folder name, which carries the session id.
  const real = path.join(dir, "real");
  fs.mkdirSync(real);
  const link = path.join(dir, "link");
  fs.symlinkSync(real, link);
  const d = (await createSessionWorktree(repo, path.join(real, "wts"), "d4"))!;
  const linked = { ...d, path: path.join(link, "wts", path.basename(d.path)) };
  git(d.path, "checkout", "-q", "--detach");
  write(path.join(d.path, "d4.md"), "d4\n");
  git(d.path, "add", "-A");
  git(d.path, "commit", "-qm", "detached d4");
  fs.rmSync(path.join(real, "wts"), { recursive: true, force: true });
  assert.equal((await worktreeWork(linked)).unpushed, 1, "through the link");
  fs.rmSync(link);
  assert.equal((await worktreeWork(linked)).unpushed, 1, "by name");
  assert.equal((await removeSessionWorktree(linked, { force: true })).removed, true);
  assert.equal(git(repo, "log", "-1", "--format=%s", `${d.branch}-detached`), "detached d4");

  // A registration left behind (its folder deleted, its branch gone) is someone's: a create there is refused, and
  // leaves it registered.
  const e = (await createSessionWorktree(repo, wtRoot, "e5"))!;
  git(e.path, "checkout", "-q", "--detach");
  git(repo, "branch", "-D", e.branch);
  fs.rmSync(e.path, { recursive: true, force: true });
  await assert.rejects(createSessionWorktree(repo, wtRoot, "e5"), /already exists/);
  assert.ok(git(repo, "worktree", "list", "--porcelain").includes(path.basename(e.path)));

  // A second create with the same id fails, and leaves the first one's branch and folder alone.
  const first = (await createSessionWorktree(repo, wtRoot, "c3"))!;
  fs.writeFileSync(path.join(first.path, "keep.txt"), "k\n");
  git(repo, "update-ref", "-d", "refs/heads/mypi/c3"); // the precheck passes, as in a race; worktree add then fails
  await assert.rejects(createSessionWorktree(repo, wtRoot, "c3"), /already exists/);
  assert.ok(fs.existsSync(path.join(first.path, "keep.txt")));
});
