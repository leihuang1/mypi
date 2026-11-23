export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface ModelSummary {
  provider: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  thinkingLevels: ThinkingLevel[];
  contextWindow?: number;
}

export interface DeviceInfo {
  uid: string;
  name: string;
  hostname: string;
  platform: string;
  apiVersion: 1;
  durableVersion: string;
  startedAt: number;
  models: ModelSummary[];
  defaultModel: ModelRef;
  defaultThinkingLevel: ThinkingLevel;
  startDirs: string[];
  recentDirs?: string[];
  bookmarks?: string[];
}

export interface FileEntrySummary {
  name: string;
  path: string;
  size: number;
  mtime: number;
  isHidden: boolean;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  dirs: Array<{
    name: string;
    path: string;
    isGitRepo: boolean;
    isHidden?: boolean;
  }>;
  files?: FileEntrySummary[];
  recentDirs?: string[];
  bookmarks?: string[];
}

export interface CreateDirectoryRequest {
  parentPath?: string;
  name?: string;
  path?: string;
  gitInit?: boolean;
}

export interface CreateDirectoryResponse {
  path: string;
  isGitRepo: boolean;
}

export interface GitCloneRequest {
  targetParentDir: string;
  repoUrl: string;
  folderName?: string;
}

export interface GitCloneResponse {
  path: string;
  isGitRepo: boolean;
}

export interface UpdateBookmarkRequest {
  path: string;
  bookmarked: boolean;
}

export interface UpdateBookmarkResponse {
  bookmarks: string[];
}

export interface FilePreviewResponse {
  path: string;
  name: string;
  size: number;
  truncated: boolean;
  isBinary: boolean;
  content: string;
}

/**
 * idle: nothing asked yet. running: a run or queued input. needs_you: waiting on the answer to `ask_user`, or the last
 * run failed. done: the last run finished. shipped and archived come with Ship and Archive.
 */
export type SessionStatus = "idle" | "running" | "needs_you" | "done" | "shipped" | "archived";

/** What the agent asked with `ask_user`. */
export interface AskedQuestion {
  text: string;
  /** Offered answers; the user may still type their own. */
  choices?: string[];
}

export interface SessionSummary {
  id: string;
  name: string;
  cwd: string;
  model: ModelRef;
  thinkingLevel: ThinkingLevel;
  /** Ponytail's "smallest complete change" rules are in the agent's system prompt. */
  ponytail: boolean;
  /** A session started in a git repo works on its own branch, in its own worktree (its `cwd`). */
  branch?: string;
  worktreePath?: string;
  /** What the branch started from. Its changes are shown against their merge-base with it. */
  baseRef?: string;
  /** The checkout the session was started from, which the session leaves alone. */
  repoPath?: string;
  createdAt: number;
  updatedAt: number;
  busy: boolean;
  /** Absent from daemons older than M2. */
  status?: SessionStatus;
  /** Set while the status is needs_you because of a question. */
  question?: AskedQuestion;
  entryCount: number;
}

export interface CreateSessionRequest {
  name?: string;
  cwd: string;
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  /** Default true. */
  ponytail?: boolean;
  /** Default true: in a git repo, work on a new branch in a new worktree instead of in `cwd` itself. */
  worktree?: boolean;
}

export interface UpdateSessionRequest {
  name?: string;
  cwd?: string;
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  ponytail?: boolean;
}

export interface CompactSessionRequest {
  instructions?: string;
}

export interface CompactSessionResponse {
  taskId: number;
  status: "started";
}

export interface ResetSessionRequest {
  handoff?: string;
}

export interface ResetSessionResponse {
  status: "reset";
}

export interface AbortSubmissionResponse {
  submissionId: number;
  status: "aborted" | "already_placed" | "settled" | "not_found";
}

export interface RunNotification {
  type: "notice";
  cursor: string;
  sessionId: string;
  title: string;
  body: string;
  /** Absent from daemons older than M2. */
  kind?: "done" | "question" | "error";
  /** A question's offered answers. */
  choices?: string[];
  createdAt: number;
}

export type NotificationFrame =
  | RunNotification
  | { type: "ready"; cursor: string; gap?: boolean }
  | { type: "heartbeat" };

export interface SendMessageRequest {
  requestId: string;
  content: string;
  whenBusy?: "steer" | "followUp" | "reject";
}

export interface SendMessageResponse {
  submissionId: number;
  requestId: string;
  status: string;
}

export interface ToolDiagnosticItem {
  severity: "info" | "warn" | "error";
  message: string;
  code?: string;
}

export interface ToolCallItem {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: "pending" | "running" | "done" | "error" | "interrupted";
  output: string;
  isError?: boolean;
  details?: unknown;
  diagnostics?: ToolDiagnosticItem[];
}

export interface UserTranscriptItem {
  id: string;
  entryId?: number;
  kind: "user";
  text: string;
  timestamp?: number;
}

export interface AssistantTranscriptItem {
  id: string;
  entryId?: number;
  kind: "assistant";
  thinking: string;
  text: string;
  status: "streaming" | "done" | "aborted" | "error";
  errorMessage?: string;
  toolCalls: ToolCallItem[];
  blocks?: ReadonlyArray<Record<string, unknown>>;
  timestamp?: number;
}

export interface SystemTranscriptItem {
  id: string;
  entryId?: number;
  kind: "compaction" | "reset" | "system";
  text: string;
}

export type TranscriptItem =
  | UserTranscriptItem
  | AssistantTranscriptItem
  | SystemTranscriptItem;

