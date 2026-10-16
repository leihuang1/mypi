import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { GitFileStatus, GitStatusResponse } from "@mypi/shared";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
  });
  return stdout;
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

  try {
    const inside = (
      await runGit(cwd, ["rev-parse", "--is-inside-work-tree"])
    ).trim();
    if (inside !== "true") {
      throw new Error("Not a git work tree");
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
    branch = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    // Empty repo without commits yet
  }

  const statusOut = await runGit(cwd, ["status", "--porcelain=v1", "-uall"]);
  const lines = statusOut
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean);

  // Get numstat for tracked changes
  const numstatMap = new Map<string, { additions: number; deletions: number }>();
  try {
    const numstatOut = await runGit(cwd, ["diff", "HEAD", "--numstat"]);
    for (const line of numstatOut.split(/\r?\n/)) {
      const parts = line.split("\t");
      if (parts.length >= 3) {
        const add = Number.parseInt(parts[0], 10);
        const del = Number.parseInt(parts[1], 10);
        const filePath = parts.slice(2).join("\t");
        numstatMap.set(filePath, {
          additions: Number.isNaN(add) ? 0 : add,
          deletions: Number.isNaN(del) ? 0 : del,
        });
      }
    }
  } catch {
    // Fallback if HEAD does not exist yet
    try {
      const numstatOut = await runGit(cwd, ["diff", "--numstat"]);
      for (const line of numstatOut.split(/\r?\n/)) {
        const parts = line.split("\t");
        if (parts.length >= 3) {
          const add = Number.parseInt(parts[0], 10);
          const del = Number.parseInt(parts[1], 10);
          const filePath = parts.slice(2).join("\t");
          numstatMap.set(filePath, {
            additions: Number.isNaN(add) ? 0 : add,
            deletions: Number.isNaN(del) ? 0 : del,
          });
        }
      }
    } catch {
      // Ignore
    }
  }

  let fullDiff = "";
  try {
    fullDiff = await runGit(cwd, ["diff", "HEAD", "--unified=3"]);
  } catch {
    try {
      fullDiff = await runGit(cwd, ["diff", "--unified=3"]);
    } catch {
      fullDiff = "";
    }
  }

  // Split fullDiff by file ("diff --git a/... b/...")
  const perFileDiff = new Map<string, string>();
  const diffChunks = fullDiff.split(/(?=^diff --git )/m);
  for (const chunk of diffChunks) {
    if (!chunk.trim()) continue;
    const match = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (match) {
      perFileDiff.set(match[2], chunk.trim());
    }
  }

  const files: GitFileStatus[] = [];
  let modified = 0;
  let added = 0;
  let deleted = 0;
  let untracked = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const line of lines) {
    const xy = line.slice(0, 2);
    let rawPath = line.slice(3).trim();
    if (rawPath.includes(" -> ")) {
      rawPath = rawPath.split(" -> ").pop()!.trim();
    }
    if (rawPath.startsWith('"') && rawPath.endsWith('"')) {
      rawPath = rawPath.slice(1, -1);
    }

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

    // For untracked text files, synthesize a preview diff up to 16KB
    if (status === "?" && !fileDiff) {
      try {
        const absPath = path.join(cwd, rawPath);
        const stat = fs.statSync(absPath);
        if (stat.isFile() && stat.size <= 32 * 1024) {
          const content = fs.readFileSync(absPath, "utf8");
          if (!content.includes("\u0000")) {
            const contentLines = content.split(/\r?\n/);
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
