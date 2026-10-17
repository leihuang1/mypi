import type {
  AbortSubmissionResponse,
  CompactSessionRequest,
  CompactSessionResponse,
  CreateDirectoryRequest,
  CreateDirectoryResponse,
  CreateSessionRequest,
  DeviceInfo,
  DirectoryListing,
  FilePreviewResponse,
  GitCloneRequest,
  GitCloneResponse,
  GitStatusResponse,
  OpenAIAccountUsageResponse,
  ResetSessionRequest,
  ResetSessionResponse,
  SendMessageRequest,
  SendMessageResponse,
  SessionSummary,
  SseFrame,
  UpdateBookmarkRequest,
  UpdateBookmarkResponse,
  UpdateSessionRequest,
} from "./protocol";

export interface MyPiClientOptions {
  baseUrl: string;
  token: string;
}

export interface ConnectPairingPayload {
  url: string;
  fallbackUrls?: string[];
  token: string;
  name?: string;
}

export function parsePairingInput(input: string): ConnectPairingPayload | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    if (trimmed.startsWith("mypi://")) {
      const parsed = new URL(trimmed);
      const url = parsed.searchParams.get("url");
      const fallback = parsed.searchParams.getAll("fallbackUrl");
      const token = parsed.searchParams.get("token");
      const name = parsed.searchParams.get("name") ?? undefined;
      if (url && token) {
        return {
          url: normalizeBaseUrl(url),
          ...(fallback.length > 0
            ? { fallbackUrls: fallback.map(normalizeBaseUrl) }
            : {}),
          token,
          name,
        };
      }
    }
    if (trimmed.startsWith("{")) {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.url === "string" && typeof obj.token === "string") {
        return {
          url: normalizeBaseUrl(obj.url),
          token: obj.token,
          name: typeof obj.name === "string" ? obj.name : undefined,
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function normalizeBaseUrl(url: string): string {
  let clean = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(clean)) {
    clean = `http://${clean}`;
  }
  return clean;
}

export class SseParser {
  private buffer = "";

  feed(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];

    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawBlock = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      boundary = this.buffer.indexOf("\n\n");

      const dataLines: string[] = [];
      for (const line of rawBlock.split(/\r?\n/)) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      if (dataLines.length > 0) {
        const payload = dataLines.join("\n");
        try {
          frames.push(JSON.parse(payload) as SseFrame);
        } catch {
          // Ignore malformed frame
        }
      }
    }

    return frames;
  }
}

export class MyPiClient {
  readonly baseUrl: string;
  readonly token: string;

