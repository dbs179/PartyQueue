import { test } from "node:test";
import assert from "node:assert/strict";
import { queueTrackGenreFields } from "../src/sonos.js";

test("queueTrackGenreFields falls back to set lane when artist has no cache", () => {
  assert.deepEqual(
    queueTrackGenreFields("Anyone Unknown Zz", {
      source: "filler",
      genreLane: "electronic",
    }),
    {
      genreLane: "electronic",
      genreLabel: "Electronic",
      genreLanes: ["electronic"],
      genreLabels: ["Electronic"],
    }
  );
});

test("queueTrackGenreFields skips DJ clips and unknown origins", () => {
  assert.deepEqual(
    queueTrackGenreFields(
      "Ariana Grande",
      { source: "filler", genreLane: "pop" },
      { djClip: true }
    ),
    {
      genreLane: null,
      genreLabel: null,
      genreLanes: [],
      genreLabels: [],
    }
  );
  assert.deepEqual(queueTrackGenreFields("Ariana Grande", null), {
    genreLane: null,
    genreLabel: null,
    genreLanes: [],
    genreLabels: [],
  });
});

test("queueTrackGenreFields returns both cached buckets with set lane first", () => {
  // Amy Ray cache: folk + rock; Folk set should list Folk before Rock.
  const out = queueTrackGenreFields("Amy Ray", {
    source: "filler",
    genreLane: "folk",
  });
  assert.deepEqual(out.genreLanes, ["folk", "rock"]);
  assert.deepEqual(out.genreLabels, ["Folk", "Rock"]);
});

test("queueTrackGenreFields keeps set lane when two tags expand to three buckets", () => {
  // Yellowcard: pop punk + punk rock → punk/pop/rock; Rock set must lead.
  const out = queueTrackGenreFields("Yellowcard", {
    source: "discovered",
    genreLane: "rock",
  });
  assert.equal(out.genreLanes[0], "rock");
  assert.equal(out.genreLabels[0], "Rock");
  assert.equal(out.genreLanes.length, 2);
  assert.ok(out.genreLanes.includes("rock"));
});

test("queueTrackGenreFields maps searched artists from genre cache", () => {
  const out = queueTrackGenreFields("Ariana Grande", { source: "searched" });
  assert.ok(out.genreLanes.length >= 1);
  assert.ok(out.genreLabels.length >= 1);
  assert.ok(!out.genreLanes.includes("other"));
});
