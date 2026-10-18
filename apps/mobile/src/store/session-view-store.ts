import AsyncStorage from "@react-native-async-storage/async-storage";
import type { FailedSubmissionDraft } from "./session-lifecycle";

export interface SessionViewState {
  draft: string;
  failedDraft: FailedSubmissionDraft | null;
  offset: number;
  following: boolean;
  advanceKey: string;
}

const STORAGE_KEY = "@mypi/session_views_v1";
let views: Record<string, SessionViewState> = {};
let timer: ReturnType<typeof setTimeout> | undefined;
let writes = Promise.resolve();

export async function loadSessionViews(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (value && typeof value.draft === "string" && Number.isFinite(value.offset) && typeof value.following === "boolean") {
          views[key] = { ...value, advanceKey: typeof value.advanceKey === "string" ? value.advanceKey : "0" };
        }
      }
    }
  } catch {
    // Local storage failure must not prevent using a session.
  }
}

export function sessionViewKey(serverId: string, sessionId: string): string {
  return JSON.stringify([serverId, sessionId]);
}

export function getSessionView(key: string): SessionViewState {
  return views[key] ?? { draft: "", failedDraft: null, offset: 0, following: true, advanceKey: "0" };
}

export function saveSessionView(key: string, patch: Partial<SessionViewState>): void {
  views[key] = { ...getSessionView(key), ...patch };
  clearTimeout(timer);
  timer = setTimeout(flushSessionViews, 300);
}

export function flushSessionViews(): void {
  clearTimeout(timer);
  const serialized = JSON.stringify(views);
  writes = writes.then(() => AsyncStorage.setItem(STORAGE_KEY, serialized)).catch(() => {
    console.warn("MyPi: session drafts could not be saved to local storage");
  });
}

export function removeSessionView(serverId: string, sessionId: string): void {
  delete views[sessionViewKey(serverId, sessionId)];
  flushSessionViews();
}
