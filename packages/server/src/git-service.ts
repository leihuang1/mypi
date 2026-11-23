import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { GitFileStatus, GitStatusResponse } from "@mypi/shared";
import { gitEnv } from "./worktree-service.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[], noIndex = false): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", ...args], {
      cwd,
      // shortcut: cap each diff at 4 MiB; add per-file fetching before supporting larger workspaces.
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
      env: gitEnv({ GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" }),
    });
    return stdout;
  } catch (err) {
    const failure = err as { code?: number; stdout?: string };
    // git diff --no-index uses exit 1 to report differences, not failure.
    if (noIndex && failure.code === 1 && typeof failure.stdout === "string") return failure.stdout;
    throw err;
  }
}

export function unquoteGitPath(input: string): string {
  const raw = input.replace(/\r?\n$/, "");
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  const escapes: Record<string, number> = {
    a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92,
  };
  for (let i = 0; i < inner.length;) {
    if (inner[i] === "\\" && i + 1 < inner.length) {
      const octal = inner.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
      if (octal) {
        bytes.push(Number.parseInt(octal, 8));
        i += octal.length + 1;
        continue;
      }
      const next = inner[i + 1];
      if (next in escapes) {
        bytes.push(escapes[next]);
        i += 2;
        continue;
      }
      i++;
    }
    const char = String.fromCodePoint(inner.codePointAt(i)!);
    bytes.push(...Buffer.from(char, "utf8"));
    i += char.length;
  }
  return Buffer.from(bytes).toString("utf8");
}

function chunkPath(chunk: string): string | undefined {
  for (const prefix of ["+++ ", "--- "]) {
    const header = chunk.split("\n").find((line) => line.startsWith(prefix));
    if (!header) continue;
    const token = header.slice(4).replace(/\r$/, "");
    const decoded = unquoteGitPath(token.startsWith('"') ? token : token.replace(/\t.*$/, ""));
    if (decoded !== "/dev/null") return decoded.slice(2);
  }
  return undefined;
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  const tokens = output.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const match = tokens[i].match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
    if (!match) continue;
    let filePath = match[3];
    if (!filePath) {
      // --no-index encodes /dev/null → new path as a rename in numstat -z.
      i += 2;
      filePath = tokens[i];
    }
    if (filePath && match[1] !== "-" && match[2] !== "-") {
      stats.set(filePath, { additions: Number(match[1]), deletions: Number(match[2]) });
    }
  }
  return stats;
}

export function noGitStatus(): GitStatusResponse {
  return {
    isGitRepo: false,
    clean: true,
    summary: { modified: 0, added: 0, deleted: 0, untracked: 0, totalAdditions: 0, totalDeletions: 0 },
    files: [],
    fullDiff: "",
    updatedAt: Date.now(),
  };
}

/** Where `head`'s branch left `baseRef`, or `baseCommit` when that ref is gone or unrelated. */
async function mergeBase(repoRoot: string, head: string, baseRef?: string, baseCommit?: string): Promise<string | undefined> {
  for (const ref of [baseRef, baseCommit]) {
    if (!ref) continue;
    const merged = await runGit(repoRoot, ["merge-base", ref, head]).catch(() => "");
    if (merged.trim()) return merged.trim();
  }
  return undefined;
}

const COUNT_FILE_BYTES = 1024 * 1024;
const COUNT_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * The size of the changes, for a notice: every changed path, binary and mode-only ones too, from `--numstat` and the
 * untracked files' line counts, without building patches.
 */
