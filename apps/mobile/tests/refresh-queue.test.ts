import assert from "node:assert/strict";
import { it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createRefreshQueue } from "../src/store/refresh-queue.js";

it("coalesces bursts and serializes a refresh requested while in flight", async () => {
  let calls = 0;
  let finish!: () => void;
  const queue = createRefreshQueue(async () => {
    calls++;
    if (calls === 1) await new Promise<void>((resolve) => { finish = resolve; });
  }, 5);
  queue.trigger(); queue.trigger(); queue.trigger();
  await sleep(20);
  assert.equal(calls, 1);
  queue.trigger(); queue.trigger();
  await sleep(20);
  assert.equal(calls, 1);
  finish();
  await sleep(20);
  assert.equal(calls, 2);
  queue.trigger();
  queue.dispose();
  await sleep(20);
  assert.equal(calls, 2);
});
