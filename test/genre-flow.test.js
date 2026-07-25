import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BUCKET_NEIGHBORS,
  compatibleWith,
  bucketsCompatible,
  fitsLane,
  fitsNeighbor,
  bridgeFitsBoth,
  bridgeSlotCount,
  dominantBucket,
  pickSetLane,
  genreFlowScore,
} from "../src/genre-flow.js";
import { sampleSongs, spotifyTrackId } from "../src/sampler.js";

test("compat matrix: metal sits with rock/punk, not country", () => {
  assert.ok(compatibleWith("metal").has("rock"));
  assert.ok(compatibleWith("metal").has("punk"));
  assert.ok(!compatibleWith("metal").has("country"));
  assert.equal(bucketsCompatible(["metal"], ["country"]), false);
  assert.equal(bucketsCompatible(["metal"], ["rock"]), true);
  assert.equal(bucketsCompatible(["other"], ["country"]), true);
});

test("fitsLane / fitsNeighbor soft checks", () => {
  assert.equal(fitsLane(["metal", "rock"], "metal"), true);
  assert.equal(fitsLane(["country"], "metal"), false);
  assert.equal(fitsLane([], "metal"), true); // unknown → don't block
  assert.equal(fitsNeighbor(["punk"], ["metal"]), true);
  assert.equal(fitsNeighbor(["country"], ["metal"]), false);
});

test("bridge prefers overlap between previous and next lane", () => {
  assert.equal(bridgeFitsBoth(["rock"], "metal", "pop"), true); // rock near both
  assert.equal(bridgeFitsBoth(["classical"], "metal", "country"), false);
  assert.equal(bridgeSlotCount(1), 0);
  assert.equal(bridgeSlotCount(3), 1);
  assert.equal(bridgeSlotCount(5), 2);
  assert.equal(bridgeSlotCount(10), 2);
});

test("pickSetLane rotates away from previous and recent", () => {
  const a = pickSetLane({
    enabled: ["rock", "country", "hiphop"],
    previousLane: "rock",
    recentLanes: ["rock"],
    salt: 0,
  });
  assert.notEqual(a, "rock");
  assert.ok(["country", "hiphop"].includes(a));

  const only = pickSetLane({
    enabled: ["country"],
    previousLane: "country",
    salt: 3,
  });
  assert.equal(only, "country");
});

test("dominantBucket prefers specific lanes", () => {
  assert.equal(dominantBucket(["rock", "metal"]), "metal");
  assert.equal(dominantBucket(["pop", "country"], new Set(["country", "folk"])), "country");
});

test("genreFlowScore ranks on-lane higher than clash", () => {
  const flow = {
    lane: "metal",
    previousLane: "country",
    bridgeLeft: 0,
    lastBuckets: new Set(["metal"]),
  };
  const on = genreFlowScore(["metal"], flow);
  const off = genreFlowScore(["country"], flow);
  assert.ok(on > off, `expected on-lane ${on} > off-lane ${off}`);
});

test("genreFlowScore ranks exact lane above a neighbor", () => {
  const flow = {
    lane: "metal",
    previousLane: null,
    bridgeLeft: 0,
    lastBuckets: new Set(),
  };
  const exact = genreFlowScore(["metal"], flow);
  const neighbor = genreFlowScore(["rock"], flow); // rock neighbors metal
  const clash = genreFlowScore(["country"], flow);
  assert.ok(exact > neighbor, `expected exact ${exact} > neighbor ${neighbor}`);
  assert.ok(neighbor > clash, `expected neighbor ${neighbor} > clash ${clash}`);
});

test("pickSetLane skips lanes the pool can't serve", () => {
  // hiphop enabled but the filtered pool has no hiphop tracks — the rotation
  // must not land there just to "shift genres".
  const poolCounts = new Map([
    ["rock", 12],
    ["pop", 8],
    ["hiphop", 0],
  ]);
  for (let salt = 0; salt < 6; salt++) {
    const lane = pickSetLane({
      enabled: ["rock", "pop", "hiphop"],
      previousLane: "rock",
      recentLanes: ["rock"],
      salt,
      poolCounts,
      minPerLane: 3,
    });
    assert.notEqual(lane, "hiphop", `salt ${salt} rotated into an empty lane`);
  }
});

