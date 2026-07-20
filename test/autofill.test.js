import { test } from "node:test";
import assert from "node:assert/strict";

import {
  shouldAutofillRefill,
  autofillNextDelayMs,
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
