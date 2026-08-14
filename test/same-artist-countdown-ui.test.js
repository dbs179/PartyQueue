import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sameArtistCountdownLabel,
  specialSetCountdownLabel,
} from "../public/js/same-artist-countdown-ui.js";

test("sameArtistCountdownLabel hides when disabled", () => {
  assert.equal(sameArtistCountdownLabel(null), "");
  assert.equal(sameArtistCountdownLabel({ enabled: false, setsUntil: 3 }), "");
});

test("sameArtistCountdownLabel uses the PC bar copy", () => {
  assert.equal(
    sameArtistCountdownLabel({ enabled: true, setsUntil: 8 }),
    "Same Artist Set In : 8 sets"
  );
  assert.equal(
    sameArtistCountdownLabel({ enabled: true, setsUntil: 1 }),
    "Same Artist Set In : 1 set"
  );
  assert.equal(
    sameArtistCountdownLabel({ enabled: true, setsUntil: 0 }),
    "Same Artist Set In : next set"
  );
});

test("specialSetCountdownLabel names Loved, Hated, and Requested", () => {
  assert.equal(
    specialSetCountdownLabel({ kind: "loved", setsUntil: 3 }),
    "Most Loved Set In : 3 sets"
  );
  assert.equal(
    specialSetCountdownLabel({ kind: "hated", setsUntil: 1 }),
    "Most Hated Set In : 1 set"
  );
  assert.equal(
    specialSetCountdownLabel({ kind: "requested", setsUntil: 5 }),
    "Most Requested Set In : 5 sets"
  );
  assert.equal(specialSetCountdownLabel({ kind: "loved" }), "");
});
