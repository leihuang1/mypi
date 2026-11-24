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
  // More than one: can't tell which is this session's, and "none" would read as nothing there to keep.
  if (named.length > 1) throw new Error(`Several missing worktrees are named ${path.basename(target)}: can't tell which is ${target}`);
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
/** Where an unconfirmed removal moves a checkout: beside it, in a folder of mypi's own. */
const TRASH = ".mypi-trash";

/** Housekeeping that mustn't undo what's done: a failure is logged, not thrown. */
function tidy(what: string, run: () => void): void {
  try {
    run();
  } catch (err) {
    console.warn(`[mypi-server] Couldn't ${what}: ${firstLine(err)}`);
  }
}

/** Marks a worktree's metadata folder that a removal kept (see `removeSessionWorktree`): only those are expired. */
const RETIRED = "mypi-retired";

/**
 * What removal put in `dir` over a week ago: names it gave (`<name>-<13 digits>`, the time in ms), and with
 * `marked`, only folders holding that file.
 */
function emptyTrash(dir: string, marked?: string): void {
  let names: string[] = [];
  tidy(`list ${dir}`, () => { names = fs.existsSync(dir) ? fs.readdirSync(dir) : []; });
  for (const name of names) {
    const at = Number(/^.+-(\d{13})$/.exec(name)?.[1]);
    if (at && Date.now() - at > TRASH_DAYS * 86_400_000 && (!marked || fs.existsSync(path.join(dir, name, marked)))) {
      tidy(`empty ${path.join(dir, name)}`, () => fs.rmSync(path.join(dir, name), { recursive: true, force: true }));
    }
  }
}

/** Whether git knows the session's folder as its worktree: a folder put at its path since isn't. */
export async function isSessionWorktree(worktree: SessionWorktree): Promise<boolean> {
  return (await registration(worktree)) !== undefined;
}

/** The worktree's own metadata folder in the git dir (`worktrees/<name>`), found by the checkout path it records. */
function metadataDir(commonDir: string, checkout: string): string | undefined {
  const root = path.join(commonDir, "worktrees");
  for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const file = path.join(root, name, "gitdir");
    const recorded = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
    if (recorded && path.dirname(path.resolve(root, name, recorded)) === path.resolve(checkout)) return path.join(root, name);
  }
  return undefined;
}

/** Git's metadata for a worktree, back where it was (its folder made again if something removed it). */
function restore(retired: string, meta: string): void {
  fs.mkdirSync(path.dirname(meta), { recursive: true });
  fs.renameSync(retired, meta);
}

/** Why the worktree with this metadata mustn't be removed, confirmed or not. */
function refusal(meta: string): string | undefined {
  if (fs.existsSync(path.join(meta, "locked"))) return "git 不让移除这个工作区（它被 git worktree lock 锁住了），先在电脑上解锁";
  if (fs.existsSync(path.join(meta, "modules"))) return "这个工作区里有子模块，它们的提交可能只在这里：请在电脑上处理后再移除";
  return undefined;
}

/**
 * Remove the worktree when it holds nothing uncommitted, ignored or unpushed, or when `force` (an Archive the user
 * confirmed) says to drop those files. Commits are never lost to it:
 * - git's metadata for the worktree is first renamed beside itself (`worktrees/<name>-mypi-retired-<ms>`): the
 *   checkout no longer finds it, so nothing can be committed or staged there from then on, and the HEAD read next is
 *   final; commits on a detached HEAD are kept on `<branch>-detached`. Git still counts the renamed folder as a
 *   worktree (locked, so `git worktree prune` leaves it), so its HEAD, index and reflog keep everything they reach
 *   from gc the whole time, and for the week it's kept;
 * - the branch is deleted only when the exact tip checked is in a commit known to be safe (`backedUp`), only if it
 *   still points there, and not while it's checked out anywhere (put back if it was checked out meanwhile).
 * A locked worktree, or one holding submodule repositories (their commits may exist nowhere else), is refused
 * whatever `force` says: `blocked` says why. A folder at the path that git doesn't know as this worktree is left
 * alone: `unregistered`. Without `force` the checkout is moved to `.mypi-trash/` beside it, not deleted, so a file
 * written after the count is there for a week, and git lists it there as a locked worktree. Throws, removing
 * nothing, when the work can't be checked. `pushed`: the head GitHub merged, if known.
 */
