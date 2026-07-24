import { test } from "node:test";
import assert from "node:assert/strict";

import { discoverySlots } from "../src/sampler.js";
import {
  GENRE_PRESETS,
  ROTATABLE_PRESET_IDS,
  normalizePresetId,
  presetGenres,
  presetIdForGenres,
} from "../src/genre-presets.js";

// The client keeps its own copy of GENRE_PRESETS (public/js/app.js); the
// mirrors here pin the intended id sets so a rename on either side (or on the
// server GENRE_BUCKETS list) doesn't silently break them.
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

test("discoverySlots keeps at least half of each batch from playlists", () => {
  assert.equal(discoverySlots(25, 5), 5);
  assert.equal(discoverySlots(2, 5), 1, "Random 2 splits playlist/discovery");
});

test("server registry matches the pinned preset sets", () => {
  assert.deepEqual(GENRE_PRESETS.party, PARTY);
  assert.deepEqual(GENRE_PRESETS.chill, CHILL);
  assert.deepEqual(GENRE_PRESETS.country, COUNTRY);
  assert.deepEqual(GENRE_PRESETS.heavy, HEAVY);
  assert.deepEqual(GENRE_PRESETS.rap, RAP);
  assert.deepEqual(GENRE_PRESETS.kids, KIDS);
  assert.equal(GENRE_PRESETS.all, null);
  assert.deepEqual(ROTATABLE_PRESET_IDS, [
    "party",
    "chill",
    "country",
    "heavy",
    "rap",
    "kids",
  ]);
});

test("preset helpers normalize, resolve, and reverse-map", () => {
  assert.equal(normalizePresetId("  PARTY "), "party");
  assert.equal(normalizePresetId("disco"), null);
  assert.deepEqual(presetGenres("heavy"), ["rock", "metal"]);
  assert.equal(presetGenres("all"), null, "'all' has no explicit bucket list");
  assert.equal(presetIdForGenres(["metal", "rock"]), "heavy", "order-insensitive");
  assert.equal(presetIdForGenres(["rock"]), null);
  assert.equal(presetIdForGenres(null), null);
});
