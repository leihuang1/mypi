import type {
  AssistantTranscriptItem,
  RawAgentEvent,
  RawEntryRecord,
  RawSnapshotEvent,
  SessionLiveState,
  SseFrame,
  ToolCallItem,
  ToolDiagnosticItem,
  TranscriptItem,
  UsageSummary,
} from "./protocol";

export function createInitialSessionState(): SessionLiveState {
  return {
    entries: [],
    items: [],
    busy: false,
    inFlightAssistant: null,
    liveTools: {},
    inbox: [],
    compacting: false,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalCost: 0,
    },
  };
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const obj = part as Record<string, unknown>;
          if (obj.type === "text" && typeof obj.text === "string") {
            return obj.text;
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function parseAssistantMessage(
  msg: Record<string, unknown>,
  id: string,
  entryId?: number,
): AssistantTranscriptItem {
  const content = Array.isArray(msg.content) ? msg.content : [];
  const thinkingParts: string[] = [];
  const textParts: string[] = [];
  const toolCalls: ToolCallItem[] = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "thinking" && typeof b.thinking === "string") {
      thinkingParts.push(b.thinking);
    } else if (b.type === "text" && typeof b.text === "string") {
      textParts.push(b.text);
    } else if (b.type === "toolCall") {
      const callId = typeof b.id === "string" ? b.id : `call-${toolCalls.length}`;
      const toolName = typeof b.name === "string" ? b.name : "tool";
      const args =
        b.arguments && typeof b.arguments === "object"
          ? (b.arguments as Record<string, unknown>)
          : {};
      toolCalls.push({
        callId,
        toolName,
        args,
        status: "pending",
        output: "",
      });
    }
  }

  const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : undefined;
  let status: AssistantTranscriptItem["status"] = "done";
  if (stopReason === "aborted") {
    status = "aborted";
  } else if (stopReason === "error") {
    status = "error";
  }

  const errorMessage =
    typeof msg.errorMessage === "string" ? msg.errorMessage : undefined;
  const timestamp =
    typeof msg.timestamp === "number" ? msg.timestamp : undefined;

  return {
    id,
    entryId,
    kind: "assistant",
    thinking: thinkingParts.join("\n"),
    text: textParts.join(""),
    status,
    errorMessage,
    toolCalls,
    timestamp,
  };
}

function parseUsage(rawUsage: unknown): UsageSummary {
  const summary: UsageSummary = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };
  if (!rawUsage || typeof rawUsage !== "object") return summary;
  const u = rawUsage as Record<string, unknown>;
  const totals =
    u.totals && typeof u.totals === "object"
      ? (u.totals as Record<string, unknown>)
      : u;

  if (typeof totals.input === "number") summary.inputTokens = totals.input;
  if (typeof totals.output === "number") summary.outputTokens = totals.output;
  if (typeof totals.totalTokens === "number") {
    summary.totalTokens = totals.totalTokens;
  } else {
    summary.totalTokens = summary.inputTokens + summary.outputTokens;
  }
  if (totals.cost && typeof totals.cost === "object") {
    const c = totals.cost as Record<string, unknown>;
    if (typeof c.total === "number") summary.totalCost = c.total;
  }
  return summary;
}

