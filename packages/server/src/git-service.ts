import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { GitFileStatus, GitStatusResponse } from "@mypi/shared";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "core.quotePath=false", ...args],
    {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
    },
  );
  return stdout;
}

export function unquoteGitPath(input: string): string {
  const raw = input.replace(/\r?\n$/, "");
  if (!raw.startsWith('"') || !raw.endsWith('"')) {
    return raw;
  }
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next >= "0" && next <= "7") {
        let octal = next;
        let step = 2;
        while (
          step <= 3 &&
          i + step < inner.length &&
          inner[i + step] >= "0" &&
          inner[i + step] <= "7"
        ) {
          octal += inner[i + step];
          step++;
        }
        bytes.push(Number.parseInt(octal, 8));
        i += step;
        continue;
      }
      const escapes: Record<string, number> = {
        a: 0x07,
        b: 0x08,
        t: 0x09,
        n: 0x0a,
        v: 0x0b,
        f: 0x0c,
        r: 0x0d,
        '"': 0x22,
        "\\": 0x5c,
      };
      if (next in escapes) {
        bytes.push(escapes[next]);
        i += 2;
        continue;
      }
      const nextCp = inner.codePointAt(i + 1)!;
      const nextStr = String.fromCodePoint(nextCp);
      bytes.push(...Buffer.from(nextStr, "utf8"));
      i += 1 + nextStr.length;
      continue;
    }
    const cp = inner.codePointAt(i)!;
    const charStr = String.fromCodePoint(cp);
    bytes.push(...Buffer.from(charStr, "utf8"));
    i += charStr.length;
  }
  return Buffer.from(bytes).toString("utf8");
}

function cleanDiffHeaderToken(rawLine: string): string {
  const noCr = rawLine.replace(/\r$/, "");
  // For unquoted paths containing spaces, Git appends a trailing tab separator on ---/+++ lines
  if (!noCr.startsWith('"')) {
    return noCr.replace(/\t.*$/, "");
  }
  return noCr;
}

function stripDiffPrefix(raw: string, prefix: "a/" | "b/"): string {
  const unquoted = unquoteGitPath(raw);
  if (unquoted.startsWith(prefix)) {
    return unquoted.slice(prefix.length);
  }
  return unquoted;
}

function extractDiffChunkPath(chunk: string): string | null {
  const plusMatch = chunk.match(/^\+\+\+ ([^\r\n]+)$/m);
  if (plusMatch) {
    const rawPlus = cleanDiffHeaderToken(plusMatch[1]);
    if (rawPlus !== "/dev/null") {
      return stripDiffPrefix(rawPlus, "b/");
    }
  }
  const minusMatch = chunk.match(/^--- ([^\r\n]+)$/m);
  if (minusMatch) {
    const rawMinus = cleanDiffHeaderToken(minusMatch[1]);
    if (rawMinus !== "/dev/null") {
      return stripDiffPrefix(rawMinus, "a/");
    }
  }
  const headerMatch = chunk.match(/^diff --git ([^\r\n]+)$/m);
  if (headerMatch) {
    const rest = headerMatch[1].replace(/\r$/, "");
    // Check symmetric unquoted "a/<path> b/<path>" first (preserves trailing spaces)
    if (rest.startsWith("a/") && rest.length % 2 === 1) {
      const mid = (rest.length - 1) / 2;
      if (rest[mid] === " " && rest.slice(mid + 1).startsWith("b/")) {
        const aPath = rest.slice(2, mid);
        const bPath = rest.slice(mid + 3);
        if (aPath === bPath) {
          return bPath;
        }
      }
    }
    const quotedBIdx = rest.lastIndexOf(' "b/');
    if (quotedBIdx > 0) {
      return stripDiffPrefix(rest.slice(quotedBIdx + 1), "b/");
    }
    const bIdx = rest.lastIndexOf(" b/");
    if (bIdx > 0) {
      return stripDiffPrefix(rest.slice(bIdx + 1), "b/");
    }
  }
  return null;
}

function parseNumstatZ(
  numstatOut: string,
  targetMap: Map<string, { additions: number; deletions: number }>,
): void {
  const tokens = numstatOut.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i++];
    if (!token) continue;
    const parts = token.split("\t");
    if (parts.length < 3) continue;
    const add = Number.parseInt(parts[0], 10);
    const del = Number.parseInt(parts[1], 10);
    let filePath = parts.slice(2).join("\t");
    if (filePath === "") {
      // Rename/copy in --numstat -z: followed by oldPath\0newPath\0
      const oldPath = tokens[i++] ?? "";
      const newPath = tokens[i++] ?? "";
      filePath = newPath || oldPath;
    }
    if (filePath) {
      targetMap.set(filePath, {
        additions: Number.isNaN(add) ? 0 : add,
        deletions: Number.isNaN(del) ? 0 : del,
      });
    }
  }
}

