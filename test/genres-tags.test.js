import { test } from "node:test";
import assert from "node:assert/strict";

import { tagsToBuckets } from "../src/genres.js";

test("tagsToBuckets only uses the top 2 Last.fm tags by count", () => {
  // Grupo Frontera-shaped tags: norteño/latin dominate; rnb is a weak third.
  const buckets = tagsToBuckets([
    { name: "Norteno", count: 100 },
    { name: "latin", count: 44 },
    { name: "rnb", count: 29 },
    { name: "mexico", count: 29 },
    { name: "country", count: 4 },
  ]);
  assert.deepEqual(buckets, []);
  assert.ok(!buckets.includes("soul"), "weak rnb must not map to soul");
});

test("tagsToBuckets maps the two strongest mappable tags", () => {
  const buckets = tagsToBuckets([
    { name: "metal", count: 100 },
    { name: "rock", count: 80 },
    { name: "country", count: 40 },
  ]);
  assert.deepEqual(buckets, ["metal", "rock"]);
});

test("tagsToBuckets ignores tags below the popularity floor", () => {
  const buckets = tagsToBuckets([
    { name: "rock", count: 100 },
    { name: "country", count: 4 },
  ]);
  assert.deepEqual(buckets, ["rock"]);
});

test("tagsToBuckets treats pop punk as Punk only and caps at two genres", () => {
  // Yellowcard-shaped: pop punk must not also become Pop via \\bpop\\b.
  const buckets = tagsToBuckets([
    { name: "pop punk", count: 100 },
    { name: "punk rock", count: 97 },
    { name: "rock", count: 51 },
  ]);
  assert.deepEqual(buckets, ["punk", "rock"]);
  assert.ok(!buckets.includes("pop"));
  assert.equal(buckets.length, 2);
});

test("needsGenreFetch re-fetches legacy bucket-only cache rows", async () => {
  // Use an isolated temp cache so we don't touch the live genre-cache.json.
  const prev = process.env.PARTYQUEUE_GENRE_CACHE_FILE;
  const tmp = new URL(`./tmp-genre-cache-${Date.now()}.json`, import.meta.url);
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = fileURLToPath(tmp);
  writeFileSync(
    path,
    JSON.stringify({
      marshmello: { buckets: ["electronic", "hiphop", "pop"], at: 1 },
      "fresh artist": {
        buckets: ["rock"],
        tags: [{ name: "rock", count: 100 }],
        v: 4,
        at: 1,
      },
    })
  );
  process.env.PARTYQUEUE_GENRE_CACHE_FILE = path;
  try {
    // Re-import so CACHE_FILE / in-memory cache pick up the temp path.
    const mod = await import(`../src/genres.js?cacheBust=${Date.now()}`);
    assert.equal(mod.needsGenreFetch("Marshmello"), true);
    assert.equal(mod.needsGenreFetch("Fresh Artist"), false);
    assert.equal(mod.needsGenreFetch("Never Seen"), true);
  } finally {
    if (prev == null) delete process.env.PARTYQUEUE_GENRE_CACHE_FILE;
    else process.env.PARTYQUEUE_GENRE_CACHE_FILE = prev;
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
});
