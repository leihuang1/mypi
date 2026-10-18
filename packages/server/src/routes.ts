import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CompactSessionRequest,
  CreateDirectoryRequest,
  CreateSessionRequest,
  GitCloneRequest,
  NotificationDeviceRequest,
  ResetSessionRequest,
  SendMessageRequest,
  SseFrame,
  UpdateBookmarkRequest,
  UpdateSessionRequest,
} from "@mypi/shared";
import { inspectGitDirectory } from "./git-service.js";
import type { HarnessManager } from "./harness-mgr.js";

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PATCH, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-DPI-Token, Idempotency-Key",
  );
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  setCorsHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(res, status, { error: { code, message } });
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 1024 * 1024) throw new Error("Request body too large");
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

function checkBearerAuth(
  req: IncomingMessage,
  url: URL,
  expectedToken: string,
): boolean {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token === expectedToken) return true;
  }
  const dpiToken = req.headers["x-dpi-token"];
  if (typeof dpiToken === "string" && dpiToken.trim() === expectedToken) {
    return true;
  }
  const queryToken = url.searchParams.get("token");
  if (queryToken && queryToken.trim() === expectedToken) {
    return true;
  }
  return false;
}

export function createRequestHandler(options: {
  manager: HarnessManager;
  token: string;
  activeResponses?: Set<ServerResponse>;
}) {
  const { manager, token, activeResponses } = options;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      setCorsHeaders(res);

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      let url: URL;
      try {
        const rawHost =
          typeof req.headers.host === "string" && req.headers.host.trim()
            ? req.headers.host.trim()
            : "localhost";
        url = new URL(req.url || "/", `http://${rawHost}`);
      } catch {
        sendError(res, 400, "bad_request", "Malformed request URL or Host header");
        return;
      }

      const pathname = url.pathname;

      if (manager.isClosing()) {
        sendError(res, 503, "closing", "Server is shutting down");
        return;
      }

      if (req.method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, { ok: true, timestamp: Date.now() });
        return;
      }

      if (!pathname.startsWith("/v1/")) {
        sendError(res, 404, "not_found", `Route not found: ${pathname}`);
        return;
      }

      if (!checkBearerAuth(req, url, token)) {
        sendError(res, 401, "unauthorized", "Invalid or missing bearer token");
        return;
      }
      if (req.method === "POST" && pathname === "/v1/notifications/devices") {
        try {
          manager.notifications.register(await readJsonBody<NotificationDeviceRequest>(req));
          sendJson(res, 200, { ok: true });
        } catch {
          sendError(res, 400, "invalid", "Invalid notification registration or unavailable storage");
        }
        return;
      }
      if (req.method === "POST" && pathname === "/v1/notifications/presence") {
        const body = await readJsonBody<{ deviceId: string; sessionId: string | null }>(req);
        manager.notifications.presence(body.deviceId, body.sessionId);
        sendJson(res, 200, { ok: true });
        return;
      }

      // GET /v1/device
      if (req.method === "GET" && pathname === "/v1/device") {
        sendJson(res, 200, manager.getDeviceInfo());
        return;
      }

      // GET /v1/usage/openai
      if (req.method === "GET" && pathname === "/v1/usage/openai") {
        const usage = await manager.getOpenAIUsage();
        sendJson(res, 200, usage);
        return;
      }

      // GET /v1/fs/dirs
      if (req.method === "GET" && pathname === "/v1/fs/dirs") {
        const dirPath = url.searchParams.get("path") || undefined;
        const hiddenParam = url.searchParams.get("includeHidden");
        const includeHidden = hiddenParam === "1" || hiddenParam === "true";
        const listing = manager.listDirectories(dirPath, { includeHidden });
        sendJson(res, 200, listing);
        return;
      }

      // POST /v1/fs/mkdir
      if (req.method === "POST" && pathname === "/v1/fs/mkdir") {
        const body = await readJsonBody<CreateDirectoryRequest>(req);
        const created = await manager.createDirectory(body);
        sendJson(res, 201, created);
        return;
      }

      // POST /v1/fs/git-clone
      if (req.method === "POST" && pathname === "/v1/fs/git-clone") {
        const body = await readJsonBody<GitCloneRequest>(req);
        const cloned = await manager.gitCloneDirectory(body);
        sendJson(res, 201, cloned);
        return;
      }

      // POST /v1/fs/bookmarks
      if (req.method === "POST" && pathname === "/v1/fs/bookmarks") {
        const body = await readJsonBody<UpdateBookmarkRequest>(req);
        const updated = manager.updateBookmark(body);
        sendJson(res, 200, updated);
        return;
      }

      // GET /v1/fs/file
      if (req.method === "GET" && pathname === "/v1/fs/file") {
        const filePath = url.searchParams.get("path") || "";
        const preview = manager.readFilePreview(filePath);
        sendJson(res, 200, preview);
        return;
      }

      // GET /v1/sessions
      if (req.method === "GET" && pathname === "/v1/sessions") {
        const sessions = await manager.listSessions();
        sendJson(res, 200, sessions);
        return;
      }

      // POST /v1/sessions
      if (req.method === "POST" && pathname === "/v1/sessions") {
        const body = await readJsonBody<CreateSessionRequest>(req);
        const created = await manager.createSession(body);
        sendJson(res, 201, created);
        return;
      }

      // Match /v1/sessions/:sessionId...
      const sessionMatch = pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/(.+))?$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const subRoute = sessionMatch[2] || "";

        if (!subRoute) {
          if (req.method === "GET") {
            const summary = await manager.getSessionSummary(sessionId);
            sendJson(res, 200, summary);
            return;
          }
          if (req.method === "PATCH") {
            const body = await readJsonBody<UpdateSessionRequest>(req);
            const updated = await manager.updateSession(sessionId, body);
            sendJson(res, 200, updated);
            return;
          }
          if (req.method === "DELETE") {
            const result = await manager.deleteSession(sessionId);
            sendJson(res, 200, result);
            return;
          }
        }

        // POST /v1/sessions/:id/messages
        if (req.method === "POST" && subRoute === "messages") {
          const body = await readJsonBody<SendMessageRequest>(req);
          if (!body.content || typeof body.content !== "string") {
            sendError(res, 400, "invalid", "Message content is required");
            return;
          }
          const result = await manager.sendMessage(sessionId, {
            requestId: body.requestId || `req-${Date.now()}`,
            content: body.content,
            whenBusy: body.whenBusy,
          });
          sendJson(res, 200, result);
          return;
        }

        // POST /v1/sessions/:id/compact
        if (req.method === "POST" && subRoute === "compact") {
          const body = await readJsonBody<CompactSessionRequest>(req);
          const result = await manager.compactSession(sessionId, body);
          sendJson(res, 200, result);
          return;
        }

        // POST /v1/sessions/:id/reset
        if (req.method === "POST" && subRoute === "reset") {
          const body = await readJsonBody<ResetSessionRequest>(req);
          const result = await manager.resetSession(sessionId, body);
          sendJson(res, 200, result);
          return;
        }

        // POST /v1/sessions/:id/inbox/:submissionId/abort
        const inboxAbortMatch = subRoute.match(/^inbox\/(\d+)\/abort$/);
        if (req.method === "POST" && inboxAbortMatch) {
          const submissionId = Number(inboxAbortMatch[1]);
          const result = await manager.abortSubmission(sessionId, submissionId);
          sendJson(res, 200, result);
          return;
        }

        // POST /v1/sessions/:id/abort
        if (req.method === "POST" && subRoute === "abort") {
          const result = await manager.abortSession(sessionId);
          sendJson(res, 200, result);
          return;
        }

        // GET /v1/sessions/:id/git
        if (req.method === "GET" && subRoute === "git") {
          const summary = await manager.getSessionSummary(sessionId);
          const gitInfo = await inspectGitDirectory(summary.cwd);
          sendJson(res, 200, gitInfo);
          return;
        }

        // GET /v1/sessions/:id/events (SSE stream)
        if (req.method === "GET" && subRoute === "events") {
          let closed = req.destroyed || res.writableEnded;
          let heartbeat: ReturnType<typeof setInterval> | null = null;
          let unsubscribe: (() => Promise<void>) | null = null;

          const cleanup = () => {
            if (closed && !heartbeat && !unsubscribe) return;
            closed = true;
            activeResponses?.delete(res);
            if (heartbeat) {
              clearInterval(heartbeat);
              heartbeat = null;
            }
            if (unsubscribe) {
              const fn = unsubscribe;
              unsubscribe = null;
              void fn();
            }
          };

          req.once("close", cleanup);
          res.once("close", cleanup);

          const writeFrame = (frame: SseFrame) => {
            if (closed || res.writableEnded) return;
            if (!res.headersSent) {
              res.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": "*",
                "X-Accel-Buffering": "no",
              });
            }
            res.write(`data: ${JSON.stringify(frame)}\n\n`);
          };

          const unsub = await manager.subscribeSession(sessionId, writeFrame);
          if (closed || req.destroyed || res.writableEnded) {
            await unsub();
            return;
          }

          unsubscribe = unsub;
          activeResponses?.add(res);
          heartbeat = setInterval(() => {
            writeFrame({ type: "heartbeat", timestamp: Date.now() });
          }, 15_000);
          return;
        }
      }

      sendError(res, 404, "not_found", `Route not found: ${pathname}`);
    } catch (err) {
      if (res.headersSent) {
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const lower = message.toLowerCase();
      const status = lower.includes("not found")
        ? 404
        : lower.includes("shutting down")
          ? 503
          : 500;
      sendError(
        res,
        status,
        status === 404 ? "not_found" : status === 503 ? "closing" : "internal",
        message,
      );
    }
  };
}
