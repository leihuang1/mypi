import type { AskedQuestion, RawAgentEvent, RawEntryRecord } from "@mypi/shared";
import { assistantTurn } from "./extensions/ask-user.js";

type FailureCause = "model" | "no_model" | "task";

export interface RunNotice {
  id: string;
  kind: "ended" | "error";
  cause?: FailureCause;
  /** The run ended by asking this with `ask_user`. */
  question?: AskedQuestion;
  /** The text of the run's last assistant message that had any. */
  summary?: string;
}

export interface RunNoticeState {
  runId?: string;
  running?: boolean;
  queued?: boolean;
  stopped?: boolean;
  error?: FailureCause;
  terminalError?: FailureCause;
  question?: AskedQuestion;
  summary?: string;
  pending?: RunNotice;
}

function withEntry(state: RunNoticeState, entry?: RawEntryRecord): RunNoticeState {
  const message = entry?.model?.find((msg) => msg.role === "assistant");
  if (!message) return state;
  if (message.stopReason === "error") return { ...state, error: "model" };
  // Only the run's last assistant message decides whether it ends with a question.
  const turn = assistantTurn(message);
  return { ...state, question: turn.question, summary: turn.text || state.summary };
}

function settled(state: RunNoticeState, id: string, kind: RunNotice["kind"], cause?: FailureCause): RunNotice {
  return { id, kind, cause, question: state.question, summary: state.summary };
}

export function reduceRunNotice(state: RunNoticeState, event: RawAgentEvent): RunNoticeState {
  switch (event.type) {
    case "snapshot": {
      let next = { ...state, running: Boolean(event.run), queued: event.inbox.length > 0 };
      if (event.run) return { ...next, runId: event.run.inputs.join(","), pending: undefined };
      // Recover a previously observed run that settled immediately before a daemon restart.
      if (state.running && state.runId) {
        next = withEntry(next, [...event.entries].reverse().find((e) => e.model?.some((m) => m.role === "assistant"))) as typeof next;
        return { ...next, pending: settled(next, state.runId, next.error ? "error" : "ended", next.error) };
      }
      return next;
    }
    case "run_start":
      return {
        ...(state.pending || state.queued || state.running ? state : {}),
        runId: event.inputs.join(","), running: true, pending: undefined, question: undefined, summary: undefined,
      };
    case "message_end":
      return withEntry(state, event.entry);
    case "submission": {
      const record = event.record;
      if (record.type !== "input" || !state.runId?.split(",").includes(String(record.id))) return state;
      if (record.status === "unanswered") {
        if (record.reason === "aborted" || record.reason === "reset") return { ...state, stopped: true };
        const error = record.reason === "no_model" ? "no_model" : record.reason === "model_error" ? "model" : "task";
        return { ...state, error, terminalError: error, pending: state.pending ? { ...state.pending, kind: "error", cause: error } : undefined };
      }
      if (record.status === "done") {
        // Success clears provisional errors, not a settled failure from a merged run.
        const error = state.terminalError;
        return { ...state, error, pending: state.pending ? { ...state.pending, kind: error ? "error" : "ended", cause: error } : undefined };
      }
      return state;
    }
    case "task_failed":
      // Compaction has its own lifecycle; recoverable tool result errors never enter this branch.
      if (!state.running || event.kind.includes("compaction")) return state;
      return { ...state, error: event.kind === "pi.generation" ? "model" : "task" };
    case "run_end":
      return {
        ...state, runId: event.inputs.join(","), running: false,
        pending: settled(state, event.inputs.join(","), state.error ? "error" : "ended", state.error),
      };
    case "inbox_update":
      return { ...state, queued: event.items.length > 0 };
    default:
      return state;
  }
}
