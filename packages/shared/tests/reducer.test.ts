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
});
