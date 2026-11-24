import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A session's own checkout: branch `mypi/<id>` in `<data>/worktrees`, started from a fresh `origin/<default>`. */
export interface SessionWorktree {
  /** The folder the session was started from. Its checkout is never touched. */
  sourceCwd: string;
  /** Root of the checkout `sourceCwd` is in, which may itself be a worktree that goes away. */
  repoPath: string;
  /** The repository's shared git directory, which outlives every checkout: git maintenance runs here. */
  gitDir?: string;
  /** Root of the worktree. */
  path: string;
  branch: string;
  /** What the branch started from, and what its changes are measured against. */
  baseRef: string;
  /** The commit it started at: a base that can't move or vanish, for when `baseRef` does. */
  baseCommit?: string;
}

/** What a worktree holds that exists nowhere else. */
export interface WorktreeWork {
  exists: boolean;
  /** Changed, staged and untracked paths. */
  uncommitted: number;
  /** Ignored files that aren't regenerable output (an `.env`, notes, data). */
  ignored: number;
  /** Commits on the branch, or on whatever the worktree has checked out, that neither a remote branch nor the base has. */
  unpushed: number;
}

// The daemon may inherit a repository selection (a launcher run from a git hook); every git command here names its own.
export const REPO_SELECTORS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_PREFIX"];

/** The daemon's environment for git, built per call so it is the current one. */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const name of REPO_SELECTORS) delete env[name];
  return env;
}

