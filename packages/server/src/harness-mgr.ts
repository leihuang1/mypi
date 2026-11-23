import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type Conversation,
  createRegistry,
  Harness,
  InboxDoc,
  ROOT_CONVERSATION_ID,
  type SubmissionId,
  watchEvents,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type {
  AbortSubmissionResponse,
  ArchiveRequest,
  ArchiveResponse,
  CompactSessionRequest,
  CompactSessionResponse,
  CreateDirectoryRequest,
  CreateDirectoryResponse,
  CreateSessionRequest,
  DeviceInfo,
  DirectoryListing,
  FileEntrySummary,
  FilePreviewResponse,
  GitCloneRequest,
  GitStatusResponse,
  GitCloneResponse,
  ModelRef,
  OpenAIAccountUsageResponse,
  PullRequestInfo,
  QueuedSubmissionItem,
  RawAgentEvent,
  RawEntryRecord,
  RawSnapshotEvent,
  ResetSessionRequest,
  ResetSessionResponse,
  SendMessageRequest,
  SendMessageResponse,
  SessionStatus,
  SessionSummary,
  ShipPreview,
  ShipRequest,
  ShipResponse,
  SseFrame,
  ThinkingLevel,
  UpdateBookmarkRequest,
  UpdateBookmarkResponse,
  UpdateSessionRequest,
} from "@mypi/shared";
import { NotificationService } from "./notification-service.js";
import type { LoadedModelsConfig } from "./auth-loader.js";
import { AskUserExtension, conversationState, lastReply } from "./extensions/ask-user.js";
import { agentShellEnv, GuardExtension } from "./extensions/guard.js";
import { createPiCompatExtension } from "./extensions/pi-compat.js";
import { changeStats, inspectGitDirectory, noGitStatus } from "./git-service.js";
import { ConflictError } from "./errors.js";
import { pullRequestState, shipState, shipWorktree } from "./ship.js";
import { createSessionWorktree, removeSessionWorktree, type SessionWorktree, worktreeCwd, worktreeWork } from "./worktree-service.js";

const execFileAsync = promisify(execFile);

interface CatalogEntry {
  id: string;
  name: string;
  cwd: string;
  model: ModelRef;
  thinkingLevel: ThinkingLevel;
  /** Absent in catalogs written before the toggle existed: on. */
  ponytail?: boolean;
  /** Set when the session works in its own worktree; `cwd` is inside it. */
  worktree?: SessionWorktree;
  /** The draft PR Ship opened; when it last shipped, and the commit it pushed. */
  pr?: PullRequestInfo & { shippedAt: number; head?: string };
  /** Archived by the user, or after the PR was merged or closed. Read-only from then on. */
  archivedAt?: number;
  /** When the user last sent a message: work after the last Ship means the session isn't "shipped" any more. */
  lastInputAt?: number;
  /** The submission of the last message sent, for its outcome. Cleared by reset. */
  lastInput?: number;
  createdAt: number;
  updatedAt: number;
}

interface CatalogData {
  deviceUid: string;
  sessions: CatalogEntry[];
  bookmarks?: string[];
}

interface ManagedSession {
  meta: CatalogEntry;
  harness: Harness;
  root: Conversation;
  submissionTexts: Map<number, string>;
  stopNotifications: () => Promise<void>;
}

/** The folder a session is about: the one it was started from, not its worktree. */
function sourceDir(meta: CatalogEntry): string {
  return meta.worktree?.sourceCwd ?? meta.cwd;
}

function worktreeFields(meta: CatalogEntry): Pick<SessionSummary, "branch" | "worktreePath" | "baseRef" | "repoPath" | "prUrl" | "prState"> {
  const wt = meta.worktree;
  return {
    ...(wt ? { branch: wt.branch, worktreePath: wt.path, baseRef: wt.baseRef, repoPath: wt.repoPath } : {}),
    ...(meta.pr ? { prUrl: meta.pr.url, prState: meta.pr.state } : {}),
    ...(meta.archivedAt ? { archivedAt: meta.archivedAt } : {}),
  };
}

function assertWritable(meta: CatalogEntry): void {
  if (meta.archivedAt) throw new ConflictError("会话已归档，只能查看");
}

