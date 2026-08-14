import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resetReactionSetCountersForTests,
  noteReactionSetBuilt,
} from "../src/reaction-sets.js";
import {
  resetSameArtistBatchCountersForTests,
  noteRandomSetBuilt,
} from "../src/same-artist-batch.js";
import {
  listSpecialSetCandidates,
  pickNextSpecialSet,
  resetSpecialSetReservationForTests,
} from "../src/special-set-next.js";

const settingsAllOn = {
  endlessQueueCount: 5,
  lovedReactionSetEnabled: true,
  lovedReactionSetEveryN: 6,
  hatedReactionSetEnabled: true,
  hatedReactionSetEveryN: 6,
  sameArtistBatchEnabled: true,
  sameArtistBatchEveryN: 8,
};

const allReady = { loved: true, hated: true, sameArtist: true };

beforeEach(() => {
  resetReactionSetCountersForTests();
  resetSameArtistBatchCountersForTests();
  resetSpecialSetReservationForTests();
});

test("hides Loved/Hated when the pool is too small", () => {
  const rows = listSpecialSetCandidates({
    settings: settingsAllOn,
    setSize: 5,
    playlists: [],
    poolReady: { loved: false, hated: false, sameArtist: false },
  });
  const loved = rows.find((r) => r.kind === "loved");
  assert.equal(loved.enabled, true);
  assert.equal(loved.poolReady, false);
  assert.equal(loved.eligible, false);
});

test("hides a flavor when its toggle is off", () => {
  const rows = listSpecialSetCandidates({
    settings: { ...settingsAllOn, lovedReactionSetEnabled: false },
    setSize: 5,
    playlists: [],
    poolReady: allReady,
  });
  assert.equal(rows.find((r) => r.kind === "loved").eligible, false);
  assert.equal(rows.find((r) => r.kind === "hated").eligible, true);
});

test("picks the soonest eligible flavor", () => {
  for (let i = 0; i < 6; i++) noteReactionSetBuilt({ kind: null });
  const next = pickNextSpecialSet({
    settings: settingsAllOn,
    setSize: 5,
    playlists: [],
    poolReady: { loved: true, hated: true, sameArtist: false },
    random: () => 0,
  });
  assert.ok(next.kind === "loved" || next.kind === "hated");
  assert.equal(next.setsUntil, 0);
});

test("when all three are due and fillable, a random pick sticks", () => {
  for (let i = 0; i < 8; i++) {
    noteReactionSetBuilt({ kind: null });
    noteRandomSetBuilt({ wasShowcase: false });
  }
  const first = pickNextSpecialSet({
    settings: settingsAllOn,
    setSize: 5,
    playlists: [],
    poolReady: allReady,
    random: () => 0.99,
  });
  assert.equal(first.kind, "sameArtist");
  const second = pickNextSpecialSet({
    settings: settingsAllOn,
    setSize: 5,
    playlists: [],
    poolReady: allReady,
    random: () => 0,
  });
  assert.equal(second.kind, "sameArtist", "reservation must survive a new roll");
});

test("same-artist is ineligible without a ready pool", () => {
  const rows = listSpecialSetCandidates({
    settings: settingsAllOn,
    setSize: 5,
    playlists: [],
    poolReady: { loved: false, hated: false, sameArtist: false },
  });
  assert.equal(rows.find((r) => r.kind === "sameArtist").eligible, false);
});
