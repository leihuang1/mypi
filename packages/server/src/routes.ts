import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CreateSessionRequest,
  SendMessageRequest,
  SseFrame,
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
  for await (const chunk of req) {
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
}) {
  const { manager, token } = options;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

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

    try {
      // GET /v1/device
      if (req.method === "GET" && pathname === "/v1/device") {
        sendJson(res, 200, manager.getDeviceInfo());
        return;
      }

      // GET /v1/fs/dirs
      if (req.method === "GET" && pathname === "/v1/fs/dirs") {
        const dirPath = url.searchParams.get("path") || undefined;
        const listing = manager.listDirectories(dirPath);
        sendJson(res, 200, listing);
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
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
            "X-Accel-Buffering": "no",
          });

          const writeFrame = (frame: SseFrame) => {
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify(frame)}\n\n`);
            }
          };

          const unsubscribe = await manager.subscribeSession(sessionId, writeFrame);
          const heartbeat = setInterval(() => {
            writeFrame({ type: "heartbeat", timestamp: Date.now() });
          }, 15_000);

          req.on("close", () => {
            clearInterval(heartbeat);
            void unsubscribe();
          });
          return;
        }
      }

      sendError(res, 404, "not_found", `Route not found: ${pathname}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes("not found") ? 404 : 500;
      sendError(
        res,
        status,
        status === 404 ? "not_found" : "internal",
        message,
      );
    }
  };
}