/** The commit message and PR title Ship suggests: the first line of the agent's last reply. */
function suggestedMessage(meta: CatalogEntry, reply: string | undefined): string {
  const line = reply?.split("\n").map((l) => l.replace(/^[\s#>*-]+|\*\*/g, "").trim()).find(Boolean);
  return (line || meta.name).slice(0, 200);
}

const DEFAULT_SYSTEM_INSTRUCTIONS = [
  "You are Pi, an expert coding agent running inside a durable session managed by MyPi.",
  "You have access to read, write, edit, and bash tools operating directly in the session's working directory.",
  "Keep responses concise, accurate, and mobile-friendly when inspected from a phone screen.",
].join("\n");

export class HarnessManager {
  readonly dataDir: string;
  readonly name: string;
  readonly startDirs: string[];
  readonly modelsConfig: LoadedModelsConfig;
  readonly startedAt = Date.now();
  readonly notifications: NotificationService;
  private catalogPath: string;
  private catalog: CatalogData;
  private activeSessions = new Map<string, Promise<ManagedSession>>();
  private activeSubscribers = new Set<() => Promise<void>>();
  private inFlightOps = new Set<Promise<unknown>>();
  /** The agent's shell environment: the daemon's, minus GitHub credentials. */
  private readonly agentEnv: NodeJS.ProcessEnv;
  /** One environment per session and directory, so their tool processes can be killed on shutdown. */
  private toolEnvs = new Map<string, NodeExecutionEnv>();
  /** Sessions with a Ship in progress: one at a time each. */
  private shipping = new Set<string>();
  private prTimer: ReturnType<typeof setInterval> | undefined;
  private checkingPullRequests = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: {
    dataDir: string;
    startDirs: string[];
    modelsConfig: LoadedModelsConfig;
    name?: string;
  }) {
    this.name = options.name ?? os.hostname();
    this.dataDir = options.dataDir;
    this.startDirs = options.startDirs;
    this.modelsConfig = options.modelsConfig;
    fs.mkdirSync(path.join(this.dataDir, "sessions"), { recursive: true });
    this.catalogPath = path.join(this.dataDir, "catalog.json");
    this.catalog = this.loadCatalog();
    this.agentEnv = agentShellEnv(this.dataDir);
    this.notifications = new NotificationService(
      this.dataDir,
      (id) => this.catalog.sessions.find((session) => session.id === id)?.name,
      undefined,
      async (id) => {
        // Only a worktree holds just the session's own changes.
        const meta = this.catalog.sessions.find((session) => session.id === id);
        if (!meta?.worktree) return undefined;
        return changeStats(meta.cwd, meta.worktree.baseRef, meta.worktree.baseCommit);
      },
    );
  }

  async resumeSessions(): Promise<void> {
    await this.trackOp(async () => {
      await Promise.all(this.catalog.sessions.map(async (meta) => {
        try { await this.openManagedSession(meta); }
        catch (err) { console.error(`[mypi-server] Could not resume ${meta.id}:`, err); }
      }));
    });
  }

  beginClose(): void {
    this.closing = true;
  }

  isClosing(): boolean {
    return this.closing;
  }

  private assertOpen(): void {
    if (this.closing) {
      throw new Error("Server is shutting down");
    }
  }

  private trackOp<T>(fn: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const p = fn();
    this.inFlightOps.add(p);
    p.finally(() => {
      this.inFlightOps.delete(p);
    }).catch(() => {});
    return p;
  }

  private loadCatalog(): CatalogData {
    if (fs.existsSync(this.catalogPath)) {
      let raw: string;
      try {
        raw = fs.readFileSync(this.catalogPath, "utf8");
      } catch (err) {
        throw new Error(
          `Failed to read catalog at ${this.catalogPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new Error(
          `Corrupted catalog JSON at ${this.catalogPath} (refusing to overwrite): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Array.isArray((parsed as CatalogData).sessions)
      ) {
        throw new Error(
          `Invalid catalog structure at ${this.catalogPath} (refusing to overwrite)`,
        );
      }

      const valid = parsed as CatalogData;
      return {
        ...valid,
        deviceUid:
          typeof valid.deviceUid === "string" && valid.deviceUid.trim()
            ? valid.deviceUid
            : crypto.randomUUID(),
        bookmarks: Array.isArray(valid.bookmarks) ? valid.bookmarks : [],
      };
    }

    const fresh: CatalogData = {
      deviceUid: crypto.randomUUID(),
      sessions: [],
      bookmarks: [],
    };
    this.saveCatalog(fresh);
    return fresh;
  }

  private saveCatalog(data: CatalogData = this.catalog): void {
    const tmpPath = `${this.catalogPath}.${process.pid}.${Date.now()}.${crypto
      .randomBytes(4)
      .toString("hex")}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmpPath, this.catalogPath);
  }

  private expandUserPath(rawPath: string): string {
    const trimmed = rawPath.trim();
    if (trimmed === "~") {
      return os.homedir();
    }
    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
      return path.resolve(os.homedir(), trimmed.slice(2));
    }
    return path.resolve(trimmed);
  }

  getBookmarks(): string[] {
    const raw = this.catalog.bookmarks ?? [];
    return raw.filter((dirPath) => {
      try {
        return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
      } catch {
        return false;
      }
    });
  }

  getRecentDirs(): string[] {
    const seen = new Set<string>();
    const recent: string[] = [];
    const sortedSessions = [...this.catalog.sessions].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    for (const s of sortedSessions) {
      const dir = sourceDir(s);
      if (dir && !seen.has(dir)) {
        try {
          if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
            seen.add(dir);
            recent.push(dir);
          }
        } catch {
          // Ignore inaccessible dir
        }
      }
      if (recent.length >= 8) break;
    }
    for (const startDir of this.startDirs) {
      const resolved = this.expandUserPath(startDir);
      if (!seen.has(resolved) && recent.length < 8) {
        try {
          if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
            seen.add(resolved);
            recent.push(resolved);
          }
        } catch {
          // Ignore
        }
      }
    }
    return recent;
  }

  updateBookmark(req: UpdateBookmarkRequest): UpdateBookmarkResponse {
    if (!req.path || typeof req.path !== "string") {
      throw new Error("Bookmark path is required");
    }
    const targetPath = this.expandUserPath(req.path);
    const current = new Set(this.catalog.bookmarks ?? []);
    if (req.bookmarked) {
      if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
        throw new Error(`Directory not found: ${targetPath}`);
      }
      current.add(targetPath);
    } else {
      current.delete(targetPath);
    }
    this.catalog.bookmarks = Array.from(current);
    this.saveCatalog();
    return { bookmarks: this.getBookmarks() };
  }

  getDeviceInfo(): DeviceInfo {
    return {
      uid: this.catalog.deviceUid,
      name: this.name,
      hostname: os.hostname(),
      platform: `${os.platform()} (${os.arch()})`,
      apiVersion: 1,
      durableVersion: "1.3.0",
      startedAt: this.startedAt,
      models: this.modelsConfig.availableModels,
      defaultModel: this.modelsConfig.defaultModel,
      defaultThinkingLevel: this.modelsConfig.defaultThinkingLevel,
      startDirs: this.startDirs,
      recentDirs: this.getRecentDirs(),
      bookmarks: this.getBookmarks(),
    };
  }

  listDirectories(
    requestedPath?: string,
    options?: { includeHidden?: boolean },
  ): DirectoryListing {
    const includeHidden = Boolean(options?.includeHidden);
    const targetPath = requestedPath
      ? this.expandUserPath(requestedPath)
      : this.startDirs[0]
        ? this.expandUserPath(this.startDirs[0])
        : os.homedir();

    if (!fs.existsSync(targetPath)) {
      throw new Error(`Directory not found: ${targetPath}`);
    }
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${targetPath}`);
    }

    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const dirs = entries
      .filter(
        (e) =>
          e.isDirectory() && (includeHidden || !e.name.startsWith(".")),
      )
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
          isHidden: e.name.startsWith("."),
        };
      })
      .sort((a, b) => {
        if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    const files: FileEntrySummary[] = entries
      .filter(
        (e) => e.isFile() && (includeHidden || !e.name.startsWith(".")),
      )
      .map((e) => {
        const fullPath = path.join(targetPath, e.name);
        let size = 0;
        let mtime = 0;
        try {
          const fstat = fs.statSync(fullPath);
          size = fstat.size;
          mtime = Math.floor(fstat.mtimeMs);
        } catch {
          // Ignore stat error
        }
        return {
          name: e.name,
          path: fullPath,
          size,
          mtime,
          isHidden: e.name.startsWith("."),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const parentDir = path.dirname(targetPath);
    return {
      path: targetPath,
      parent: parentDir !== targetPath ? parentDir : null,
      dirs,
      files,
      recentDirs: this.getRecentDirs(),
      bookmarks: this.getBookmarks(),
    };
  }

  async createDirectory(
    req: CreateDirectoryRequest,
  ): Promise<CreateDirectoryResponse> {
    let targetPath: string;
    if (req.path?.trim()) {
      targetPath = this.expandUserPath(req.path);
    } else if (req.parentPath && req.name?.trim()) {
      const parentDir = this.expandUserPath(req.parentPath);
      if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
        throw new Error(`Parent directory not found: ${parentDir}`);
      }
      targetPath = path.resolve(parentDir, req.name.trim());
    } else {
      throw new Error("parentPath and directory name are required");
    }

    fs.mkdirSync(targetPath, { recursive: true });

    let isGitRepo = fs.existsSync(path.join(targetPath, ".git"));
    if (req.gitInit && !isGitRepo) {
      await execFileAsync("git", ["init"], { cwd: targetPath });
      isGitRepo = true;
    }

    return {
      path: targetPath,
      isGitRepo,
    };
  }

  async gitCloneDirectory(req: GitCloneRequest): Promise<GitCloneResponse> {
    if (!req.targetParentDir || !req.repoUrl?.trim()) {
      throw new Error("targetParentDir and repoUrl are required");
    }
    const parentDir = this.expandUserPath(req.targetParentDir);
    if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
      throw new Error(`Parent directory not found: ${parentDir}`);
    }
    const repoUrl = req.repoUrl.trim();
    const inferredName =
      req.folderName?.trim() ||
      path
        .basename(repoUrl.replace(/\/+$/, ""))
        .replace(/\.git$/i, "") ||
      "repo";

    const targetPath = path.resolve(parentDir, inferredName);
    if (fs.existsSync(targetPath)) {
      throw new Error(`Target directory already exists: ${targetPath}`);
    }

    await execFileAsync("git", ["clone", repoUrl, targetPath], {
      cwd: parentDir,
      timeout: 120_000,
    });

    return {
      path: targetPath,
      isGitRepo: fs.existsSync(path.join(targetPath, ".git")),
    };
  }

  readFilePreview(requestedPath: string): FilePreviewResponse {
    if (!requestedPath || !requestedPath.trim()) {
      throw new Error("File path is required");
    }
    const targetPath = this.expandUserPath(requestedPath);
    if (!fs.existsSync(targetPath)) {
      throw new Error(`File not found: ${targetPath}`);
    }
    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${targetPath}`);
    }

    const maxBytes = 64 * 1024; // 64 KB preview limit
    const readSize = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(targetPath, "r");
    try {
      fs.readSync(fd, buffer, 0, readSize, 0);
    } finally {
      fs.closeSync(fd);
    }

    // Check first 4KB for null bytes to detect binary files
    const checkLength = Math.min(readSize, 4096);
    let isBinary = false;
    for (let i = 0; i < checkLength; i++) {
      if (buffer[i] === 0) {
        isBinary = true;
        break;
      }
    }

    return {
      path: targetPath,
      name: path.basename(targetPath),
      size: stat.size,
      content: isBinary ? "" : buffer.toString("utf8"),
      truncated: stat.size > maxBytes,
      isBinary,
    };
  }

  private async openManagedSession(meta: CatalogEntry): Promise<ManagedSession> {
    this.assertOpen();
    const existing = this.activeSessions.get(meta.id);
    if (existing) return existing;

    const promise = (async () => {
      const sessionDir = path.join(this.dataDir, "sessions", meta.id);
      fs.mkdirSync(sessionDir, { recursive: true });
      const dbPath = path.join(sessionDir, "agent.sqlite");

      const registry = createRegistry();
      registry.install(CodingTools);
      registry.install(createPiCompatExtension({ ponytail: () => meta.ponytail !== false }));
      registry.install(GuardExtension);
      registry.install(AskUserExtension);

      const storage = await openNodeSqliteStorage(dbPath);
      const harness = await Harness.open(
        storage,
        {
          models: this.modelsConfig.models,
          registry,
          env: ({ cwd }) => this.toolEnv(meta, cwd),
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

      // This observer belongs to the daemon, never to an App/SSE connection.
      const noticeStream = await watchEvents(harness, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
      const recoveredSubmissions: RawAgentEvent[] = [];
      for (const id of this.notifications.observedInputs(meta.id)) {
        const submission = await harness.submission(id as SubmissionId, BACKGROUND_CONTEXT);
        if (submission) recoveredSubmissions.push({ type: "submission", record: await submission.status(BACKGROUND_CONTEXT) });
      }
      this.notifications.events(meta.id, [noticeStream.snapshot as unknown as RawSnapshotEvent, ...recoveredSubmissions]);
      noticeStream.start(async (events) => {
        this.notifications.events(meta.id, events as unknown as RawAgentEvent[]);
      });
      let noticeStopped = false;
      const stopNotifications = async () => {
        if (noticeStopped) return;
        noticeStopped = true;
        this.activeSubscribers.delete(stopNotifications);
        await noticeStream.stop();
      };
      this.activeSubscribers.add(stopNotifications);

      // Resume any unfinished durable tasks from before a crash/restart
      if (!this.closing) {
        harness.resume();
      }

      return {
        meta,
        harness,
        root,
        submissionTexts: new Map<number, string>(),
        stopNotifications,
      };
    })();

    this.activeSessions.set(meta.id, promise);
    try {
      return await promise;
    } catch (err) {
      if (!this.closing) {
        this.activeSessions.delete(meta.id);
      }
      throw err;
    }
  }

  private toolEnv(meta: CatalogEntry, cwd: string | undefined): NodeExecutionEnv {
    const dir = cwd && fs.existsSync(cwd) ? cwd : meta.cwd;
    const key = `${meta.id}\0${dir}`;
    let env = this.toolEnvs.get(key);
    if (!env) {
      env = new NodeExecutionEnv({ cwd: dir, shellEnv: this.agentEnv });
      this.toolEnvs.set(key, env);
    }
    return env;
  }

  /**
   * Kill the agent's running tool processes (and their process groups). For a daemon about to exit: they would
   * otherwise outlive it, while the restarted session reports them as interrupted.
   */
  killToolProcesses(): void {
    for (const env of this.toolEnvs.values()) void env.cleanup(BACKGROUND_CONTEXT);
  }

  private async buildSessionSummary(meta: CatalogEntry): Promise<SessionSummary> {
    try {
      const managed = await this.openManagedSession(meta);
      const [inspection, ctxView, agent] = await Promise.all([
        managed.harness.inspect(BACKGROUND_CONTEXT),
        managed.root.context(BACKGROUND_CONTEXT),
        managed.root.agent(BACKGROUND_CONTEXT),
      ]);

      const busy = inspection.tasks.length > 0 || inspection.submissions.some((s) => s.status === "placed");
      // Submitting to an idle conversation places the input at once; after a failed run, queued inputs wait for the
      // next one. So queued with nothing running is stuck, not running.
      const stuck = !busy && inspection.submissions.some((s) => s.status === "queued");
      // The last input's outcome, from the runtime: some failures (no model, a task fault) write no assistant message.
      const last = meta.lastInput === undefined ? undefined
        : await (await managed.harness.submission(meta.lastInput as SubmissionId, BACKGROUND_CONTEXT))?.status(BACKGROUND_CONTEXT);
      const conversation = conversationState(ctxView.entries as unknown as RawEntryRecord[]);
      const failed = stuck || conversation.failed ||
        (last?.status === "unanswered" && last.reason !== "aborted" && last.reason !== "reset");
      const finished = last?.status === "done" || last?.status === "unanswered" ? last.status === "done" : conversation.finished;
      const status: SessionStatus = meta.archivedAt ? "archived"
        : busy ? "running"
          : conversation.question || failed ? "needs_you"
            : meta.pr?.state === "open" && (meta.lastInputAt ?? 0) <= meta.pr.shippedAt ? "shipped"
              : finished || meta.pr ? "done" : "idle";

      return {
        id: meta.id,
        name: meta.name,
        cwd: agent.cwd || meta.cwd,
        model: agent.model || meta.model,
        thinkingLevel: (agent.thinkingLevel as ThinkingLevel) || meta.thinkingLevel,
        ponytail: meta.ponytail !== false,
        ...worktreeFields(meta),
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        busy,
        status,
        ...(status === "needs_you" && conversation.question ? { question: conversation.question } : {}),
        entryCount: ctxView.entries.length,
      };
    } catch {
      return {
        id: meta.id,
        name: meta.name,
        cwd: meta.cwd,
        model: meta.model,
        thinkingLevel: meta.thinkingLevel,
        ponytail: meta.ponytail !== false,
        ...worktreeFields(meta),
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        busy: false,
        entryCount: 0,
      };
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.trackOp(async () => {
      const sorted = [...this.catalog.sessions].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      );
      return Promise.all(sorted.map((s) => this.buildSessionSummary(s)));
    });
  }

  async createSession(req: CreateSessionRequest): Promise<SessionSummary> {
    return this.trackOp(async () => {
      const resolvedCwd = this.expandUserPath(
        req.cwd || this.startDirs[0] || os.homedir(),
      );
      if (!fs.existsSync(resolvedCwd)) {
        throw new Error(`Working directory does not exist: ${resolvedCwd}`);
      }

      const id = crypto.randomUUID().slice(0, 8);
      const defaultName =
        req.name?.trim() || `${path.basename(resolvedCwd)} (${id.slice(0, 4)})`;
      const worktree = req.worktree === false
        ? undefined
        : await createSessionWorktree(resolvedCwd, path.join(this.dataDir, "worktrees"), id);
      const now = Date.now();

      const meta: CatalogEntry = {
        id,
        name: defaultName,
        cwd: worktree ? worktreeCwd(worktree) : resolvedCwd,
        worktree,
        model: req.model ?? this.modelsConfig.defaultModel,
        thinkingLevel:
          req.thinkingLevel ?? this.modelsConfig.defaultThinkingLevel,
        ponytail: req.ponytail ?? true,
        createdAt: now,
        updatedAt: now,
      };

      if (this.closing && worktree) {
        await removeSessionWorktree(worktree).catch(() => {});
      }
      this.assertOpen();
      this.catalog.sessions.push(meta);
      this.saveCatalog();

      await this.openManagedSession(meta);
      return this.buildSessionSummary(meta);
    });
  }

  async getSessionSummary(sessionId: string): Promise<SessionSummary> {
    return this.trackOp(async () => {
      const meta = this.catalog.sessions.find((s) => s.id === sessionId);
      if (!meta) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      return this.buildSessionSummary(meta);
    });
  }

  async updateSession(
    sessionId: string,
    req: UpdateSessionRequest,
  ): Promise<SessionSummary> {
    return this.trackOp(async () => {
      const meta = this.catalog.sessions.find((s) => s.id === sessionId);
      if (!meta) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      assertWritable(meta);

      if (req.name && req.name.trim()) {
        meta.name = req.name.trim();
      }
      if (req.model) {
        meta.model = req.model;
      }
      if (req.thinkingLevel) {
        meta.thinkingLevel = req.thinkingLevel;
      }
      if (typeof req.ponytail === "boolean") {
        meta.ponytail = req.ponytail;
      }
      if (req.cwd && req.cwd.trim()) {
        const resolvedCwd = this.expandUserPath(req.cwd);
        if (
          !fs.existsSync(resolvedCwd) ||
          !fs.statSync(resolvedCwd).isDirectory()
        ) {
          throw new Error(`Working directory does not exist: ${resolvedCwd}`);
        }
        // Real paths: a symlink in the worktree may lead back to the checkout, and /var is /private/var.
        const relative = meta.worktree && path.relative(fs.realpathSync(meta.worktree.path), fs.realpathSync(resolvedCwd));
        if (relative !== undefined && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
          throw new Error(`This session works in its own worktree; its folder must stay inside ${meta.worktree!.path}`);
        }
        meta.cwd = resolvedCwd;
      }
      meta.updatedAt = Date.now();
      this.saveCatalog();

      const managed = await this.openManagedSession(meta);
      if (req.model || req.thinkingLevel || req.cwd) {
        await managed.root.configure(
          {
            model: req.model ?? meta.model,
            thinkingLevel: req.thinkingLevel ?? meta.thinkingLevel,
            cwd: meta.cwd,
          },
          BACKGROUND_CONTEXT,
        );
      }

      return this.buildSessionSummary(meta);
    });
  }

  async deleteSession(sessionId: string): Promise<{ archived: boolean }> {
    return this.trackOp(async () => {
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
          this.notifications.stopSession(sessionId);
          await managed.stopNotifications();
          await managed.root.abort(BACKGROUND_CONTEXT, { background: true });
          await managed.harness.close(BACKGROUND_CONTEXT);
        } catch {
          // Ignore close errors
        }
      }

      for (const key of this.toolEnvs.keys()) {
        if (key.startsWith(`${meta.id}\0`)) this.toolEnvs.delete(key);
      }

      if (meta.worktree) {
        try {
          const { removed, work } = await removeSessionWorktree(meta.worktree, { pushed: meta.pr?.head });
          if (!removed) {
            console.warn(`[mypi-server] Kept ${meta.worktree.path} and ${meta.worktree.branch} of deleted session ${meta.id}: ` +
              `${work.uncommitted} uncommitted path(s), ${work.unpushed} unpushed commit(s)`);
          }
        } catch (err) {
          console.error(`[mypi-server] Could not remove the worktree of deleted session ${meta.id}:`, err);
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
    });
  }

  async sendMessage(
    sessionId: string,
    req: SendMessageRequest,
  ): Promise<SendMessageResponse> {
    return this.trackOp(async () => {
      const meta = this.catalog.sessions.find((s) => s.id === sessionId);
      if (!meta) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      assertWritable(meta);
      const managed = await this.openManagedSession(meta);

      // Ensure session name auto-updates on first prompt if still generic
      if (
        meta.name.endsWith(`(${meta.id.slice(0, 4)})`) &&
        req.content.trim().length > 0
      ) {
        const preview = req.content.trim().split(/\r?\n/)[0].slice(0, 36);
        meta.name = `${path.basename(sourceDir(meta))}: ${preview}`;
      }
      meta.updatedAt = Date.now();
      meta.lastInputAt = meta.updatedAt;
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

      managed.submissionTexts.set(submission.id, req.content);
      meta.lastInput = submission.id;
      this.saveCatalog();

      const statusRecord = await submission.status(BACKGROUND_CONTEXT);
      return {
        submissionId: submission.id,
        requestId: req.requestId,
        status: statusRecord.status,
      };
    });
  }

  /** The session's changes: against its base for a worktree session, none once archived (the worktree is gone). */
  async gitStatus(sessionId: string): Promise<GitStatusResponse> {
    return this.trackOp(async () => {
      const meta = this.catalog.sessions.find((s) => s.id === sessionId);
      if (!meta) throw new Error(`Session not found: ${sessionId}`);
      if (meta.archivedAt) return noGitStatus();
      return inspectGitDirectory(meta.cwd, meta.worktree?.baseRef, meta.worktree?.baseCommit);
    });
  }

  async shipPreview(sessionId: string): Promise<ShipPreview> {
    return this.trackOp(async () => {
      const meta = this.catalog.sessions.find((s) => s.id === sessionId);
      if (!meta) throw new Error(`Session not found: ${sessionId}`);
      const managed = await this.openManagedSession(meta);
      const ctxView = await managed.root.context(BACKGROUND_CONTEXT);
      const message = suggestedMessage(meta, lastReply(ctxView.entries as unknown as RawEntryRecord[]));
      const pr = meta.pr && { url: meta.pr.url, number: meta.pr.number, state: meta.pr.state };
      if (!meta.worktree) {
        return { ready: false, reason: "这个会话直接在原目录里工作，没有自己的分支可以发布", uncommitted: 0, unpushed: 0, suggestedMessage: message };
      }
      const state = await shipState(meta.worktree);
      const nothing = !state.problem && state.uncommitted + state.unpushed === 0;
      return {
        ready: !state.problem && !nothing,
        reason: state.problem ?? (nothing ? (pr ? "已发布，之后没有新的改动" : "还没有可以发布的改动") : undefined),
        branch: meta.worktree.branch,
        baseRef: meta.worktree.baseRef,
        uncommitted: state.uncommitted,
        unpushed: state.unpushed,
        suggestedMessage: message,
        pr,
      };
    });
  }

  /** Commit, push `mypi/<id>` and open a draft PR (or update the open one) with the daemon's credentials. */
  async shipSession(sessionId: string, req: ShipRequest): Promise<ShipResponse> {
    return this.trackOp(async () => {
      const meta = this.catalog.sessions.find((s) => s.id === sessionId);
      if (!meta) throw new Error(`Session not found: ${sessionId}`);
      assertWritable(meta);
      if (!meta.worktree) throw new ConflictError("这个会话直接在原目录里工作，没有自己的分支可以发布");
      if (this.shipping.has(sessionId)) throw new ConflictError("正在发布中");
      this.shipping.add(sessionId);
      try {
        const managed = await this.openManagedSession(meta);
        const [inspection, ctxView] = await Promise.all([
          managed.harness.inspect(BACKGROUND_CONTEXT),
          managed.root.context(BACKGROUND_CONTEXT),
        ]);
        if (inspection.tasks.length > 0 || inspection.submissions.some((s) => s.status === "queued" || s.status === "placed")) {
          throw new ConflictError("Agent 还在工作，等它结束再发布");
        }
        const reply = lastReply(ctxView.entries as unknown as RawEntryRecord[]);
        const message = req.message?.trim() || suggestedMessage(meta, reply);
        const body = [reply?.slice(0, 4000), `_Shipped by MyPi from session “${meta.name}”._`].filter(Boolean).join("\n\n");
        const existing = meta.pr?.state === "open" ? { url: meta.pr.url, number: meta.pr.number, state: meta.pr.state } : undefined;
        const result = await shipWorktree(meta.worktree, { message, body, existing });
        meta.pr = { ...result.pr, shippedAt: Date.now(), head: result.head };
        meta.updatedAt = meta.pr.shippedAt;
        this.saveCatalog();
        return { pr: result.pr, committed: result.committed, pushed: result.pushed, session: await this.buildSessionSummary(meta) };
      } finally {
        this.shipping.delete(sessionId);
      }
    });
  }

  /**
   * Make the session read-only and remove its worktree. Without `force`, a worktree that still holds uncommitted or
   * unpushed work stays, and the response says what's there. Unpushed commits always stay on the branch.
   */
  async archiveSession(sessionId: string, req: ArchiveRequest): Promise<ArchiveResponse> {
    return this.trackOp(async () => {
      const meta = this.catalog.sessions.find((s) => s.id === sessionId);
      if (!meta) throw new Error(`Session not found: ${sessionId}`);
      if (meta.archivedAt) return { archived: true, uncommitted: 0, ignored: 0, unpushed: 0, session: await this.buildSessionSummary(meta) };
      if (this.shipping.has(sessionId)) throw new ConflictError("正在发布中，等它结束再归档");
      const summary = await this.buildSessionSummary(meta);
      if (summary.busy) throw new ConflictError("Agent 还在工作，先停止再归档");
      let work = { uncommitted: 0, ignored: 0, unpushed: 0 };
      if (meta.worktree) {
        const { exists: _, ...found } = await worktreeWork(meta.worktree, meta.pr?.head);
        work = found;
        if (!req.force && work.uncommitted + work.ignored + work.unpushed > 0) return { archived: false, ...work, session: summary };
        const { removed } = await removeSessionWorktree(meta.worktree, { force: true, pushed: meta.pr?.head });
        if (!removed) console.warn(`[mypi-server] Archived ${meta.id} but kept its locked worktree ${meta.worktree.path}`);
      }
      meta.archivedAt = Date.now();
      meta.updatedAt = meta.archivedAt;
      this.saveCatalog();
      return { archived: true, ...work, session: await this.buildSessionSummary(meta) };
    });
  }

  /** Poll open PRs every `intervalMs`; when one is merged or closed, clean up and archive its session. */
  watchPullRequests(intervalMs = 5 * 60_000): void {
    clearInterval(this.prTimer);
    this.prTimer = setInterval(() => {
      this.checkPullRequests().catch((err) => console.error("[mypi-server] PR check failed:", err));
    }, intervalMs);
    this.prTimer.unref();
  }

  async checkPullRequests(): Promise<void> {
    if (this.checkingPullRequests || this.closing) return;
    this.checkingPullRequests = true;
    try {
      await this.trackOp(async () => {
        for (const meta of this.catalog.sessions) {
          if (!meta.pr || meta.archivedAt || this.shipping.has(meta.id) || this.closing) continue;
          if (meta.pr.state === "open") {
            const state = await pullRequestState(meta.pr.url).catch((err) => {
              console.warn(`[mypi-server] Could not check ${meta.pr?.url}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
              return "open" as const;
            });
            if (state === "open") continue;
            meta.pr = { ...meta.pr, state };
            this.saveCatalog();
          }
          // Merged or closed: done with the worktree, unless the agent is still at it or left something new in it.
          if ((await this.buildSessionSummary(meta)).busy) continue;
          const result = meta.worktree
            ? await removeSessionWorktree(meta.worktree, { pushed: meta.pr.head }).catch((err) => {
              console.error(`[mypi-server] Could not remove the worktree of ${meta.id}:`, err);
              return undefined;
            })
            : { removed: true };
          if (!result?.removed) continue;
          meta.archivedAt = Date.now();
          meta.updatedAt = meta.archivedAt;
          this.saveCatalog();
        }
      });
    } finally {
      this.checkingPullRequests = false;
    }
  }

  async compactSession(
    sessionId: string,
    req?: CompactSessionRequest,
  ): Promise<CompactSessionResponse> {
    return this.trackOp(async () => {
      const meta = this.catalog.sessions.find((s) => s.id === sessionId);
      if (!meta) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      assertWritable(meta);
      const managed = await this.openManagedSession(meta);
      const taskId = await managed.root.compact(
        req?.instructions?.trim() || undefined,
        BACKGROUND_CONTEXT,
      );
      meta.updatedAt = Date.now();
      this.saveCatalog();
      return {
        taskId: Number(taskId),
        status: "started",
      };
    });
  }

  async resetSession(
    sessionId: string,
    req?: ResetSessionRequest,
  ): Promise<ResetSessionResponse> {
    return this.trackOp(async () => {
      const meta = this.catalog.sessions.find((s) => s.id === sessionId);
      if (!meta) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      assertWritable(meta);
      const managed = await this.openManagedSession(meta);
      this.notifications.stopSession(sessionId);
      await managed.root.reset(
        req?.handoff?.trim() || undefined,
        BACKGROUND_CONTEXT,
      );
      delete meta.lastInput; // the new context hasn't run
      meta.updatedAt = Date.now();
      this.saveCatalog();
      return {
        status: "reset",
      };
    });
  }

  async abortSubmission(
    sessionId: string,
    submissionId: number,
  ): Promise<AbortSubmissionResponse> {
    return this.trackOp(async () => {
      const meta = this.catalog.sessions.find((s) => s.id === sessionId);
      if (!meta) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const managed = await this.openManagedSession(meta);
      const status = await managed.harness.abortSubmission(
        submissionId as SubmissionId,
        BACKGROUND_CONTEXT,
        ROOT_CONVERSATION_ID,
      );
      meta.updatedAt = Date.now();
      this.saveCatalog();
      return {
        submissionId,
        status,
      };
    });
  }

  async abortSession(sessionId: string): Promise<{ status: string }> {
    return this.trackOp(async () => {
      const meta = this.catalog.sessions.find((s) => s.id === sessionId);
      if (!meta) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const managed = await this.openManagedSession(meta);
      this.notifications.stopSession(sessionId);
      await managed.root.abort(BACKGROUND_CONTEXT, { background: true });
      meta.updatedAt = Date.now();
      this.saveCatalog();
      return { status: "aborted" };
    });
  }

  private async enrichInboxItems(
    managed: ManagedSession,
    items: readonly QueuedSubmissionItem[],
  ): Promise<QueuedSubmissionItem[]> {
    if (!items || items.length === 0) return [];
    const docItemsMap = new Map<number, string>();
    try {
      const inboxDoc = await managed.harness.snapshot(
        InboxDoc,
        ROOT_CONVERSATION_ID,
        BACKGROUND_CONTEXT,
      );
      if (inboxDoc && Array.isArray(inboxDoc.items)) {
        for (const docItem of inboxDoc.items) {
          const itemId = Number(docItem.id);
          if (Number.isFinite(itemId) && "content" in docItem) {
            if (typeof docItem.content === "string") {
              docItemsMap.set(itemId, docItem.content);
            } else if (Array.isArray(docItem.content)) {
              const textParts = docItem.content
                .map((p) =>
                  p.type === "text" && typeof p.text === "string" ? p.text : "",
                )
                .filter(Boolean)
                .join("\n");
              if (textParts) {
                docItemsMap.set(itemId, textParts);
              }
            }
          }
        }
      }
    } catch {
      // Fallback to cached submissionTexts map
    }

    return items.map((item) => ({
      ...item,
      text:
        item.text ||
        docItemsMap.get(item.id) ||
        managed.submissionTexts.get(item.id),
    }));
  }

  async getOpenAIUsage(): Promise<OpenAIAccountUsageResponse> {
    return this.trackOp(async () => {
      const byModelMap = new Map<
        string,
        OpenAIAccountUsageResponse["ledger"]["byModel"][number]
      >();
      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      let totalTokens = 0;
      let totalCost = 0;
      let sessionCount = 0;

      for (const meta of this.catalog.sessions) {
        if (this.closing) break;
        try {
          const managed = await this.openManagedSession(meta);
          const usageState = await managed.harness.usage(BACKGROUND_CONTEXT);
          let sessionHasOpenAI = false;

          for (const [modelKey, u] of Object.entries(usageState.models ?? {})) {
            if (
              modelKey.startsWith("openai/") ||
              modelKey.startsWith("openai-codex/")
            ) {
              sessionHasOpenAI = true;
              const input = u.input ?? 0;
              const output = u.output ?? 0;
              const cacheRead = u.cacheRead ?? 0;
              const cacheWrite = u.cacheWrite ?? 0;
              const tokens =
                u.totalTokens ?? input + output + cacheRead + cacheWrite;
              const cost = u.cost?.total ?? 0;

              totalInput += input;
              totalOutput += output;
              totalCacheRead += cacheRead;
              totalCacheWrite += cacheWrite;
              totalTokens += tokens;
              totalCost += cost;

              const existing = byModelMap.get(modelKey) ?? {
                modelId: modelKey,
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                totalCost: 0,
              };
              existing.inputTokens += input;
              existing.outputTokens += output;
              existing.totalTokens += tokens;
              existing.totalCost += cost;
              byModelMap.set(modelKey, existing);
            }
          }

          if (sessionHasOpenAI) {
            sessionCount += 1;
          }
        } catch {
          // Ignore individual session read failures
        }
      }

      const auth = this.modelsConfig.openaiAuth;
      return {
        provider: "openai",
        configured: auth.configured,
        authType: auth.authType,
        subscriptionLabel: auth.subscriptionLabel,
        tokenExpiresAt: auth.tokenExpiresAt,
        dashboardUrl:
          auth.authType === "oauth"
            ? "https://chatgpt.com/settings/usage"
            : "https://platform.openai.com/usage",
        rateLimits: this.modelsConfig.getOpenAIRateLimits(),
        ledger: {
          sessionCount,
          inputTokens: totalInput,
          outputTokens: totalOutput,
          cacheReadTokens: totalCacheRead,
          cacheWriteTokens: totalCacheWrite,
          totalTokens,
          totalCost,
          byModel: Array.from(byModelMap.values()).sort(
            (a, b) => b.totalTokens - a.totalTokens,
          ),
        },
        updatedAt: Date.now(),
      };
    });
  }

  async subscribeSession(
    sessionId: string,
    onFrame: (frame: SseFrame) => void,
  ): Promise<() => Promise<void>> {
    return this.trackOp(async () => {
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

      const rawSnapshot = stream.snapshot as unknown as RawSnapshotEvent;
      const enrichedInbox = await this.enrichInboxItems(
        managed,
        rawSnapshot.inbox ?? [],
      );

      onFrame({
        type: "snapshot",
        session: summary,
        snapshot: {
          ...rawSnapshot,
          inbox: enrichedInbox,
        },
      });

      stream.start(async (events) => {
        const rawEvents = events as unknown as RawAgentEvent[];
        const enrichedEvents: RawAgentEvent[] = [];
        for (const ev of rawEvents) {
          if (ev.type === "inbox_update") {
            const items = await this.enrichInboxItems(managed, ev.items);
            enrichedEvents.push({
              ...ev,
              items,
            });
          } else {
            enrichedEvents.push(ev);
          }
        }
        onFrame({
          type: "events",
          events: enrichedEvents,
        });
      });

      let stopped = false;
      const unsubscribe = async () => {
        if (stopped) return;
        stopped = true;
        this.activeSubscribers.delete(unsubscribe);
        try {
          await stream.stop();
        } catch {
          // Ignore stop error
        }
      };

      this.activeSubscribers.add(unsubscribe);
      if (this.closing) {
        await unsubscribe();
        throw new Error("Server is shutting down");
      }
      return unsubscribe;
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    clearInterval(this.prTimer);
    this.closePromise = (async () => {
      await this.notifications.close();
      while (
        this.inFlightOps.size > 0 ||
        this.activeSubscribers.size > 0 ||
        this.activeSessions.size > 0
      ) {
        if (this.inFlightOps.size > 0) {
          await Promise.allSettled(Array.from(this.inFlightOps));
        }
        if (this.activeSubscribers.size > 0) {
          const subs = Array.from(this.activeSubscribers);
          this.activeSubscribers.clear();
          await Promise.allSettled(subs.map((unsub) => unsub()));
        }
        if (this.activeSessions.size > 0) {
          const entries = Array.from(this.activeSessions.entries());
          for (const [id] of entries) {
            this.activeSessions.delete(id);
          }
          await Promise.allSettled(
            entries.map(async ([, promise]) => {
              const managed = await promise;
              await managed.harness.close(BACKGROUND_CONTEXT);
            }),
          );
        }
      }
      this.toolEnvs.clear();
    })();
    return this.closePromise;
  }
}
