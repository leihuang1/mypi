import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import type { PullRequestInfo } from "@mypi/shared";
import { ConflictError } from "./errors.js";
import { gitEnv, networkEnv as gitNetworkEnv, type SessionWorktree, worktreeWork } from "./worktree-service.js";

// The owner's hooks don't run for Ship: --no-verify skips pre-commit and pre-push, but not prepare-commit-msg (which
// can rewrite the message the user approved) or post-commit (an auto-sync hook would push past Ship's rule).
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

const execFileAsync = promisify(execFile);

// The daemon's own credentials, and nothing may wait for a terminal or print colour codes. Built per call, not at
// import, so it is the environment the daemon has now.
const networkEnv = () => ({ ...gitNetworkEnv(), GH_PROMPT_DISABLED: "1", NO_COLOR: "1" });

async function run(command: string, cwd: string, args: string[], timeout = 15_000, env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { cwd, env: env ?? gitEnv(), timeout, maxBuffer: 4 * 1024 * 1024 });
  return stdout.replace(/\n$/, "");
}

function firstLine(err: unknown): string {
  const stderr = (err as { stderr?: string }).stderr?.trim();
  return (stderr || (err instanceof Error ? err.message : String(err))).split("\n")[0];
}

/** `owner/name` of a github.com remote URL (HTTPS or SSH), else undefined. */
export function githubRepo(url: string): string | undefined {
  const m = url.match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

export interface ShipState {
  /** Why Ship can't run, if it can't. */
  problem?: string;
  repo?: string;
  /** The PR's base: origin's default branch. */
  base?: string;
  uncommitted: number;
  /** Commits not on the PR branch as last fetched (or, before the first push, not on the base). */
  unpushed: number;
  /** Commits the branch has beyond its base: something to open a PR for. */
  ahead: number;
}

const count = async (cwd: string, tips: string[], exclude: string[]) =>
  Number(await run("git", cwd, ["rev-list", "--count", ...tips, "--not", ...exclude]));

async function hasRef(cwd: string, ref: string): Promise<boolean> {
  return run("git", cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then(() => true, () => false);
}

/** Why the worktree can't be committed as it is: conflicts, or a merge, rebase or cherry-pick still in progress. */
async function unfinished(cwd: string): Promise<string | undefined> {
  if (await run("git", cwd, ["ls-files", "--unmerged"])) return "工作区里有未解决的冲突，先解决再发布";
  for (const [marker, what] of [["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"],
    ["rebase-merge", "rebase"], ["rebase-apply", "rebase"],
    // A cherry-pick or revert of several commits, after the first was resolved and committed by hand.
    ["sequencer", "cherry-pick 或 revert 序列"]]) {
    if (fs.existsSync(await run("git", cwd, ["rev-parse", "--path-format=absolute", "--git-path", marker]))) {
      return `工作区里有没做完的 ${what}，先完成或放弃再发布`;
    }
  }
  return undefined;
}

/**
 * `owner/name` on github.com that a URL reaches: a github.com URL, or an SSH host alias (`git@work:owner/name`, for a
 * second account) that ssh's own config resolves to github.com. `ssh -G` only reads that config; it connects nowhere.
 */
async function githubTarget(cwd: string, url: string): Promise<string | undefined> {
  const direct = githubRepo(url);
  if (direct) return direct;
  const m = url.match(/^(?:[\w.-]+@)?([\w-]+(?:\.[\w-]+)*):([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
    ?? url.match(/^ssh:\/\/(?:[\w.-]+@)?([\w-]+(?:\.[\w-]+)*)(?::\d+)?\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m) return undefined;
  const config = await run("ssh", cwd, ["-G", m[1]], 5000).catch(() => "");
  return /^hostname github\.com$/im.test(config) ? `${m[2]}/${m[3]}` : undefined;
}

/**
 * The GitHub repo `git push origin` reaches, which is the one the PR is opened on. Push must go where fetch comes from
 * (the base came from there), to one URL: a pushurl, pushInsteadOf or second URL would send the code somewhere else
 * than the PR. An insteadOf may change how origin is reached (HTTPS to SSH, a host alias), never which repo.
 */
async function destination(cwd: string): Promise<{ repo?: string; problem?: string }> {
  const configured = await run("git", cwd, ["config", "--get-all", "remote.origin.url"]).catch(() => "");
  if (!configured) return { problem: "这个仓库没有 origin 远程，无法推送" };
  if (configured.includes("\n")) return { problem: "origin 配置了多个地址，Ship 只推送到一个" };
  const repo = await githubTarget(cwd, configured);
  if (!repo) return { problem: "origin 不是 github.com 上的仓库，无法创建 PR" };
  // get-url applies insteadOf and pushInsteadOf: these are the addresses git will really use.
  const fetchUrl = await run("git", cwd, ["remote", "get-url", "origin"]);
  const pushUrls = await run("git", cwd, ["remote", "get-url", "--push", "--all", "origin"]);
  if (pushUrls !== fetchUrl) return { problem: "origin 的推送地址和拉取地址不同（pushurl 或 pushInsteadOf），Ship 不会推到别处" };
  if (fetchUrl !== configured && (await githubTarget(cwd, fetchUrl)) !== repo) {
    return { problem: `origin 被 insteadOf 改写到了 ${repo} 以外的地方，Ship 不会推到别处` };
  }
  return { repo };
}

/** Whether the worktree can be shipped, and what it holds. */
export async function shipState(worktree: SessionWorktree): Promise<ShipState> {
  const none = { uncommitted: 0, unpushed: 0, ahead: 0 };
  if (!fs.existsSync(worktree.path)) return { problem: "这个会话的工作区已经不在了", ...none };
  const cwd = worktree.path;
  const { uncommitted } = await worktreeWork(worktree);
  const base = [worktree.baseRef, worktree.baseCommit];
  const known: string[] = [];
  for (const ref of base) if (ref && (await hasRef(cwd, ref))) known.push(ref);
  const tracking = `refs/remotes/origin/${worktree.branch}`;
  const ahead = await count(cwd, ["HEAD"], known);
  const unpushed = await count(cwd, ["HEAD"], (await hasRef(cwd, tracking)) ? [tracking] : known);
  const refuse = (problem: string) => ({ problem, uncommitted, unpushed, ahead });
  if (!worktree.baseRef.startsWith("origin/")) return refuse("这个仓库没有 origin 远程，无法推送");
  const { repo, problem } = await destination(cwd);
  if (problem) return refuse(problem);
  const prBase = worktree.baseRef.slice("origin/".length);
  const head = await run("git", cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
  // Ship's whole push rule: only the session's own mypi/ branch, never the default branch.
  if (!/^mypi\/[\w.-]+$/.test(worktree.branch) || worktree.branch === prBase) return refuse(`只能推送 mypi/ 分支，不能推送 ${worktree.branch}`);
  if (head !== worktree.branch) return refuse(`工作区当前在 ${head || "游离的 HEAD"} 上，不是 ${worktree.branch}`);
  const busy = await unfinished(cwd);
  if (busy) return refuse(busy);
  return { repo, base: prBase, uncommitted, unpushed, ahead };
}

/** A PR's state on GitHub now, and its head commit (for a merged one: what was merged). */
export async function pullRequestState(url: string): Promise<{ state: PullRequestInfo["state"]; head?: string }> {
  const out = await run("gh", os.tmpdir(), ["pr", "view", url, "--json", "state,headRefOid"], 30_000, networkEnv());
  const pr = JSON.parse(out) as { state?: unknown; headRefOid?: unknown };
  const state = String(pr.state).toLowerCase();
  if (state !== "open" && state !== "merged" && state !== "closed") throw new Error(`gh pr view printed state ${String(pr.state)}`);
  return { state, ...(typeof pr.headRefOid === "string" && /^[0-9a-f]{40}$/.test(pr.headRefOid) ? { head: pr.headRefOid } : {}) };
}

/** The branch's open PR: a merged or closed one doesn't review what was just pushed. */
async function findPullRequest(cwd: string, repo: string, branch: string): Promise<PullRequestInfo | undefined> {
  const out = await run("gh", cwd, ["pr", "view", branch, "--repo", repo, "--json", "url,number,state"], 30_000, networkEnv()).catch(() => "");
  if (!out) return undefined;
  const pr = JSON.parse(out) as { url?: unknown; number?: unknown; state?: unknown };
  if (typeof pr.url !== "string" || typeof pr.number !== "number" || String(pr.state).toLowerCase() !== "open") return undefined;
  return { url: pr.url, number: pr.number, state: "open" };
}

/**
 * Commit what's left (with `message`), push the session branch to the same name on origin, and open a draft PR unless
 * `existing` is one. Never force-pushes: a branch that moved on GitHub is a refusal.
 */
export async function shipWorktree(
  worktree: SessionWorktree,
  options: { message: string; body: string; existing?: PullRequestInfo },
): Promise<{ pr: PullRequestInfo; committed: boolean; pushed: boolean; head: string }> {
  const state = await shipState(worktree);
  if (state.problem) throw new ConflictError(state.problem);
  const { repo, base } = state as Required<ShipState>;
  const branch = worktree.branch;
  const cwd = worktree.path;

  let committed = false;
  if (state.uncommitted > 0) {
    await run("git", cwd, ["add", "--all"]);
    await run("git", cwd, [...NO_HOOKS, "commit", "--quiet", "--no-verify", "--message", options.message], 60_000);
    committed = true;
  }
  const head = await run("git", cwd, ["rev-parse", "HEAD"]);
  if (!committed && state.ahead === 0 && !options.existing) throw new ConflictError("没有可以发布的改动");

  // Always push: whatever the tracking ref says, GitHub's branch must end up at HEAD. Up to date is a no-op.
  const ref = `refs/heads/${branch}`;
  let report: string;
  try {
    // Exactly this branch: no tags (push.followTags) and no submodules (push.recurseSubmodules), whatever the config.
    report = await run("git", cwd, [...NO_HOOKS, "push", "--porcelain", "--no-verify", "--no-follow-tags",
      "--recurse-submodules=no", "--set-upstream", "origin", `${ref}:${ref}`], 120_000, networkEnv());
  } catch (err) {
    // --porcelain reports each ref on stdout, rejections too.
    const stderr = `${(err as { stderr?: string }).stderr ?? ""}\n${(err as { stdout?: string }).stdout ?? ""}`;
    if (/\[remote rejected\]/.test(stderr)) {
      const why = stderr.split("\n").find((l) => l.startsWith("remote: ") && l.slice(8).trim())?.slice(8).trim()
        ?? stderr.match(/\[remote rejected\][^(]*\(([^)]*)\)/)?.[1];
      throw new ConflictError(`GitHub 拒绝了这次推送${why ? `：${why}` : ""}`);
    }
    throw /\[rejected\]|non-fast-forward|fetch first/.test(stderr)
      ? new ConflictError(`GitHub 上的 ${branch} 有本地没有的提交，Ship 不会强推：先把它们合进来再发布`)
      : new Error(`git push failed: ${firstLine(err)}`);
  }
  // The ref's flag, from GitHub's answer: "=" up to date, " " fast-forward, "*" new (also a branch GitHub had deleted).
  const pushed = /^[ *+]\t/m.test(report);
  if (options.existing) return { pr: options.existing, committed, pushed, head };

  const title = options.message.split("\n")[0].slice(0, 256);
  let pr: PullRequestInfo | undefined;
  try {
    const out = await run("gh", cwd, ["pr", "create", "--draft", "--repo", repo, "--base", base, "--head", branch,
      "--title", title, "--body", options.body], 60_000, networkEnv());
    const url = out.split("\n").map((line) => line.trim()).filter((line) => /^https:\/\//.test(line)).at(-1);
    const number = Number(url?.match(/\/pull\/(\d+)/)?.[1]);
    if (url && number) pr = { url, number, state: "open" };
    else pr = await findPullRequest(cwd, repo, branch);
  } catch (err) {
    // An earlier Ship may have created it and lost the reply, or the owner opened one by hand.
    pr = await findPullRequest(cwd, repo, branch);
    if (!pr) throw new Error(`gh pr create failed: ${firstLine(err)}`);
  }
  if (!pr) throw new Error("gh pr create printed no pull request URL");
  return { pr, committed, pushed, head };
}
