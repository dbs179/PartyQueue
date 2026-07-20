import { test } from "node:test";
import assert from "node:assert/strict";

import {
  primaryArtist,
  mixPlaylistAndDiscovery,
  sampleSongs,
} from "../src/sampler.js";
import {
  artistUnderBudget,
  spendArtistBudget,
} from "../src/similar.js";

test("primaryArtist uses the first comma-separated name", () => {
  assert.equal(primaryArtist("Tyga, Doja Cat"), "tyga");
  assert.equal(primaryArtist("  Tyga  "), "tyga");
  assert.equal(primaryArtist(""), "");
});

test("featured and solo names share one artist budget slot", () => {
  const counts = new Map();
  spendArtistBudget("Tyga, Nicki Minaj", counts);
  assert.equal(artistUnderBudget("Tyga", counts, 1), false);
  assert.equal(artistUnderBudget("Tyga, Doja Cat", counts, 1), false);
  assert.equal(artistUnderBudget("Drake", counts, 1), true);
});

test("sampleSongs caps Tyga featured + solo as one artist", () => {
  const playlists = [
    {
      id: "a",
      name: "A",
      tracks: [
        { uri: "spotify:track:t1", name: "One", artist: "Tyga" },
        { uri: "spotify:track:t2", name: "Two", artist: "Tyga, Someone" },
        { uri: "spotify:track:t3", name: "Three", artist: "Drake" },
      ],
    },
  ];
  // Force many draws; with cap 1 only one Tyga* can appear.
  const uris = sampleSongs(playlists, new Set(), 10, {
    artistCap: 1,
    artistSeedCounts: new Map(),
  });
  const tyga = uris.filter((u) => u === "spotify:track:t1" || u === "spotify:track:t2");
  assert.equal(tyga.length, 1);
  assert.ok(uris.includes("spotify:track:t3"));
});

function mark(items, discovered) {
  return items.map((artist, i) => ({
    id: `${discovered ? "d" : "p"}${i}`,
    artist,
    discovered,
  }));
}

test("mixPlaylistAndDiscovery: more playlist than discovery — no adjacent D", () => {
  const base = mark(["A", "B", "C", "D"], false);
  const extra = mark(["X", "Y"], true);
  const out = mixPlaylistAndDiscovery(base, extra);
  assert.equal(out.length, 6);
  assert.equal(out.filter((x) => x.discovered).length, 2);
  assert.equal(out[0].discovered, false, "must lead with a playlist pick");
  for (let i = 1; i < out.length; i++) {
    assert.ok(
      !(out[i].discovered && out[i - 1].discovered),
      `adjacent discoveries at ${i - 1}/${i}: ${out.map((x) => (x.discovered ? "D" : "P")).join("")}`
    );
  }
});

test("mixPlaylistAndDiscovery: 2 playlist + 3 discovery leads with P", () => {
  const base = mark(["A", "B"], false);
  const extra = mark(["X", "Y", "Z"], true);
  const out = mixPlaylistAndDiscovery(base, extra);
  const pattern = out.map((x) => (x.discovered ? "D" : "P"));
  assert.equal(pattern[0], "P");
  assert.equal(pattern.filter((x) => x === "P").length, 2);
  assert.equal(pattern.filter((x) => x === "D").length, 3);
  // Overflow packs two discoveries after the first playlist pick: P D D P D
  assert.deepEqual(pattern, ["P", "D", "D", "P", "D"]);
});

test("mixPlaylistAndDiscovery: never leads with discovery when playlists exist", () => {
  const base = mark(["A", "B", "C"], false);
  const extra = mark(["X", "Y", "Z"], true);
  for (let n = 0; n < 20; n++) {
    const out = mixPlaylistAndDiscovery(base, extra);
    assert.equal(out[0].discovered, false);
    assert.ok(!out[0].discovered);
  }
});

test("mixPlaylistAndDiscovery: overflow allows adjacent D when unavoidable", () => {
  const base = mark(["A"], false);
  const extra = mark(["X", "Y", "Z"], true);
  const out = mixPlaylistAndDiscovery(base, extra);
  assert.equal(out.length, 4);
  assert.equal(out.filter((x) => x.discovered).length, 3);
  assert.equal(out[0].discovered, false, "still lead with the playlist pick");
  // With 1 playlist there is only 1 post-track gap → adjacent D after lead P.
  let adjacent = 0;
  for (let i = 1; i < out.length; i++) {
    if (out[i].discovered && out[i - 1].discovered) adjacent++;
  }
  assert.ok(adjacent >= 1);
});

test("mixPlaylistAndDiscovery: empty sides", () => {
  assert.deepEqual(mixPlaylistAndDiscovery([], [{ id: "d", discovered: true }]), [
    { id: "d", discovered: true },
  ]);
  assert.deepEqual(mixPlaylistAndDiscovery([{ id: "p" }], []), [{ id: "p" }]);
});
