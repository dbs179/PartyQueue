import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), `pq-reaction-sets-${process.pid}-`)
);
process.env.PARTYQUEUE_REACTIONS_FILE = path.join(tmpRoot, "reactions.json");
process.env.PARTYQUEUE_REACTION_SET_MEMORY_FILE = path.join(
  tmpRoot,
  "reaction-set-memory.json"
);

const {
  setReaction,
  clearReactions,
} = await import("../src/reactions.js");
const {
  REACTION_SET_THRESHOLD,
  eligibleReactionSetTracks,
  pickReactionSetTracks,
  noteReactionSetPlayed,
  clearReactionSetMemory,
  reactionSetDue,
  noteReactionSetBuilt,
  getSetsSinceLovedReactionSet,
  getSetsSinceHatedReactionSet,
  resetReactionSetCountersForTests,
  resetReactionSetMemoryForTests,
} = await import("../src/reaction-sets.js");

function seedLiked(id, count, name = "Song", artist = "Artist") {
  for (let i = 0; i < count; i++) {
    const kind = i % 3 === 0 ? "heart" : i % 3 === 1 ? "fire" : "up";
    const guestId = `liked${id}${String(i).padStart(4, "0")}`;
    setReaction(id, kind, guestId, { by: `Guest ${i}`, name, artist });
  }
}

function seedHated(id, count, name = "Bomb", artist = "Band") {
  for (let i = 0; i < count; i++) {
    const kind = i % 2 === 0 ? "down" : "vomit";
    const guestId = `hate${id}${String(i).padStart(4, "0")}`;
    setReaction(id, kind, guestId, { by: `Hater ${i}`, name, artist });
  }
}

beforeEach(() => {
  clearReactions();
  resetReactionSetMemoryForTests();
  resetReactionSetCountersForTests();
});

afterEach(() => {
  clearReactions();
  resetReactionSetMemoryForTests();
  resetReactionSetCountersForTests();
});

test("eligible requires threshold 10; night-played excluded", () => {
  seedLiked("low", 9, "Low", "A");
  seedLiked("ok", 10, "Ok", "B");
  seedLiked("hot", 50, "Hot", "C");
  const elig = eligibleReactionSetTracks("loved");
  assert.deepEqual(
    elig.map((t) => t.id).sort(),
    ["hot", "ok"]
  );
  assert.equal(REACTION_SET_THRESHOLD, 10);

  noteReactionSetPlayed("loved", ["ok"]);
  assert.deepEqual(
    eligibleReactionSetTracks("loved").map((t) => t.id),
    ["hot"]
  );
  clearReactionSetMemory();
  assert.equal(eligibleReactionSetTracks("loved").length, 2);
});

test("pick is uniform among eligible — not sorted by count", () => {
  // Deterministic RNG that always takes the last remaining index when shuffled
  // in a way we can assert both tracks appear across seeded picks.
  seedLiked("ten", 10, "Ten", "A");
  seedLiked("fifty", 50, "Fifty", "B");
  seedLiked("eleven", 11, "Eleven", "C");
  seedLiked("twelve", 12, "Twelve", "D");
  seedLiked("thirteen", 13, "Thirteen", "E");

  let calls = 0;
  const random = () => {
    // Cycle through a few values so shuffle is not identity.
    const seq = [0.1, 0.9, 0.3, 0.7, 0.5];
    const v = seq[calls % seq.length];
    calls += 1;
    return v;
  };
  const picked = pickReactionSetTracks("loved", 5, { random });
  assert.equal(picked.length, 5);
  const ids = picked.map((t) => t.id);
  assert.ok(ids.includes("ten"), "10-count track must be eligible to pick");
  assert.ok(ids.includes("fifty"), "50-count track must be eligible to pick");
  // Not sorted by descending count.
  assert.notDeepEqual(
    ids,
    ["fifty", "thirteen", "twelve", "eleven", "ten"]
  );
});

test("loved and hated every-N counters are independent", () => {
  const settings = {
    lovedReactionSetEnabled: true,
    lovedReactionSetEveryN: 6,
    hatedReactionSetEnabled: true,
    hatedReactionSetEveryN: 6,
  };
  assert.equal(reactionSetDue("loved", settings, 5), false);
  assert.equal(reactionSetDue("loved", settings, 6), true);
  assert.equal(reactionSetDue("hated", settings, 5), false);

  // Playing loved resets loved and increments hated.
  for (let i = 0; i < 6; i++) noteReactionSetBuilt({ kind: null });
  assert.equal(getSetsSinceLovedReactionSet(), 6);
  assert.equal(getSetsSinceHatedReactionSet(), 6);
  noteReactionSetBuilt({ kind: "loved" });
  assert.equal(getSetsSinceLovedReactionSet(), 0);
  assert.equal(getSetsSinceHatedReactionSet(), 7);
  assert.equal(
    reactionSetDue("hated", settings, getSetsSinceHatedReactionSet()),
    true
  );
  assert.equal(
    reactionSetDue("loved", settings, getSetsSinceLovedReactionSet()),
    false
  );
});

test("hated pool uses down/vomit kinds", () => {
  seedHated("bomb1", 10, "Bomb1", "X");
  seedHated("bomb2", 10, "Bomb2", "Y");
  seedLiked("love1", 10, "Love1", "Z");
  assert.equal(eligibleReactionSetTracks("hated").length, 2);
  assert.ok(
    !eligibleReactionSetTracks("hated").some((t) => t.id === "love1")
  );
});
