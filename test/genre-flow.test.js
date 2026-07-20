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
