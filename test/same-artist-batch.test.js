import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listPoolArtists,
  filterPlaylistsByPrimaryArtist,
  pickShowcaseArtistFromPlaylists,
  sameArtistPoolReady,
  noteRandomSetBuilt,
  getSetsSinceLastSameArtistBatch,
  resetSameArtistBatchCountersForTests,
  sameArtistSetsUntil,
} from "../src/same-artist-batch.js";
import { allowSameArtistBatch } from "../src/sampler.js";

test("listPoolArtists aggregates primary artists", () => {
  const artists = listPoolArtists([
    {
      tracks: [
        { artist: "Prince" },
        { artist: "Prince, Sheila E." },
        { artist: "The Weeknd" },
      ],
    },
  ]);
  assert.equal(artists.length, 2);
  const prince = artists.find((a) => a.key === "prince");
  assert.ok(prince);
  assert.equal(prince.trackCount, 2);
});

test("filterPlaylistsByPrimaryArtist keeps one artist", () => {
  const filtered = filterPlaylistsByPrimaryArtist(
    [
      {
        id: "p1",
        tracks: [
          { artist: "Prince", name: "A" },
          { artist: "Madonna", name: "B" },
        ],
      },
    ],
    "prince"
  );
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].tracks.length, 1);
  assert.equal(filtered[0].tracks[0].name, "A");
});

test("pickShowcaseArtistFromPlaylists prefers artists with enough tracks", () => {
  const playlists = [
    {
      tracks: [
        { artist: "A" },
        { artist: "B" },
        { artist: "B" },
        { artist: "B" },
      ],
    },
  ];
  const picked = pickShowcaseArtistFromPlaylists(playlists, {
    minTracks: 3,
    random: () => 0,
  });
  assert.equal(picked.key, "b");
  assert.equal(picked.trackCount, 3);
});

test("counter advances for normal sets and resets on showcase", () => {
  resetSameArtistBatchCountersForTests();
  noteRandomSetBuilt({ wasShowcase: false });
  noteRandomSetBuilt({ wasShowcase: false });
  assert.equal(getSetsSinceLastSameArtistBatch(), 2);
  assert.equal(
    allowSameArtistBatch(
      { sameArtistBatchEnabled: true, sameArtistBatchEveryN: 2 },
      getSetsSinceLastSameArtistBatch()
    ),
    true
  );
  noteRandomSetBuilt({ wasShowcase: true });
  assert.equal(getSetsSinceLastSameArtistBatch(), 0);
});

test("sameArtistPoolReady needs an artist with enough tracks", () => {
  assert.equal(
    sameArtistPoolReady(
      [{ id: "p", tracks: [{ artist: "Solo", name: "One" }] }],
      { minTracks: 3 }
    ),
    false
  );
  assert.equal(
    sameArtistPoolReady(
      [
        {
          id: "p",
          tracks: [
            { artist: "Foo", name: "A" },
            { artist: "Foo", name: "B" },
            { artist: "Foo", name: "C" },
          ],
        },
      ],
      { minTracks: 3 }
    ),
    true
  );
});

test("sameArtistSetsUntil counts remaining sets and hides when off", () => {
  assert.equal(sameArtistSetsUntil({ enabled: false, everyN: 8, setsSince: 3 }), null);
  assert.equal(sameArtistSetsUntil({ enabled: true, everyN: 8, setsSince: 0 }), 8);
  assert.equal(sameArtistSetsUntil({ enabled: true, everyN: 8, setsSince: 7 }), 1);
  assert.equal(sameArtistSetsUntil({ enabled: true, everyN: 8, setsSince: 8 }), 0);
  assert.equal(sameArtistSetsUntil({ enabled: true, everyN: 5, setsSince: 9 }), 0);
});