export async function removeSessionWorktree(
  worktree: SessionWorktree,
  options: { force?: boolean; pushed?: string } = {},
): Promise<{ removed: boolean; branchDeleted: boolean; work: WorktreeWork; blocked?: string; unregistered?: boolean }> {
  const gitDir = gitDirOf(worktree);
  const registered = await registration(worktree);
  if (!registered && fs.existsSync(worktree.path)) {
    // A folder git doesn't know as this worktree: not ours to count or delete. The branch stays.
    return { removed: false, branchDeleted: false, work: { exists: true, uncommitted: 0, ignored: 0, unpushed: 0 }, unregistered: true };
  }
  const { work, disposable: regenerable } = await inspect(worktree, options.pushed);
  const kept = (blocked?: string) => ({ removed: false, branchDeleted: false, work, ...(blocked ? { blocked } : {}) });
  if (!options.force && work.uncommitted + work.ignored + work.unpushed > 0) return kept();
  const safe = [worktree.baseCommit, worktree.baseRef, options.pushed];
  const checkout = registered?.dir ?? worktree.path;

  let meta: string | undefined;
  let retired: string | undefined;
  let moved: string | undefined;
  let head = "";
  if (registered) {
    const common = await git(gitDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    meta = metadataDir(common, registered.dir);
    if (!meta) throw new Error(`Can't find git's metadata for the worktree at ${registered.dir}`);
    const refused = refusal(meta);
    if (refused) return kept(refused);
    retired = `${meta}-${RETIRED}-${Date.now()}`;
    fs.renameSync(meta, retired);
    // Checked again where nothing can change it any more: a submodule added or a lock taken just before the rename.
    const late = refusal(retired);
    if (late) {
      restore(retired, meta);
      return kept(late);
    }
    fs.writeFileSync(path.join(retired, "locked"),
      `mypi removed this worktree; kept until ${new Date(Date.now() + TRASH_DAYS * 86_400_000).toISOString()}\n`);
  }
  try {
    // HEAD as git resolves it from the renamed metadata: any object format, any ref storage (reftable's HEAD file
    // isn't the commit). Not resolving is fine only for a branch with no commits yet.
    if (retired) head = await git(gitDir, ["--git-dir", retired, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).catch(() => "");
    if (retired && !head && !(await git(gitDir, ["--git-dir", retired, "symbolic-ref", "-q", "HEAD"]).then(() => true, () => false))) {
      throw new Error(`Can't read the HEAD of the worktree at ${checkout}`);
    }
    if (head && !(await backedUp(gitDir, head, safe)) &&
      !(await git(gitDir, ["branch", "--contains", head, "--format=%(refname)"]))) {
      const taken = await hasRef(gitDir, `refs/heads/${worktree.branch}-detached`);
      await git(gitDir, ["branch", `${worktree.branch}-detached${taken ? `-${head.slice(0, 8)}` : ""}`, head]);
    }
    if (fs.existsSync(checkout) && options.force) {
      fs.rmSync(checkout, { recursive: true, force: true });
    } else if (fs.existsSync(checkout)) {
      fs.mkdirSync(path.join(path.dirname(checkout), TRASH), { recursive: true });
      moved = path.join(path.dirname(checkout), TRASH, `${path.basename(checkout)}-${Date.now()}`);
      fs.renameSync(checkout, moved);
    }
  } catch (err) {
    // Not moved (or a forced delete stopped partway): the checkout is still there, so its metadata goes back.
    if (retired && meta) {
      try {
        fs.rmSync(path.join(retired, "locked"), { force: true });
        restore(retired, meta);
      } catch (again) {
        throw new Error(`${firstLine(err)}; and git's metadata for ${checkout} couldn't be put back from ${retired}: ${firstLine(again)}`);
      }
    }
    throw err;
  }
  // From here the checkout is in trash whatever happens: housekeeping can fail, but doesn't undo that.
  if (retired && options.force) {
    // Confirmed: what it held goes, as with `git worktree remove --force`. Its commits are on branches by now.
    tidy(`delete ${retired}`, () => fs.rmSync(retired!, { recursive: true, force: true }));
  } else if (retired) {
    tidy(`mark ${retired}`, () => fs.writeFileSync(path.join(retired!, RETIRED), ""));
    // Recorded where the checkout went, so it isn't taken for the session's worktree any more, and detached at its
    // commit, so the branch isn't checked out in it and can go.
    tidy(`point ${retired} at the trash`, () => fs.writeFileSync(path.join(retired!, "gitdir"), `${path.join(moved ?? retired!, ".git")}\n`));
    if (head) {
      await git(gitDir, ["--git-dir", retired, "update-ref", "--no-deref", "-m", "mypi: removed", "HEAD", head])
        .catch((err) => console.warn(`[mypi-server] Couldn't detach the HEAD of ${retired}: ${firstLine(err)}`));
    }
  }
  if (moved) {
    for (const p of regenerable) tidy(`delete ${p} from ${moved}`, () => fs.rmSync(path.join(moved!, p), { recursive: true, force: true }));
    emptyTrash(path.dirname(moved));
  }
  if (retired) emptyTrash(path.dirname(retired), RETIRED);

  const ref = `refs/heads/${worktree.branch}`;
  // An alias of another branch (a symbolic ref) isn't the session's branch: deleting it isn't ours to do.
  if (await git(gitDir, ["symbolic-ref", "-q", ref]).then(() => true, () => false)) return { removed: true, branchDeleted: false, work };
  const tip = await git(gitDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => "");
  if (!tip || !(await backedUp(gitDir, tip, safe))) return { removed: true, branchDeleted: false, work };
  const checkedOut = async () =>
    (await git(gitDir, ["worktree", "list", "--porcelain", "-z"]).catch(() => `branch ${ref}`)).split("\0").includes(`branch ${ref}`);
  if (await checkedOut()) return { removed: true, branchDeleted: false, work };
  // Only if it still points at the tip checked: a commit made meanwhile keeps it.
  const deleted = await git(gitDir, ["update-ref", "--no-deref", "-d", ref, tip]).then(() => true, () => false);
  const now = await git(gitDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => "");
  if (now) {
    // Moved, so kept. Or deleted and then made again, by a commit in a checkout of it that was still under way: that
    // commit had no branch to build on. Rebasing puts it on its history (not done here: it's the owner's commit).
    if (deleted && !(await git(gitDir, ["merge-base", "--is-ancestor", tip, now]).then(() => true, () => false))) {
      console.warn(`[mypi-server] ${worktree.branch} was made again at ${now} while being deleted, by a commit that ` +
        `doesn't build on ${tip}; if it should, \`git rebase --root --onto ${tip} ${worktree.branch}\``);
    }
    return { removed: true, branchDeleted: false, work };
  }
  if (await checkedOut()) {
    // Checked out somewhere in the moment between: put it back. Its commits are safe either way (the tip is backed up).
    await git(gitDir, ["branch", worktree.branch, tip])
      .catch((err) => console.warn(`[mypi-server] ${worktree.branch} was checked out while being deleted, and couldn't be put back at ${tip}: ${firstLine(err)}`));
    return { removed: true, branchDeleted: false, work };
  }
  // Said, with its commit: a checkout of it still under way (no check can see one) is left on a deleted branch.
  console.log(`[mypi-server] Deleted ${worktree.branch} at ${tip}: everything on it is in its base or its merged PR`);
  return { removed: true, branchDeleted: true, work };
}
