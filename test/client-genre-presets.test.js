import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GENRE_PRESETS,
  DECADE_LABELS,
  sameIdSet,
  presetIdsFor,
  presetNameForIds,
  moodLabelForIds,
  labelForDecade,
  trackEraDisplayLabel,
} from "../public/js/genre-presets.js";
import { GENRE_PRESETS as SERVER_PRESETS } from "../src/genre-presets.js";

test("client GENRE_PRESETS matches server genre-presets.js", () => {
  assert.deepEqual(GENRE_PRESETS, SERVER_PRESETS);
});

test("sameIdSet ignores order", () => {
  assert.equal(sameIdSet(["a", "b"], ["b", "a"]), true);
  assert.equal(sameIdSet(["a"], ["a", "b"]), false);
});

test("presetIdsFor filters to known buckets", () => {
  const all = ["rock", "metal", "pop", "folk"];
  assert.deepEqual(presetIdsFor("heavy", all), ["rock", "metal"]);
  assert.deepEqual(presetIdsFor("all", all), all);
  assert.deepEqual(presetIdsFor("heavy", []), []);
});

test("presetNameForIds and moodLabelForIds recognize Party", () => {
  const all = [
    "rock",
    "metal",
    "country",
    "hiphop",
    "electronic",
    "pop",
    "punk",
    "folk",
  ];
  const party = presetIdsFor("party", all);
  assert.equal(presetNameForIds(party, all), "Party");
  assert.equal(moodLabelForIds(party, all), "Party");
  assert.equal(moodLabelForIds(all, all), "All");
  assert.equal(presetNameForIds(["rock"], all), "Custom");
});

test("decade labels and track era display", () => {
  assert.equal(labelForDecade("80s"), DECADE_LABELS["80s"]);
  assert.equal(labelForDecade("nope"), null);
  assert.equal(
    trackEraDisplayLabel({ mood: "90s" }, "80s"),
    DECADE_LABELS["90s"]
  );
  assert.equal(
    trackEraDisplayLabel({ title: "x" }, "80s"),
    DECADE_LABELS["80s"]
  );
});
