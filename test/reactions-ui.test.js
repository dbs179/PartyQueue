import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NP_REACTION_KINDS,
  NP_MOOD_REACTION_KINDS,
  emptyReactionCounts,
  normalizeReactionCounts,
  resolveMyMood,
  isValidReactGuestId,
  createReactGuestId,
  getReactGuestId,
  REACT_GUEST_KEY,
  computeOptimisticReaction,
  createReactionsUi,
} from "../public/js/reactions-ui.js";
import { REACTION_KINDS, MOOD_REACTION_KINDS } from "../src/reactions.js";

test("client reaction kinds match server", () => {
  assert.deepEqual(NP_REACTION_KINDS, REACTION_KINDS);
  assert.deepEqual(NP_MOOD_REACTION_KINDS, MOOD_REACTION_KINDS);
});

test("emptyReactionCounts zeros every kind", () => {
  const counts = emptyReactionCounts();
  assert.equal(Object.keys(counts).length, NP_REACTION_KINDS.length);
  for (const k of NP_REACTION_KINDS) assert.equal(counts[k], 0);
});

test("normalizeReactionCounts clamps and fills", () => {
  assert.deepEqual(normalizeReactionCounts({ fire: 3, up: -2, nope: 9 }).fire, 3);
  assert.equal(normalizeReactionCounts({ fire: 3 }).up, 0);
  assert.equal(normalizeReactionCounts(null).mic, 0);
});

test("resolveMyMood accepts mood kinds only", () => {
  assert.equal(resolveMyMood("fire"), "fire");
  assert.equal(resolveMyMood("mic"), null);
  assert.equal(resolveMyMood(""), null);
  assert.equal(resolveMyMood("clap"), null);
});

test("isValidReactGuestId and createReactGuestId", () => {
  assert.equal(isValidReactGuestId("abcdefgh"), true);
  assert.equal(isValidReactGuestId("short"), false);
  assert.equal(isValidReactGuestId("bad id!!"), false);
  const id = createReactGuestId({ randomUUID: () => "a-b-c-d-e" });
  assert.equal(id, "abcde");
  assert.ok(isValidReactGuestId(createReactGuestId(undefined, () => 1, () => 0.5)));
});

test("getReactGuestId reuses or mints into storage", () => {
  const store = new Map([[REACT_GUEST_KEY, "goodid12"]]);
  const storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  assert.equal(getReactGuestId(storage), "goodid12");

  const empty = {
    getItem: () => "bad",
    setItem: (k, v) => store.set(k, v),
  };
  const minted = getReactGuestId(empty);
  assert.ok(isValidReactGuestId(minted));
  assert.equal(store.get(REACT_GUEST_KEY), minted);
});

test("computeOptimisticReaction toggles mood and mic independently", () => {
  const base = { ...emptyReactionCounts(), fire: 1, mic: 2 };
  const switchMood = computeOptimisticReaction({
    counts: base,
    mine: "fire",
    micMine: true,
    kind: "heart",
  });
  assert.equal(switchMood.mine, "heart");
  assert.equal(switchMood.counts.fire, 0);
  assert.equal(switchMood.counts.heart, 1);
  assert.equal(switchMood.micMine, true);
  assert.equal(switchMood.counts.mic, 2);

  const clearMood = computeOptimisticReaction({
    counts: switchMood.counts,
    mine: "heart",
    micMine: true,
    kind: "heart",
  });
  assert.equal(clearMood.mine, null);
  assert.equal(clearMood.counts.heart, 0);

  const micOff = computeOptimisticReaction({
    counts: base,
    mine: "fire",
    micMine: true,
    kind: "mic",
  });
  assert.equal(micOff.micMine, false);
  assert.equal(micOff.counts.mic, 1);
  assert.equal(micOff.mine, "fire");

  assert.equal(
    computeOptimisticReaction({
      counts: base,
      mine: null,
      micMine: false,
      kind: "clap",
    }),
    null
  );
});

test("noteTrackChange treats a new play of the same track as unsynced", async () => {
  const fetched = [];
  const ui = createReactionsUi(
    {},
    {
      fetch: async (url) => {
        fetched.push(String(url));
        return {
          ok: true,
          json: async () => ({ vomit: 0, mine: null, micMine: false }),
        };
      },
      hostFetch: async () => ({ ok: true, json: async () => ({}) }),
      showToast() {},
      confirmModal: async () => false,
      getNowPlayingId: () => "map1",
      getReactionPlayId: () => "map1:200",
      getNowPlayingMeta: () => ({}),
      ensureDisplayName: async () => "Dave",
      guestBadgeName: () => "Dave",
      getCurrentView: () => "now",
      loadStats() {},
    }
  );

  await ui.syncMyReactions("map1", "map1:100");
  assert.equal(ui.getSyncedFor(), "map1::map1:100");
  ui.noteTrackChange("map1", "map1:200");
  assert.equal(ui.getSyncedFor(), null);
  await ui.syncMyReactions("map1", "map1:200");
  assert.equal(ui.getSyncedFor(), "map1::map1:200");
  assert.ok(fetched.some((url) => url.includes("playId=map1%3A200")));
});
