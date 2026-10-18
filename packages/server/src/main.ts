import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import qrcode from "qrcode-terminal";
import { loadPiModelsAndAuth } from "./auth-loader.js";
import { HarnessManager } from "./harness-mgr.js";
import { createRequestHandler } from "./routes.js";

function resolveAdbBinary(): string | null {
  const candidates = [
    process.env.ANDROID_HOME
      ? path.join(process.env.ANDROID_HOME, "platform-tools", "adb")
      : "",
    path.join(os.homedir(), "Library", "Android", "sdk", "platform-tools", "adb"),
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function startAdbReverseKeepAlive(ports: number[]): () => void {
  const adbBin = resolveAdbBinary();
  if (!adbBin) return () => {};

  const applyReverse = () => {
    for (const p of ports) {
      execFile(
        adbBin,
        ["reverse", `tcp:${p}`, `tcp:${p}`],
        { timeout: 2000 },
        () => {
          // Ignore when no USB device is attached
        },
      );
    }
  };

  applyReverse();
  const timer = setInterval(applyReverse, 3000);
  timer.unref?.();
  return () => clearInterval(timer);
}

function loadOrCreateToken(dataDir: string): string {
  if (process.env.MYPI_TOKEN?.trim()) {
    return process.env.MYPI_TOKEN.trim();
  }
  const tokenFile = path.join(dataDir, "token.txt");
  if (fs.existsSync(tokenFile)) {
    const existing = fs.readFileSync(tokenFile, "utf8").trim();
    if (existing) return existing;
  }
  const fresh = `mypi_${crypto.randomBytes(18).toString("hex")}`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tokenFile, `${fresh}\n`, { mode: 0o600 });
  return fresh;
}

function getLocalNetworkAddresses(): { lan: string[]; tailscale: string[] } {
  const interfaces = os.networkInterfaces();
  const lan: string[] = [];
  const tailscale: string[] = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries) continue;
    for (const addr of entries) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (addr.address.startsWith("100.")) {
        tailscale.push(addr.address);
      } else if (
        !addr.address.startsWith("198.18.") &&
        !addr.address.startsWith("198.19.") &&
        !name.startsWith("utun")
      ) {
        lan.push(addr.address);
      }
    }
  }
  return { lan, tailscale };
}

export async function startMyPiServer(options?: {
  port?: number;
  host?: string;
  dataDir?: string;
  startDirs?: string[];
  silent?: boolean;
}) {
  const dataDir =
    options?.dataDir ??
    process.env.MYPI_DATA_DIR ??
    path.join(os.homedir(), ".mypi");
  const port = options?.port ?? Number.parseInt(process.env.MYPI_PORT || "4780", 10);
  const host = options?.host ?? process.env.MYPI_HOST ?? "0.0.0.0";

  const defaultCodeDir = path.join(os.homedir(), "code");
  const startDirs =
    options?.startDirs ??
    (fs.existsSync(defaultCodeDir)
      ? [defaultCodeDir, os.homedir()]
      : [os.homedir()]);

  const token = loadOrCreateToken(dataDir);
  const modelsConfig = await loadPiModelsAndAuth();
  const manager = new HarnessManager({
    dataDir,
    startDirs,
    modelsConfig,
  });

  const activeResponses = new Set<import("node:http").ServerResponse>();
  const inFlightRequests = new Set<Promise<void>>();
  const requestHandler = createRequestHandler({
    manager,
    token,
    activeResponses,
  });

  const server = createServer((req, res) => {
    const p = Promise.resolve(requestHandler(req, res))
      .catch((err) => {
        console.error("[mypi-server] Unhandled request error:", err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              error: { code: "internal", message: "Internal server error" },
            }),
          );
        } else if (!res.writableEnded) {
          res.end();
        }
      })
      .finally(() => {
        inFlightRequests.delete(p);
      });
    inFlightRequests.add(p);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const actualPort = (server.address() as { port: number }).port;
  let stopAdbKeepAlive = () => {};

  if (!options?.silent) {
    stopAdbKeepAlive = startAdbReverseKeepAlive([actualPort, 8081]);
    const { lan, tailscale } = getLocalNetworkAddresses();
    const candidateIps = [...lan, ...tailscale, "127.0.0.1"];
    const primaryUrl = `http://${candidateIps[0]}:${actualPort}`;
    const fallbackParams = candidateIps
      .slice(1)
      .map((ip) => `&fallbackUrl=${encodeURIComponent(`http://${ip}:${actualPort}`)}`)
      .join("");
    const pairingUri = `mypi://connect?url=${encodeURIComponent(primaryUrl)}${fallbackParams}&token=${encodeURIComponent(token)}&name=${encodeURIComponent(os.hostname())}`;

    console.log("\n========================================================");
    console.log("  MyPi Durable Daemon is running!");
    console.log("========================================================");
    console.log(`  Hostname     : ${os.hostname()}`);
    console.log(`  Data Dir     : ${dataDir}`);
    console.log(
      `  Default Model: ${modelsConfig.defaultModel.provider}/${modelsConfig.defaultModel.modelId} (${modelsConfig.defaultThinkingLevel})`,
    );
    console.log(`  Models Loaded: ${modelsConfig.availableModels.length} available from ~/.pi/agent`);
    console.log("--------------------------------------------------------");
    console.log(`  Local URL    : http://127.0.0.1:${actualPort}`);
    for (const ip of lan) {
      console.log(`  LAN Wi-Fi URL: http://${ip}:${actualPort}`);
    }
    for (const ip of tailscale) {
      console.log(`  Tailscale URL: http://${ip}:${actualPort}`);
    }
    console.log(`  Bearer Token : ${token}`);
    console.log("--------------------------------------------------------");
    console.log("  Scan QR Code in MyPi App to pair immediately:\n");
    qrcode.generate(pairingUri, { small: true });
    console.log(`\n  Pairing URI  : ${pairingUri}`);
    console.log("========================================================\n");
  }

  return {
    server,
    port: actualPort,
    token,
    manager,
    close: async () => {
      stopAdbKeepAlive();
      manager.beginClose();
      const serverClosePromise = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      for (const res of Array.from(activeResponses)) {
        try {
          if (!res.writableEnded) {
            res.end();
          }
        } catch {
          // Ignore
        }
      }
      activeResponses.clear();
      if (inFlightRequests.size > 0) {
        await Promise.allSettled(Array.from(inFlightRequests));
      }
      await manager.close();
      server.closeAllConnections?.();
      await serverClosePromise;
    },
  };
}

// Execute when run directly
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname);

if (isMain) {
  startMyPiServer().catch((err) => {
    console.error("[mypi-server] Fatal startup error:", err);
    process.exit(1);
  });
}
