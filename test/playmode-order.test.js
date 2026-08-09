import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isShufflePlayMode,
  orderedPlayMode,
} from "../src/sonos-queue-policy.js";
import { ensureOrderedPlayModeOn } from "../src/sonos-transport.js";

test("isShufflePlayMode detects Sonos shuffle enums", () => {
  assert.equal(isShufflePlayMode("NORMAL"), false);
  assert.equal(isShufflePlayMode("REPEAT_ALL"), false);
  assert.equal(isShufflePlayMode("REPEAT_ONE"), false);
  assert.equal(isShufflePlayMode("SHUFFLE"), true);
  assert.equal(isShufflePlayMode("SHUFFLE_NOREPEAT"), true);
  assert.equal(isShufflePlayMode("SHUFFLE_REPEAT_ONE"), true);
});

test("orderedPlayMode strips shuffle and keeps repeat", () => {
  assert.equal(orderedPlayMode("SHUFFLE"), "REPEAT_ALL");
  assert.equal(orderedPlayMode("SHUFFLE_NOREPEAT"), "NORMAL");
  assert.equal(orderedPlayMode("SHUFFLE_REPEAT_ONE"), "REPEAT_ONE");
  assert.equal(orderedPlayMode("NORMAL"), "NORMAL");
  assert.equal(orderedPlayMode("REPEAT_ALL"), "REPEAT_ALL");
  assert.equal(orderedPlayMode("REPEAT_ONE"), "REPEAT_ONE");
});

test("ensureOrderedPlayModeOn clears Shuffle and preserves repeat", async () => {
  const calls = [];
  const coordinator = {
    AVTransportService: {
      async GetTransportSettings() {
        return { PlayMode: "SHUFFLE" };
      },
      async SetPlayMode({ NewPlayMode }) {
        calls.push(NewPlayMode);
      },
    },
  };
  const out = await ensureOrderedPlayModeOn(coordinator);
  assert.equal(out.changed, true);
  assert.equal(out.shuffle, false);
  assert.equal(out.playMode, "REPEAT_ALL");
  assert.deepEqual(calls, ["REPEAT_ALL"]);
});

test("ensureOrderedPlayModeOn is a no-op when already ordered", async () => {
  let setCalls = 0;
  const coordinator = {
    AVTransportService: {
      async GetTransportSettings() {
        return { PlayMode: "REPEAT_ONE" };
      },
      async SetPlayMode() {
        setCalls += 1;
      },
    },
  };
  const out = await ensureOrderedPlayModeOn(coordinator);
  assert.equal(out.changed, false);
  assert.equal(out.playMode, "REPEAT_ONE");
  assert.equal(setCalls, 0);
});
