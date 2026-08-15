import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  noteReactionPlayTrack,
  playIdForTrack,
  currentReactionPlayId,
  resetReactionPlayForTests,
} from "../src/reaction-play.js";

beforeEach(() => {
  resetReactionPlayForTests();
});

test("same track keeps one play id; a different track mints a new one", () => {
  const first = noteReactionPlayTrack("abc", 1000, 12);
  assert.equal(first, "abc:1000");
  assert.equal(noteReactionPlayTrack("abc", 1500, 20), first);
  assert.equal(playIdForTrack("abc"), first);

  const next = noteReactionPlayTrack("xyz", 2000, 3);
  assert.equal(next, "xyz:2000");
  assert.equal(playIdForTrack("abc"), "");
  assert.equal(playIdForTrack("xyz"), next);
  assert.equal(currentReactionPlayId(), next);
});

test("empty and DJ gaps do not reset the live play", () => {
  const play = noteReactionPlayTrack("abc", 1000, 30);
  assert.equal(noteReactionPlayTrack("", 1100), play);
  assert.equal(noteReactionPlayTrack(null, 1200), play);
  assert.equal(playIdForTrack("abc"), play);
});

test("same track after another song is a new play", () => {
  noteReactionPlayTrack("map", 1000, 10);
  noteReactionPlayTrack("other", 2000, 5);
  const again = noteReactionPlayTrack("map", 3000, 2);
  assert.equal(again, "map:3000");
});

test("playhead jump back to the start mints a new play", () => {
  const first = noteReactionPlayTrack("map", 1000, 45);
  assert.equal(noteReactionPlayTrack("map", 2000, 50), first);
  const replay = noteReactionPlayTrack("map", 3000, 2);
  assert.equal(replay, "map:3000");
  assert.notEqual(replay, first);
});
