import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createInitialSessionState,
  MyPiClient,
  reduceSseFrame,
  type SseFrame,
} from "@mypi/shared";
import { startMyPiServer } from "../src/main.js";

describe("@mypi/server integration test", () => {
  it("starts server, loads ~/.pi models, manages durable SQLite sessions, streams SSE, and inspects git diff", async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-test-"));
    const running = await startMyPiServer({
      port: 0,
      host: "127.0.0.1",
      dataDir: tmpDataDir,
      startDirs: ["/Users/kaleo/code/android/mypi"],
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

      // 2. Device info & ~/.pi models
      const device = await client.getDevice();
      assert.equal(device.apiVersion, 1);
      assert.ok(device.models.length > 0, "Expected models loaded from ~/.pi/agent");

      // 3. Directory listing
      const dirs = await client.listDirs("/Users/kaleo/code/android/mypi");
      assert.equal(dirs.path, "/Users/kaleo/code/android/mypi");
      assert.ok(dirs.dirs.some((d) => d.name === "packages"));

      // 4. Create durable session
      const created = await client.createSession({
        name: "Android Sync Test",
        cwd: "/Users/kaleo/code/android/mypi",
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
      assert.equal(state.cwd, "/Users/kaleo/code/android/mypi");

      // 6. Git status endpoint
      const gitStatus = await client.getGitStatus(created.id);
      assert.equal(typeof gitStatus.isGitRepo, "boolean");

      // 7. File & Directory Workbench endpoints (mkdir + git init, bookmarks, file preview)
      const createdSubDir = await client.createDirectory({
        parentPath: tmpDataDir,
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

      // 8. Live session CWD + title update & context reset
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

      // 9. OpenAI account usage endpoint
      const openaiUsage = await client.getOpenAIUsage();
      assert.equal(typeof openaiUsage.configured, "boolean");
      assert.ok(Array.isArray(openaiUsage.ledger.byModel));

      // 10. Delete/archive session
      const deleted = await client.deleteSession(created.id);
      assert.equal(deleted.archived, true);
    } finally {
      await running.close();
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });
});
