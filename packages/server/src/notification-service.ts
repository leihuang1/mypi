import fs from "node:fs";
import path from "node:path";
import type { NotificationDeviceRequest, RawAgentEvent } from "@mypi/shared";
import { reduceRunNotice, type RunNoticeState } from "./notification-state.js";

interface Device extends NotificationDeviceRequest {
  activeSessionId?: string;
  presenceUntil?: number;
}
interface NoticeData {
  devices: Record<string, Device>;
  sessions: Record<string, RunNoticeState>;
  handled: Record<string, string[]>;
  receipts: Record<string, { deviceId: string; token: string; checkAfter: number }>;
}

export class NotificationService {
  private data: NoticeData;
  private file: string;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private receiptTimer: ReturnType<typeof setInterval>;
  private checkingReceipts = false;
  private jobs = new Set<Promise<unknown>>();
  private closed = false;

  constructor(
    dataDir: string,
    private sessionName: (id: string) => string | undefined,
    private send: typeof fetch = fetch,
    private settleDelay = 1500,
  ) {
    this.file = path.join(dataDir, "notifications.json");
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : { devices: {}, sessions: {}, handled: {}, receipts: {} };
    if (!this.data.devices || !this.data.sessions || !this.data.handled || !this.data.receipts) {
      throw new Error("Invalid notification store (refusing to overwrite)");
    }
    // Presence never survives a daemon restart.
    for (const device of Object.values(this.data.devices)) device.presenceUntil = 0;
    this.receiptTimer = setInterval(() => this.track(this.checkReceipts()), 30_000);
    this.receiptTimer.unref();
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private track(job: Promise<unknown>) {
    this.jobs.add(job);
    job.catch((err) => console.warn("[mypi-push]", err instanceof Error ? err.message : "Push failed"))
      .finally(() => this.jobs.delete(job));
  }

  register(request: NotificationDeviceRequest): void {
    if (!request || typeof request.deviceId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(request.deviceId) ||
      typeof request.serverId !== "string" || request.serverId.length > 100 || !request.serverId ||
      typeof request.enabled !== "boolean" ||
      (request.enabled && (typeof request.pushToken !== "string" || request.pushToken.length > 256 || !/^(ExponentPushToken|ExpoPushToken)\[[a-zA-Z0-9_-]+\]$/.test(request.pushToken)))) {
      throw new Error("Invalid notification device registration");
    }
    if (!request.enabled) {
      delete this.data.devices[request.deviceId];
    } else {
      // One installation/token must not receive duplicate pushes after re-registration.
      for (const [id, device] of Object.entries(this.data.devices)) {
        if (id !== request.deviceId && device.pushToken === request.pushToken) delete this.data.devices[id];
      }
      this.data.devices[request.deviceId] = {
        ...this.data.devices[request.deviceId],
        deviceId: request.deviceId, serverId: request.serverId, pushToken: request.pushToken, enabled: true,
      };
    }
    this.save();
  }

  presence(deviceId: string, sessionId: string | null): void {
    if (typeof deviceId !== "string" || (sessionId !== null && (typeof sessionId !== "string" || sessionId.length > 100))) {
      throw new Error("Invalid notification presence");
    }
    const device = this.data.devices[deviceId];
    if (!device) return;
    device.activeSessionId = sessionId ?? undefined;
    device.presenceUntil = sessionId ? Date.now() + 75_000 : 0;
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
        this.track(this.deliver(sessionId));
      }, this.settleDelay));
    }
  }

  private async expo(endpoint: string, body: unknown): Promise<any> {
    const response = await this.send(`https://exp.host/--/api/v2/push/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Push gateway HTTP ${response.status}`);
    const result = await response.json();
    if (result.errors) throw new Error("Push gateway rejected the request; check Expo credentials");
    return result.data;
  }

  private async deliver(sessionId: string): Promise<void> {
    const state = this.data.sessions[sessionId];
    const notice = state?.pending;
    if (!notice || state.running || state.queued || this.closed) return;
    const handled = this.data.handled[sessionId] ?? [];
    const duplicate = !notice.id || handled.includes(notice.id);
    const name = this.sessionName(sessionId);
    this.data.sessions[sessionId] = {};
    if (!duplicate) this.data.handled[sessionId] = [...handled, notice.id];
    // Persist before sending: an ambiguous gateway timeout/restart must not duplicate a notification.
    this.save();
    if (duplicate || state.stopped || !name) return;
    const devices = Object.values(this.data.devices).filter((device) =>
      device.enabled && !(device.activeSessionId === sessionId && (device.presenceUntil ?? 0) > Date.now()),
    );
    const body = notice.kind === "ended" ? "运行已结束，点此查看" : notice.cause === "no_model"
      ? "执行异常：未配置可用模型，运行无法继续。点此查看"
      : notice.cause === "model"
        ? "执行异常：模型请求失败，运行无法继续。点此查看详情"
        : "执行异常：执行任务中断，运行无法继续。点此查看详情";
    for (const device of devices) {
      // Disabling notifications while another device's delivery is in flight takes effect immediately.
      if (this.data.devices[device.deviceId] !== device ||
        (device.activeSessionId === sessionId && (device.presenceUntil ?? 0) > Date.now())) continue;
      try {
        const ticket = await this.expo("send", {
          to: device.pushToken,
          title: name.replace(/[\x00-\x1f]/g, " ").slice(0, 80),
          body,
          data: { serverId: device.serverId, sessionId, eventId: `${sessionId}:${notice.id}` },
          channelId: "runs", sound: "default", ttl: 3600,
        });
        if (ticket.status === "ok" && typeof ticket.id === "string") {
          this.data.receipts[ticket.id] = { deviceId: device.deviceId, token: device.pushToken!, checkAfter: Date.now() + 30_000 };
        } else if (ticket.details?.error === "DeviceNotRegistered") {
          this.removeInvalidDevice(device.deviceId, device.pushToken!);
        } else {
          console.warn("[mypi-push] Delivery rejected:", ticket.details?.error ?? "unknown");
        }
        this.save();
      } catch (err) {
        // shortcut: delivery is at-most-once, add an idempotent push gateway before retrying ambiguous sends.
        console.warn("[mypi-push] Delivery unconfirmed:", err instanceof Error ? err.message : "unknown");
      }
    }
  }

  private removeInvalidDevice(id: string, token: string) {
    if (this.data.devices[id]?.pushToken === token) delete this.data.devices[id];
  }

  private async checkReceipts() {
    if (this.checkingReceipts || this.closed) return;
    const ids = Object.keys(this.data.receipts).filter((id) => this.data.receipts[id].checkAfter <= Date.now()).slice(0, 100);
    if (!ids.length) return;
    this.checkingReceipts = true;
    try {
      const receipts = await this.expo("getReceipts", { ids });
      for (const id of ids) {
        const receipt = receipts[id];
        const pending = this.data.receipts[id];
        if (receipt?.status === "error") {
          if (receipt.details?.error === "DeviceNotRegistered") this.removeInvalidDevice(pending.deviceId, pending.token);
          console.warn("[mypi-push] Receipt error:", receipt.details?.error ?? "unknown");
        }
        if (receipt || Date.now() - pending.checkAfter > 24 * 60 * 60 * 1000) delete this.data.receipts[id];
      }
      this.save();
    } finally {
      this.checkingReceipts = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.receiptTimer);
    for (const timer of this.timers.values()) clearTimeout(timer);
    await Promise.allSettled(this.jobs);
  }
}