export async function inspectGitDirectory(cwd: string): Promise<GitStatusResponse> {
  const now = Date.now();
  if (!fs.existsSync(cwd)) {
    return {
      isGitRepo: false,
      clean: true,
      summary: {
        modified: 0,
        added: 0,
        deleted: 0,
        untracked: 0,
        totalAdditions: 0,
        totalDeletions: 0,
      },
      files: [],
      fullDiff: "",
      updatedAt: now,
    };
  }

  let repoRoot = cwd;
  try {
    const inside = (
      await runGit(cwd, ["rev-parse", "--is-inside-work-tree"])
    ).trim();
    if (inside !== "true") {
      throw new Error("Not a git work tree");
    }
    const topLevel = (
      await runGit(cwd, ["rev-parse", "--show-toplevel"])
    ).trim();
    if (topLevel) {
      repoRoot = topLevel;
    }
  } catch {
    return {
      isGitRepo: false,
      clean: true,
      summary: {
        modified: 0,
        added: 0,
        deleted: 0,
        untracked: 0,
        totalAdditions: 0,
        totalDeletions: 0,
      },
      files: [],
      fullDiff: "",
      updatedAt: now,
    };
  }

  let branch = "HEAD";
  try {
    branch = (
      await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])
    ).trim();
  } catch {
    // Empty repo without commits yet
  }

  const statusOut = await runGit(repoRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "-uall",
  ]);
  const statusEntries: Array<{ xy: string; path: string }> = [];
  const statusTokens = statusOut.split("\0");
  let idx = 0;
  while (idx < statusTokens.length) {
    const entry = statusTokens[idx++];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      // Consume original path token in porcelain v1 -z
      idx++;
    }
    statusEntries.push({ xy, path: filePath });
  }

  // Get numstat for tracked changes using NUL-delimited output
  const numstatMap = new Map<string, { additions: number; deletions: number }>();
  try {
    const numstatOut = await runGit(repoRoot, ["diff", "HEAD", "--numstat", "-z"]);
    parseNumstatZ(numstatOut, numstatMap);
  } catch {
    // Fallback if HEAD does not exist yet
    try {
      const numstatOut = await runGit(repoRoot, ["diff", "--numstat", "-z"]);
      parseNumstatZ(numstatOut, numstatMap);
    } catch {
      // Ignore
    }
  }

  let fullDiff = "";
  try {
    fullDiff = await runGit(repoRoot, ["diff", "HEAD", "--unified=3"]);
  } catch {
    try {
      fullDiff = await runGit(repoRoot, ["diff", "--unified=3"]);
    } catch {
      fullDiff = "";
    }
  }

  // Split fullDiff by file ("diff --git ...")
  const perFileDiff = new Map<string, string>();
  const diffChunks = fullDiff.split(/(?=^diff --git )/m);
  for (const chunk of diffChunks) {
    if (!chunk.trim()) continue;
    const parsedPath = extractDiffChunkPath(chunk);
    if (parsedPath) {
      perFileDiff.set(parsedPath, chunk.trim());
    }
  }

  const files: GitFileStatus[] = [];
  let modified = 0;
  let added = 0;
  let deleted = 0;
  let untracked = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const { xy, path: rawPath } of statusEntries) {
    const x = xy[0];
    const y = xy[1];
    const staged = x !== " " && x !== "?";

    let status: GitFileStatus["status"] = "M";
    if (xy === "??") {
      status = "?";
      untracked++;
    } else if (x === "A" || y === "A") {
      status = "A";
      added++;
    } else if (x === "D" || y === "D") {
      status = "D";
      deleted++;
    } else if (x === "R" || y === "R") {
      status = "R";
      modified++;
    } else {
      status = "M";
      modified++;
    }

    let stats = numstatMap.get(rawPath);
    let fileDiff = perFileDiff.get(rawPath) ?? "";

    // For untracked text files, synthesize a preview diff up to 32KB resolved against repoRoot
    if (status === "?" && !fileDiff) {
      try {
        const absPath = path.join(repoRoot, rawPath);
        const stat = fs.statSync(absPath);
        if (stat.isFile() && stat.size <= 32 * 1024) {
          const content = fs.readFileSync(absPath, "utf8");
          if (!content.includes("\u0000")) {
            const trimmedContent = content.replace(/\r?\n$/, "");
            const contentLines =
              trimmedContent.length > 0 ? trimmedContent.split(/\r?\n/) : [];
            stats = { additions: contentLines.length, deletions: 0 };
            fileDiff = [
              `--- /dev/null`,
              `+++ b/${rawPath}`,
              `@@ -0,0 +1,${contentLines.length} @@`,
              ...contentLines.map((l) => `+${l}`),
            ].join("\n");
          }
        }
      } catch {
        // Ignore unreadable untracked file
      }
    }

    const additions = stats?.additions ?? 0;
    const deletions = stats?.deletions ?? 0;
    totalAdditions += additions;
    totalDeletions += deletions;

    files.push({
      path: rawPath,
      status,
      staged,
      additions,
      deletions,
      diff: fileDiff,
    });
  }

  return {
    isGitRepo: true,
    branch,
    clean: files.length === 0,
    summary: {
      modified,
      added,
      deleted,
      untracked,
      totalAdditions,
      totalDeletions,
    },
    files,
    fullDiff: fullDiff.slice(0, 200_000),
    updatedAt: now,
  };
}
