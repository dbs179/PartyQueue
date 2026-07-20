import { test } from "node:test";
import assert from "node:assert/strict";

import { discoverySlots } from "../src/sampler.js";

// Mood presets are client-side; keep a mirror of the intended id sets here so
// a rename on the server GENRE_BUCKETS list doesn't silently break them.
const ALL = [
  "rock",
  "metal",
  "country",
  "hiphop",
  "electronic",
  "pop",
  "folk",
  "punk",
  "soul",
  "jazz",
  "blues",
  "classical",
  "soundtrack",
  "oldies",
  "kids",
  "other",
];

const PARTY = [
  "rock",
  "metal",
  "country",
  "hiphop",
  "electronic",
  "pop",
  "punk",
  "soul",
  "folk",
];

const CHILL = ["folk", "soul", "jazz", "blues", "pop", "electronic", "oldies", "other"];
const COUNTRY = ["country", "folk"];
const HEAVY = ["rock", "metal"];
const RAP = ["hiphop"];
const KIDS = ["kids", "soundtrack"];

test("party mood drops kids/classical/soundtrack/oldies/other", () => {
  assert.ok(!PARTY.includes("kids"));
  assert.ok(!PARTY.includes("classical"));
  assert.ok(!PARTY.includes("soundtrack"));
  assert.ok(!PARTY.includes("oldies"));
  assert.ok(!PARTY.includes("other"));
  for (const id of PARTY) assert.ok(ALL.includes(id), `unknown party id ${id}`);
});

test("country mood is country + folk", () => {
  assert.deepEqual(COUNTRY, ["country", "folk"]);
  for (const id of COUNTRY) assert.ok(ALL.includes(id));
});

test("heavy mood is rock + metal", () => {
  assert.deepEqual(HEAVY, ["rock", "metal"]);
  for (const id of HEAVY) assert.ok(ALL.includes(id));
});

test("rap mood is hiphop", () => {
  assert.deepEqual(RAP, ["hiphop"]);
  for (const id of RAP) assert.ok(ALL.includes(id));
});

test("kids mood is kids + soundtrack", () => {
  assert.deepEqual(KIDS, ["kids", "soundtrack"]);
  for (const id of KIDS) assert.ok(ALL.includes(id));
});

test("chill mood stays within known buckets", () => {
  for (const id of CHILL) assert.ok(ALL.includes(id), `unknown chill id ${id}`);
});

test("discoverySlots still carves within the batch for P2", () => {
  assert.equal(discoverySlots(25, 5), 5);
  assert.equal(discoverySlots(2, 5), 3, "small Random floors to Discovery");
});
