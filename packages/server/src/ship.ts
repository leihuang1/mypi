import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import type { PullRequestInfo } from "@mypi/shared";
import { type SessionWorktree, worktreeWork } from "./worktree-service.js";

const execFileAsync = promisify(execFile);

// The daemon's own credentials, and nothing may wait for a terminal or print colour codes. Built per call, not at
// import, so it is the environment the daemon has now.
const networkEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" });

/** A refusal the user can act on: HTTP 409 rather than 500. */
export class ShipError extends Error {
  readonly status = 409;
}

async function run(command: string, cwd: string, args: string[], timeout = 15_000, env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { cwd, env: env ?? process.env, timeout, maxBuffer: 4 * 1024 * 1024 });
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
  unpushed: number;
}

/** Whether the worktree can be shipped, and what it holds. */
export async function shipState(worktree: SessionWorktree): Promise<ShipState> {
  if (!fs.existsSync(worktree.path)) return { problem: "这个会话的工作区已经不在了", uncommitted: 0, unpushed: 0 };
  const { uncommitted, unpushed } = await worktreeWork(worktree);
  const refuse = (problem: string) => ({ problem, uncommitted, unpushed });
  // The configured URL, not `remote get-url`'s: that applies insteadOf rewrites (an SSH alias, a mirror).
  const url = await run("git", worktree.path, ["config", "--get", "remote.origin.url"]).catch(() => "");
  const repo = githubRepo(url);
  if (!url || !worktree.baseRef.startsWith("origin/")) return refuse("这个仓库没有 origin 远程，无法推送");
  if (!repo) return refuse("origin 不是 github.com 上的仓库，无法创建 PR");
  const base = worktree.baseRef.slice("origin/".length);
  const head = await run("git", worktree.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
  // Ship's whole push rule: only the session's own mypi/ branch, never the default branch.
  if (!/^mypi\/[\w.-]+$/.test(worktree.branch) || worktree.branch === base) return refuse(`只能推送 mypi/ 分支，不能推送 ${worktree.branch}`);
  if (head !== worktree.branch) return refuse(`工作区当前在 ${head || "游离的 HEAD"} 上，不是 ${worktree.branch}`);
  return { repo, base, uncommitted, unpushed };
}

async function findPullRequest(cwd: string, repo: string, branch: string): Promise<PullRequestInfo | undefined> {
  const out = await run("gh", cwd, ["pr", "view", branch, "--repo", repo, "--json", "url,number,state"], 30_000, networkEnv()).catch(() => "");
  if (!out) return undefined;
  const pr = JSON.parse(out) as { url: string; number: number; state: string };
  return { url: pr.url, number: pr.number, state: pr.state.toLowerCase() as PullRequestInfo["state"] };
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
  if (state.problem) throw new ShipError(state.problem);
  const { repo, base } = state as Required<ShipState>;
  const branch = worktree.branch;
  const cwd = worktree.path;

  let committed = false;
  if (state.uncommitted > 0) {
    await run("git", cwd, ["add", "--all"]);
    // --no-verify: Ship runs from a phone; a hook that wants a terminal or fails would just strand it.
    await run("git", cwd, ["commit", "--quiet", "--no-verify", "--message", options.message], 60_000);
    committed = true;
  }
  const head = await run("git", cwd, ["rev-parse", "HEAD"]);
  const { unpushed } = await worktreeWork(worktree);
  const published = await run("git", cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).catch(() => "");
  if (unpushed === 0 && !published && !options.existing) throw new ShipError("没有可以发布的改动");

  let pushed = false;
  if (unpushed > 0) {
    const ref = `refs/heads/${branch}`;
    try {
      await run("git", cwd, ["push", "--quiet", "--no-verify", "--set-upstream", "origin", `${ref}:${ref}`], 120_000, networkEnv());
    } catch (err) {
      const rejected = /\[rejected\]|non-fast-forward|fetch first/.test(String((err as { stderr?: string }).stderr));
      throw rejected
        ? new ShipError(`GitHub 上的 ${branch} 有本地没有的提交，Ship 不会强推：先把它们合进来再发布`)
        : new Error(`git push failed: ${firstLine(err)}`);
    }
    pushed = true;
  }
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
