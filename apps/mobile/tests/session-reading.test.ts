import assert from "node:assert/strict";
import { it } from "node:test";
import { loadScreenHandlers } from "./screen-handlers.js";

it("restores reading position once, never follows updates while reading, and follows only on request", () => {
  const scrolls: unknown[] = [];
  const saved = { offset: 420, following: false, advanceKey: "old" };
  const state = loadScreenHandlers(
    new URL("../src/screens/SessionDetailScreen.tsx", import.meta.url),
    ["restoreOrFollowScroll", "scrollToLatest"],
    {
      snapshotReady: false,
      viewKey: "server/session",
      transcriptAdvanceKey: "new",
      userScrollingRef: { current: false },
      isNearBottomRef: { current: false },
      restoreScrollRef: { current: true },
      getSessionView: () => saved,
      saveSessionView: (_key: string, patch: object) => Object.assign(saved, patch),
      setHasNewMessages: () => {},
      scrollRef: { current: {
        scrollTo: (args: unknown) => scrolls.push(args),
        scrollToEnd: () => scrolls.push("end"),
      } },
    },
  );
  state.restoreOrFollowScroll();
  assert.equal(scrolls.length, 0);
  state.snapshotReady = true;
  state.restoreOrFollowScroll();
  state.restoreOrFollowScroll();
  assert.deepEqual(scrolls.map((s: any) => s?.y), [420]);
  state.scrollToLatest();
  assert.equal(saved.following, true);
  assert.equal(saved.advanceKey, "new");
  state.restoreOrFollowScroll();
  assert.deepEqual(scrolls.slice(1), ["end", "end"]);
});
