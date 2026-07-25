import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MOOD_PACKS,
  normalizeMood,
  moodPack,
  moodLabel,
  trackFitsMood,
  getMoodCandidates,
  getMoodHits,
  resetMoodCacheForTests,
} from "../src/moods.js";

test("mood pack registry is well-formed", () => {
  assert.ok(MOOD_PACKS.length >= 6);
  const ids = new Set();
  for (const p of MOOD_PACKS) {
    assert.ok(p.id && !ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
    assert.ok(p.label);
    assert.ok(Array.isArray(p.years) && p.years.length === 2);
    assert.ok(p.years[0] <= p.years[1]);
    assert.ok(Array.isArray(p.lastfmTags) && p.lastfmTags.length > 0);
  }
});

test("normalizeMood accepts known ids and rejects everything else", () => {
  assert.equal(normalizeMood("80s"), "80s");
  assert.equal(normalizeMood(" 80S "), "80s");
  assert.equal(normalizeMood("eighties"), null);
  assert.equal(normalizeMood(""), null);
  assert.equal(normalizeMood(null), null);
  assert.equal(normalizeMood(42), null);
  assert.equal(moodLabel("80s"), "80's");
  assert.equal(moodPack("nope"), null);
});

test("trackFitsMood filters by release year and excludes unknown years", () => {
  const pack = moodPack("80s");
  assert.equal(trackFitsMood({ year: 1984 }, pack), true);
  assert.equal(trackFitsMood({ year: 1980 }, pack), true);
  assert.equal(trackFitsMood({ year: 1989 }, pack), true);
  assert.equal(trackFitsMood({ year: 1979 }, pack), false);
  assert.equal(trackFitsMood({ year: 1990 }, pack), false);
  assert.equal(trackFitsMood({}, pack), false);
  assert.equal(trackFitsMood({ year: null }, pack), false);
  // No pack = mood off = everything fits.
  assert.equal(trackFitsMood({ year: 1990 }, null), true);
});

function fakeResolver(catalog) {
  return async (artist, name) => {
    const key = `${artist}|||${name}`.toLowerCase();
    return catalog[key] ?? null;
  };
}

function hit(id, artist, name, extra = {}) {
  return {
    uri: `spotify:track:${id}`,
    id,
    name,
    artist,
    explicit: false,
    ...extra,
  };
}

test("getMoodHits resolves chart candidates with the shared guardrails", async () => {
  const candidates = [
    { artist: "Toto", name: "Africa" },
    { artist: "Toto", name: "Rosanna" },
    { artist: "A-ha", name: "Take On Me" },
    { artist: "Prince", name: "Kiss" },
    { artist: "Queen", name: "I Want It All" },
  ];
  const catalog = {
    "toto|||africa": hit("t1", "Toto", "Africa"),
    "toto|||rosanna": hit("t2", "Toto", "Rosanna"),
    "a-ha|||take on me": hit("t3", "A-ha", "Take On Me"),
    "prince|||kiss": hit("t4", "Prince", "Kiss", { explicit: true }),
    "queen|||i want it all": hit("t5", "Queen", "I Want It All"),
  };
  const out = await getMoodHits(
    {
      mood: "80s",
      count: 4,
      excludeIds: new Set(["t3"]), // already in queue
      filterExplicit: true, // drops Prince
      blockedArtists: new Set(["queen"]), // skip cooldown (primaryArtist-normalized)
      moodArtistCap: 1, // only one Toto
    },
    { tagCandidates: async () => candidates, resolveTrack: fakeResolver(catalog) }
  );
  const ids = out.map((t) => t.id).sort();
  assert.equal(ids.length, 1);
  assert.ok(ids[0] === "t1" || ids[0] === "t2"); // exactly one Toto pick
});

test("getMoodHits respects count and enabled-genre gating", async () => {
  const candidates = [
    { artist: "ArtistA", name: "Song A" },
    { artist: "ArtistB", name: "Song B" },
    { artist: "ArtistC", name: "Song C" },
  ];
  const catalog = {
    "artista|||song a": hit("a", "ArtistA", "Song A"),
    "artistb|||song b": hit("b", "ArtistB", "Song B"),
    "artistc|||song c": hit("c", "ArtistC", "Song C"),
  };
  const buckets = { ArtistA: ["rock"], ArtistB: ["country"], ArtistC: ["rock"] };
  const out = await getMoodHits(
    {
      mood: "90s",
      count: 2,
      excludeIds: [],
      enabledGenres: ["rock"],
      bucketsFor: async (a) => buckets[a] || [],
    },
    { tagCandidates: async () => candidates, resolveTrack: fakeResolver(catalog) }
  );
  assert.equal(out.length, 2);
  assert.ok(out.every((t) => t.artist !== "ArtistB"));
});

test("getMoodHits prefers the set's genre lane over off-lane era hits", async () => {
  const candidates = [
    { artist: "RockA", name: "Song 1" },
    { artist: "CountryB", name: "Song 2" },
    { artist: "RockC", name: "Song 3" },
    { artist: "CountryD", name: "Song 4" },
  ];
  const catalog = {
    "rocka|||song 1": hit("r1", "RockA", "Song 1"),
    "countryb|||song 2": hit("c1", "CountryB", "Song 2"),
    "rockc|||song 3": hit("r2", "RockC", "Song 3"),
    "countryd|||song 4": hit("c2", "CountryD", "Song 4"),
  };
  const buckets = {
    RockA: ["rock"],
    CountryB: ["country"],
    RockC: ["rock"],
    CountryD: ["country"],
  };
  const out = await getMoodHits(
    {
      mood: "90s",
      count: 2,
      excludeIds: [],
      bucketsFor: async (a) => buckets[a] || [],
      preferLane: "rock",
    },
    { tagCandidates: async () => candidates, resolveTrack: fakeResolver(catalog) }
  );
  assert.equal(out.length, 2);
  // Country doesn't neighbor rock — with enough rock hits on the chart the
  // whole batch stays in-lane.
  assert.deepEqual(out.map((t) => t.id).sort(), ["r1", "r2"]);
});

test("getMoodHits tops up with off-lane era hits when the lane runs dry", async () => {
  const candidates = [
    { artist: "RockA", name: "Song 1" },
    { artist: "CountryB", name: "Song 2" },
    { artist: "CountryD", name: "Song 4" },
  ];
  const catalog = {
    "rocka|||song 1": hit("r1", "RockA", "Song 1"),
    "countryb|||song 2": hit("c1", "CountryB", "Song 2"),
    "countryd|||song 4": hit("c2", "CountryD", "Song 4"),
  };
  const buckets = {
    RockA: ["rock"],
    CountryB: ["country"],
    CountryD: ["country"],
  };
  const out = await getMoodHits(
    {
      mood: "90s",
      count: 3,
      excludeIds: [],
      bucketsFor: async (a) => buckets[a] || [],
      preferLane: "rock",
      moodArtistCap: 1,
    },
    { tagCandidates: async () => candidates, resolveTrack: fakeResolver(catalog) }
  );
  // A thin lane must not starve the batch — off-lane era hits fill the rest.
  assert.equal(out.length, 3);
  assert.ok(out.some((t) => t.id === "r1"));
});

test("getMoodHits falls back to era-filtered Spotify search", async () => {
  const pages = {
    0: [
      hit("s1", "Falco", "Rock Me Amadeus", { year: 1985 }),
      hit("s2", "Modern", "Remaster", { year: 2015 }), // out of window
      hit("s3", "Blondie", "Call Me", { year: 1980 }),
    ],
    50: [],
  };
  const out = await getMoodHits(
    { mood: "80s", count: 5, excludeIds: [] },
    {
      tagCandidates: async () => [], // no Last.fm
      searchPage: async (query, { offset }) => {
        assert.equal(query, "year:1980-1989");
        return pages[offset] ?? [];
      },
    }
  );
  const ids = out.map((t) => t.id).sort();
  assert.deepEqual(ids, ["s1", "s3"]);
});

test("getMoodHits returns empty for unknown mood or bad count", async () => {
  assert.deepEqual(await getMoodHits({ mood: "polka", count: 5 }), []);
  assert.deepEqual(
    await getMoodHits(
      { mood: "80s", count: 0 },
      { tagCandidates: async () => [{ artist: "X", name: "Y" }] }
    ),
    []
  );
});

test("getMoodCandidates caches tag charts on disk for 24h", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pq-moods-"));
  const cacheFile = path.join(tmp, "mood-cache.json");
  const prevCacheEnv = process.env.PARTYQUEUE_MOOD_CACHE_FILE;
  const prevKey = process.env.LASTFM_API_KEY;
  process.env.PARTYQUEUE_MOOD_CACHE_FILE = cacheFile;
  process.env.LASTFM_API_KEY = "test-key";
  const realFetch = global.fetch;
  let fetches = 0;
  global.fetch = async (url) => {
    fetches += 1;
    assert.ok(String(url).includes("tag.gettoptracks"));
    return {
      ok: true,
      json: async () => ({
        tracks: {
          track: [
            { artist: { name: "Toto" }, name: "Africa" },
            { artist: { name: "A-ha" }, name: "Take On Me" },
          ],
        },
      }),
    };
  };
  t.after(() => {
    global.fetch = realFetch;
    if (prevCacheEnv === undefined) delete process.env.PARTYQUEUE_MOOD_CACHE_FILE;
    else process.env.PARTYQUEUE_MOOD_CACHE_FILE = prevCacheEnv;
    if (prevKey === undefined) delete process.env.LASTFM_API_KEY;
    else process.env.LASTFM_API_KEY = prevKey;
    resetMoodCacheForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  resetMoodCacheForTests();
  const first = await getMoodCandidates("80s");
  assert.equal(first.length, 2);
  assert.ok(fetches > 0);
  assert.ok(fs.existsSync(cacheFile));

  // Fresh in-memory state must serve from disk without refetching.
  const fetchesAfterFirst = fetches;
  resetMoodCacheForTests();
  const second = await getMoodCandidates("80s");
  assert.equal(second.length, 2);
  assert.equal(fetches, fetchesAfterFirst);

  // Expired entries refetch.
  const raw = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  raw["80s"].at = Date.now() - 25 * 60 * 60_000;
  fs.writeFileSync(cacheFile, JSON.stringify(raw));
  resetMoodCacheForTests();
  const third = await getMoodCandidates("80s");
  assert.equal(third.length, 2);
  assert.ok(fetches > fetchesAfterFirst);
});
