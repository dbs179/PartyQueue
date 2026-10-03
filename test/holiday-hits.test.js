import { test } from "node:test";
import assert from "node:assert/strict";
import { getHolidayHits } from "../src/holiday-hits.js";

const OCT = new Date(2026, 9, 2, 12);

test("dry library fill uses Spotify search and keeps holiday matches", async () => {
  const calls = [];
  const hits = await getHolidayHits(
    {
      holiday: "halloween",
      count: 2,
      excludeIds: new Set(),
      now: OCT,
    },
    {
      tagCandidates: async () => [],
      searchPage: async (query) => {
        calls.push(query);
        if (query !== "halloween") return [];
        return [
          {
            uri: "spotify:track:mash",
            id: "mash",
            name: "Monster Mash",
            artist: "Bobby Pickett",
            album: "Halloween Hits",
            explicit: false,
          },
          {
            uri: "spotify:track:ordinary",
            id: "ordinary",
            name: "Since U Been Gone",
            artist: "Kelly Clarkson",
            album: "Breakaway",
            explicit: false,
          },
          {
            uri: "spotify:track:thrill",
            id: "thrill",
            name: "Thriller",
            artist: "Michael Jackson",
            album: "Thriller",
            explicit: false,
          },
        ];
      },
    }
  );
  assert.deepEqual(
    hits.map((h) => h.id).sort(),
    ["mash", "thrill"]
  );
  assert.ok(calls.includes("halloween"));
});

test("Last.fm chart adds songs the title matcher would skip", async () => {
  const searches = [];
  const hits = await getHolidayHits(
    {
      holiday: "halloween",
      count: 2,
      excludeIds: new Set(),
      now: OCT,
    },
    {
      tagCandidates: async () => [{ artist: "The Cramps", name: "Goo Goo Muck" }],
      resolveTrack: async (artist, name) => ({
        uri: "spotify:track:goo",
        id: "goo",
        name,
        artist,
        album: "Songs the Lord Taught Us",
        explicit: false,
      }),
      searchPage: async (query) => {
        searches.push(query);
        if (query !== "halloween") return [];
        return [
          {
            uri: "spotify:track:pop",
            id: "pop",
            name: "Since U Been Gone",
            artist: "Kelly Clarkson",
            album: "Breakaway",
            explicit: false,
          },
          {
            uri: "spotify:track:thrill",
            id: "thrill",
            name: "Thriller",
            artist: "Michael Jackson",
            album: "Thriller",
            explicit: false,
          },
        ];
      },
    }
  );
  assert.deepEqual(hits.map((h) => h.id).sort(), ["goo", "thrill"]);
  assert.ok(searches.includes("halloween"));
});

test("unknown holiday yields nothing", async () => {
  assert.deepEqual(
    await getHolidayHits(
      { holiday: "polka", count: 3, now: OCT },
      {
        tagCandidates: async () => [],
        searchPage: async () => [{ uri: "spotify:track:x", id: "x", name: "Monster Mash", artist: "A" }],
      }
    ),
    []
  );
});
