import { test } from "node:test";
import assert from "node:assert/strict";

import {
  laneSource,
  getLaneHits,
  resetLaneCacheForTests,
} from "../src/lane-hits.js";

function hit(id, artist, name) {
  return {
    uri: `spotify:track:${id}`,
    id,
    artist,
    name,
    explicit: false,
  };
}

function fakeResolver(catalog) {
  return async (artist, name) => {
    const key = `${String(artist || "").toLowerCase()}|||${String(name || "").toLowerCase()}`;
    return catalog[key] || null;
  };
}

test("laneSource maps PartyQueue buckets to Last.fm tags", () => {
  assert.ok(laneSource("folk")?.lastfmTags.includes("folk"));
  assert.ok(laneSource("hiphop")?.lastfmTags.some((t) => /hip|rap/i.test(t)));
  assert.equal(laneSource("nope"), null);
});

test("getLaneHits accepts only exact-lane artists", async () => {
  resetLaneCacheForTests();
  const candidates = [
    { artist: "FolkA", name: "Song 1" },
    { artist: "HipB", name: "Song 2" },
    { artist: "FolkC", name: "Song 3" },
  ];
  const catalog = {
    "folka|||song 1": hit("f1", "FolkA", "Song 1"),
    "hipb|||song 2": hit("h1", "HipB", "Song 2"),
    "folkc|||song 3": hit("f2", "FolkC", "Song 3"),
  };
  const buckets = {
    FolkA: ["folk"],
    HipB: ["hiphop"],
    FolkC: ["folk"],
  };
  const out = await getLaneHits(
    {
      lane: "folk",
      count: 3,
      excludeIds: [],
      bucketsFor: async (a) => buckets[a] || [],
    },
    {
      tagCandidates: async () => candidates,
      resolveTrack: fakeResolver(catalog),
      searchPage: async () => [],
    }
  );
  assert.deepEqual(out.map((t) => t.id).sort(), ["f1", "f2"]);
});

test("getLaneHits shortens when exact-lane candidates are exhausted", async () => {
  resetLaneCacheForTests();
  const candidates = [
    { artist: "FolkA", name: "Song 1" },
    { artist: "HipB", name: "Song 2" },
  ];
  const catalog = {
    "folka|||song 1": hit("f1", "FolkA", "Song 1"),
    "hipb|||song 2": hit("h1", "HipB", "Song 2"),
  };
  const out = await getLaneHits(
    {
      lane: "folk",
      count: 5,
      excludeIds: [],
      bucketsFor: async (a) =>
        String(a).startsWith("Folk") ? ["folk"] : ["hiphop"],
    },
    {
      tagCandidates: async () => candidates,
      resolveTrack: fakeResolver(catalog),
      searchPage: async () => [],
    }
  );
  assert.deepEqual(out.map((t) => t.id), ["f1"]);
});

test("getLaneHits honors exclude and library memory ids", async () => {
  resetLaneCacheForTests();
  const candidates = [
    { artist: "FolkA", name: "Song 1" },
    { artist: "FolkC", name: "Song 3" },
  ];
  const catalog = {
    "folka|||song 1": hit("f1", "FolkA", "Song 1"),
    "folkc|||song 3": hit("f2", "FolkC", "Song 3"),
  };
  const out = await getLaneHits(
    {
      lane: "folk",
      count: 2,
      excludeIds: new Set(["f1"]),
      bucketsFor: async () => ["folk"],
    },
    {
      tagCandidates: async () => candidates,
      resolveTrack: fakeResolver(catalog),
      searchPage: async () => [],
    }
  );
  assert.deepEqual(out.map((t) => t.id), ["f2"]);
});

test("getLaneHits stops promptly when abort signal fires", async () => {
  resetLaneCacheForTests();
  const ac = new AbortController();
  let resolves = 0;
  const started = Date.now();
  const out = await getLaneHits(
    {
      lane: "folk",
      count: 5,
      excludeIds: [],
      bucketsFor: async () => ["folk"],
      signal: ac.signal,
    },
    {
      tagCandidates: async () =>
        Array.from({ length: 40 }, (_, i) => ({
          artist: `Folk${i}`,
          name: `Song ${i}`,
        })),
      resolveTrack: async (artist, name) => {
        resolves += 1;
        if (resolves === 2) ac.abort();
        await new Promise((r) => setTimeout(r, 40));
        return hit(`id-${resolves}`, artist, name);
      },
      searchPage: async () => [],
    }
  );
  const elapsed = Date.now() - started;
  assert.ok(out.length <= 3, `expected early stop, got ${out.length}`);
  assert.ok(resolves < 20, `expected few resolves, got ${resolves}`);
  assert.ok(elapsed < 1500, `expected abort under 1.5s, took ${elapsed}ms`);
});