test("pickSetLane keeps the full rotation when no lane meets the minimum", () => {
  // Thin era-filtered library living off chart top-ups: don't pin one lane.
  const poolCounts = new Map([
    ["rock", 1],
    ["pop", 1],
  ]);
  const lane = pickSetLane({
    enabled: ["rock", "pop", "hiphop"],
    previousLane: "rock",
    recentLanes: ["rock"],
    salt: 0,
    poolCounts,
    minPerLane: 3,
  });
  assert.ok(["pop", "hiphop"].includes(lane));
});

test("sampleSongs picks exact-lane tracks before neighbor-lane tracks", () => {
  // Rock neighbors metal, so both "fit" the lane — but with enough metal in
  // the pool, a metal set should actually be metal.
  const playlists = [
    {
      id: "m",
      name: "metal",
      tracks: Array.from({ length: 8 }, (_, i) => ({
        uri: `spotify:track:metal${i}`,
        name: `M${i}`,
        artist: `MetalAct${i}`,
      })),
    },
    {
      id: "r",
      name: "rock",
      tracks: Array.from({ length: 8 }, (_, i) => ({
        uri: `spotify:track:rock${i}`,
        name: `R${i}`,
        artist: `RockAct${i}`,
      })),
    },
  ];
  const bucketsFor = (artist) => {
    const a = String(artist || "").toLowerCase();
    if (a.startsWith("metal")) return ["metal"];
    if (a.startsWith("rock")) return ["rock"];
    return ["other"];
  };
  const flowState = {
    lane: "metal",
    previousLane: null,
    bridgeLeft: 0,
    lastBuckets: new Set(),
  };
  const picks = sampleSongs(playlists, new Set(), 5, {
    bucketsFor,
    flowState,
  });
  assert.equal(picks.length, 5);
  const metalCount = picks.filter((u) =>
    String(spotifyTrackId(u) || "").startsWith("metal")
  ).length;
  assert.equal(
    metalCount,
    5,
    `expected an all-metal set, got ${metalCount}/5: ${picks.join(",")}`
  );
});

test("sampleSongs with flowState soft-prefers the set lane", () => {
  // One playlist of metal, one of country — lane=metal should usually win.
  const playlists = [
    {
      id: "m",
      name: "metal",
      tracks: Array.from({ length: 8 }, (_, i) => ({
        uri: `spotify:track:metal${i}`,
        name: `M${i}`,
        artist: `MetalAct${i}`,
      })),
    },
    {
      id: "c",
      name: "country",
      tracks: Array.from({ length: 8 }, (_, i) => ({
        uri: `spotify:track:country${i}`,
        name: `C${i}`,
        artist: `CountryAct${i}`,
      })),
    },
  ];
  const bucketsFor = (artist) => {
    const a = String(artist || "").toLowerCase();
    if (a.startsWith("metal")) return ["metal"];
    if (a.startsWith("country")) return ["country"];
    return ["other"];
  };
  const flowState = {
    lane: "metal",
    previousLane: null,
    bridgeLeft: 0,
    lastBuckets: new Set(),
  };
  const picks = sampleSongs(playlists, new Set(), 5, {
    bucketsFor,
    flowState,
  });
  assert.equal(picks.length, 5);
  const metalCount = picks.filter((u) =>
    String(spotifyTrackId(u) || "").startsWith("metal")
  ).length;
  assert.ok(
    metalCount >= 4,
    `expected mostly metal picks, got ${metalCount}/5: ${picks.join(",")}`
  );
});

test("BUCKET_NEIGHBORS covers every GENRE bucket id used as a key", () => {
  for (const id of Object.keys(BUCKET_NEIGHBORS)) {
    assert.ok(Array.isArray(BUCKET_NEIGHBORS[id]));
  }
});
