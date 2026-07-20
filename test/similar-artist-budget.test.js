import { test } from "node:test";
import assert from "node:assert/strict";

import {
  artistUnderBudget,
  spendArtistBudget,
  discoveryFitsLane,
} from "../src/similar.js";

test("artistUnderBudget rejects artists already at the cap", () => {
  const counts = new Map([["ac/dc", 1]]);
  assert.equal(artistUnderBudget("AC/DC", counts, 1), false);
  assert.equal(artistUnderBudget("Other", counts, 1), true);
});

test("artistUnderBudget treats missing/blank artists as allowed", () => {
  assert.equal(artistUnderBudget("", new Map(), 1), true);
  assert.equal(artistUnderBudget(null, new Map(), 1), true);
});

test("spendArtistBudget increments and normalizes the artist key", () => {
  const counts = new Map();
  assert.equal(spendArtistBudget("AC/DC", counts), "ac/dc");
  assert.equal(counts.get("ac/dc"), 1);
  spendArtistBudget("ac/dc", counts);
  assert.equal(counts.get("ac/dc"), 2);
  assert.equal(artistUnderBudget("AC/DC", counts, 2), false);
});

test("discoveryArtistCap is independent of the shared artist budget helper", () => {
  // Shared budget still has room, but the per-batch discovery cap is spent.
  const shared = new Map([["ac/dc", 0]]);
  const disc = new Map([["ac/dc", 1]]);
  assert.equal(artistUnderBudget("AC/DC", shared, 1), true);
  assert.equal(artistUnderBudget("AC/DC", disc, 1), false);
});

test("primary artist collapses featured credits for budget checks", () => {
  const counts = new Map([["tyga", 1]]);
  assert.equal(artistUnderBudget("Tyga, Doja Cat", counts, 1), false);
  assert.equal(spendArtistBudget("Tyga, Nicki", new Map()), "tyga");
});

test("discoveryFitsLane hard-rejects off-lane Songs Like", () => {
  assert.equal(discoveryFitsLane(["metal", "rock"], "metal"), true);
  assert.equal(discoveryFitsLane(["rock"], "metal"), true); // neighbor OK
  assert.equal(discoveryFitsLane(["country"], "metal"), false);
  assert.equal(discoveryFitsLane(["other"], "metal"), false);
  assert.equal(discoveryFitsLane([], "metal"), false);
  assert.equal(discoveryFitsLane(["country"], null), true); // no lane → allow
});
