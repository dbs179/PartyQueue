import { test } from "node:test";
import assert from "node:assert/strict";
import {
  queueTrackGenreFields,
  queueTrackFromPlaylist,
} from "../src/sonos.js";
import { trackIdsFromPlaylistPool } from "../src/spotify.js";

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
  assert.deepEqual(
    queueTrackGenreFields("Ariana Grande", null, { bucketsFor: () => [] }),
    {
      genreLane: null,
      genreLabel: null,
      genreLanes: [],
      genreLabels: [],
    }
  );
});

test("queueTrackGenreFields maps untracked origin from artist cache", () => {
  const out = queueTrackGenreFields("Ariana Grande", null, {
    bucketsFor: () => ["pop"],
  });
  assert.deepEqual(out.genreLanes, ["pop"]);
  assert.deepEqual(out.genreLabels, ["Pop"]);
});

test("queueTrackGenreFields keeps only the matched set-lane genre", () => {
  // Amy Ray cache: folk + rock; Folk set should show Folk only (no second genre).
  const out = queueTrackGenreFields("Amy Ray", {
    source: "filler",
    genreLane: "folk",
  });
  assert.deepEqual(out.genreLanes, ["folk"]);
  assert.deepEqual(out.genreLabels, ["Folk"]);
});

test("queueTrackGenreFields keeps set lane when two tags expand to three buckets", () => {
  // Yellowcard: pop punk + punk rock → punk/pop/rock; Rock set must win alone.
  const out = queueTrackGenreFields("Yellowcard", {
    source: "discovered",
    genreLane: "rock",
  });
  assert.deepEqual(out.genreLanes, ["rock"]);
  assert.deepEqual(out.genreLabels, ["Rock"]);
});

test("queueTrackGenreFields maps searched artists from genre cache", () => {
  // Inject buckets — CI has no Last.fm genre cache on disk.
  const out = queueTrackGenreFields(
    "Ariana Grande",
    { source: "searched" },
    { bucketsFor: () => ["pop", "other"] }
  );
  assert.deepEqual(out.genreLanes, ["pop"]);
  assert.deepEqual(out.genreLabels, ["Pop"]);
});

test("queueTrackGenreFields searched with empty cache has no pills", () => {
  const out = queueTrackGenreFields(
    "Anyone Unknown ZzZz",
    { source: "searched" },
    { bucketsFor: () => [] }
  );
  assert.deepEqual(out.genreLanes, []);
  assert.deepEqual(out.genreLabels, []);
});

test("queueTrackFromPlaylist: filler yes, discover/mood no", () => {
  assert.equal(queueTrackFromPlaylist("abc", { source: "filler" }), true);
  assert.equal(queueTrackFromPlaylist("abc", { source: "discovered" }), false);
  assert.equal(queueTrackFromPlaylist("abc", { source: "mood" }), false);
});

test("trackIdsFromPlaylistPool extracts Spotify ids", () => {
  const ids = trackIdsFromPlaylistPool([
    {
      id: "pl1",
      name: "Hits",
      tracks: [
        { uri: "spotify:track:aaa111", name: "A" },
        { uri: "spotify:track:bbb222", name: "B" },
      ],
    },
    {
      id: "pl2",
      name: "More",
      tracks: [{ uri: "x-sonos-spotify:spotify%3atrack%3accc333?sid=9", name: "C" }],
    },
  ]);
  assert.ok(ids.has("aaa111"));
  assert.ok(ids.has("bbb222"));
  assert.ok(ids.has("ccc333"));
  assert.equal(ids.size, 3);
});
