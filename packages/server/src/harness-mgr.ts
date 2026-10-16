import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type Conversation,
  createRegistry,
  Harness,
  ROOT_CONVERSATION_ID,
  watchEvents,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type {
  CreateSessionRequest,
  DeviceInfo,
  DirectoryListing,
  ModelRef,
  RawAgentEvent,
  RawSnapshotEvent,
  SendMessageRequest,
  SendMessageResponse,
  SessionSummary,
  SseFrame,
  ThinkingLevel,
  UpdateSessionRequest,
} from "@mypi/shared";
import type { LoadedModelsConfig } from "./auth-loader.js";

interface CatalogEntry {
  id: string;
  name: string;
  cwd: string;
  model: ModelRef;
  thinkingLevel: ThinkingLevel;
  createdAt: number;
  updatedAt: number;
}

interface CatalogData {
  deviceUid: string;
  sessions: CatalogEntry[];
}

interface ManagedSession {
  meta: CatalogEntry;
  harness: Harness;
  root: Conversation;
}

const DEFAULT_SYSTEM_INSTRUCTIONS = [
  "You are Pi, an expert coding agent running inside a durable session managed by MyPi.",
  "You have access to read, write, edit, and bash tools operating directly in the session's working directory.",
  "Keep responses concise, accurate, and mobile-friendly when inspected from a phone screen.",
].join("\n");

export class HarnessManager {
  readonly dataDir: string;
  readonly startDirs: string[];
  readonly modelsConfig: LoadedModelsConfig;
  readonly startedAt = Date.now();
  private catalogPath: string;
  private catalog: CatalogData;
  private activeSessions = new Map<string, Promise<ManagedSession>>();

  constructor(options: {
    dataDir: string;
    startDirs: string[];
    modelsConfig: LoadedModelsConfig;
  }) {
    this.dataDir = options.dataDir;
    this.startDirs = options.startDirs;
    this.modelsConfig = options.modelsConfig;
    fs.mkdirSync(path.join(this.dataDir, "sessions"), { recursive: true });
    this.catalogPath = path.join(this.dataDir, "catalog.json");
    this.catalog = this.loadCatalog();
  }

