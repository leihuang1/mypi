import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A session's own checkout: branch `mypi/<id>` in `<data>/worktrees`, started from a fresh `origin/<default>`. */
export interface SessionWorktree {
  /** The folder the session was started from. Its checkout is never touched. */
  sourceCwd: string;
  /** Root of the repository `sourceCwd` is in. */
  repoPath: string;
  /** Root of the worktree. */
  path: string;
  branch: string;
  /** What the branch started from, and what its changes are measured against. */
  baseRef: string;
}

/** What a worktree holds that exists nowhere else. */
export interface WorktreeWork {
  exists: boolean;
  /** Changed, staged and untracked paths. */
  uncommitted: number;
  /** Commits on the branch that neither a remote branch nor the base has. */
  unpushed: number;
}

// Network operations must fail rather than wait for a password: the daemon has no terminal. Built per call, not at
// import, so it is the environment the daemon has now.
const networkEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" });

async function git(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: options.env ?? process.env,
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
    await git(repoPath, ["fetch", "--quiet", "--prune", "origin"], { env: networkEnv(), timeout: 60_000 });
  } catch (err) {
    console.warn(`[mypi-server] git fetch failed in ${repoPath}, so the session starts from the last fetched origin: ${firstLine(err)}`);
  }
  const originHead = async () => git(repoPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
  let head = await originHead();
  if (!head) {
    // Clones record origin/HEAD; a remote added later needs to be asked.
    await git(repoPath, ["remote", "set-head", "origin", "--auto"], { env: networkEnv(), timeout: 30_000 }).catch(() => "");
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
  try {
    if ((await git(cwd, ["rev-parse", "--is-inside-work-tree"])) !== "true") return undefined;
    repoPath = await git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return undefined;
  }
  if (!(await hasRef(repoPath, "HEAD"))) return undefined;

  const baseRef = await baseFor(repoPath);
  const branch = `mypi/${id}`;
  const worktreePath = path.join(root, `${path.basename(repoPath).replace(/[^\w.-]+/g, "-")}-${id}`);
  fs.mkdirSync(root, { recursive: true });
  // --no-track: the branch's upstream is set when Ship first pushes it, not to the base it started from.
  await git(repoPath, ["worktree", "add", "--quiet", "--no-track", "-b", branch, worktreePath, baseRef], { timeout: 120_000 });
  return { sourceCwd: cwd, repoPath, path: worktreePath, branch, baseRef };
}

/** The session's working directory: the folder it was started from, at the same place in its worktree. */
export function worktreeCwd(worktree: SessionWorktree): string {
  const relative = path.relative(fs.realpathSync(worktree.repoPath), fs.realpathSync(worktree.sourceCwd));
  const dir = path.join(worktree.path, relative);
  return fs.existsSync(dir) ? dir : worktree.path;
}

export async function worktreeWork(worktree: SessionWorktree): Promise<WorktreeWork> {
  const exists = fs.existsSync(worktree.path);
  const status = exists ? await git(worktree.path, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"]) : "";
  // The branch's commits, and HEAD's in case the agent switched branches, that no remote branch or the base has.
  const tips = [`refs/heads/${worktree.branch}`, ...(exists ? ["HEAD"] : [])];
  const present: string[] = [];
  for (const tip of tips) if (await hasRef(exists ? worktree.path : worktree.repoPath, tip)) present.push(tip);
  const base = (await hasRef(worktree.repoPath, worktree.baseRef)) ? [worktree.baseRef] : [];
  const unpushed = present.length === 0 ? "0"
    : await git(exists ? worktree.path : worktree.repoPath, ["rev-list", "--count", ...present, "--not", "--remotes", ...base]);
  return {
    exists,
    uncommitted: status.split("\0").filter(Boolean).length,
    unpushed: Number(unpushed),
  };
}

/**
 * Remove the worktree and its branch when they hold nothing that exists elsewhere; otherwise leave both, so work is
 * never lost. Throws, removing nothing, when that can't be checked.
 */
export async function removeSessionWorktree(worktree: SessionWorktree): Promise<{ removed: boolean; work: WorktreeWork }> {
  const work = await worktreeWork(worktree);
  if (work.uncommitted > 0 || work.unpushed > 0) return { removed: false, work };
  if (work.exists) await git(worktree.repoPath, ["worktree", "remove", worktree.path]);
  else await git(worktree.repoPath, ["worktree", "prune"]);
  // -D: a squash- or rebase-merged branch is not an ancestor of anything, yet nothing on it is unpushed.
  await git(worktree.repoPath, ["branch", "-D", worktree.branch]).catch(() => "");
  return { removed: true, work };
}
