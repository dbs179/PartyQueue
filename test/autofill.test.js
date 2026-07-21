import { test } from "node:test";
import assert from "node:assert/strict";

import {
  shouldAutofillRefill,
  autofillNextDelayMs,
  clearQueueWithoutAutoRefill,
} from "../src/autofill.js";

test("shouldAutofillRefill while playing near the end", () => {
  assert.equal(
    shouldAutofillRefill({
      playingFromQueue: true,
      isPlaying: true,
      upcoming: 1,
      total: 5,
    }),
    true
  );
  assert.equal(
    shouldAutofillRefill({
      playingFromQueue: true,
      isPlaying: true,
      upcoming: 0,
      total: 1,
    }),
    true
  );
});

test("shouldAutofillRefill does not revive after Stop (even on the queue)", () => {
  assert.equal(
    shouldAutofillRefill({
      playingFromQueue: true,
      isPlaying: false,
      upcoming: 0,
      total: 1,
    }),
    false
  );
  assert.equal(
    shouldAutofillRefill({
      playingFromQueue: true,
      isPlaying: false,
      upcoming: 1,
      total: 3,
    }),
    false
  );
});

test("shouldAutofillRefill never seeds empty queue after Clear or boot", () => {
  assert.equal(
    shouldAutofillRefill({
      playingFromQueue: false,
      isPlaying: false,
      upcoming: 0,
      total: 0,
    }),
    false
  );
  // Clear Queue often leaves CurrentURI on x-rincon-queue with total=0.
  assert.equal(
    shouldAutofillRefill({
      playingFromQueue: true,
      isPlaying: false,
      upcoming: 0,
      total: 0,
    }),
    false
  );
  assert.equal(
    shouldAutofillRefill({
      playingFromQueue: true,
      isPlaying: true,
      upcoming: 0,
      total: 0,
    }),
    false
  );
  // Stale pre-Clear snapshot shape (playing + low upcoming) must still not
  // refill once total is known empty — pairs with getQueueStatus cache bust.
  assert.equal(
    shouldAutofillRefill({
      playingFromQueue: true,
      isPlaying: true,
      upcoming: 1,
      total: 0,
    }),
    false
  );
});

test("shouldAutofillRefill skips deep queues and external sources with leftovers", () => {
  assert.equal(
    shouldAutofillRefill({
      playingFromQueue: true,
      isPlaying: true,
      upcoming: 5,
      total: 10,
    }),
    false
  );
  assert.equal(
    shouldAutofillRefill({
      playingFromQueue: false,
      isPlaying: true,
      upcoming: 4,
      total: 4,
    }),
    false
  );
});

test("autofillNextDelayMs uses critical cadence when idle near-empty", () => {
  const critical = autofillNextDelayMs({
    playingFromQueue: true,
    isPlaying: false,
    upcoming: 0,
    total: 1,
  });
  const idleDeep = autofillNextDelayMs({
    playingFromQueue: true,
    isPlaying: false,
    upcoming: 8,
    total: 10,
  });
  assert.equal(critical, 5_000);
  assert.equal(idleDeep, 60_000);
});

test("autofillNextDelayMs tightens while playing near the end", () => {
  const near = autofillNextDelayMs({
    playingFromQueue: true,
    isPlaying: true,
    upcoming: 1,
    total: 4,
  });
  const deep = autofillNextDelayMs({
    playingFromQueue: true,
    isPlaying: true,
    upcoming: 8,
    total: 12,
  });
  assert.equal(near, 5_000);
  assert.ok(deep > near);
});

test("Clear waits for an active refill, then clears last", async () => {
  let finishRefill;
  const events = [];
  const pendingTick = new Promise((resolve) => {
    finishRefill = () => {
      events.push("refill-finished");
      resolve();
    };
  });

  const clearing = clearQueueWithoutAutoRefill({
    pendingTick,
    clear: async () => {
      events.push("queue-cleared");
      return { ok: true };
    },
  });

  await Promise.resolve();
  assert.deepEqual(events, [], "Clear must wait while autofill is active");

  finishRefill();
  assert.deepEqual(await clearing, { ok: true });
  assert.deepEqual(events, ["refill-finished", "queue-cleared"]);
});
