import { test } from "node:test";
import assert from "node:assert/strict";
import { sameArtistCountdownLabel } from "../public/js/same-artist-countdown-ui.js";

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
