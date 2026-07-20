import { test } from "node:test";
import assert from "node:assert/strict";

import {
  spotifyTrackId,
  sampleSongs,
  pickWithRelaxation,
  discoverySlots,
  discoveryPlan,
  sharesMood,
} from "../src/sampler.js";

// Build a playlist pool from a compact spec: { name: [[id, artist], ...] }.
function pool(spec) {
  return Object.entries(spec).map(([name, tracks]) => ({
    id: name,
    name,
    tracks: tracks.map(([id, artist]) => ({
      uri: `spotify:track:${id}`,
      name: id,
      artist,
    })),
  }));
}

function distinctArtistPool(playlistCount, perPlaylist) {
  const spec = {};
  for (let p = 0; p < playlistCount; p++) {
    spec[`pl${p}`] = Array.from({ length: perPlaylist }, (_, i) => [
      `p${p}s${i}`,
      `artist${p}_${i}`,
    ]);
  }
  return pool(spec);
}

const idsOf = (uris) => uris.map(spotifyTrackId);
const artistOf = (uri, lookup) => lookup.get(uri);

function artistLookup(playlists) {
  const m = new Map();
  for (const pl of playlists) {
    for (const t of pl.tracks) m.set(t.uri, t.artist);
  }
  return m;
}

test("returns the requested count with no repeats", () => {
  const playlists = distinctArtistPool(3, 10);
  const picks = sampleSongs(playlists, new Set(), 5);
  assert.equal(picks.length, 5);
  assert.equal(new Set(idsOf(picks)).size, 5, "all picks are unique");
});

test("never returns an excluded (recently played / queued) track", () => {
  const playlists = distinctArtistPool(2, 10);
  const exclude = new Set(["p0s0", "p0s1", "p1s5"]);
  const picks = sampleSongs(playlists, exclude, 10);
  for (const id of idsOf(picks)) {
    assert.ok(!exclude.has(id), `excluded id ${id} leaked into picks`);
  }
});

test("returns short rather than repeating when the pool is exhausted", () => {
  const playlists = pool({ tiny: [["a", "A"], ["b", "B"]] });
  const picks = sampleSongs(playlists, new Set(), 5);
  assert.equal(picks.length, 2);
});

test("artist cap limits how often one artist appears in a batch", () => {
  const playlists = pool({
    rock: Array.from({ length: 10 }, (_, i) => [`acdc${i}`, "AC/DC"]),
    mix: Array.from({ length: 10 }, (_, i) => [`mix${i}`, `Artist ${i}`]),
  });
  const lookup = artistLookup(playlists);
  const picks = sampleSongs(playlists, new Set(), 12, { artistCap: 2 });
  const acdc = picks.filter((u) => artistOf(u, lookup) === "AC/DC").length;
  assert.ok(acdc <= 2, `AC/DC appeared ${acdc} times, cap was 2`);
});

test("artist seed counts count against the cap", () => {
  const playlists = pool({
    rock: Array.from({ length: 10 }, (_, i) => [`acdc${i}`, "AC/DC"]),
    mix: Array.from({ length: 10 }, (_, i) => [`mix${i}`, `Artist ${i}`]),
  });
  const lookup = artistLookup(playlists);
  // AC/DC has already played its 2 of 2 in the recent window -> never pick it.
  const seed = new Map([["ac/dc", 2]]);
  const picks = sampleSongs(playlists, new Set(), 8, {
    artistCap: 2,
    artistSeedCounts: seed,
  });
  const acdc = picks.filter((u) => artistOf(u, lookup) === "AC/DC").length;
  assert.equal(acdc, 0, "an already-maxed artist should be skipped entirely");
});

test("preferUnheard soft-biases toward tracks not in memory", () => {
  // One playlist: half "heard", half fresh. With preferUnheard, all picks should
  // come from the fresh half when we only ask for that many.
  const playlists = pool({
    pl: [
      ["heard0", "A0"],
      ["heard1", "A1"],
      ["fresh0", "B0"],
      ["fresh1", "B1"],
      ["fresh2", "B2"],
    ],
  });
  const heard = new Set(["heard0", "heard1"]);
  const picks = sampleSongs(playlists, new Set(), 3, { preferUnheard: heard });
  assert.equal(picks.length, 3);
  for (const id of idsOf(picks)) {
    assert.ok(!heard.has(id), `heard id ${id} should lose to unheard tracks`);
  }
});

test("relaxation: recent-song memory is dropped only when needed to fill", () => {
  const playlists = distinctArtistPool(2, 5); // 10 songs total
  const everySong = new Set(
    playlists.flatMap((pl) => pl.tracks.map((t) => spotifyTrackId(t.uri)))
  );
  // baseExclude empty, but recent memory covers EVERY song -> passes 1 & 2 are
  // empty, pass 3 relaxes recent memory and fills from the pool.
  const result = pickWithRelaxation(
    playlists,
    new Set(),
    6,
    everySong,
    new Map(),
    { artistCap: 3 }
  );
  assert.equal(result.uris.length, 6);
  assert.equal(result.relaxedMemory, true);
  assert.equal(result.memoryReuseCount, 6);
});

