import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NotificationFrame, RawAgentEvent, RunNotification } from "@mypi/shared";
import { reduceRunNotice, type RunNoticeState } from "./notification-state.js";

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
    if (next.pending && !next.running && !next.queued) {
      this.timers.set(sessionId, setTimeout(() => {
        this.timers.delete(sessionId);
        try { this.publish(sessionId); }
        catch (err) { console.error("[mypi-notifications] Unable to persist event:", err); }
      }, this.settleDelay));
    }
  }

  private publish(sessionId: string): void {
    const state = this.data.sessions[sessionId];
    const notice = state?.pending;
    if (!notice || state.running || state.queued || this.closed) return;
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
      const body = notice.kind === "ended" ? "运行已结束，点此查看" : notice.cause === "no_model"
        ? "执行异常：未配置可用模型，运行无法继续。点此查看"
        : notice.cause === "model"
          ? "执行异常：模型请求失败，运行无法继续。点此查看详情"
          : "执行异常：执行任务中断，运行无法继续。点此查看详情";
      this.data.sequence++;
      event = {
        type: "notice", cursor: `${this.data.epoch}:${this.data.sequence}`, sessionId,
        title: name.replace(/[\x00-\x1f]/g, " ").slice(0, 80), body, createdAt: Date.now(),
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
