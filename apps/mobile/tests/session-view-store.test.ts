import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { it } from "node:test";
import ts from "typescript";

function loadStore(storage: Map<string, string>) {
  const source = fs.readFileSync(new URL("../src/store/session-view-store.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
  const exports: Record<string, any> = {};
  vm.runInNewContext(outputText, {
    exports, console, setTimeout, clearTimeout,
    require: () => ({
      getItem: async (key: string) => storage.get(key) ?? null,
      setItem: async (key: string, value: string) => { storage.set(key, value); },
    }),
  });
  return exports;
}

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
