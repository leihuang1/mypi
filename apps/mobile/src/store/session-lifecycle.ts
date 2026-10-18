import type { SendMessageRequest } from "@mypi/shared";

export type AppScreenName =
  | "sessions"
  | "pair"
  | "new-session"
  | "session-detail";

export interface FailedSubmissionDraft extends SendMessageRequest {
  error: string;
}

// Restore is an explicit edit/new submission; Retry preserves the original request ID.
export function restoreFailedDraftToInput(
  currentInputText: string,
  failedDraft: FailedSubmissionDraft | null,
): {
  inputText: string;
  failedDraft: null;
} {
  if (!failedDraft) {
    return { inputText: currentInputText, failedDraft: null };
  }
  return {
    inputText: currentInputText.trim().length > 0
      ? `${failedDraft.content}\n${currentInputText}`
      : failedDraft.content,
    failedDraft: null,
  };
}
