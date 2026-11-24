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
// Dependencies, build output and tool caches only; an ignored log or data file may be the only record of something.
const DISPOSABLE = new Set(["node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  "dist", "build", "target", ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache", "coverage", ".gradle",
  ".DS_Store"]);
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
  fs.mkdirSync(root, { recursive: true });
  try {
    // --no-track: the branch's upstream is set when Ship first pushes it, not to the base it started from. No hooks: a
    // post-checkout hook that needs the new checkout's dependencies would fail every session in that repo.
    await git(gitDir, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--quiet", "--no-track", "-b", branch, worktreePath, baseCommit],
      { timeout: 120_000 });
  } catch (err) {
    // A checkout can fail halfway (a filter), leaving the new branch or worktree: both hold only the base, so drop them.
    await git(gitDir, ["worktree", "remove", "--force", worktreePath]).catch(() => "");
    await git(gitDir, ["branch", "-D", branch]).catch(() => "");
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

/** The worktree's registration and its HEAD, which git keeps even when the folder was deleted by hand. */
async function registration(worktree: SessionWorktree): Promise<{ head?: string } | undefined> {
  const list = await git(gitDirOf(worktree), ["worktree", "list", "--porcelain"]);
  const target = path.resolve(worktree.path);
  const real = fs.existsSync(target) ? fs.realpathSync(target) : target;
  for (const entry of list.split("\n\n")) {
    const lines = entry.split("\n");
    const dir = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (dir && (path.resolve(dir) === target || path.resolve(dir) === real)) {
      return { head: lines.find((l) => l.startsWith("HEAD "))?.slice("HEAD ".length) };
    }
  }
  return undefined;
}

/** `pushed`: a commit known to be on GitHub (the one Ship pushed), for when its remote branch is gone. */
export async function worktreeWork(worktree: SessionWorktree, pushed?: string): Promise<WorktreeWork> {
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
    exists,
    uncommitted: records.length - ignored.length,
    ignored: ignored.filter((p) => !disposable(p)).length,
    unpushed: Number(unpushed),
  };
}

/**
 * Remove the worktree and its branch when they hold nothing that exists elsewhere; otherwise leave both, so work is
 * never lost. `force` (an Archive the user confirmed) removes the worktree with its uncommitted and ignored files, but
 * still keeps a branch with unpushed commits. `keepBranch`: remove only the worktree. A locked worktree stays. Throws,
 * removing nothing, when that can't be checked.
 */
export async function removeSessionWorktree(
  worktree: SessionWorktree,
  options: { force?: boolean; pushed?: string; keepBranch?: boolean } = {},
): Promise<{ removed: boolean; branchDeleted: boolean; work: WorktreeWork }> {
  const work = await worktreeWork(worktree, options.pushed);
  if (!options.force && work.uncommitted + work.ignored + work.unpushed > 0) return { removed: false, branchDeleted: false, work };
  const registered = await registration(worktree);
  if (registered?.head && work.unpushed > 0 &&
    !(await git(gitDirOf(worktree), ["branch", "--contains", registered.head, "--format=%(refname)"]))) {
    // Commits on a detached HEAD go with the worktree's HEAD: keep them on a branch of their own.
    await git(gitDirOf(worktree), ["branch", `${worktree.branch}-detached`, registered.head]);
  }
  if (registered) {
    // Without --force, git checks once more and refuses if a file appeared since the count above. --force only when
    // the user confirmed, or the folder is already gone (its registration remains); it still refuses a locked one.
    const force = options.force || !work.exists ? ["--force"] : [];
    await git(gitDirOf(worktree), ["worktree", "remove", ...force, worktree.path]).catch(() => "");
    if (await registration(worktree)) return { removed: false, branchDeleted: false, work };
  } else if (work.exists) {
    return { removed: false, branchDeleted: false, work }; // a folder git doesn't know as this worktree: not ours to delete
  }
  if (work.unpushed > 0 || options.keepBranch) return { removed: true, branchDeleted: false, work };
  // -D: a squash- or rebase-merged branch is not an ancestor of anything, yet nothing on it is unpushed.
  await git(gitDirOf(worktree), ["branch", "-D", worktree.branch]).catch(() => "");
  return { removed: true, branchDeleted: !(await hasRef(gitDirOf(worktree), `refs/heads/${worktree.branch}`)), work };
}
