import { test } from "node:test";
import assert from "node:assert/strict";

import {
  shouldAutofillRefill,
  autofillNextDelayMs,
  clearQueueWithoutAutoRefill,
} from "../src/autofill.js";
import {
  queueWorkGeneration,
  queueWorkWasPreempted,
  resetQueuePreemptForTests,
} from "../src/queue-preempt.js";

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

test("autofillNextDelayMs never burns critical polls while stopped", () => {
  // Overnight state: stopped, empty queue. Refill can't fire here, so hold the
  // gentle idle cadence instead of the old 5s critical loop (~70k calls/night).
  const stoppedEmpty = autofillNextDelayMs({
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
  assert.equal(stoppedEmpty, 60_000);
  assert.equal(idleDeep, 60_000);
});

test("autofillNextDelayMs decays deep stopped queues, capped at 5 minutes", () => {
  const stoppedDeep = { playingFromQueue: false, isPlaying: false, upcoming: 8, total: 10 };
  assert.equal(autofillNextDelayMs(stoppedDeep, 1, 0), 60_000);
  assert.equal(autofillNextDelayMs(stoppedDeep, 1, 1), 120_000);
  assert.equal(autofillNextDelayMs(stoppedDeep, 1, 2), 240_000);
  assert.equal(autofillNextDelayMs(stoppedDeep, 1, 3), 300_000);
  assert.equal(autofillNextDelayMs(stoppedDeep, 1, 50), 300_000);
  // Near-empty stopped queues never decay past the idle cadence: an externally
  // resumed last song must still be caught within a minute.
  const stoppedEmpty = { playingFromQueue: false, isPlaying: false, upcoming: 0, total: 0 };
  assert.equal(autofillNextDelayMs(stoppedEmpty, 1, 50), 60_000);
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

test("Clear preempts active work and does not wait for a refill promise", async () => {
  resetQueuePreemptForTests();
  const generation = queueWorkGeneration();
  const events = [];
  const clearing = await clearQueueWithoutAutoRefill({
    cancelDj: async () => {
      events.push("dj-cancelled");
    },
    clear: async () => {
      events.push("queue-cleared");
      return { ok: true };
    },
  });

  assert.deepEqual(clearing, { ok: true });
  assert.equal(queueWorkWasPreempted(generation), true);
  assert.deepEqual(events, ["dj-cancelled", "queue-cleared"]);
});
