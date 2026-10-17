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
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      contextTokens: 0,
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

function addSingleUsageBucket(
  target: UsageSummary,
  bucket: Record<string, unknown>,
): void {
  const input = typeof bucket.input === "number" ? bucket.input : 0;
  const output = typeof bucket.output === "number" ? bucket.output : 0;
  const cacheRead = typeof bucket.cacheRead === "number" ? bucket.cacheRead : 0;
  const cacheWrite = typeof bucket.cacheWrite === "number" ? bucket.cacheWrite : 0;
  const total =
    typeof bucket.totalTokens === "number" && bucket.totalTokens > 0
      ? bucket.totalTokens
      : input + output + cacheRead + cacheWrite;

  target.inputTokens += input;
  target.outputTokens += output;
  target.cacheReadTokens += cacheRead;
  target.cacheWriteTokens += cacheWrite;
  target.totalTokens += total;

  if (bucket.cost && typeof bucket.cost === "object") {
    const c = bucket.cost as Record<string, unknown>;
    if (typeof c.total === "number") {
      target.totalCost += c.total;
    }
  }
}

function estimateRawMessageTokens(msg: Record<string, unknown>): number {
  const CHARS_PER_TOKEN = 3.5;
  const content = msg.content;
  if (typeof content === "string") {
    return Math.ceil(content.length / CHARS_PER_TOKEN);
  }
  if (Array.isArray(content)) {
    let chars = 0;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        chars += b.text.length;
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        chars += b.thinking.length;
      } else if (b.type === "toolCall") {
        chars +=
          (typeof b.name === "string" ? b.name.length : 4) +
          JSON.stringify(b.arguments ?? {}).length;
      } else {
        chars += 1200;
      }
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }
  return 0;
}

export function estimateActiveContextTokens(
  entries: readonly RawEntryRecord[],
  inFlightAssistant: AssistantTranscriptItem | null,
): number {
  // Determine active context range after newest reset or compaction head marker
  let headMarkerIndex = -1;
  let headTargetId: number | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === "pi.reset") {
      headMarkerIndex = i;
      headTargetId = e.id;
      break;
    }
    if (e.kind === "pi.compaction" || typeof e.head === "number") {
      headMarkerIndex = i;
      headTargetId = typeof e.head === "number" ? e.head : e.id;
      break;
    }
  }

  const activeEntries: RawEntryRecord[] = [];
  if (headMarkerIndex >= 0) {
    activeEntries.push(entries[headMarkerIndex]);
    for (let i = 0; i < entries.length; i++) {
      if (i === headMarkerIndex) continue;
      const e = entries[i];
      if (headTargetId !== undefined && e.id >= headTargetId && i > headMarkerIndex) {
        activeEntries.push(e);
      } else if (
        entries[headMarkerIndex].kind === "pi.compaction" &&
        headTargetId !== undefined &&
        e.id >= headTargetId
      ) {
        activeEntries.push(e);
      }
    }
  } else {
    activeEntries.push(...entries);
  }

  const headMarkerEntryId =
    headMarkerIndex >= 0 ? entries[headMarkerIndex].id : -1;
  let measuredTokens = 0;
  let measuredEntryIdx = -1;

  for (let i = activeEntries.length - 1; i >= 0; i--) {
    const e = activeEntries[i];
    if (e.id <= headMarkerEntryId) continue;
    const firstMsg =
      Array.isArray(e.model) && e.model.length > 0 ? e.model[0] : undefined;
    if (
      e.kind === "pi.assistant" &&
      firstMsg &&
      firstMsg.stopReason !== "aborted" &&
      firstMsg.stopReason !== "error" &&
      firstMsg.usage &&
      typeof firstMsg.usage === "object"
    ) {
      const u = firstMsg.usage as Record<string, unknown>;
      const input = typeof u.input === "number" ? u.input : 0;
      const output = typeof u.output === "number" ? u.output : 0;
      const cacheRead = typeof u.cacheRead === "number" ? u.cacheRead : 0;
      const cacheWrite = typeof u.cacheWrite === "number" ? u.cacheWrite : 0;
      const total =
        typeof u.totalTokens === "number" && u.totalTokens > 0
          ? u.totalTokens
          : input + output + cacheRead + cacheWrite;
      if (total > 0) {
        measuredTokens = total;
        measuredEntryIdx = i;
        break;
      }
    }
  }

  let trailingTokens = 0;
  const startIdx = measuredEntryIdx >= 0 ? measuredEntryIdx + 1 : 0;
  for (let i = startIdx; i < activeEntries.length; i++) {
    const msgs = Array.isArray(activeEntries[i].model) ? activeEntries[i].model! : [];
    for (const m of msgs) {
      if (m && typeof m === "object") {
        trailingTokens += estimateRawMessageTokens(m as Record<string, unknown>);
      }
    }
  }

  if (inFlightAssistant) {
    const inFlightChars =
      (inFlightAssistant.thinking?.length || 0) +
      (inFlightAssistant.text?.length || 0);
    trailingTokens += Math.ceil(inFlightChars / 3.5);
  }

  return measuredTokens + trailingTokens;
}

