import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyAgentEvent,
  applySnapshot,
  createInitialSessionState,
  parsePairingInput,
  reduceSseFrame,
  SseParser,
} from "../src/index.js";

describe("@mypi/shared reducer and SSE parser", () => {
  it("shares immutable history blocks and never mutates earlier streaming states", () => {
    const historyBlock = Object.freeze({ type: "text", text: "history".repeat(2000) });
    let state = applySnapshot({
      type: "snapshot",
      entries: [{ id: 1, conversationId: 1, kind: "pi.assistant", model: [
        { role: "assistant", content: [historyBlock] },
      ] }],
      tools: [], inbox: [], compactions: [], agent: {},
    });
    state = applyAgentEvent(state, {
      type: "message_start",
      message: { role: "assistant", content: [
        { type: "toolCall", id: "call", name: "bash", arguments: Object.freeze({ command: "git " }) },
      ] },
    });
    const previous = state;
    state = applyAgentEvent(state, {
      type: "message_update",
      changes: [{ type: "toolcall_delta", contentIndex: 0, path: ["command"], delta: "status" }],
    });
    assert.equal(previous.inFlightAssistant?.toolCalls[0].args.command, "git ");
    assert.equal(state.inFlightAssistant?.toolCalls[0].args.command, "git status");
    assert.equal(state.items[0].kind, "assistant");
    if (state.items[0].kind === "assistant") {
      assert.equal(state.items[0].blocks?.[0], historyBlock,
        "Streaming must not deep-copy unchanged history on every delta");
    }
  });

  it("reduces snapshot and streaming events into transcript items", () => {
    const initial = createInitialSessionState();
    const afterSnap = reduceSseFrame(initial, {
      type: "snapshot",
      session: {
        id: "sess-1",
        name: "Test Session",
        cwd: "/Users/kaleo/code/android/mypi",
        model: { provider: "openai", modelId: "gpt-6-astra" },
        thinkingLevel: "high",
        createdAt: 1000,
        updatedAt: 1000,
        busy: false,
        entryCount: 1,
      },
      snapshot: {
        type: "snapshot",
        entries: [
          {
            id: 1,
            conversationId: 1,
            kind: "pi.user",
            model: [{ role: "user", content: "Hello Pi Durable!" }],
          },
        ],
        tools: [],
        compactions: [],
        inbox: [],
        agent: {
          model: { provider: "openai", modelId: "gpt-6-astra" },
          thinkingLevel: "high",
          cwd: "/Users/kaleo/code/android/mypi",
        },
      },
    });

    assert.equal(afterSnap.items.length, 1);
    assert.equal(afterSnap.items[0].kind, "user");
    assert.equal(afterSnap.items[0].text, "Hello Pi Durable!");
    assert.equal(afterSnap.busy, false);

    // Simulate streaming assistant response with thinking + text + tool execution
    let state = applyAgentEvent(afterSnap, {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    assert.equal(state.busy, true);

    state = applyAgentEvent(state, {
      type: "message_update",
      changes: [
        { type: "thinking_delta", contentIndex: 0, delta: "Checking files..." },
        { type: "text_delta", contentIndex: 1, delta: "I will run ls." },
        {
          type: "toolcall_start",
          contentIndex: 2,
          block: {
            type: "toolCall",
            id: "call-1",
            name: "bash",
            arguments: { command: "ls -la" },
          },
        },
      ],
    });

    assert.equal(state.items.length, 2);
    const streamingAssistant = state.items[1];
    assert.equal(streamingAssistant.kind, "assistant");
    if (streamingAssistant.kind === "assistant") {
      assert.equal(streamingAssistant.thinking, "Checking files...");
      assert.equal(streamingAssistant.text, "I will run ls.");
      assert.equal(streamingAssistant.toolCalls.length, 1);
      assert.equal(streamingAssistant.toolCalls[0].toolName, "bash");
    }

    // Tool execution starts and streams output
    state = applyAgentEvent(state, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls -la" },
    });
    state = applyAgentEvent(state, {
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "bash",
      output: { append: "package.json\n" },
    });

    const runningAssistant = state.items[1];
    if (runningAssistant.kind === "assistant") {
      assert.equal(runningAssistant.toolCalls[0].status, "running");
      assert.equal(runningAssistant.toolCalls[0].output, "package.json\n");
    }
  });

  it("parses SSE frames and pairing URIs accurately", () => {
    const parser = new SseParser();
    const f1 = parser.feed('data: {"type":"hello","apiVersion":1,"sessionId":"s1","serverTime":123}\n\n');
    assert.equal(f1.length, 1);
    assert.equal(f1[0].type, "hello");

    const paired = parsePairingInput(
      "mypi://connect?url=http%3A%2F%2F192.168.1.10%3A4780&token=secret123&name=MacBook",
    );
    assert.deepEqual(paired, {
      url: "http://192.168.1.10:4780",
      token: "secret123",
      name: "MacBook",
    });
  });

  it("calculates active contextTokens after compaction/reset and parses nested UsageState", () => {
    const state = applySnapshot({
      type: "snapshot",
      entries: [
        {
          id: 1,
          conversationId: 1,
          kind: "pi.user",
          model: [{ role: "user", content: "A".repeat(400) }], // ~115 tokens before compaction
        },
        {
          id: 2,
          conversationId: 1,
          kind: "pi.compaction",
          model: [{ role: "user", content: "Summary1234567890" }], // ~5 tokens
        },
        {
          id: 3,
          conversationId: 1,
          kind: "pi.user",
          model: [{ role: "user", content: "B".repeat(70) }], // 20 tokens
        },
      ],
      tools: [],
      compactions: [],
      inbox: [{ id: 7, mode: "steer", text: "Check tests" }],
      agent: {
        model: { provider: "openai", modelId: "gpt-5" },
        thinkingLevel: "high",
        cwd: "/tmp",
      },
      usage: {
        models: {
          "openai/gpt-5": {
            input: 1200,
            output: 300,
            cacheRead: 400,
            totalTokens: 1900,
            cost: { total: 0.0125 },
          },
        },
      },
    });

    assert.equal(state.usage.inputTokens, 1200);
    assert.equal(state.usage.outputTokens, 300);
    assert.equal(state.usage.cacheReadTokens, 400);
    assert.equal(state.usage.totalTokens, 1900);
    assert.equal(state.usage.totalCost, 0.0125);
    // Active context should only count entries from the compaction entry (id 2) onwards, not id 1
    assert.ok(
      state.usage.contextTokens > 20 && state.usage.contextTokens < 40,
      `Expected contextTokens between 20 and 40, got ${state.usage.contextTokens}`,
    );
    assert.equal(state.inbox[0]?.text, "Check tests");
  });

  it("handles text_start with initial text, block replacement, and toolcall_delta matching snapshot (#6)", () => {
    let state = createInitialSessionState();
    state = applyAgentEvent(state, {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });

    // 1. text_start already contains "Hello", followed by text_delta " world"
    state = applyAgentEvent(state, {
      type: "message_update",
      changes: [
        {
          type: "thinking_start",
          contentIndex: 0,
          block: { type: "thinking", thinking: "Step 1" },
        },
        {
          type: "text_start",
          contentIndex: 1,
          block: { type: "text", text: "Hello" },
        },
        {
          type: "toolcall_start",
          contentIndex: 2,
          block: {
            type: "toolCall",
            id: "call-99",
            name: "bash",
            arguments: { command: "git " },
          },
        },
      ],
    });

    state = applyAgentEvent(state, {
      type: "message_update",
      changes: [
        { type: "thinking_delta", contentIndex: 0, delta: " + Step 2" },
        { type: "text_delta", contentIndex: 1, delta: " world" },
        {
          type: "toolcall_delta",
          contentIndex: 2,
          path: ["command"],
          delta: "status",
        },
      ],
    });

    const equivalentSnapshot = applySnapshot({
      type: "snapshot",
      entries: [],
      generation: {
        attempt: 1,
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Step 1 + Step 2" },
            { type: "text", text: "Hello world" },
            {
              type: "toolCall",
              id: "call-99",
              name: "bash",
              arguments: { command: "git status" },
            },
          ],
        },
      },
      tools: [],
      compactions: [],
      inbox: [],
      agent: {},
    });

    const item = state.items[0];
    const snapItem = equivalentSnapshot.items[0];
    assert.equal(item?.kind, "assistant");
    assert.equal(snapItem?.kind, "assistant");
    if (item?.kind === "assistant" && snapItem?.kind === "assistant") {
      assert.equal(item.thinking, "Step 1 + Step 2");
      assert.equal(item.text, "Hello world");
      assert.deepEqual(item.toolCalls, snapItem.toolCalls);
    }

    // Whole-block replacement by contentIndex
    state = applyAgentEvent(state, {
      type: "message_update",
      changes: [
        {
          type: "block",
          contentIndex: 1,
          block: { type: "text", text: "Replaced text block" },
        },
      ],
    });
    if (state.items[0]?.kind === "assistant") {
      assert.equal(state.items[0].text, "Replaced text block");
    }
  });

  it("surfaces compaction errors from compaction_end and snapshot.compactionFailure (#7)", () => {
    let state = createInitialSessionState();
    state = applyAgentEvent(state, {
      type: "compaction_start",
      taskId: 12,
      reason: "manual",
      blocking: false,
    });
    assert.equal(state.compacting, true);

    state = applyAgentEvent(state, {
      type: "compaction_end",
      taskId: 12,
      reason: "manual",
      error: "Provider rate limit exceeded",
    });
    assert.equal(state.compacting, false);
    assert.equal(
      state.lastError,
      "Compaction failed: Provider rate limit exceeded",
    );

    const fromSnap = applySnapshot({
      type: "snapshot",
      entries: [],
      tools: [],
      compactions: [],
      compactionFailure: {
        taskId: 12,
        reason: "manual",
        error: "Summarizer timed out",
      },
      inbox: [],
      agent: {},
    });
    assert.equal(fromSnap.lastError, "Compaction failed: Summarizer timed out");
  });

  it("preserves interrupted status and output when tool_execution_end has no result entry (#8)", () => {
    let state = createInitialSessionState();
    state = applyAgentEvent(state, {
      type: "message_end",
      entry: {
        id: 10,
        conversationId: 1,
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-int",
                name: "bash",
                arguments: { command: "sleep 10" },
              },
            ],
          },
        ],
      },
    });

    state = applyAgentEvent(state, {
      type: "tool_execution_start",
      toolCallId: "call-int",
      toolName: "bash",
      args: { command: "sleep 10" },
    });
    state = applyAgentEvent(state, {
      type: "tool_execution_update",
      toolCallId: "call-int",
      toolName: "bash",
      output: { append: "partial log line 1\n" },
    });
    // Tool ends without an entry (interrupted/aborted/faulted)
    state = applyAgentEvent(state, {
      type: "tool_execution_end",
      toolCallId: "call-int",
      toolName: "bash",
    });
    // Run ends afterwards
    state = applyAgentEvent(state, {
      type: "run_end",
      inputs: [1],
    });

    const assistant = state.items[0];
    assert.equal(assistant?.kind, "assistant");
    if (assistant?.kind === "assistant") {
      assert.equal(assistant.toolCalls[0]?.status, "interrupted");
      assert.equal(assistant.toolCalls[0]?.output, "partial log line 1\n");
    }
  });

  it("keeps SSE connection open when initial snapshot exceeds maxXhrBufferChars and only rotates after post-snapshot events exceed threshold (P1 #1, #17)", async () => {
    const { MyPiClient } = await import("../src/index.js");
    const origXhr = (globalThis as Record<string, unknown>).XMLHttpRequest;

    class MockXhr {
      static instances: MockXhr[] = [];
      static HEADERS_RECEIVED = 2;
      readyState = 0;
      status = 200;
      responseText = "";
      aborted = false;
      onreadystatechange?: () => void;
      onprogress?: () => void;
      onerror?: () => void;
      onloadend?: () => void;

      constructor() {
        MockXhr.instances.push(this);
      }
      open() {}
      setRequestHeader() {}
      send() {
        this.readyState = MockXhr.HEADERS_RECEIVED;
        this.onreadystatechange?.();
      }
      abort() {
        this.aborted = true;
        // Native XHR fires onloadend synchronously or asynchronously on abort
        this.onloadend?.();
      }
      pushChunk(chunk: string) {
        this.responseText += chunk;
        this.onprogress?.();
      }
    }

    (globalThis as Record<string, unknown>).XMLHttpRequest = MockXhr;
    try {
      const client = new MyPiClient({
        baseUrl: "http://127.0.0.1:4780",
        token: "test-token",
      });
      const frames: unknown[] = [];
      const maxXhrBufferChars = 200;
      const unsub = client.subscribeSessionEvents("s-xhr", {
        maxXhrBufferChars,
        onFrame: (f) => frames.push(f),
      });

      assert.equal(MockXhr.instances.length, 1);
      const firstXhr = MockXhr.instances[0];

      // 1. Push hello + a large snapshot (well over maxXhrBufferChars = 200)
      const helloStr =
        'data: {"type":"hello","apiVersion":1,"sessionId":"s-xhr","serverTime":1700000000000}\n\n';
      const largeSnapStr = `data: ${JSON.stringify({
        type: "snapshot",
        session: {
          id: "s-xhr",
          name: "Large Snapshot Session",
          cwd: "/tmp",
          model: { provider: "openai", modelId: "gpt-5" },
          thinkingLevel: "high",
          createdAt: 1,
          updatedAt: 1,
          busy: false,
          entryCount: 1,
        },
        snapshot: {
          type: "snapshot",
          entries: [
            {
              id: 1,
              conversationId: 1,
              kind: "pi.user",
              model: [{ role: "user", content: "X".repeat(600) }],
            },
          ],
          tools: [],
          compactions: [],
          inbox: [],
          agent: {},
        },
      })}\n\n`;
      assert.ok(largeSnapStr.length > maxXhrBufferChars * 3);

      firstXhr.pushChunk(helloStr + largeSnapStr);

      // Must NOT disconnect or open a 2nd connection just because snapshot exceeded maxXhrBufferChars
      assert.equal(frames.length, 2);
      assert.equal(firstXhr.aborted, false);
      assert.equal(
        MockXhr.instances.length,
        1,
        "Oversized initial snapshot must not trigger immediate SSE reconnect",
      );

      // 2. Push post-snapshot incremental events exceeding maxXhrBufferChars (200 chars)
      const eventsStr = `data: ${JSON.stringify({
        type: "events",
        events: [
          {
            type: "message_update",
            changes: [
              {
                type: "text_delta",
                contentIndex: 0,
                delta: "Y".repeat(220),
              },
            ],
          },
        ],
      })}\n\n`;
      assert.ok(eventsStr.length >= maxXhrBufferChars);
      firstXhr.pushChunk(eventsStr);

      assert.equal(frames.length, 3);
      assert.equal(firstXhr.aborted, true);
      assert.equal(
        MockXhr.instances.length,
        2,
        "Expected XHR stream to rotate into a 2nd instance after post-snapshot events exceed maxXhrBufferChars",
      );

      // 3. Second connection also receives the oversized snapshot and must remain connected
      const secondXhr = MockXhr.instances[1];
      secondXhr.pushChunk(helloStr + largeSnapStr);
      assert.equal(secondXhr.aborted, false);
      assert.equal(MockXhr.instances.length, 2);

      unsub();
      assert.equal(secondXhr.aborted, true);
    } finally {
      (globalThis as Record<string, unknown>).XMLHttpRequest = origXhr;
    }
  });
});