export function buildTranscriptItems(
  entries: readonly RawEntryRecord[],
  inFlightAssistant: AssistantTranscriptItem | null,
  liveTools: Readonly<Record<string, ToolCallItem>>,
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const toolCallIndex = new Map<string, ToolCallItem>();

  for (const entry of entries) {
    const firstMsg =
      Array.isArray(entry.model) && entry.model.length > 0
        ? entry.model[0]
        : undefined;

    if (entry.kind === "pi.user" || (firstMsg && firstMsg.role === "user" && entry.kind !== "pi.compaction" && entry.kind !== "pi.reset")) {
      const text = firstMsg ? extractTextFromContent(firstMsg.content) : "";
      items.push({
        id: `entry-${entry.id}`,
        entryId: entry.id,
        kind: "user",
        text,
        timestamp:
          firstMsg && typeof firstMsg.timestamp === "number"
            ? firstMsg.timestamp
            : undefined,
      });
    } else if (entry.kind === "pi.assistant" && firstMsg) {
      const assistantItem = parseAssistantMessage(
        firstMsg,
        `entry-${entry.id}`,
        entry.id,
      );
      for (const tc of assistantItem.toolCalls) {
        const live = liveTools[tc.callId];
        if (live) {
          tc.status = live.status;
          tc.output = live.output;
          tc.details = live.details;
          tc.diagnostics = live.diagnostics;
        }
        toolCallIndex.set(tc.callId, tc);
      }
      items.push(assistantItem);
    } else if (entry.kind === "pi.tool_result" && firstMsg) {
      const callId =
        typeof firstMsg.toolCallId === "string" ? firstMsg.toolCallId : "";
      const isError = Boolean(firstMsg.isError);
      const output = extractTextFromContent(firstMsg.content);
      const dataObj =
        entry.data && typeof entry.data === "object"
          ? (entry.data as Record<string, unknown>)
          : undefined;
      const diagnostics = Array.isArray(dataObj?.diagnostics)
        ? (dataObj.diagnostics as ToolDiagnosticItem[])
        : undefined;

      const existing = toolCallIndex.get(callId);
      if (existing) {
        existing.status = isError ? "error" : "done";
        existing.isError = isError;
        existing.output = output;
        if (diagnostics) {
          existing.diagnostics = diagnostics;
        }
      } else {
        const toolName =
          typeof firstMsg.toolName === "string" ? firstMsg.toolName : "tool";
        items.push({
          id: `entry-${entry.id}`,
          entryId: entry.id,
          kind: "assistant",
          thinking: "",
          text: "",
          status: "done",
          toolCalls: [
            {
              callId: callId || `tool-${entry.id}`,
              toolName,
              args: {},
              status: isError ? "error" : "done",
              isError,
              output,
              diagnostics,
            },
          ],
        });
      }
    } else if (entry.kind === "pi.compaction") {
      const summaryText = firstMsg ? extractTextFromContent(firstMsg.content) : "Context compacted";
      items.push({
        id: `entry-${entry.id}`,
        entryId: entry.id,
        kind: "compaction",
        text: summaryText,
      });
    } else if (entry.kind === "pi.reset") {
      const handoff = firstMsg ? extractTextFromContent(firstMsg.content) : "";
      items.push({
        id: `entry-${entry.id}`,
        entryId: entry.id,
        kind: "reset",
        text: handoff ? `Context reset: ${handoff}` : "Context reset",
      });
    }
  }

  if (inFlightAssistant) {
    const mergedToolCalls = inFlightAssistant.toolCalls.map((tc) => {
      const live = liveTools[tc.callId];
      return live ? { ...tc, ...live } : tc;
    });
    items.push({
      ...inFlightAssistant,
      toolCalls: mergedToolCalls,
    });
  }

  return items;
}

export function applySnapshot(snapshot: RawSnapshotEvent): SessionLiveState {
  const entries = [...snapshot.entries];
  const liveTools: Record<string, ToolCallItem> = {};

  for (const slot of snapshot.tools ?? []) {
    liveTools[slot.callId] = {
      callId: slot.callId,
      toolName: slot.name,
      args: {},
      status: slot.status,
      output: slot.output ?? "",
      details: slot.details,
      diagnostics: slot.diagnostics ? [...slot.diagnostics] : undefined,
    };
  }

  let inFlightAssistant: AssistantTranscriptItem | null = null;
  if (snapshot.generation?.message) {
    inFlightAssistant = {
      ...parseAssistantMessage(snapshot.generation.message, "in-flight"),
      status: "streaming",
    };
  }

  const busy = Boolean(
    snapshot.run ||
      snapshot.generation ||
      (snapshot.tools && snapshot.tools.some((t) => t.status !== "done")),
  );

  const retry = snapshot.generation?.retry
    ? {
        attempt: snapshot.generation.attempt,
        at: snapshot.generation.retry.at,
        errorMessage: snapshot.generation.retry.error,
      }
    : undefined;

  return {
    entries,
    items: buildTranscriptItems(entries, inFlightAssistant, liveTools),
    busy,
    inFlightAssistant,
    liveTools,
    inbox: snapshot.inbox ? [...snapshot.inbox] : [],
    compacting: Boolean(snapshot.compactions && snapshot.compactions.length > 0),
    retry,
    model: snapshot.agent?.model,
    thinkingLevel: snapshot.agent?.thinkingLevel,
    cwd: snapshot.agent?.cwd,
    usage: parseUsage(snapshot.usage),
  };
}

function applyMessageChanges(
  current: AssistantTranscriptItem | null,
  changes: ReadonlyArray<Record<string, unknown>>,
): AssistantTranscriptItem {
  const base: AssistantTranscriptItem = current
    ? {
        ...current,
        toolCalls: [...current.toolCalls],
      }
    : {
        id: "in-flight",
        kind: "assistant",
        thinking: "",
        text: "",
        status: "streaming",
        toolCalls: [],
      };

  for (const change of changes) {
    const type = change.type;
    if (type === "message" && change.message && typeof change.message === "object") {
      return {
        ...parseAssistantMessage(change.message as Record<string, unknown>, "in-flight"),
        status: "streaming",
      };
    }
    if (type === "thinking_delta" && typeof change.delta === "string") {
      base.thinking += change.delta;
    } else if (type === "text_delta" && typeof change.delta === "string") {
      base.text += change.delta;
    } else if (
      (type === "text_start" || type === "thinking_start" || type === "toolcall_start" || type === "block") &&
      change.block &&
      typeof change.block === "object"
    ) {
      const b = change.block as Record<string, unknown>;
      if (b.type === "toolCall") {
        const callId = typeof b.id === "string" ? b.id : `call-${base.toolCalls.length}`;
        const toolName = typeof b.name === "string" ? b.name : "tool";
        const args =
          b.arguments && typeof b.arguments === "object"
            ? (b.arguments as Record<string, unknown>)
            : {};
        const existingIdx = base.toolCalls.findIndex((t) => t.callId === callId);
        if (existingIdx >= 0) {
          base.toolCalls[existingIdx] = {
            ...base.toolCalls[existingIdx],
            toolName,
            args,
          };
        } else {
          base.toolCalls.push({
            callId,
            toolName,
            args,
            status: "pending",
            output: "",
          });
        }
      }
    }
  }

  return base;
}

