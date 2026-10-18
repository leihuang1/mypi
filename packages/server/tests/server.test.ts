import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import {
  createInitialSessionState,
  MyPiClient,
  reduceSseFrame,
  type SseFrame,
} from "@mypi/shared";
import { loadPiModelsAndAuth } from "../src/auth-loader.js";
import { HarnessManager } from "../src/harness-mgr.js";
import { startMyPiServer } from "../src/main.js";

const execFileAsync = promisify(execFile);

describe("@mypi/server integration test", () => {
  it("starts server, loads models, manages durable SQLite sessions, streams SSE, and inspects git diff using temp fixtures (#19)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-test-"));
    const tmpDataDir = path.join(tmpRoot, "data");
    const fixtureWorkspace = path.join(tmpRoot, "workspace");
    fs.mkdirSync(path.join(fixtureWorkspace, "packages"), { recursive: true });

    const running = await startMyPiServer({
      port: 0,
      host: "127.0.0.1",
      dataDir: tmpDataDir,
      startDirs: [fixtureWorkspace],
      silent: true,
    });

    try {
      const client = new MyPiClient({
        baseUrl: `http://127.0.0.1:${running.port}`,
        token: running.token,
      });

      // 1. Health check
      const health = await client.healthz();
      assert.equal(health.ok, true);

      // 2. Device info & models
      const device = await client.getDevice();
      assert.equal(device.apiVersion, 1);
      assert.ok(device.models.length > 0, "Expected models loaded");

      // 3. Directory listing (fixture workspace, no hardcoded checkout path)
      const dirs = await client.listDirs(fixtureWorkspace);
      assert.equal(dirs.path, fixtureWorkspace);
      assert.ok(dirs.dirs.some((d) => d.name === "packages"));

      // 4. Create durable session
      const created = await client.createSession({
        name: "Android Sync Test",
        cwd: fixtureWorkspace,
      });
      assert.equal(created.name, "Android Sync Test");

      // 5. Subscribe to SSE stream and verify hello + snapshot
      const receivedFrames: SseFrame[] = [];
      let state = createInitialSessionState();

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for SSE snapshot")),
          5000,
        );
        const unsub = client.subscribeSessionEvents(created.id, {
          onFrame: (frame) => {
            receivedFrames.push(frame);
            state = reduceSseFrame(state, frame);
            if (frame.type === "snapshot") {
              clearTimeout(timeout);
              unsub();
              resolve();
            }
          },
        });
      });

      assert.ok(receivedFrames.some((f) => f.type === "hello"));
      assert.ok(receivedFrames.some((f) => f.type === "snapshot"));
      assert.equal(state.cwd, fixtureWorkspace);

      // 6. File & Directory Workbench endpoints (mkdir + git init, bookmarks, file preview)
      const createdSubDir = await client.createDirectory({
        parentPath: tmpRoot,
        name: "sandbox-repo",
        gitInit: true,
      });
      assert.equal(createdSubDir.isGitRepo, true);

      const bookmarkRes = await client.updateBookmark({
        path: createdSubDir.path,
        bookmarked: true,
      });
      assert.ok(bookmarkRes.bookmarks.includes(createdSubDir.path));

      const sampleFilePath = path.join(createdSubDir.path, "hello.ts");
      fs.writeFileSync(sampleFilePath, "export const x = 42;\n", "utf8");
      const preview = await client.readFilePreview(sampleFilePath);
      assert.equal(preview.name, "hello.ts");
      assert.equal(preview.isBinary, false);
      assert.ok(preview.content.includes("export const x = 42;"));

      // 7. Live session CWD + title update & context reset
      const updatedSession = await client.updateSession(created.id, {
        name: "Updated Title",
        cwd: createdSubDir.path,
      });
      assert.equal(updatedSession.name, "Updated Title");
      assert.equal(updatedSession.cwd, createdSubDir.path);

      const resetRes = await client.resetSession(created.id, {
        handoff: "Starting fresh in sandbox-repo",
      });
      assert.equal(resetRes.status, "reset");

      // 8. OpenAI account usage endpoint
      const openaiUsage = await client.getOpenAIUsage();
      assert.equal(typeof openaiUsage.configured, "boolean");
      assert.ok(Array.isArray(openaiUsage.ledger.byModel));

      // 9. Delete/archive session
      const deleted = await client.deleteSession(created.id);
      assert.equal(deleted.archived, true);
    } finally {
      await running.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("handles malformed Host header (#1), missing SSE session 404 (#2), and clean shutdown with active SSE (#16, #18)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-edge-"));
    const running = await startMyPiServer({
      port: 0,
      host: "127.0.0.1",
      dataDir: path.join(tmpRoot, "data"),
      startDirs: [tmpRoot],
      silent: true,
    });

    try {
      // #1: Unauthenticated request with invalid Host: "[" must return 400 and not crash daemon
      const statusCode = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: running.port,
            path: "/healthz",
            method: "GET",
            headers: {
              Host: "[",
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(statusCode, 400);

      // Verify daemon is still alive after malformed Host request
      const client = new MyPiClient({
        baseUrl: `http://127.0.0.1:${running.port}`,
        token: running.token,
      });
      const health = await client.healthz();
      assert.equal(health.ok, true);

      // #2: Subscribing to a non-existent session returns clean 404 JSON without ERR_HTTP_HEADERS_SENT
      const missingRes = await fetch(
        `http://127.0.0.1:${running.port}/v1/sessions/does-not-exist/events`,
        {
          headers: {
            Authorization: `Bearer ${running.token}`,
          },
        },
      );
      assert.equal(missingRes.status, 404);
      const missingBody = (await missingRes.json()) as {
        error?: { code?: string };
      };
      assert.equal(missingBody.error?.code, "not_found");

      // #18: Keep an active SSE subscription open and verify running.close() still finishes promptly
      const session = await client.createSession({
        name: "Active SSE Close Test",
        cwd: tmpRoot,
      });

      let unsubActive = () => {};
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out connecting SSE")),
          5000,
        );
        unsubActive = client.subscribeSessionEvents(session.id, {
          onFrame: (f) => {
            if (f.type === "snapshot") {
              clearTimeout(timer);
              resolve();
            }
          },
        });
      });

      // Close server while SSE stream is still open
      await running.close();
      unsubActive();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite corrupted catalog.json on startup (#3)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-catalog-"));
    const catalogPath = path.join(tmpRoot, "catalog.json");
    const corruptedContent = '{"deviceUid":"u1","sessions":[{"id":"s1"';
    fs.writeFileSync(catalogPath, corruptedContent, "utf8");

    try {
      const modelsConfig = await loadPiModelsAndAuth();
      assert.throws(
        () =>
          new HarnessManager({
            dataDir: tmpRoot,
            startDirs: [tmpRoot],
            modelsConfig,
          }),
        /Corrupted catalog JSON/,
      );
      // Verify original corrupted file was NOT overwritten with empty sessions
      assert.equal(fs.readFileSync(catalogPath, "utf8"), corruptedContent);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("accurately inspects Chinese, trailing-space, and emoji+tab filenames (#14, P2 #4) and untracked files in subdirectories (#15)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-git-"));
    const repoDir = path.join(tmpRoot, "repo");
    const subDir = path.join(repoDir, "app");
    fs.mkdirSync(subDir, { recursive: true });

    await execFileAsync("git", ["init"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "test@mypi.local"], {
      cwd: repoDir,
    });
    await execFileAsync("git", ["config", "user.name", "MyPi Test"], {
      cwd: repoDir,
    });

    const chineseFile = path.join(repoDir, "中文.txt");
    const trailingSpaceFile = path.join(repoDir, "trailing.txt ");
    const emojiTabFile = path.join(repoDir, "emoji😀\t.txt");

    fs.writeFileSync(chineseFile, "第一行\n", "utf8");
    fs.writeFileSync(trailingSpaceFile, "line1\n", "utf8");
    fs.writeFileSync(emojiTabFile, "emoji1\n", "utf8");

    await execFileAsync("git", ["add", "."], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoDir });

    // Modify Chinese, trailing-space, and emoji+tab files, plus create an untracked file in subdirectory
    fs.writeFileSync(chineseFile, "第一行\n第二行新增\n", "utf8");
    fs.writeFileSync(trailingSpaceFile, "line1\nline2 trailing\n", "utf8");
    fs.writeFileSync(emojiTabFile, "emoji1\nemoji2 🚀\n", "utf8");
    const subNewFile = path.join(subDir, "new.ts");
    fs.writeFileSync(subNewFile, "export const sub = true;\n", "utf8");

    const running = await startMyPiServer({
      port: 0,
      host: "127.0.0.1",
      dataDir: path.join(tmpRoot, "data"),
      startDirs: [repoDir],
      silent: true,
    });

    try {
      const client = new MyPiClient({
        baseUrl: `http://127.0.0.1:${running.port}`,
        token: running.token,
      });

      // Create session with cwd set to the subdirectory /repo/app
      const session = await client.createSession({
        name: "Subdir Git Test",
        cwd: subDir,
      });

      const gitStatus = await client.getGitStatus(session.id);
      assert.equal(gitStatus.isGitRepo, true);
      assert.equal(gitStatus.clean, false);

      // Verify #14: Chinese filename is unescaped, has additions=1, and non-empty diff
      const zhEntry = gitStatus.files.find((f) => f.path === "中文.txt");
      assert.ok(zhEntry, "Expected unescaped 中文.txt in git status files");
      assert.equal(zhEntry.status, "M");
      assert.equal(zhEntry.additions, 1);
      assert.ok(
        zhEntry.diff.includes("+第二行新增"),
        "Expected diff for 中文.txt to contain added line",
      );

      // Verify P2 #4a: Filename with trailing space preserves trailing space and diff
      const trailingEntry = gitStatus.files.find(
        (f) => f.path === "trailing.txt ",
      );
      assert.ok(
        trailingEntry,
        "Expected 'trailing.txt ' with trailing space in git status files",
      );
      assert.equal(trailingEntry.status, "M");
      assert.equal(trailingEntry.additions, 1);
      assert.ok(
        trailingEntry.diff.includes("+line2 trailing"),
        "Expected non-empty diff for 'trailing.txt '",
      );

      // Verify P2 #4b: Filename with emoji surrogate pair and tab character preserves both and diff
      const emojiEntry = gitStatus.files.find(
        (f) => f.path === "emoji😀\t.txt",
      );
      assert.ok(
        emojiEntry,
        "Expected 'emoji😀\\t.txt' in git status files",
      );
      assert.equal(emojiEntry.status, "M");
      assert.equal(emojiEntry.additions, 1);
      assert.ok(
        emojiEntry.diff.includes("+emoji2 🚀"),
        "Expected non-empty diff for 'emoji😀\\t.txt'",
      );

      // Verify #15: Untracked file in subdirectory has synthesized preview diff and line count
      const subEntry = gitStatus.files.find((f) => f.path === "app/new.ts");
      assert.ok(subEntry, "Expected app/new.ts in git status files");
      assert.equal(subEntry.status, "?");
      assert.equal(subEntry.additions, 1);
      assert.ok(
        subEntry.diff.includes("+export const sub = true;"),
        "Expected untracked file preview diff when session cwd is in subdirectory",
      );
    } finally {
      await running.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("rejects new session creation during close() and leaves zero open Harnesses after close() completes (P2 #3)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-close-race-"));
    const running = await startMyPiServer({
      port: 0,
      host: "127.0.0.1",
      dataDir: path.join(tmpRoot, "data"),
      startDirs: [tmpRoot],
      silent: true,
    });

    try {
      const client = new MyPiClient({
        baseUrl: `http://127.0.0.1:${running.port}`,
        token: running.token,
      });

      const first = await client.createSession({
        name: "Session 1",
        cwd: tmpRoot,
      });

      // Intercept Session 1's harness.close to pause mid-shutdown
      const internalActive = (
        running.manager as unknown as {
          activeSessions: Map<
            string,
            Promise<{ harness: { close: (ctx: unknown) => Promise<void> } }>
          >;
        }
      ).activeSessions;
      const managed1 = await internalActive.get(first.id)!;
      const origClose = managed1.harness.close.bind(managed1.harness);

      let releaseClose!: () => void;
      const closeGate = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      let enteredHarnessClose!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        enteredHarnessClose = resolve;
      });

      managed1.harness.close = async (ctx: unknown) => {
        enteredHarnessClose();
        await closeGate;
        return origClose(ctx);
      };

      // Begin server shutdown
      const closingPromise = running.close();
      await enteredPromise;

      // Attempting to create a new session while close() is in progress must fail
      await assert.rejects(
        () =>
          running.manager.createSession({
            name: "Late Session During Close",
            cwd: tmpRoot,
          }),
        /shutting down/i,
      );

      releaseClose();
      await closingPromise;

      assert.equal(
        internalActive.size,
        0,
        "Expected zero active Harnesses remaining after close() resolves",
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
