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

/** Whether the entry is the user speaking: a message, a steer, a reset's handoff. A compaction's summary is phrased as
 * a user message, but it answers nothing. */
export function userSpoke(entry: RawEntryRecord): boolean {
  return entry.kind !== "pi.compaction" && Boolean(entry.model?.some((msg) => msg.role === "user"));
}

function withEntry(state: RunNoticeState, entry?: RawEntryRecord): RunNoticeState {
  // A steer answers an earlier question.
  const next = entry && userSpoke(entry) ? { ...state, question: undefined } : state;
  const message = entry?.model?.find((msg) => msg.role === "assistant");
  if (!message) return next;
  if (message.stopReason === "error") return { ...next, error: "model" };
  // A question stands until the user answers, even if the agent went on (it asked alongside other tools).
  const turn = assistantTurn(message);
  return { ...next, question: turn.question ?? next.question, summary: turn.text || next.summary };
}

/** The question and summary of the run in `entries`, read back from the entries since the user last spoke. */
function recovered(state: RunNoticeState, entries: readonly RawEntryRecord[]): RunNoticeState {
  let question: AskedQuestion | undefined;
  let summary: string | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const messages = entries[i].model ?? [];
    if (userSpoke(entries[i])) break;
    const message = messages.find((msg) => msg.role === "assistant");
    if (!message || message.stopReason === "error") continue;
    const turn = assistantTurn(message);
    question ??= turn.question;
    summary ??= turn.text || undefined;
  }
  return { ...state, question, summary };
}

function settled(state: RunNoticeState, id: string, kind: RunNotice["kind"], cause?: FailureCause): RunNotice {
  return { id, kind, cause, question: state.question, summary: state.summary };
}

export function reduceRunNotice(state: RunNoticeState, event: RawAgentEvent): RunNoticeState {
  switch (event.type) {
    case "snapshot": {
      let next = { ...state, running: Boolean(event.run), queued: event.inbox.length > 0 };
      // After a restart, the run's committed messages may not have reached this observer: read them back.
      if (event.run) return { ...recovered(next, event.entries), runId: event.run.inputs.join(","), pending: undefined };
      // Recover a previously observed run that settled immediately before a daemon restart.
      if (state.running && state.runId) {
        const last = [...event.entries].reverse().find((e) => e.model?.some((m) => m.role === "assistant"));
        next = recovered(withEntry(next, last), event.entries) as typeof next;
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