  constructor(options: MyPiClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = options.token.trim();
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "X-DPI-Token": this.token,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...this.headers(),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (body?.error?.message) {
          message = body.error.message;
        }
      } catch {
        // Fallback to status code
      }
      throw new Error(message);
    }
    return (await res.json()) as T;
  }

  async healthz(): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/healthz`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { ok: boolean };
  }

  async getDevice(): Promise<DeviceInfo> {
    return this.request<DeviceInfo>("/v1/device");
  }

  async listDirs(
    path?: string,
    options?: { includeHidden?: boolean },
  ): Promise<DirectoryListing> {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    if (options?.includeHidden) params.set("includeHidden", "true");
    const qs = params.toString();
    return this.request<DirectoryListing>(`/v1/fs/dirs${qs ? `?${qs}` : ""}`);
  }

  async createDirectory(
    req: CreateDirectoryRequest,
  ): Promise<CreateDirectoryResponse> {
    return this.request<CreateDirectoryResponse>("/v1/fs/mkdir", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async gitClone(req: GitCloneRequest): Promise<GitCloneResponse> {
    return this.request<GitCloneResponse>("/v1/fs/git-clone", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async updateBookmark(
    req: UpdateBookmarkRequest,
  ): Promise<UpdateBookmarkResponse> {
    return this.request<UpdateBookmarkResponse>("/v1/fs/bookmarks", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async readFilePreview(path: string): Promise<FilePreviewResponse> {
    return this.request<FilePreviewResponse>(
      `/v1/fs/file?path=${encodeURIComponent(path)}`,
    );
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.request<SessionSummary[]>("/v1/sessions");
  }

  async createSession(req: CreateSessionRequest): Promise<SessionSummary> {
    return this.request<SessionSummary>("/v1/sessions", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async getSession(sessionId: string): Promise<SessionSummary> {
    return this.request<SessionSummary>(`/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  async updateSession(
    sessionId: string,
    req: UpdateSessionRequest,
  ): Promise<SessionSummary> {
    return this.request<SessionSummary>(
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(req),
      },
    );
  }

  async deleteSession(sessionId: string): Promise<{ archived: boolean }> {
    return this.request<{ archived: boolean }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "DELETE",
      },
    );
  }

  async sendMessage(
    sessionId: string,
    req: SendMessageRequest,
  ): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify(req),
      },
    );
  }

  async abortSession(sessionId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/abort`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
  }

  async compactSession(
    sessionId: string,
    req?: CompactSessionRequest,
  ): Promise<CompactSessionResponse> {
    return this.request<CompactSessionResponse>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/compact`,
      {
        method: "POST",
        body: JSON.stringify(req ?? {}),
      },
    );
  }

  async resetSession(
    sessionId: string,
    req?: ResetSessionRequest,
  ): Promise<ResetSessionResponse> {
    return this.request<ResetSessionResponse>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/reset`,
      {
        method: "POST",
        body: JSON.stringify(req ?? {}),
      },
    );
  }

  async abortSubmission(
    sessionId: string,
    submissionId: number,
  ): Promise<AbortSubmissionResponse> {
    return this.request<AbortSubmissionResponse>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/inbox/${encodeURIComponent(
        String(submissionId),
      )}/abort`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
  }

  async getGitStatus(sessionId: string): Promise<GitStatusResponse> {
    return this.request<GitStatusResponse>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/git`,
    );
  }

  async getOpenAIUsage(): Promise<OpenAIAccountUsageResponse> {
    return this.request<OpenAIAccountUsageResponse>("/v1/usage/openai");
  }

  /**
   * Subscribe to a session's SSE stream (`hello -> snapshot -> events`).
   * Works across Node.js, Web, and React Native (Android/iOS) with automatic reconnect.
   */
  subscribeSessionEvents(
    sessionId: string,
    handlers: {
      onFrame: (frame: SseFrame) => void;
      onStatusChange?: (status: "connecting" | "connected" | "reconnecting" | "error", error?: string) => void;
    },
  ): () => void {
    let stopped = false;
    let abortStream: (() => void) | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const url = `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events`;

    const connect = (isReconnect: boolean) => {
      if (stopped) return;
      handlers.onStatusChange?.(isReconnect ? "reconnecting" : "connecting");

      // Prefer XMLHttpRequest in React Native environments where fetch ReadableStream may be unavailable
      if (typeof XMLHttpRequest !== "undefined") {
        const xhr = new XMLHttpRequest();
        const parser = new SseParser();
        let processedLength = 0;

        xhr.open("GET", url, true);
        xhr.setRequestHeader("Authorization", `Bearer ${this.token}`);
        xhr.setRequestHeader("X-DPI-Token", this.token);
        xhr.setRequestHeader("Accept", "text/event-stream");

        xhr.onreadystatechange = () => {
          if (stopped) return;
          if (xhr.readyState === XMLHttpRequest.HEADERS_RECEIVED && xhr.status === 200) {
            handlers.onStatusChange?.("connected");
          }
        };

        xhr.onprogress = () => {
          if (stopped) return;
          const text = xhr.responseText || "";
          const delta = text.slice(processedLength);
          processedLength = text.length;
          if (delta) {
            for (const frame of parser.feed(delta)) {
              handlers.onFrame(frame);
            }
          }
        };

        xhr.onerror = () => {
          if (stopped) return;
          handlers.onStatusChange?.("reconnecting", "Network stream disconnected");
          scheduleReconnect();
        };

        xhr.onloadend = () => {
          if (stopped) return;
          if (xhr.status === 401 || xhr.status === 404) {
            handlers.onStatusChange?.("error", `HTTP ${xhr.status}`);
            return;
          }
          scheduleReconnect();
        };

        abortStream = () => xhr.abort();
        xhr.send();
        return;
      }

      // Node.js / modern fetch ReadableStream
      const controller = new AbortController();
      abortStream = () => controller.abort();

      (async () => {
        try {
          const res = await fetch(url, {
            headers: {
              Authorization: `Bearer ${this.token}`,
              "X-DPI-Token": this.token,
              Accept: "text/event-stream",
            },
            signal: controller.signal,
          });
          if (!res.ok || !res.body) {
            if (res.status === 401 || res.status === 404) {
              handlers.onStatusChange?.("error", `HTTP ${res.status}`);
              return;
            }
            throw new Error(`HTTP ${res.status}`);
          }

          handlers.onStatusChange?.("connected");
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          const parser = new SseParser();

          while (!stopped) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            for (const frame of parser.feed(chunk)) {
              handlers.onFrame(frame);
            }
          }
          if (!stopped) scheduleReconnect();
        } catch (err) {
          if (stopped) return;
          handlers.onStatusChange?.(
            "reconnecting",
            err instanceof Error ? err.message : String(err),
          );
          scheduleReconnect();
        }
      })();
    };

    const scheduleReconnect = () => {
      if (stopped) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => connect(true), 1500);
    };

    connect(false);

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      abortStream?.();
    };
  }
}