  private loadCatalog(): CatalogData {
    if (fs.existsSync(this.catalogPath)) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(this.catalogPath, "utf8"),
        ) as CatalogData;
        if (parsed && Array.isArray(parsed.sessions)) {
          return parsed;
        }
      } catch {
        // Fallback to new catalog
      }
    }
    const fresh: CatalogData = {
      deviceUid: crypto.randomUUID(),
      sessions: [],
    };
    this.saveCatalog(fresh);
    return fresh;
  }

  private saveCatalog(data: CatalogData = this.catalog): void {
    fs.writeFileSync(this.catalogPath, JSON.stringify(data, null, 2), "utf8");
  }

  getDeviceInfo(): DeviceInfo {
    return {
      uid: this.catalog.deviceUid,
      name: os.hostname(),
      hostname: os.hostname(),
      platform: `${os.platform()} (${os.arch()})`,
      apiVersion: 1,
      durableVersion: "1.3.0",
      startedAt: this.startedAt,
      models: this.modelsConfig.availableModels,
      defaultModel: this.modelsConfig.defaultModel,
      defaultThinkingLevel: this.modelsConfig.defaultThinkingLevel,
      startDirs: this.startDirs,
    };
  }

  listDirectories(requestedPath?: string): DirectoryListing {
    const targetPath = requestedPath
      ? path.resolve(requestedPath)
      : this.startDirs[0] || os.homedir();

    if (!fs.existsSync(targetPath)) {
      throw new Error(`Directory not found: ${targetPath}`);
    }
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${targetPath}`);
    }

    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => {
        const fullPath = path.join(targetPath, e.name);
        let isGitRepo = false;
        try {
          isGitRepo = fs.existsSync(path.join(fullPath, ".git"));
        } catch {
          isGitRepo = false;
        }
        return {
          name: e.name,
          path: fullPath,
          isGitRepo,
        };
      })
      .sort((a, b) => {
        if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    const parentDir = path.dirname(targetPath);
    return {
      path: targetPath,
      parent: parentDir !== targetPath ? parentDir : null,
      dirs,
    };
  }

  private async openManagedSession(meta: CatalogEntry): Promise<ManagedSession> {
    const existing = this.activeSessions.get(meta.id);
    if (existing) return existing;

    const promise = (async () => {
      const sessionDir = path.join(this.dataDir, "sessions", meta.id);
      fs.mkdirSync(sessionDir, { recursive: true });
      const dbPath = path.join(sessionDir, "agent.sqlite");

      const registry = createRegistry();
      registry.install(CodingTools);

      const storage = await openNodeSqliteStorage(dbPath);
      const harness = await Harness.open(
        storage,
        {
          models: this.modelsConfig.models,
          registry,
          env: ({ cwd }) =>
            new NodeExecutionEnv({
              cwd: cwd && fs.existsSync(cwd) ? cwd : meta.cwd,
            }),
          onReport: (err) => {
            console.error(`[mypi-server] Harness error (${meta.id}):`, err);
          },
        },
        BACKGROUND_CONTEXT,
      );

      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: {
          model: meta.model,
          thinkingLevel: meta.thinkingLevel,
          cwd: meta.cwd,
          instructions: DEFAULT_SYSTEM_INSTRUCTIONS,
        },
      });

      // Resume any unfinished durable tasks from before a crash/restart
      harness.resume();

      return { meta, harness, root };
    })();

    this.activeSessions.set(meta.id, promise);
    try {
      return await promise;
    } catch (err) {
      this.activeSessions.delete(meta.id);
      throw err;
    }
  }

  private async buildSessionSummary(meta: CatalogEntry): Promise<SessionSummary> {
    try {
      const managed = await this.openManagedSession(meta);
      const [inspection, ctxView, agent] = await Promise.all([
        managed.harness.inspect(BACKGROUND_CONTEXT),
        managed.root.context(BACKGROUND_CONTEXT),
        managed.root.agent(BACKGROUND_CONTEXT),
      ]);

      const busy =
        inspection.tasks.length > 0 ||
        inspection.submissions.some(
          (s) => s.status === "queued" || s.status === "placed",
        );

      return {
        id: meta.id,
        name: meta.name,
        cwd: agent.cwd || meta.cwd,
        model: agent.model || meta.model,
        thinkingLevel: (agent.thinkingLevel as ThinkingLevel) || meta.thinkingLevel,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        busy,
        entryCount: ctxView.entries.length,
      };
    } catch {
      return {
        id: meta.id,
        name: meta.name,
        cwd: meta.cwd,
        model: meta.model,
        thinkingLevel: meta.thinkingLevel,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        busy: false,
        entryCount: 0,
      };
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    const sorted = [...this.catalog.sessions].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    return Promise.all(sorted.map((s) => this.buildSessionSummary(s)));
  }

  async createSession(req: CreateSessionRequest): Promise<SessionSummary> {
    const resolvedCwd = path.resolve(req.cwd || this.startDirs[0] || os.homedir());
    if (!fs.existsSync(resolvedCwd)) {
      throw new Error(`Working directory does not exist: ${resolvedCwd}`);
    }

    const id = crypto.randomUUID().slice(0, 8);
    const now = Date.now();
    const defaultName =
      req.name?.trim() || `${path.basename(resolvedCwd)} (${id.slice(0, 4)})`;

    const meta: CatalogEntry = {
      id,
      name: defaultName,
      cwd: resolvedCwd,
      model: req.model ?? this.modelsConfig.defaultModel,
      thinkingLevel: req.thinkingLevel ?? this.modelsConfig.defaultThinkingLevel,
      createdAt: now,
      updatedAt: now,
    };

    this.catalog.sessions.push(meta);
    this.saveCatalog();

    await this.openManagedSession(meta);
    return this.buildSessionSummary(meta);
  }

  async getSessionSummary(sessionId: string): Promise<SessionSummary> {
    const meta = this.catalog.sessions.find((s) => s.id === sessionId);
    if (!meta) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return this.buildSessionSummary(meta);
  }

  async updateSession(
    sessionId: string,
    req: UpdateSessionRequest,
  ): Promise<SessionSummary> {
    const meta = this.catalog.sessions.find((s) => s.id === sessionId);
    if (!meta) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (req.name && req.name.trim()) {
      meta.name = req.name.trim();
    }
    if (req.model) {
      meta.model = req.model;
    }
    if (req.thinkingLevel) {
      meta.thinkingLevel = req.thinkingLevel;
    }
    meta.updatedAt = Date.now();
    this.saveCatalog();

    const managed = await this.openManagedSession(meta);
    if (req.model || req.thinkingLevel) {
      await managed.root.configure(
        {
          model: req.model ?? meta.model,
          thinkingLevel: req.thinkingLevel ?? meta.thinkingLevel,
        },
        BACKGROUND_CONTEXT,
      );
    }

    return this.buildSessionSummary(meta);
  }

  async deleteSession(sessionId: string): Promise<{ archived: boolean }> {
    const idx = this.catalog.sessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const [meta] = this.catalog.sessions.splice(idx, 1);
    this.saveCatalog();

    const active = this.activeSessions.get(meta.id);
    if (active) {
      this.activeSessions.delete(meta.id);
      try {
        const managed = await active;
        await managed.root.abort(BACKGROUND_CONTEXT, { background: true });
        await managed.harness.close(BACKGROUND_CONTEXT);
      } catch {
        // Ignore close errors
      }
    }

    const sessionDir = path.join(this.dataDir, "sessions", meta.id);
    const archiveDir = path.join(this.dataDir, "archive", meta.id);
    if (fs.existsSync(sessionDir)) {
      fs.mkdirSync(path.dirname(archiveDir), { recursive: true });
      try {
        fs.renameSync(sessionDir, archiveDir);
      } catch {
        // Ignore archive move error
      }
    }

    return { archived: true };
  }

  async sendMessage(
    sessionId: string,
    req: SendMessageRequest,
  ): Promise<SendMessageResponse> {
    const meta = this.catalog.sessions.find((s) => s.id === sessionId);
    if (!meta) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const managed = await this.openManagedSession(meta);

    // Ensure session name auto-updates on first prompt if still generic
    if (
      meta.name.endsWith(`(${meta.id.slice(0, 4)})`) &&
      req.content.trim().length > 0
    ) {
      const preview = req.content.trim().split(/\r?\n/)[0].slice(0, 36);
      meta.name = `${path.basename(meta.cwd)}: ${preview}`;
    }
    meta.updatedAt = Date.now();
    this.saveCatalog();

    const submission = await managed.root.submit(
      {
        type: "input",
        requestId: req.requestId,
        content: req.content,
        whenBusy: req.whenBusy ?? "steer",
      },
      BACKGROUND_CONTEXT,
    );

    const statusRecord = await submission.status(BACKGROUND_CONTEXT);
    return {
      submissionId: submission.id,
      requestId: req.requestId,
      status: statusRecord.status,
    };
  }

  async abortSession(sessionId: string): Promise<{ status: string }> {
    const meta = this.catalog.sessions.find((s) => s.id === sessionId);
    if (!meta) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const managed = await this.openManagedSession(meta);
    await managed.root.abort(BACKGROUND_CONTEXT, { background: true });
    meta.updatedAt = Date.now();
    this.saveCatalog();
    return { status: "aborted" };
  }

  async subscribeSession(
    sessionId: string,
    onFrame: (frame: SseFrame) => void,
  ): Promise<() => Promise<void>> {
    const meta = this.catalog.sessions.find((s) => s.id === sessionId);
    if (!meta) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const managed = await this.openManagedSession(meta);
    const summary = await this.buildSessionSummary(meta);

    onFrame({
      type: "hello",
      apiVersion: 1,
      sessionId: meta.id,
      serverTime: Date.now(),
    });

    const stream = await watchEvents(
      managed.harness,
      ROOT_CONVERSATION_ID,
      BACKGROUND_CONTEXT,
    );

    onFrame({
      type: "snapshot",
      session: summary,
      snapshot: stream.snapshot as unknown as RawSnapshotEvent,
    });

    stream.start(async (events) => {
      onFrame({
        type: "events",
        events: events as unknown as readonly RawAgentEvent[],
      });
    });

    return async () => {
      try {
        await stream.stop();
      } catch {
        // Ignore stop error
      }
    };
  }
}