test("strict fill: never drops song memory just to fill a short batch", () => {
  const playlists = distinctArtistPool(2, 5); // 10 songs total
  const everySong = new Set(
    playlists.flatMap((pl) => pl.tracks.map((t) => spotifyTrackId(t.uri)))
  );
  const result = pickWithRelaxation(
    playlists,
    new Set(),
    6,
    everySong,
    new Map(),
    { artistCap: 3, strictFill: true }
  );
  assert.equal(result.uris.length, 0, "strict mode must not re-add remembered songs");
  assert.equal(result.relaxedMemory, false);
});

test("strict fill: still returns fresh songs when memory is only partial", () => {
  const playlists = distinctArtistPool(2, 5); // 10 songs
  const recent = new Set(["p0s0", "p0s1", "p1s0"]);
  const result = pickWithRelaxation(
    playlists,
    new Set(),
    6,
    recent,
    new Map(),
    { artistCap: 10, strictFill: true }
  );
  assert.equal(result.uris.length, 6);
  for (const id of idsOf(result.uris)) {
    assert.ok(!recent.has(id), `remembered id ${id} leaked under strict fill`);
  }
});

test("relaxation: artist cap is dropped before falling short", () => {
  // Only one artist available; cap would limit to 2, but we want 5.
  const playlists = pool({
    solo: Array.from({ length: 10 }, (_, i) => [`s${i}`, "Solo"]),
  });
  const result = pickWithRelaxation(playlists, new Set(), 5, new Set(), new Map(), {
    artistCap: 2,
  });
  assert.equal(result.uris.length, 5, "should relax the cap to fill the request");
  assert.equal(result.relaxedArtist, true);
});

test("baseExclude (live queue) is always honored, even through relaxation", () => {
  const playlists = distinctArtistPool(1, 4);
  const baseExclude = new Set(["p0s0", "p0s1"]);
  const result = pickWithRelaxation(
    playlists,
    baseExclude,
    10,
    new Set(),
    new Map(),
    { artistCap: 3 }
  );
  for (const id of idsOf(result.uris)) {
    assert.ok(!baseExclude.has(id), `live-queue id ${id} should never be re-added`);
  }
  assert.equal(result.uris.length, 2, "only the two non-queued songs remain");
});

test("discoveryPlan: large Random carves Discovery out of the batch", () => {
  assert.deepEqual(discoveryPlan(25, 5), {
    playlistWant: 20,
    similarWant: 5,
    totalTarget: 25,
  });
  assert.deepEqual(discoveryPlan(25, 0), {
    playlistWant: 25,
    similarWant: 0,
    totalTarget: 25,
  });
  assert.equal(discoverySlots(25, 5), 5);
});

test("discoveryPlan: small Random keeps at least half from playlists", () => {
  // Random 2 always means one playlist + one discovery when Discover is on.
  assert.deepEqual(discoveryPlan(2, 5), {
    playlistWant: 1,
    similarWant: 1,
    totalTarget: 2,
  });
  assert.deepEqual(discoveryPlan(3, 5), {
    playlistWant: 2,
    similarWant: 1,
    totalTarget: 3,
  });
  assert.deepEqual(discoveryPlan(0, 5), {
    playlistWant: 0,
    similarWant: 0,
    totalTarget: 0,
  });
  assert.equal(discoverySlots(2, 5), 1);
});

test("sharesMood is true when any genre bucket overlaps", () => {
  const bucketsFor = (artist) =>
    artist === "Rock Band" ? ["rock", "punk"] : ["jazz"];
  assert.equal(
    sharesMood({ artist: "Rock Band" }, new Set(["rock"]), bucketsFor),
    true
  );
  assert.equal(
    sharesMood({ artist: "Jazz Cat" }, new Set(["rock"]), bucketsFor),
    false
  );
});

test("blockedArtists are never picked", () => {
  const playlists = pool({
    rock: [
      ["a", "Blocked"],
      ["b", "Blocked"],
      ["c", "Ok"],
      ["d", "Ok"],
    ],
  });
  const picks = sampleSongs(playlists, new Set(), 4, {
    blockedArtists: new Set(["blocked"]),
  });
  assert.equal(picks.length, 2);
  for (const id of idsOf(picks)) {
    assert.ok(id === "c" || id === "d");
  }
});

test("mood continuity soft-prefers matching genre buckets", () => {
  // One playlist: mood-matching tracks and off-mood tracks. With recentBuckets
  // = rock, all picks should come from the rock artists when we only ask for 2.
  const playlists = pool({
    pl: [
      ["r0", "Rock A"],
      ["r1", "Rock B"],
      ["j0", "Jazz A"],
      ["j1", "Jazz B"],
    ],
  });
  const bucketsFor = (artist) =>
    /^Rock/.test(artist) ? ["rock"] : ["jazz"];
  const picks = sampleSongs(playlists, new Set(), 2, {
    recentBuckets: new Set(["rock"]),
    bucketsFor,
  });
  assert.equal(picks.length, 2);
  for (const id of idsOf(picks)) {
    assert.ok(id.startsWith("r"), `expected rock pick, got ${id}`);
  }
});
