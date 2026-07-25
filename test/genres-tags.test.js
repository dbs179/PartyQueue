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
  assert.deepEqual(buckets.sort(), ["metal", "rock"]);
});

test("tagsToBuckets ignores tags below the popularity floor", () => {
  const buckets = tagsToBuckets([
    { name: "rock", count: 100 },
    { name: "country", count: 4 },
  ]);
  assert.deepEqual(buckets, ["rock"]);
});
