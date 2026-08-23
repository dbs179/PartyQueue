import { test } from "node:test";
import assert from "node:assert/strict";
import { createPartyDisplayClock } from "../public/js/party-display-clock.js";

test("createPartyDisplayClock paints local time and ticks until stopped", () => {
  const el = { textContent: "", dateTime: "" };
  let now = new Date(2026, 7, 23, 11, 49, 0);
  /** @type {Function|null} */
  let tick = null;
  let cleared = 0;
  const clock = createPartyDisplayClock({
    el,
    now: () => now,
    locale: "en-US",
    intervalMs: 1000,
    setIntervalFn: (fn) => {
      tick = fn;
      return 7;
    },
    clearIntervalFn: () => {
      cleared += 1;
      tick = null;
    },
  });

  clock.start();
  assert.equal(el.textContent, "11:49 AM");
  assert.equal(el.dateTime, "11:49");
  assert.equal(clock.isRunning(), true);

  now = new Date(2026, 7, 23, 11, 50, 0);
  tick();
  assert.equal(el.textContent, "11:50 AM");
  assert.equal(el.dateTime, "11:50");

  clock.stop();
  assert.equal(cleared, 1);
  assert.equal(clock.isRunning(), false);
});
