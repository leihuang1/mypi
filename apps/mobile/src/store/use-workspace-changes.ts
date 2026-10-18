import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { GitStatusResponse, MyPiClient } from "@mypi/shared";
import { createRefreshQueue } from "./refresh-queue";

const cache = new Map<string, GitStatusResponse>();

export function useWorkspaceChanges(client: MyPiClient, sessionId: string, cwd: string) {
  const key = JSON.stringify([client.baseUrl, sessionId, cwd]);
  const [result, setResult] = useState<{ key: string; info?: GitStatusResponse; stale: boolean }>({ key, info: cache.get(key), stale: false });
  const queue = useRef<ReturnType<typeof createRefreshQueue>>();
  const refresh = useCallback(() => queue.current?.trigger(), []);

  useEffect(() => {
    let cancelled = false;
    setResult({ key, info: cache.get(key), stale: false });
    const current = createRefreshQueue(async () => {
      try {
        const info = await client.getGitStatus(sessionId);
        if (cancelled) return;
        cache.delete(key);
        cache.set(key, info);
        if (cache.size > 8) cache.delete(cache.keys().next().value!);
        setResult({ key, info, stale: false });
      } catch {
        if (!cancelled) setResult((prev) => ({ ...prev, stale: true }));
      }
    });
    queue.current = current;
    current.trigger();
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") current.trigger();
    });
    return () => {
      cancelled = true;
      current.dispose();
      appState.remove();
    };
  }, [client, sessionId, key]);

  return { info: result.key === key ? result.info : undefined, stale: result.key === key && result.stale, refresh };
}
