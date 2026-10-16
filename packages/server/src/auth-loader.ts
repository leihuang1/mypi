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
import type { ModelRef, ModelSummary, ThinkingLevel } from "@mypi/shared";

export interface LoadedModelsConfig {
  models: Models;
  availableModels: ModelSummary[];
  defaultModel: ModelRef;
  defaultThinkingLevel: ThinkingLevel;
}

interface PiSettingsFile {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  enabledModels?: string[];
}

export async function loadPiModelsAndAuth(options?: {
  piAgentDir?: string;
}): Promise<LoadedModelsConfig> {
  const piAgentDir =
    options?.piAgentDir ?? path.join(os.homedir(), ".pi", "agent");

  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();

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
  };
}
