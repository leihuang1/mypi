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

function cloneJsonRecord(obj: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  } catch {
    return { ...obj };
  }
}

function appendStringAtPath(
  root: Record<string, unknown>,
  path: readonly (string | number)[],
  delta: string,
): Record<string, unknown> {
  const cloned = cloneJsonRecord(root);
  if (path.length === 0) return cloned;

  let cursor: Record<string, unknown> | unknown[] = cloned;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const nextKey = path[i + 1];
    if (Array.isArray(cursor)) {
      const idx = typeof key === "number" ? key : Number(key);
      const existing = cursor[idx];
      if (!existing || typeof existing !== "object") {
        cursor[idx] = typeof nextKey === "number" ? [] : {};
      }
      cursor = cursor[idx] as Record<string, unknown> | unknown[];
    } else {
      const strKey = String(key);
      const existing = cursor[strKey];
      if (!existing || typeof existing !== "object") {
        cursor[strKey] = typeof nextKey === "number" ? [] : {};
      }
      cursor = cursor[strKey] as Record<string, unknown> | unknown[];
    }
  }

  const lastKey = path[path.length - 1];
  if (Array.isArray(cursor)) {
    const idx = typeof lastKey === "number" ? lastKey : Number(lastKey);
    const prev = typeof cursor[idx] === "string" ? (cursor[idx] as string) : "";
    cursor[idx] = prev + delta;
  } else {
    const strKey = String(lastKey);
    const prev =
      typeof cursor[strKey] === "string" ? (cursor[strKey] as string) : "";
    cursor[strKey] = prev + delta;
  }

  return cloned;
}

function parseAssistantMessage(
  msg: Record<string, unknown>,
  id: string,
  entryId?: number,
): AssistantTranscriptItem {
  const content = Array.isArray(msg.content) ? msg.content : [];
  const blocks: Record<string, unknown>[] = [];
  const thinkingParts: string[] = [];
  const textParts: string[] = [];
  const toolCalls: ToolCallItem[] = [];

  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block || typeof block !== "object") {
      blocks.push({ type: "empty" });
      continue;
    }
    const b = block as Record<string, unknown>;
    blocks.push(b);
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
    blocks,
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
          tc.isError = live.isError;
          tc.details = live.details;
          tc.diagnostics = live.diagnostics;
          if (
            Object.keys(tc.args).length === 0 &&
            Object.keys(live.args).length > 0
          ) {
            tc.args = live.args;
          }
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
      if (!live) return tc;
      return {
        ...tc,
        ...live,
        args:
          Object.keys(tc.args).length > 0 ? tc.args : live.args,
      };
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
    const isFaultedOrOrphanedDone =
      slot.status === "done" && slot.entry === undefined;
    liveTools[slot.callId] = {
      callId: slot.callId,
      toolName: slot.name,
      args: {},
      status: isFaultedOrOrphanedDone ? "interrupted" : slot.status,
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

  const lastError = snapshot.compactionFailure?.error
    ? `Compaction failed: ${snapshot.compactionFailure.error}`
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
    lastError,
  };
}

function reconstructBlocksFromItem(
  item: AssistantTranscriptItem | null,
): Record<string, unknown>[] {
  if (!item) return [];
  if (item.blocks) {
    return item.blocks.map((b) => cloneJsonRecord(b));
  }
  const blocks: Record<string, unknown>[] = [];
  if (item.thinking) {
    blocks.push({ type: "thinking", thinking: item.thinking });
  }
  if (item.text) {
    blocks.push({ type: "text", text: item.text });
  }
  for (const tc of item.toolCalls) {
    blocks.push({
      type: "toolCall",
      id: tc.callId,
      name: tc.toolName,
      arguments: cloneJsonRecord(tc.args),
    });
  }
  return blocks;
}

function ensureBlockSlot(
  blocks: Record<string, unknown>[],
  index: number,
): void {
  while (blocks.length <= index) {
    blocks.push({ type: "empty" });
  }
}