export interface QueuedSubmissionItem {
  id: number;
  mode: "steer" | "followUp";
  text?: string;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCost: number;
  contextTokens: number;
}

export interface OpenAIRateLimitSnapshot {
  limitRequests?: number;
  remainingRequests?: number;
  resetRequests?: string;
  limitTokens?: number;
  remainingTokens?: number;
  resetTokens?: string;
  rawHeaders?: Record<string, string>;
  updatedAt: number;
}

export interface OpenAIAccountUsageResponse {
  provider: "openai";
  configured: boolean;
  authType: "oauth" | "api_key" | "none";
  subscriptionLabel?: string;
  tokenExpiresAt?: number;
  dashboardUrl: string;
  rateLimits?: OpenAIRateLimitSnapshot;
  ledger: {
    sessionCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    totalCost: number;
    byModel: Array<{
      modelId: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      totalCost: number;
    }>;
  };
  updatedAt: number;
}

export interface SessionLiveState {
  entries: RawEntryRecord[];
  items: TranscriptItem[];
  busy: boolean;
  inFlightAssistant: AssistantTranscriptItem | null;
  liveTools: Record<string, ToolCallItem>;
  inbox: QueuedSubmissionItem[];
  compacting: boolean;
  retry?: {
    attempt: number;
    at: number;
    errorMessage: string;
  };
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  cwd?: string;
  usage: UsageSummary;
  lastError?: string;
}

export interface GitFileStatus {
  path: string;
  status: "M" | "A" | "D" | "R" | "?";
  staged: boolean;
  additions: number;
  deletions: number;
  diff: string;
}

export interface GitStatusResponse {
  isGitRepo: boolean;
  branch?: string;
  /** Set when changes are shown against the merge-base with this ref instead of HEAD. */
  baseRef?: string;
  clean: boolean;
  summary: {
    modified: number;
    added: number;
    deleted: number;
    untracked: number;
    totalAdditions: number;
    totalDeletions: number;
  };
  files: GitFileStatus[];
  fullDiff: string;
  updatedAt: number;
}

// Raw wire shapes from @earendil-works/pi-durable watchEvents
export interface RawEntryRecord {
  id: number;
  conversationId: number;
  kind: string;
  model?: ReadonlyArray<Record<string, unknown>>;
  data?: unknown;
  head?: number;
  byTaskId?: number;
}

export interface RawToolSlot {
  callId: string;
  name: string;
  status: "pending" | "running" | "done";
  output?: string;
  details?: unknown;
  diagnostics?: ToolDiagnosticItem[];
  taskId?: number;
  entry?: number;
}

export interface RawSnapshotEvent {
  type: "snapshot";
  entries: readonly RawEntryRecord[];
  run?: {
    inputs: readonly number[];
  };
  generation?: {
    attempt: number;
    message?: Record<string, unknown>;
    retry?: {
      at: number;
      error: string;
    };
  };
  tools: readonly RawToolSlot[];
  compactions: ReadonlyArray<{
    taskId: number;
    reason: string;
    blocking: boolean;
    attempt: number;
  }>;
  compactionFailure?: {
    taskId: number;
    reason: string;
    error: string;
  };
  inbox: ReadonlyArray<{
    id: number;
    mode: "steer" | "followUp";
    text?: string;
  }>;
  agent: {
    model?: ModelRef;
    thinkingLevel?: ThinkingLevel;
    cwd?: string;
  };
  usage?: unknown;
}

export type RawAgentEvent =
  | RawSnapshotEvent
  | { type: "submission"; record: { id: number; type: "input" | "write"; status: "queued" | "placed" | "done" | "unanswered"; reason?: string } }
  | { type: "run_start"; inputs: readonly number[] }
  | { type: "run_end"; inputs: readonly number[] }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start"; message: Record<string, unknown> }
  | {
      type: "message_update";
      usage?: unknown;
      changes: ReadonlyArray<Record<string, unknown>>;
    }
  | { type: "message_end"; entry: RawEntryRecord }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      taskId?: number;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      output?: { trimStart?: number; append?: string } | { set: string };
      details?: unknown;
      diagnostics?: readonly ToolDiagnosticItem[];
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      entry?: RawEntryRecord;
      result?: {
        isError: boolean;
        structuredOutput?: unknown;
        details?: unknown;
        diagnostics?: readonly ToolDiagnosticItem[];
      };
    }
  | {
      type: "inbox_update";
      items: ReadonlyArray<{ id: number; mode: "steer" | "followUp"; text?: string }>;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      at: number;
      errorMessage: string;
    }
  | { type: "auto_retry_end"; attempt: number }
  | { type: "entry_appended"; entry: RawEntryRecord }
  | {
      type: "agent_changed";
      agent: {
        model?: ModelRef;
        thinkingLevel?: ThinkingLevel;
        cwd?: string;
      };
    }
  | { type: "usage_changed"; usage: unknown }
  | { type: "task_failed"; taskId: number; kind: string; message: string }
  | { type: "compaction_start"; taskId: number; reason: string; blocking: boolean }
  | { type: "compaction_end"; taskId: number; reason: string; error?: string };

export type SseFrame =
  | {
      type: "hello";
      apiVersion: 1;
      sessionId: string;
      serverTime: number;
    }
  | {
      type: "snapshot";
      session: SessionSummary;
      snapshot: RawSnapshotEvent;
    }
  | {
      type: "events";
      events: readonly RawAgentEvent[];
    }
  | {
      type: "heartbeat";
      timestamp: number;
    };
