import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Credential,
  getSupportedThinkingLevels,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Models,
  type ModelsStoreEntry,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  ModelRef,
  ModelSummary,
  OpenAIRateLimitSnapshot,
  ThinkingLevel,
} from "@mypi/shared";

export interface OpenAIAuthMetadata {
  configured: boolean;
  authType: "oauth" | "api_key" | "none";
  subscriptionLabel?: string;
  tokenExpiresAt?: number;
}

export interface LoadedModelsConfig {
  models: Models;
  availableModels: ModelSummary[];
  defaultModel: ModelRef;
  defaultThinkingLevel: ThinkingLevel;
  openaiAuth: OpenAIAuthMetadata;
  getOpenAIRateLimits: () => OpenAIRateLimitSnapshot | undefined;
}

interface PiSettingsFile {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  enabledModels?: string[];
}

function parseOptionalNumber(val: string | undefined): number | undefined {
  if (!val) return undefined;
  const num = Number(val);
  return Number.isFinite(num) ? num : undefined;
}

function extractRateLimitsFromHeaders(
  headers: Record<string, string>,
): OpenAIRateLimitSnapshot | undefined {
  const lower: Record<string, string> = {};
  const rawHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    lower[lk] = v;
    if (
      lk.includes("ratelimit") ||
      lk.includes("codex") ||
      lk.includes("usage") ||
      lk.includes("quota") ||
      lk.includes("retry-after")
    ) {
      rawHeaders[lk] = v;
    }
  }

  const limitRequests = parseOptionalNumber(
    lower["x-ratelimit-limit-requests"] ?? lower["x-codex-limit-requests"],
  );
  const remainingRequests = parseOptionalNumber(
    lower["x-ratelimit-remaining-requests"] ?? lower["x-codex-remaining-requests"],
  );
  const resetRequests =
    lower["x-ratelimit-reset-requests"] ?? lower["x-codex-reset-requests"];
  const limitTokens = parseOptionalNumber(
    lower["x-ratelimit-limit-tokens"] ?? lower["x-codex-limit-tokens"],
  );
  const remainingTokens = parseOptionalNumber(
    lower["x-ratelimit-remaining-tokens"] ?? lower["x-codex-remaining-tokens"],
  );
  const resetTokens =
    lower["x-ratelimit-reset-tokens"] ?? lower["x-codex-reset-tokens"];

  if (
    limitRequests === undefined &&
    remainingRequests === undefined &&
    limitTokens === undefined &&
    remainingTokens === undefined &&
    Object.keys(rawHeaders).length === 0
  ) {
    return undefined;
  }

  return {
    limitRequests,
    remainingRequests,
    resetRequests,
    limitTokens,
    remainingTokens,
    resetTokens,
    rawHeaders: Object.keys(rawHeaders).length > 0 ? rawHeaders : undefined,
    updatedAt: Date.now(),
  };
}