function applyMessageChanges(
  current: AssistantTranscriptItem | null,
  changes: ReadonlyArray<Record<string, unknown>>,
): AssistantTranscriptItem {
  const id = current?.id ?? "in-flight";
  const entryId = current?.entryId;
  let blocks = reconstructBlocksFromItem(current);

  for (const change of changes) {
    const type = change.type;
    if (type === "message" && change.message && typeof change.message === "object") {
      const parsed = parseAssistantMessage(
        change.message as Record<string, unknown>,
        id,
        entryId,
      );
      blocks = reconstructBlocksFromItem(parsed);
      continue;
    }

    const idx =
      typeof change.contentIndex === "number" && change.contentIndex >= 0
        ? change.contentIndex
        : undefined;

    if (
      (type === "text_start" ||
        type === "thinking_start" ||
        type === "toolcall_start" ||
        type === "block") &&
      change.block &&
      typeof change.block === "object"
    ) {
      const clonedBlock = cloneJsonRecord(
        change.block as Record<string, unknown>,
      );
      if (idx !== undefined) {
        ensureBlockSlot(blocks, idx);
        blocks[idx] = clonedBlock;
      } else {
        blocks.push(clonedBlock);
      }
    } else if (type === "text_delta" && typeof change.delta === "string") {
      if (idx !== undefined) {
        ensureBlockSlot(blocks, idx);
        const existing = blocks[idx];
        const prevText =
          existing?.type === "text" && typeof existing.text === "string"
            ? existing.text
            : "";
        blocks[idx] = {
          ...(existing?.type === "text" ? existing : { type: "text" }),
          type: "text",
          text: prevText + change.delta,
        };
      } else {
        let lastTextIdx = -1;
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (blocks[i]?.type === "text") {
            lastTextIdx = i;
            break;
          }
        }
        if (lastTextIdx >= 0) {
          const prev =
            typeof blocks[lastTextIdx].text === "string"
              ? (blocks[lastTextIdx].text as string)
              : "";
          blocks[lastTextIdx] = {
            ...blocks[lastTextIdx],
            text: prev + change.delta,
          };
        } else {
          blocks.push({ type: "text", text: change.delta });
        }
      }
    } else if (type === "thinking_delta" && typeof change.delta === "string") {
      if (idx !== undefined) {
        ensureBlockSlot(blocks, idx);
        const existing = blocks[idx];
        const prevThinking =
          existing?.type === "thinking" && typeof existing.thinking === "string"
            ? existing.thinking
            : "";
        blocks[idx] = {
          ...(existing?.type === "thinking" ? existing : { type: "thinking" }),
          type: "thinking",
          thinking: prevThinking + change.delta,
        };
      } else {
        let lastThinkingIdx = -1;
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (blocks[i]?.type === "thinking") {
            lastThinkingIdx = i;
            break;
          }
        }
        if (lastThinkingIdx >= 0) {
          const prev =
            typeof blocks[lastThinkingIdx].thinking === "string"
              ? (blocks[lastThinkingIdx].thinking as string)
              : "";
          blocks[lastThinkingIdx] = {
            ...blocks[lastThinkingIdx],
            thinking: prev + change.delta,
          };
        } else {
          blocks.push({ type: "thinking", thinking: change.delta });
        }
      }
    } else if (type === "toolcall_delta" && typeof change.delta === "string") {
      const pathArr = Array.isArray(change.path)
        ? (change.path as ReadonlyArray<string | number>)
        : [];
      let targetIdx = idx;
      if (targetIdx === undefined) {
        let found = -1;
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (blocks[i]?.type === "toolCall") {
            found = i;
            break;
          }
        }
        targetIdx = found >= 0 ? found : blocks.length;
      }
      ensureBlockSlot(blocks, targetIdx);
      const existing = blocks[targetIdx];
      const baseCall: Record<string, unknown> =
        existing?.type === "toolCall"
          ? cloneJsonRecord(existing)
          : {
              type: "toolCall",
              id: `call-${targetIdx}`,
              name: "tool",
              arguments: {},
            };
      const baseArgs =
        baseCall.arguments && typeof baseCall.arguments === "object"
          ? (baseCall.arguments as Record<string, unknown>)
          : {};
      baseCall.arguments = appendStringAtPath(baseArgs, pathArr, change.delta);
      blocks[targetIdx] = baseCall;
    }
  }

  return {
    ...parseAssistantMessage({ content: blocks }, id, entryId),
    status: "streaming",
    timestamp: current?.timestamp,
  };
}

function hasToolResultEntry(
  entries: readonly RawEntryRecord[],
  callId: string,
): boolean {
  return entries.some((entry) => {
    const firstMsg =
      Array.isArray(entry.model) && entry.model.length > 0
        ? entry.model[0]
        : undefined;
    return (
      (entry.kind === "pi.tool_result" ||
        entry.kind === "pi.tool-result" ||
        firstMsg?.role === "toolResult") &&
      firstMsg?.toolCallId === callId
    );
  });
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

    case "run_end": {
      busy = false;
      inFlightAssistant = null;
      retry = undefined;
      // Preserve unfinished/interrupted tool outputs that never received a result entry
      const nextLive: Record<string, ToolCallItem> = {};
      for (const [callId, tool] of Object.entries(liveTools)) {
        if (hasToolResultEntry(entries, callId)) {
          continue;
        }
        nextLive[callId] = {
          ...tool,
          status:
            tool.status === "running" || tool.status === "pending"
              ? "interrupted"
              : tool.status,
        };
      }
      liveTools = nextLive;
      break;
    }

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

    case "message_end":
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
        if (event.entry.kind === "pi.compaction" || event.entry.kind === "pi.reset") {
          lastError = undefined;
        }
      } else if (!entries.some((e) => e.id === event.entry.id)) {
        entries = [...entries, event.entry];
      }
      if (event.type === "message_end" && event.entry.kind === "pi.assistant") {
        inFlightAssistant = null;
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
      if (event.entry) {
        if (!entries.some((e) => e.id === event.entry!.id)) {
          entries = [...entries, event.entry];
        }
        const nextLive = { ...liveTools };
        delete nextLive[event.toolCallId];
        liveTools = nextLive;
      } else {
        // Tool ended without a result entry (interrupted, faulted, orphaned, or nested)
        const prev = liveTools[event.toolCallId];
        const terminalStatus: ToolCallItem["status"] = event.result
          ? event.result.isError
            ? "error"
            : "done"
          : "interrupted";
        liveTools = {
          ...liveTools,
          [event.toolCallId]: {
            callId: event.toolCallId,
            toolName: event.toolName || prev?.toolName || "tool",
            args: prev?.args ?? {},
            status: terminalStatus,
            isError: event.result?.isError ?? prev?.isError,
            output: prev?.output ?? "",
            details:
              event.result?.details !== undefined
                ? event.result.details
                : prev?.details,
            diagnostics: event.result?.diagnostics
              ? [...event.result.diagnostics]
              : prev?.diagnostics,
          },
        };
      }
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
      lastError = undefined;
      break;

    case "compaction_end":
      compacting = false;
      if (event.error) {
        lastError = `Compaction failed: ${event.error}`;
      }
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
