import { test } from "node:test";
import assert from "node:assert/strict";
import { yieldToEventLoop } from "../src/yield-event-loop.js";

test("yieldToEventLoop lets queued setImmediate work run", async () => {
  let ran = false;
  setImmediate(() => {
    ran = true;
  });
  assert.equal(ran, false);
  await yieldToEventLoop();
  assert.equal(ran, true);
});

test("multiple yields advance in order", async () => {
  const order = [];
  setImmediate(() => order.push("a"));
  await yieldToEventLoop();
  order.push("after-a");
  setImmediate(() => order.push("b"));
  await yieldToEventLoop();
  order.push("after-b");
  assert.deepEqual(order, ["a", "after-a", "b", "after-b"]);
});
