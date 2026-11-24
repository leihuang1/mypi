import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NotificationFrame, RawAgentEvent, RunNotification } from "@mypi/shared";
import { type RunNotice, reduceRunNotice, type RunNoticeState } from "./notification-state.js";

/** A session's changes, for the "done" notice. */
export interface ChangeStats {
  files: number;
  additions: number;
  deletions: number;
  /** A text file was too big to count, or past the total budget: the line counts are short. */
  partial?: boolean;
}

const ICON = { done: "✅", question: "❓", error: "⚠️" } as const;

/** The first line of a reply that says something, outside code blocks and without Markdown markup. */
export function headline(text: string | undefined): string | undefined {
  let fence: string | undefined;
  for (const raw of text?.split("\n") ?? []) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (fence) {
      // Closed only by the same character, at least as many, alone on the line: ``` inside ```` is content.
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && raw.trim() === marker) fence = undefined;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(raw)) continue; // a thematic break: ***, - - -
    const line = raw.trim()
      .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, "") // headings, quotes, list markers; not "-5"
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // Emphasis goes, but not inside `code`: `__init__` is a name.
      .split(/(`+[^`]*`+)/)
      .map((part, i) => (i % 2 ? part.replace(/^`+|`+$/g, "") : part.replace(/\*\*|__/g, "")))
      .join("")
      .trim();
    if (line) return line.slice(0, 200);
  }
  return undefined;
}

const STATS_TIMEOUT_MS = 5000;

export function noticeBody(notice: RunNotice, stats: ChangeStats | undefined): string {
  if (notice.kind === "error") {
    return notice.cause === "no_model"
      ? "执行异常：未配置可用模型，运行无法继续。点此查看"
      : notice.cause === "model"
        ? "执行异常：模型请求失败，运行无法继续。点此查看详情"
        : "执行异常：执行任务中断，运行无法继续。点此查看详情";
  }
  if (notice.question) {
    const choices = notice.question.choices?.join(" / ");
    return choices ? `${notice.question.text}\n${choices}` : notice.question.text;
  }
  // Some files were too big to count: the file count is right, the line counts aren't.
  const changes = !stats || stats.files === 0 ? undefined
    : stats.partial ? `${stats.files} 个文件（有大文件，未统计行数）`
      : `+${stats.additions} −${stats.deletions} · ${stats.files} 个文件`;
  return [headline(notice.summary), changes].filter(Boolean).join("\n") || "运行已结束，点此查看";
}

interface NoticeData {
  epoch: string;
  sequence: number;
  sessions: Record<string, RunNoticeState>;
  handled: Record<string, string[]>;
  notices: RunNotification[];
}

export class NotificationService {
  private data: NoticeData;
  private file: string;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<(frame: NotificationFrame) => void>();
  private closed = false;

  constructor(
    dataDir: string,
    private sessionName: (id: string) => string | undefined,
    private settleDelay = 1500,
    /** The session's changes when a run ends without a question; omitted or undefined: no change line. */
    private changeStats?: (id: string) => Promise<ChangeStats | undefined>,
  ) {
    // Separate from the retired push store: no device tokens or third-party credentials are loaded.
    this.file = path.join(dataDir, "notification-events.json");
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : { epoch: crypto.randomUUID(), sequence: 0, sessions: {}, handled: {}, notices: [] };
    if (typeof this.data.epoch !== "string" || !Number.isSafeInteger(this.data.sequence) ||
      !this.data.sessions || !this.data.handled || !Array.isArray(this.data.notices)) {
      throw new Error("Invalid notification event store (refusing to overwrite)");
    }
    this.save();
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  observedInputs(sessionId: string): number[] {
    return this.data.sessions[sessionId]?.runId?.split(",").map(Number).filter(Number.isSafeInteger) ?? [];
  }

  stopSession(sessionId: string): void {
    const state = this.data.sessions[sessionId];
    if (state) {
      this.data.sessions[sessionId] = { ...state, stopped: true };
      this.save();
    }
  }

  events(sessionId: string, events: readonly RawAgentEvent[]): void {
    if (this.closed) return;
    const previous = this.data.sessions[sessionId] ?? {};
    let next = previous;
    for (const event of events) next = reduceRunNotice(next, event);
    if (next === previous) return;
    this.data.sessions[sessionId] = next;
    this.save();
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
    if (next.pending && !next.running && (!next.queued || next.pending.kind === "error")) {
      this.timers.set(sessionId, setTimeout(() => {
        this.timers.delete(sessionId);
        this.publish(sessionId).catch((err) => console.error("[mypi-notifications] Unable to persist event:", err));
      }, this.settleDelay));
    }
  }

  private async publish(sessionId: string): Promise<void> {
    const notice = this.data.sessions[sessionId]?.pending;
    if (!notice) return;
    // The change line is optional: a slow or failing count never holds the notice.
    let timer: Parameters<typeof clearTimeout>[0];
    const stats = notice.kind === "ended" && !notice.question && this.changeStats
      ? await Promise.race([
        this.changeStats(sessionId).catch(() => undefined),
        new Promise<undefined>((resolve) => { timer = setTimeout(resolve, STATS_TIMEOUT_MS); }),
      ]).finally(() => clearTimeout(timer))
      : undefined;
    // Reading the changes takes a moment: publish only if that same run is still the settled one.
    const state = this.data.sessions[sessionId];
    if (!state || state.pending !== notice || state.running || (state.queued && notice.kind !== "error") || this.closed) return;
    const handled = this.data.handled[sessionId] ?? [];
    const duplicate = !notice.id || handled.includes(notice.id);
    const name = this.sessionName(sessionId);
    const previous = this.data;
    this.data = {
      ...previous,
      sessions: { ...previous.sessions, [sessionId]: {} },
      handled: { ...previous.handled, [sessionId]: duplicate ? handled : [...handled, notice.id] },
    };
    let event: RunNotification | undefined;
    if (!duplicate && !state.stopped && name) {
      const kind = notice.kind === "error" ? "error" : notice.question ? "question" : "done";
      this.data.sequence++;
      event = {
        type: "notice", cursor: `${this.data.epoch}:${this.data.sequence}`, sessionId,
        title: `${ICON[kind]} ${name.replace(/[\x00-\x1f]/g, " ").slice(0, 80)}`,
        body: noticeBody(notice, stats).replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ").slice(0, 600),
        kind,
        ...(kind === "question" && notice.question?.choices ? { choices: notice.question.choices } : {}),
        createdAt: Date.now(),
      };
      // shortcut: replay the latest 256 notices; add paged history if long offline periods need full delivery.
      this.data.notices = [...this.data.notices, event].slice(-256);
    }
    try { this.save(); }
    catch (err) { this.data = previous; throw err; }
    if (event) {
      for (const listener of this.listeners) listener(event);
    }
  }

  subscribe(cursor: string | undefined, listener: (frame: NotificationFrame) => void): () => void {
    if (this.closed) throw new Error("Server is shutting down");
    const prefix = `${this.data.epoch}:`;
    const sequence = cursor?.startsWith(prefix) ? Number(cursor.slice(prefix.length)) : NaN;
    const canReplay = Number.isSafeInteger(sequence) && sequence >= 0 && sequence <= this.data.sequence;
    if (canReplay) {
      const oldest = this.data.notices[0];
      if (oldest && sequence < Number(oldest.cursor.slice(prefix.length)) - 1) {
        listener({ type: "ready", cursor: `${prefix}${Number(oldest.cursor.slice(prefix.length)) - 1}`, gap: true });
      }
      for (const notice of this.data.notices) {
        if (Number(notice.cursor.slice(prefix.length)) > sequence) listener(notice);
      }
    }
    // First enable starts at the tail; a replaced daemon store also establishes a new baseline.
    listener({ type: "ready", cursor: `${prefix}${this.data.sequence}`, ...(cursor && !canReplay ? { gap: true } : {}) });
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.listeners.clear();
  }
}