export async function changeStats(cwd: string, baseRef?: string, baseCommit?: string): Promise<{ files: number; additions: number; deletions: number }> {
  const repoRoot = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).replace(/\n$/, "");
  const head = (await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"])).trim();
  const base = (await mergeBase(repoRoot, head, baseRef, baseCommit)) ?? head;
  const [numstat, untracked] = await Promise.all([
    runGit(repoRoot, ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", base, "--"]),
    runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const stats = { files: 0, additions: 0, deletions: 0 };
  for (const record of numstat.split("\0").filter(Boolean)) {
    const [added, deleted] = record.split("\t");
    stats.files++;
    stats.additions += Number(added) || 0; // "-" for a binary file
    stats.deletions += Number(deleted) || 0;
  }
  let budget = COUNT_TOTAL_BYTES;
  for (const file of untracked.split("\0").filter(Boolean)) {
    stats.files++;
    const full = path.join(repoRoot, file);
    const info = await fs.lstat(full).catch(() => undefined);
    if (!info?.isFile() || info.size > COUNT_FILE_BYTES || info.size > budget) continue;
    budget -= info.size;
    const data = await fs.readFile(full).catch(() => undefined);
    if (!data?.length || data.includes(0)) continue;
    let lines = data.at(-1) === 0x0a ? 0 : 1;
    for (const byte of data) if (byte === 0x0a) lines++;
    stats.additions += lines;
  }
  return stats;
}

/**
 * Changes in `cwd`'s work tree: against HEAD, or with `baseRef`, against its merge-base, so local commits show too.
 * `baseCommit` stands in when `baseRef` is gone (a deleted or renamed default branch).
 */
export async function inspectGitDirectory(cwd: string, baseRef?: string, baseCommit?: string): Promise<GitStatusResponse> {
  const result = noGitStatus();
  let repoRoot: string;
  try {
    // Remove only the output delimiter, not whitespace belonging to the directory.
    repoRoot = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).replace(/\n$/, "");
  } catch (err) {
    if (/not a git repository|must be run in a work tree/i.test(String((err as { stderr?: string }).stderr))) return result;
    throw err;
  }
  result.isGitRepo = true;

  let base: string;
  try {
    base = (await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"])).trim();
  } catch (err) {
    if ((err as { code?: number }).code !== 1) throw err;
    // An unborn repository compares both staged and unstaged files to an empty tree.
    base = (await runGit(repoRoot, ["hash-object", "-t", "tree", "/dev/null"])).trim();
  }
  const merged = await mergeBase(repoRoot, base, baseRef, baseCommit);
  if (merged) [base, result.baseRef] = [merged, baseRef];
  result.branch = (await runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim() || undefined;
  const diffArgs = ["diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=all", base];
  const [statsOut, patch, untrackedOut, statusOut] = await Promise.all([
    runGit(repoRoot, [...diffArgs, "--numstat", "-z", "--"]),
    runGit(repoRoot, [...diffArgs, "--unified=3", "--"]),
    runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
    runGit(repoRoot, ["status", "--porcelain=v1", "--no-renames", "-z", "-uno"]),
  ]);
  const stats = parseNumstat(statsOut);
  const stagedPaths = new Set(statusOut.split("\0").filter((s) => s && s[0] !== " ").map((s) => s.slice(3)));
  const append = (file: GitFileStatus) => {
    // Hide binary, empty, mode-only and net-zero changes from this text-only surface.
    if (!file.diff || file.additions + file.deletions === 0) return;
    result.files.push(file);
    const key = file.status === "?" ? "untracked" : file.status === "A" ? "added" : file.status === "D" ? "deleted" : "modified";
    result.summary[key]++;
    result.summary.totalAdditions += file.additions;
    result.summary.totalDeletions += file.deletions;
  };
  for (const chunk of patch.split(/(?=^diff --git )/m)) {
    const filePath = chunkPath(chunk);
    const counts = filePath && stats.get(filePath);
    if (!filePath || !counts) continue;
    append({
      path: filePath,
      status: /^new file mode /m.test(chunk) ? "A" : /^deleted file mode /m.test(chunk) ? "D" : "M",
      staged: stagedPaths.has(filePath),
      ...counts,
      diff: chunk.replace(/\n$/, ""),
    });
  }

  for (const filePath of untrackedOut.split("\0").filter(Boolean)) {
    const stat = await fs.lstat(path.join(repoRoot, filePath));
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    const args = ["diff", "--no-index", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv"];
    const countsOut = await runGit(repoRoot, [...args, "--numstat", "-z", "--", "/dev/null", filePath], true);
    const counts = parseNumstat(countsOut).get(filePath);
    if (!counts || counts.additions + counts.deletions === 0) continue;
    const diff = await runGit(repoRoot, [...args, "--unified=3", "--", "/dev/null", filePath], true);
    append({ path: filePath, status: "?", staged: false, ...counts, diff: diff.replace(/\n$/, "") });
  }
  result.files.sort((a, b) => a.path.localeCompare(b.path));
  result.clean = result.files.length === 0;
  result.fullDiff = result.files.map((file) => file.diff).join("\n").slice(0, 200_000);
  return result;
}
