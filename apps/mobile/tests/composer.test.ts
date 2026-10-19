import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SendMessageRequest } from "@mypi/shared";
import * as lifecycle from "../src/store/session-lifecycle.js";
import { loadScreenHandlers, loadSessionViewStore } from "./screen-handlers.js";

function composer(onSend: (request: SendMessageRequest, state: any) => Promise<void>, store = loadSessionViewStore()) {
  const saved = store.getSessionView("server/fixture");
  const state: Record<string, any> = {
    ...lifecycle,
    session: { id: "fixture" },
    sending: false,
    failedDraft: saved.failedDraft,
    inputTextRef: { current: saved.draft || "Message A" },
    isNearBottomRef: { current: false },
    mountedRef: { current: true },
    currentSessionIdRef: { current: "fixture" },
    viewKey: "server/fixture",
    saveSessionView: store.saveSessionView,
    getSessionView: store.getSessionView,
    persistSessionViews: () => store.persistSessionViews(),
    get saved() { return store.getSessionView("server/fixture"); },
    setBottomTray: () => {},
    setConnError: () => {},
  };
  state.setSending = (value: boolean) => { state.sending = value; };
  state.updateInputText = (value: string) => {
    state.inputTextRef.current = value;
    store.saveSessionView("server/fixture", { draft: value });
  };
  state.setFailedDraft = (value: unknown) => { state.failedDraft = value; };
  state.client = { sendMessage: (_id: string, request: SendMessageRequest) => onSend(request, state) };
  return loadScreenHandlers(
    new URL("../src/screens/SessionDetailScreen.tsx", import.meta.url),
    ["submitMessage", "handleSend", "handleRetryFailedDraft", "handleDismissFailedDraft", "handleRestoreFailedDraft"],
    state,
  );
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("composer submission recovery", () => {
  for (const outcome of ["success", "failure"]) {
    it(`ignores an old screen's ${outcome} after a newer prompt fails`, async () => {
      const storage = new Map<string, string>();
      const store = loadSessionViewStore(storage);
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const old = composer(() => new Promise<void>((a, b) => { resolve = a; reject = b; }), store);
      const pending = old.handleSend();
      await tick();
      old.mountedRef.current = false;
      const current = composer(async (request) => { if (request.content === "Message B") throw new Error("B failed"); }, store);
      await current.handleRetryFailedDraft();
      current.updateInputText("Message B");
      await current.handleSend();
      const failedB = current.saved.failedDraft;
      if (outcome === "success") resolve(); else reject(new Error("A failed"));
      await pending;
      assert.equal(current.saved.failedDraft, failedB);
      store.flushSessionViews();
      await tick();
      const reloaded = loadSessionViewStore(storage);
      await reloaded.loadSessionViews();
      assert.equal(reloaded.getSessionView("server/fixture").failedDraft?.content, "Message B");
    });
  }

  it("does not overwrite an in-flight retry of the same request with an older failure", async () => {
    const store = loadSessionViewStore();
    let fail!: (error: Error) => void;
    const old = composer(() => new Promise<void>((_resolve, reject) => { fail = reject; }), store);
    const first = old.handleSend();
    await tick();
    old.mountedRef.current = false;
    let complete!: () => void;
    const current = composer(() => new Promise<void>((resolve) => { complete = resolve; }), store);
    const retry = current.handleRetryFailedDraft();
    await tick();
    const pendingRetry = current.saved.failedDraft;
    fail(new Error("Old response lost"));
    await first;
    assert.equal(current.saved.failedDraft, pendingRetry);
    complete();
    await retry;
    assert.equal(current.saved.failedDraft, null);
  });

  it("persists the request ID before HTTP even while more view updates arrive", async () => {
    const storage = new Map<string, string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = loadSessionViewStore(storage, async (key, value) => {
      await gate;
      storage.set(key, value);
    });
    const sent: SendMessageRequest[] = [];
    let acceptedStorage!: Map<string, string>;
    const state = composer(async (request) => { sent.push(request); acceptedStorage = new Map(storage); }, store);
    const pending = state.handleSend();
    for (let i = 0; i < 20; i++) store.saveSessionView("server/fixture", { advanceKey: String(i) });
    state.updateInputText("Draft B");
    await tick();
    const beforeWrite = sent.length;
    release();
    await pending;
    assert.equal(beforeWrite, 0, "HTTP must wait for durable recovery data");
    const recovered = loadSessionViewStore(acceptedStorage);
    await recovered.loadSessionViews();
    assert.equal(recovered.getSessionView("server/fixture").failedDraft?.requestId, sent[0].requestId);
    assert.equal(recovered.getSessionView("server/fixture").draft, "");
    assert.equal(state.inputTextRef.current, "Draft B");
  });

  it("retains a recoverable prompt and does not send when local persistence fails", async () => {
    const storage = new Map<string, string>();
    let full = true;
    const store = loadSessionViewStore(storage, async (key, value) => {
      if (full) throw new Error("Storage full");
      storage.set(key, value);
    });
    const sent: SendMessageRequest[] = [];
    const state = composer(async (request) => { sent.push(request); }, store);
    await state.handleSend();
    assert.equal(sent.length, 0);
    assert.equal(state.failedDraft.content, "Message A");
    assert.match(state.failedDraft.error, /未发送/);
    const requestId = state.failedDraft.requestId;
    full = false;
    await state.handleRetryFailedDraft();
    assert.equal(sent[0].requestId, requestId);
    assert.equal(state.failedDraft, null);
  });
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
    assert.equal(state.saved.failedDraft, null);
    assert.equal(state.saved.draft, "Message A\nDraft B");
  });

  it("keeps a dismissed prompt dismissed after reloading storage", async () => {
    const storage = new Map<string, string>();
    const store = loadSessionViewStore(storage);
    const state = composer(async () => { throw new Error("Offline"); }, store);
    await state.handleSend();
    state.handleDismissFailedDraft();
    store.flushSessionViews();
    await tick();
    const recovered = loadSessionViewStore(storage);
    await recovered.loadSessionViews();
    assert.equal(recovered.getSessionView("server/fixture").failedDraft, null);
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
