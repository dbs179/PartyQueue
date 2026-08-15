import { test } from "node:test";
import assert from "node:assert/strict";
import { createDebounced } from "../public/js/debounce.js";

test("createDebounced collapses bursts into one trailing call", async () => {
  let n = 0;
  const run = createDebounced(() => {
    n += 1;
  }, 20);
  run();
  run();
  run();
  assert.equal(n, 0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(n, 1);
  run.cancel();
});

test("createDebounced.cancel prevents a pending call", async () => {
  let n = 0;
  const run = createDebounced(() => {
    n += 1;
  }, 20);
  run();
  run.cancel();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(n, 0);
});