export async function loadPiModelsAndAuth(options?: {
  piAgentDir?: string;
}): Promise<LoadedModelsConfig> {
  const piAgentDir =
    options?.piAgentDir ?? path.join(os.homedir(), ".pi", "agent");

  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();

  let openaiAuth: OpenAIAuthMetadata = {
    configured: false,
    authType: "none",
  };

  if (process.env.OPENAI_API_KEY) {
    openaiAuth = {
      configured: true,
      authType: "api_key",
      subscriptionLabel: "OpenAI Platform API Key (ENV)",
    };
  }

  // 1. Seed credentials from ~/.pi/agent/auth.json (read-only on ~/.pi)
  const authPath = path.join(piAgentDir, "auth.json");
  if (fs.existsSync(authPath)) {
    try {
      const rawAuth = JSON.parse(
        fs.readFileSync(authPath, "utf8"),
      ) as Record<string, Credential>;
      for (const [providerId, cred] of Object.entries(rawAuth)) {
        if (cred && typeof cred === "object" && "type" in cred) {
          await credentials.modify(providerId, async () => cred);
          if (providerId === "openai" || providerId === "openai-codex") {
            const credObj = cred as unknown as Record<string, unknown>;
            if (cred.type === "oauth") {
              const scopes = Array.isArray(credObj.scopes)
                ? (credObj.scopes as string[])
                : [];
              const isDirect = scopes.includes("chatgpt.tokens.use.direct");
              openaiAuth = {
                configured: true,
                authType: "oauth",
                subscriptionLabel: isDirect
                  ? "ChatGPT Subscription (Direct OAuth)"
                  : "ChatGPT Plus/Pro (Codex OAuth)",
                tokenExpiresAt:
                  typeof credObj.expires === "number"
                    ? credObj.expires
                    : undefined,
              };
            } else if (cred.type === "api_key") {
              openaiAuth = {
                configured: true,
                authType: "api_key",
                subscriptionLabel: "OpenAI Platform API Key",
              };
            }
          }
        }
      }
    } catch (err) {
      console.warn("[mypi-server] Failed to read ~/.pi/agent/auth.json:", err);
    }
  }

  // 2. Seed cached models catalog from ~/.pi/agent/models-store.json
  const modelsStorePath = path.join(piAgentDir, "models-store.json");
  if (fs.existsSync(modelsStorePath)) {
    try {
      const rawStore = JSON.parse(
        fs.readFileSync(modelsStorePath, "utf8"),
      ) as Record<string, ModelsStoreEntry>;
      for (const [providerId, entry] of Object.entries(rawStore)) {
        if (entry && Array.isArray(entry.models)) {
          await modelsStore.write(providerId, entry);
        }
      }
    } catch (err) {
      console.warn(
        "[mypi-server] Failed to read ~/.pi/agent/models-store.json:",
        err,
      );
    }
  }

  // 3. Initialize builtin providers and restore cached dynamic models offline
  const models = builtinModels({ credentials, modelsStore });
  await models.refresh({ allowNetwork: false });

  // Intercept OpenAI provider response headers to capture live rate limits
  let latestOpenAIRateLimits: OpenAIRateLimitSnapshot | undefined;
  for (const provId of ["openai", "openai-codex"]) {
    const prov = models.getProvider(provId);
    if (!prov) continue;
    const origStream = prov.stream.bind(prov);
    const origStreamSimple = prov.streamSimple.bind(prov);

    const wrapOptions = <T>(opts: T): T => {
      const baseOpts = (
        opts && typeof opts === "object" ? { ...(opts as object) } : {}
      ) as Record<string, unknown>;
      const userOnResponse =
        typeof baseOpts.onResponse === "function"
          ? (baseOpts.onResponse as (
              res: { status: number; headers: Record<string, string> },
              model: unknown,
            ) => unknown)
          : undefined;
      baseOpts.onResponse = async (
        res: { status: number; headers: Record<string, string> },
        model: unknown,
      ) => {
        if (res?.headers) {
          const parsed = extractRateLimitsFromHeaders(res.headers);
          if (parsed) {
            latestOpenAIRateLimits = parsed;
          }
        }
        await userOnResponse?.(res, model);
      };
      return baseOpts as unknown as T;
    };

    models.setProvider({
      ...prov,
      stream: (model, ctx, opts) => origStream(model, ctx, wrapOptions(opts)),
      streamSimple: (model, ctx, opts) =>
        origStreamSimple(model, ctx, wrapOptions(opts)),
    });
  }

  // 4. Read ~/.pi/agent/settings.json for defaults and enabledModels filter
  let settings: PiSettingsFile = {};
  const settingsPath = path.join(piAgentDir, "settings.json");
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(
        fs.readFileSync(settingsPath, "utf8"),
      ) as PiSettingsFile;
    } catch {
      // Ignore malformed settings.json
    }
  }

  const available = await models.getAvailable();
  const enabledSet =
    Array.isArray(settings.enabledModels) && settings.enabledModels.length > 0
      ? new Set(settings.enabledModels)
      : null;

  const mapModel = (m: (typeof available)[number]): ModelSummary => {
    const levels = getSupportedThinkingLevels(m) as ThinkingLevel[];
    return {
      provider: m.provider,
      modelId: m.id,
      name: m.name || m.id,
      reasoning: Boolean(m.reasoning),
      thinkingLevels: levels.length > 0 ? levels : ["off"],
      contextWindow: m.contextWindow,
    };
  };

  // Prefer enabledModels first if configured, then all available models
  let availableModels: ModelSummary[] = [];
  if (enabledSet) {
    const enabledAvailable = available.filter((m) =>
      enabledSet.has(`${m.provider}/${m.id}`),
    );
    const others = available.filter(
      (m) => !enabledSet.has(`${m.provider}/${m.id}`),
    );
    availableModels = [...enabledAvailable, ...others].map(mapModel);
  } else {
    availableModels = available.map(mapModel);
  }

  // Fallback if no provider is configured yet: list static models from openai/anthropic
  if (availableModels.length === 0) {
    availableModels = models.getModels().slice(0, 20).map(mapModel);
  }

  let defaultModel: ModelRef = {
    provider: settings.defaultProvider || "openai",
    modelId: settings.defaultModel || "gpt-5",
  };

  const hasDefault = availableModels.some(
    (m) =>
      m.provider === defaultModel.provider &&
      m.modelId === defaultModel.modelId,
  );
  if (!hasDefault && availableModels.length > 0) {
    defaultModel = {
      provider: availableModels[0].provider,
      modelId: availableModels[0].modelId,
    };
  }

  const defaultThinkingLevel: ThinkingLevel =
    settings.defaultThinkingLevel || "high";

  return {
    models,
    availableModels,
    defaultModel,
    defaultThinkingLevel,
    openaiAuth,
    getOpenAIRateLimits: () => latestOpenAIRateLimits,
  };
}
