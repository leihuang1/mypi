import assert from "node:assert/strict";
import { it } from "node:test";
import { loadSessionViewStore as loadStore } from "./screen-handlers.js";

it("persists drafts and reading position separately for each server/session across restart", async () => {
  const storage = new Map<string, string>();
  let store = loadStore(storage);
  const a = store.sessionViewKey("server-a", "same-id");
  const b = store.sessionViewKey("server-b", "same-id");
  store.saveSessionView(a, { draft: "Draft A", offset: 321, following: false, advanceKey: "seen" });
  store.saveSessionView(b, { draft: "Draft B" });
  store.flushSessionViews();
  await new Promise((resolve) => setImmediate(resolve));
  store = loadStore(storage);
  await store.loadSessionViews();
  assert.equal(store.getSessionView(a).draft, "Draft A");
  assert.equal(store.getSessionView(a).offset, 321);
  assert.equal(store.getSessionView(a).following, false);
  assert.equal(store.getSessionView(b).draft, "Draft B");
  store.removeSessionView("server-a", "same-id");
  assert.equal(store.getSessionView(a).draft, "");
  assert.equal(store.getSessionView(b).draft, "Draft B");
});

it("tolerates corrupted local storage without crashing session opening", async () => {
  for (const raw of ["null", "[]", "{bad json", '{"bad":{"draft":7}}']) {
    const store = loadStore(new Map([["@mypi/session_views_v1", raw]]));
    await store.loadSessionViews();
    assert.equal(store.getSessionView("bad").draft, "");
  }
});