function parseUsage(rawUsage: unknown, contextTokens = 0): UsageSummary {
  const summary: UsageSummary = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    contextTokens,
  };
  if (!rawUsage || typeof rawUsage !== "object") return summary;
  const u = rawUsage as Record<string, unknown>;

  if (u.models && typeof u.models === "object") {
    for (const bucket of Object.values(u.models as Record<string, unknown>)) {
      if (bucket && typeof bucket === "object") {
        addSingleUsageBucket(summary, bucket as Record<string, unknown>);
      }
    }
    if (u.tools && typeof u.tools === "object") {
      for (const bucket of Object.values(u.tools as Record<string, unknown>)) {
        if (bucket && typeof bucket === "object") {
          addSingleUsageBucket(summary, bucket as Record<string, unknown>);
        }
      }
    }
    return summary;
  }

  const totals =
    u.totals && typeof u.totals === "object"
      ? (u.totals as Record<string, unknown>)
      : u;
  addSingleUsageBucket(summary, totals);
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
    } else if (
      (entry.kind === "pi.tool_result" ||
        entry.kind === "pi.tool-result" ||
        firstMsg?.role === "toolResult") &&
      firstMsg
    ) {
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

  const contextTokens = estimateActiveContextTokens(entries, inFlightAssistant);

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
    usage: parseUsage(snapshot.usage, contextTokens),
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
      if (
        typeof event.entry.head === "number" ||
        event.entry.kind === "pi.compaction" ||
        event.entry.kind === "pi.reset"
      ) {
        const target =
          typeof event.entry.head === "number"
            ? event.entry.head
            : event.entry.id;
        let kept = entries.findIndex(
          (candidate) => candidate.head === undefined && candidate.id >= target,
        );
        if (kept < 0) kept = entries.length;
        entries = [event.entry, ...entries.slice(kept)];
      } else if (!entries.some((e) => e.id === event.entry.id)) {
        entries = [...entries, event.entry];
      }
      if (event.entry.kind === "pi.assistant") {
        inFlightAssistant = null;
      }
      break;
    }

    case "entry_appended": {
      if (
        typeof event.entry.head === "number" ||
        event.entry.kind === "pi.compaction" ||
        event.entry.kind === "pi.reset"
      ) {
        const target =
          typeof event.entry.head === "number"
            ? event.entry.head
            : event.entry.id;
        let kept = entries.findIndex(
          (candidate) => candidate.head === undefined && candidate.id >= target,
        );
        if (kept < 0) kept = entries.length;
        entries = [event.entry, ...entries.slice(kept)];
      } else if (!entries.some((e) => e.id === event.entry.id)) {
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
      usage = parseUsage(event.usage, estimateActiveContextTokens(entries, inFlightAssistant));
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

  const nextContextTokens = estimateActiveContextTokens(entries, inFlightAssistant);
  if (usage.contextTokens !== nextContextTokens) {
    usage = { ...usage, contextTokens: nextContextTokens };
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
