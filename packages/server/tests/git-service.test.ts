import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { inspectGitDirectory } from "../src/git-service.js";

it("shows net HEAD text changes once, excludes binary/net-zero, and includes large new text", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-net-diff-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  const write = (name: string, content: string | Buffer) => fs.writeFileSync(path.join(cwd, name), content);
  try {
    assert.equal((await inspectGitDirectory(cwd)).isGitRepo, false);
    git("init");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.com");
    write("mixed.txt", "original\n");
    write("cancelled.txt", "original\n");
    write("deleted.txt", "remove\n");
    write("binary.bin", Buffer.from([0, 1, 2]));
    git("add", ".");
    git("commit", "-m", "base");
    write("mixed.txt", "staged\n");
    write("cancelled.txt", "staged\n");
    git("add", ".");
    write("mixed.txt", "final\nextra\n");
    write("cancelled.txt", "original\n");
    write("binary.bin", Buffer.from([0, 3, 4]));
    write("new.bin", Buffer.from([0, 5]));
    write("empty.txt", "");
    write("large.txt", "line\n".repeat(10_000));
    write("new\n😀\t.txt", "hello\n");
    fs.unlinkSync(path.join(cwd, "deleted.txt"));
    const info = await inspectGitDirectory(cwd);
    assert.deepEqual(info.files.map((f) => f.path).sort(), ["deleted.txt", "large.txt", "mixed.txt", "new\n😀\t.txt"].sort());
    const mixed = info.files.find((f) => f.path === "mixed.txt")!;
    assert.equal(mixed.additions, 2);
    assert.equal(mixed.deletions, 1);
    assert.match(mixed.diff, /-original/);
    assert.doesNotMatch(mixed.diff, /staged/);
    assert.equal(info.files.find((f) => f.path === "large.txt")!.additions, 10_000);
    assert.equal(info.files.find((f) => f.path === "deleted.txt")!.status, "D");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

it("includes staged text in unborn repositories and propagates IO failures", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-unborn-"));
  try {
    execFileSync("git", ["init"], { cwd, stdio: "pipe" });
    fs.writeFileSync(path.join(cwd, "first.txt"), "staged\n");
    execFileSync("git", ["add", "."], { cwd });
    fs.writeFileSync(path.join(cwd, "first.txt"), "working\n");
    const info = await inspectGitDirectory(cwd);
    assert.equal(info.files.length, 1);
    assert.equal(info.files[0].status, "A");
    assert.match(info.files[0].diff, /\+working/);
    await assert.rejects(inspectGitDirectory(path.join(cwd, "missing")));
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