/** Network operations must fail rather than wait for a password: the daemon has no terminal. */
export const networkEnv = () => gitEnv({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" });

// Regenerable output that cleanup may delete with a worktree. Any other ignored file counts as work.
// Installed dependencies and tool caches only. Build folders (build/, dist/, target/) can hold a local .env or results,
// and an ignored log may be the only record of a run, so they count as work.
const DISPOSABLE = new Set(["node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".next", ".nuxt", ".turbo", ".parcel-cache", ".gradle", ".DS_Store"]);
const DISPOSABLE_FILE = /\.(pyc|tsbuildinfo)$/;

function disposable(ignoredPath: string): boolean {
  const parts = ignoredPath.replace(/\/$/, "").split("/");
  return parts.some((part) => DISPOSABLE.has(part)) || DISPOSABLE_FILE.test(parts.at(-1) ?? "");
}

async function git(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: options.env ?? gitEnv(),
    timeout: options.timeout ?? 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.replace(/\n$/, "");
}

function firstLine(err: unknown): string {
  const stderr = (err as { stderr?: string }).stderr?.trim();
  return (stderr || (err instanceof Error ? err.message : String(err))).split("\n")[0];
}

async function hasRef(cwd: string, ref: string): Promise<boolean> {
  return git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then(() => true, () => false);
}

/**
 * The ref a new session branches from: origin's default branch after a fetch, or, in a repo without `origin`, the
 * current branch. A failed fetch (offline, no access) falls back to the last fetched state.
 */
async function baseFor(repoPath: string): Promise<string> {
  const remotes = (await git(repoPath, ["remote"])).split("\n");
  if (!remotes.includes("origin")) {
    return (await git(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")) || git(repoPath, ["rev-parse", "HEAD"]);
  }
  try {
    // followRemoteHEAD: the fetch also moves origin/HEAD when the remote's default branch changed (git 2.48+).
    await git(repoPath, ["-c", "remote.origin.followRemoteHEAD=always", "fetch", "--quiet", "--prune", "origin"],
      { env: networkEnv(), timeout: 30_000 });
  } catch (err) {
    console.warn(`[mypi-server] git fetch failed in ${repoPath}, so the session starts from the last fetched origin: ${firstLine(err)}`);
  }
  const originHead = async () => git(repoPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
  let head = await originHead();
  if (!head || !(await hasRef(repoPath, head))) {
    // Missing (a remote added after the clone), or pointing at a branch that's gone: ask the remote.
    await git(repoPath, ["remote", "set-head", "origin", "--auto"], { env: networkEnv(), timeout: 15_000 }).catch(() => "");
    head = await originHead();
  }
  if (head && (await hasRef(repoPath, head))) return head;
  for (const ref of ["origin/main", "origin/master"]) {
    if (await hasRef(repoPath, ref)) return ref;
  }
  throw new Error(`Can't tell origin's default branch in ${repoPath}. Run \`git remote set-head origin --auto\` there and retry.`);
}

/**
 * Create the worktree a new session in `cwd` works in. Returns `undefined`, and the session works in `cwd` itself, when
 * `cwd` is not in a git work tree or the repository has no commit to branch from.
 */
export async function createSessionWorktree(cwd: string, root: string, id: string): Promise<SessionWorktree | undefined> {
  let repoPath: string;
  let gitDir: string;
  try {
    if ((await git(cwd, ["rev-parse", "--is-inside-work-tree"])) !== "true") return undefined;
    repoPath = await git(cwd, ["rev-parse", "--show-toplevel"]);
    gitDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  } catch {
    return undefined;
  }
  if (!(await hasRef(repoPath, "HEAD"))) return undefined;

  const baseRef = await baseFor(repoPath);
  const baseCommit = await git(repoPath, ["rev-parse", `${baseRef}^{commit}`]);
  const branch = `mypi/${id}`;
  if (await hasRef(gitDir, `refs/heads/${branch}`)) throw new Error(`Branch ${branch} already exists in ${repoPath}`);
  const worktreePath = path.join(root, `${path.basename(repoPath).replace(/[^\w.-]+/g, "-")}-${id}`);
  // Someone else's: a folder, or a registration whose folder was deleted (it may hold the only ref to a commit).
  // Refused before anything is made, so the rollback below never touches them.
  const taken = { sourceCwd: cwd, repoPath, gitDir, path: worktreePath, branch, baseRef };
  if (fs.existsSync(worktreePath) || (await registration(taken))) throw new Error(`A worktree already exists at ${worktreePath}`);
  fs.mkdirSync(root, { recursive: true });
  try {
    // --no-track: the branch's upstream is set when Ship first pushes it, not to the base it started from. No hooks: a
    // post-checkout hook that needs the new checkout's dependencies would fail every session in that repo.
    await git(gitDir, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--quiet", "--no-track", "-b", branch, worktreePath, baseCommit],
      { timeout: 120_000 });
  } catch (err) {
    // A checkout can fail halfway (a filter), leaving the new branch or worktree: both hold only the base, so drop
    // them. Not when the branch or folder already existed: another attempt made those.
    if (!/already exists/.test(String((err as { stderr?: string }).stderr))) {
      await git(gitDir, ["worktree", "remove", "--force", worktreePath]).catch(() => "");
      await git(gitDir, ["branch", "-D", branch]).catch(() => "");
    }
    throw err;
  }
  return { sourceCwd: cwd, repoPath, gitDir, path: worktreePath, branch, baseRef, baseCommit };
}

/** The session's working directory: the folder it was started from, at the same place in its worktree. */
export function worktreeCwd(worktree: SessionWorktree): string {
  const relative = path.relative(fs.realpathSync(worktree.repoPath), fs.realpathSync(worktree.sourceCwd));
  const dir = path.join(worktree.path, relative);
  return fs.existsSync(dir) ? dir : worktree.path;
}

/** Where git maintenance runs: the shared git directory (catalogs from before it was recorded: the checkout). */
const gitDirOf = (worktree: SessionWorktree) => worktree.gitDir ?? worktree.repoPath;

/** The worktree's registration: its HEAD, which git keeps even when the folder was deleted by hand, and its path as git spelled it. */
async function registration(worktree: SessionWorktree): Promise<{ head?: string; dir: string } | undefined> {
  // -z: a path may contain a newline.
  const list = await git(gitDirOf(worktree), ["worktree", "list", "--porcelain", "-z"]);
  const target = path.resolve(worktree.path);
  // Git records the real path. For a folder that's gone, resolve the nearest one still there (/var is /private/var,
  // and the whole worktrees folder may have been deleted).
  let existing = target;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  const real = path.join(fs.realpathSync(existing), path.relative(existing, target));
  const entries = list.split("\0\0").map((entry) => {
    const fields = entry.split("\0");
    return {
      dir: fields.find((f) => f.startsWith("worktree "))?.slice("worktree ".length),
      head: fields.find((f) => f.startsWith("HEAD "))?.slice("HEAD ".length),
    };
  });
  const exact = entries.find((e) => e.dir && (path.resolve(e.dir) === target || path.resolve(e.dir) === real));
  if (exact) return { head: exact.head, dir: exact.dir! };
  // Its spelling can't be resolved any more (a symlink in it was removed): the one missing registration with the
  // same folder name, which carries the session id.
  if (fs.existsSync(target)) return undefined;
  const named = entries.filter((e) => e.dir && path.basename(e.dir) === path.basename(target) && !fs.existsSync(e.dir));
  return named.length === 1 ? { head: named[0].head, dir: named[0].dir! } : undefined;
}

/** `pushed`: a commit known to be on GitHub (the head it merged), for when its remote branch is gone. */
export async function worktreeWork(worktree: SessionWorktree, pushed?: string): Promise<WorktreeWork> {
  return (await inspect(worktree, pushed)).work;
}

async function inspect(worktree: SessionWorktree, pushed?: string): Promise<{ work: WorktreeWork; disposable: string[] }> {
  const exists = fs.existsSync(worktree.path);
  const status = exists
    ? await git(worktree.path, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal", "--ignored=matching"])
    : "";
  const records = status.split("\0").filter(Boolean);
  const ignored = records.filter((r) => r.startsWith("!! ")).map((r) => r.slice(3));

  // The branch, and the worktree's own HEAD (the agent may have switched or detached), against everything backed up.
  const tips: string[] = [];
  const head = (await registration(worktree))?.head;
  for (const tip of [`refs/heads/${worktree.branch}`, head]) if (tip && (await hasRef(gitDirOf(worktree), tip))) tips.push(tip);
  const known: string[] = [];
  for (const ref of [worktree.baseRef, worktree.baseCommit, pushed]) if (ref && (await hasRef(gitDirOf(worktree), ref))) known.push(ref);
  const unpushed = tips.length === 0 ? "0" : await git(gitDirOf(worktree), ["rev-list", "--count", ...tips, "--not", "--remotes", ...known]);
  return {
    work: {
      exists,
      uncommitted: records.length - ignored.length,
      ignored: ignored.filter((p) => !disposable(p)).length,
      unpushed: Number(unpushed),
    },
    disposable: ignored.filter(disposable),
  };
}

/**
 * Whether every commit on `tip` is in one known to be safe: the session's base, or `pushed` (the head GitHub merged).
 * Not tracking refs: they're this clone's last view of GitHub, and the branch there may have been replaced since.
 */
async function backedUp(gitDir: string, tip: string, safe: (string | undefined)[]): Promise<boolean> {
  for (const ref of safe) {
    if (ref && (await git(gitDir, ["merge-base", "--is-ancestor", tip, ref]).then(() => true, () => false))) return true;
  }
  return false;
}

const TRASH_DAYS = 7;

/** Old trash, by the time in its name: what an unconfirmed removal moved aside a week ago. */
function emptyTrash(trash: string): void {
  for (const name of fs.existsSync(trash) ? fs.readdirSync(trash) : []) {
    const at = Number(/-(\d+)$/.exec(name)?.[1]);
    if (at && Date.now() - at > TRASH_DAYS * 86_400_000) fs.rmSync(path.join(trash, name), { recursive: true, force: true });
  }
}

/**
 * Remove the worktree when it holds nothing uncommitted, ignored or unpushed, or when `force` (an Archive the user
 * confirmed) says to drop those files. Commits are never lost to it:
 * - the branch is deleted only when the exact tip checked is in a commit known to be safe (`backedUp`), and only if
 *   it still points there, so a commit made meanwhile keeps it;
 * - commits on a detached HEAD are kept on `<branch>-detached`.
 * Without `force` the folder is moved to `.trash/` beside it rather than deleted, so a file written after the count
 * is still there for a week. A locked worktree stays. Throws, removing nothing, when the work can't be checked.
 * `pushed`: the head GitHub merged, if known.
 */
export async function removeSessionWorktree(
  worktree: SessionWorktree,
  options: { force?: boolean; pushed?: string } = {},
): Promise<{ removed: boolean; branchDeleted: boolean; work: WorktreeWork }> {
  const gitDir = gitDirOf(worktree);
  const { work, disposable: regenerable } = await inspect(worktree, options.pushed);
  const kept = { removed: false, branchDeleted: false, work };
  if (!options.force && work.uncommitted + work.ignored + work.unpushed > 0) return kept;
  const safe = [worktree.baseCommit, worktree.baseRef, options.pushed];
  const ref = `refs/heads/${worktree.branch}`;
  // The tip, read once: the branch is deleted below only if it still points here.
  const tip = await git(gitDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => "");
  const registered = await registration(worktree);
  if (registered?.head && registered.head !== tip && !(await backedUp(gitDir, registered.head, safe)) &&
    !(await git(gitDir, ["branch", "--contains", registered.head, "--format=%(refname)"]))) {
    // Commits on a detached HEAD go with the worktree's HEAD: keep them on a branch of their own.
    const taken = await hasRef(gitDir, `${ref}-detached`);
    await git(gitDir, ["branch", `${worktree.branch}-detached${taken ? `-${registered.head.slice(0, 8)}` : ""}`, registered.head]);
  }
  if (registered) {
    const trashDir = path.join(path.dirname(worktree.path), ".trash");
    let moved: string | undefined;
    if (work.exists && !options.force) {
      fs.mkdirSync(trashDir, { recursive: true });
      moved = path.join(trashDir, `${path.basename(worktree.path)}-${Date.now()}`);
      fs.renameSync(worktree.path, moved);
    }
    // The folder is gone now (moved, or deleted by hand); only a confirmed removal deletes files itself.
    // By the path git recorded, which may be spelled differently from the catalog's.
    await git(gitDir, ["worktree", "remove", "--force", registered.dir]).catch(() => "");
    if (await registration(worktree)) {
      if (moved) fs.renameSync(moved, worktree.path); // locked: put it back
      // Counted again: what's there now, not what was there before the attempt.
      return { removed: false, branchDeleted: false, work: (await inspect(worktree, options.pushed)).work };
    }
    if (moved) {
      for (const p of regenerable) fs.rmSync(path.join(moved, p), { recursive: true, force: true });
      emptyTrash(trashDir);
    }
  } else if (work.exists) {
    return kept; // a folder git doesn't know as this worktree: not ours to delete
  }
  const elsewhere = (await git(gitDir, ["worktree", "list", "--porcelain", "-z"])).split("\0").includes(`branch ${ref}`);
  if (!tip || elsewhere || !(await backedUp(gitDir, tip, safe))) return { removed: true, branchDeleted: false, work };
  await git(gitDir, ["update-ref", "-d", ref, tip]).catch(() => "");
  return { removed: true, branchDeleted: !(await hasRef(gitDir, ref)), work };
}
