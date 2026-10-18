import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SendMessageRequest } from "@mypi/shared";
import * as lifecycle from "../src/store/session-lifecycle.js";
import { loadScreenHandlers } from "./screen-handlers.js";

function composer(onSend: (request: SendMessageRequest, state: any) => Promise<void>) {
  const saved: Record<string, any> = {};
  const state: Record<string, any> = {
    ...lifecycle,
    session: { id: "fixture" },
    sending: false,
    failedDraft: null,
    inputTextRef: { current: "Message A" },
    isNearBottomRef: { current: false },
    mountedRef: { current: true },
    currentSessionIdRef: { current: "fixture" },
    viewKey: "server/fixture",
    saveSessionView: (_key: string, patch: object) => { Object.assign(saved, patch); },
    saved,
    setBottomTray: () => {},
    setConnError: () => {},
  };
  state.setSending = (value: boolean) => { state.sending = value; };
  state.updateInputText = (value: string) => { state.inputTextRef.current = value; };
  state.setFailedDraft = (value: unknown) => { state.failedDraft = value; };
  state.client = { sendMessage: (_id: string, request: SendMessageRequest) => onSend(request, state) };
  return loadScreenHandlers(
    new URL("../src/screens/SessionDetailScreen.tsx", import.meta.url),
    ["submitMessage", "handleSend", "handleRetryFailedDraft", "handleRestoreFailedDraft"],
    state,
  );
}

describe("composer submission recovery", () => {
  it("keeps an unconfirmed submission after leaving the session mid-request", async () => {
    const state = composer(async (_request, current) => {
      current.mountedRef.current = false;
      throw new Error("Offline after navigating away");
    });
    await state.handleSend();
    assert.equal(state.saved.failedDraft.content, "Message A");
    assert.match(state.saved.failedDraft.error, /Offline/);
  });

  it("retries an accepted submission with the same ID after its response is lost", async () => {
    const accepted = new Map<string, string>();
    const requests: SendMessageRequest[] = [];
    const state = composer(async (request, state) => {
      requests.push(request);
      accepted.set(request.requestId, request.content);
      if (requests.length === 1) {
        state.inputTextRef.current = "Draft B";
        throw new Error("Response lost after acceptance");
      }
    });
    await state.handleSend("followUp");
    await state.handleRetryFailedDraft();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].requestId, requests[0].requestId);
    assert.equal(requests[1].whenBusy, "followUp");
    assert.equal(accepted.size, 1);
    assert.equal(state.inputTextRef.current, "Draft B");
    assert.equal(state.failedDraft, null);
  });

  it("does not send B or discard failed A until the failure is explicitly resolved", async () => {
    let attempts = 0;
    const state = composer(async (_request, state) => {
      attempts++;
      state.inputTextRef.current = "Draft B";
      throw new Error("Offline");
    });
    await state.handleSend();
    const failedA = state.failedDraft;
    await state.handleSend();
    assert.equal(attempts, 1);
    assert.equal(state.failedDraft, failedA);
    assert.equal(state.inputTextRef.current, "Draft B");
    state.handleRestoreFailedDraft();
    assert.equal(state.inputTextRef.current, "Message A\nDraft B");
    assert.equal(state.failedDraft, null);
  });

  it("keeps submission identity even when no new draft was typed", async () => {
    const requests: SendMessageRequest[] = [];
    const state = composer(async (request) => {
      requests.push(request);
      throw new Error("Offline");
    });
    await state.handleSend();
    assert.equal(state.inputTextRef.current, "");
    assert.equal(state.failedDraft.content, "Message A");
    await state.handleRetryFailedDraft();
    assert.equal(requests[1].requestId, requests[0].requestId);
    assert.equal(state.failedDraft.requestId, requests[0].requestId);
  });
});
