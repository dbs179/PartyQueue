import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOLIDAY_SONG_MEMORY,
  RANDOMNESS_DEFAULTS,
  songMemoryWindow,
} from "../src/settings.js";

test("holiday moods cap song memory at 30", () => {
  assert.equal(HOLIDAY_SONG_MEMORY, 30);
  assert.equal(
    songMemoryWindow({ songMemory: RANDOMNESS_DEFAULTS.songMemory }, { holiday: true }),
    30
  );
  assert.equal(songMemoryWindow({ songMemory: 500 }, { holiday: true }), 30);
  assert.equal(songMemoryWindow({ songMemory: 80 }, { holiday: true }), 30);
});

test("a shorter host song memory still wins during a holiday", () => {
  assert.equal(songMemoryWindow({ songMemory: 12 }, { holiday: true }), 12);
  assert.equal(songMemoryWindow({ songMemory: 1 }, { holiday: true }), 1);
});

test("ordinary Random keeps the host song memory", () => {
  assert.equal(songMemoryWindow({ songMemory: 500 }), 500);
  assert.equal(songMemoryWindow({ songMemory: 42 }, { holiday: false }), 42);
  assert.equal(songMemoryWindow({}), RANDOMNESS_DEFAULTS.songMemory);
});