export function applyAgentEvent(
  state: SessionLiveState,
  event: RawAgentEvent,
): SessionLiveState {
  if (event.type === "snapshot") {
    return applySnapshot(event);
  }

  let entries = state.entries;
  let inFlightAssistant = state.inFlightAssistant;
  let liveTools = state.liveTools;
  let busy = state.busy;
  let inbox = state.inbox;
  let compacting = state.compacting;
  let retry = state.retry;
  let model = state.model;
  let thinkingLevel = state.thinkingLevel;
  let cwd = state.cwd;
  let usage = state.usage;
  let lastError = state.lastError;

  switch (event.type) {
    case "run_start":
    case "turn_start":
      busy = true;
      lastError = undefined;
      break;

    case "run_end":
      busy = false;
      inFlightAssistant = null;
      liveTools = {};
      retry = undefined;
      break;

    case "message_start": {
      const role = event.message?.role;
      if (role === "assistant") {
        busy = true;
        inFlightAssistant = {
          ...parseAssistantMessage(event.message, "in-flight"),
          status: "streaming",
        };
      }
      break;
    }

    case "message_update": {
      busy = true;
      inFlightAssistant = applyMessageChanges(inFlightAssistant, event.changes);
      break;
    }

    case "message_end": {
      if (!entries.some((e) => e.id === event.entry.id)) {
        entries = [...entries, event.entry];
      }
      if (event.entry.kind === "pi.assistant") {
        inFlightAssistant = null;
      }
      break;
    }

    case "entry_appended": {
      if (!entries.some((e) => e.id === event.entry.id)) {
        entries = [...entries, event.entry];
      }
      break;
    }

    case "tool_execution_start": {
      busy = true;
      liveTools = {
        ...liveTools,
        [event.toolCallId]: {
          callId: event.toolCallId,
          toolName: event.toolName,
          args: event.args ?? {},
          status: "running",
          output: liveTools[event.toolCallId]?.output ?? "",
        },
      };
      break;
    }

    case "tool_execution_update": {
      const prev = liveTools[event.toolCallId] ?? {
        callId: event.toolCallId,
        toolName: event.toolName,
        args: {},
        status: "running" as const,
        output: "",
      };
      let nextOutput = prev.output;
      if (event.output) {
        if ("set" in event.output) {
          nextOutput = event.output.set;
        } else {
          if (typeof event.output.trimStart === "number" && event.output.trimStart > 0) {
            nextOutput = nextOutput.slice(event.output.trimStart);
          }
          if (typeof event.output.append === "string") {
            nextOutput += event.output.append;
          }
        }
      }
      liveTools = {
        ...liveTools,
        [event.toolCallId]: {
          ...prev,
          status: "running",
          output: nextOutput,
          details: event.details !== undefined ? event.details : prev.details,
          diagnostics: event.diagnostics
            ? [...event.diagnostics]
            : prev.diagnostics,
        },
      };
      break;
    }

    case "tool_execution_end": {
      if (event.entry && !entries.some((e) => e.id === event.entry!.id)) {
        entries = [...entries, event.entry];
      }
      const nextLive = { ...liveTools };
      delete nextLive[event.toolCallId];
      liveTools = nextLive;
      break;
    }

    case "inbox_update":
      inbox = [...event.items];
      break;

    case "auto_retry_start":
      retry = {
        attempt: event.attempt,
        at: event.at,
        errorMessage: event.errorMessage,
      };
      break;

    case "auto_retry_end":
      retry = undefined;
      break;

    case "agent_changed":
      model = event.agent.model ?? model;
      thinkingLevel = event.agent.thinkingLevel ?? thinkingLevel;
      cwd = event.agent.cwd ?? cwd;
      break;

    case "usage_changed":
      usage = parseUsage(event.usage);
      break;

    case "compaction_start":
      compacting = true;
      break;

    case "compaction_end":
      compacting = false;
      break;

    case "task_failed":
      lastError = `${event.kind}: ${event.message}`;
      break;
  }

  return {
    entries,
    items: buildTranscriptItems(entries, inFlightAssistant, liveTools),
    busy,
    inFlightAssistant,
    liveTools,
    inbox,
    compacting,
    retry,
    model,
    thinkingLevel,
    cwd,
    usage,
    lastError,
  };
}

export function reduceSseFrame(
  state: SessionLiveState,
  frame: SseFrame,
): SessionLiveState {
  if (frame.type === "snapshot") {
    return applySnapshot(frame.snapshot);
  }
  if (frame.type === "events") {
    let next = state;
    for (const ev of frame.events) {
      next = applyAgentEvent(next, ev);
    }
    return next;
  }
  return state;
}
