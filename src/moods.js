// Era "Moods" for Random / Never-Ending.
//
// A mood (e.g. "80s") narrows playlist picks to a release-year window and,
// when the host's playlists can't fill a batch, tops the batch up with era
// hits from OUTSIDE the library: Last.fm tag charts ("80s" etc.) resolved to
// real Spotify tracks via findTrackUri, or era-filtered Spotify search when
// no Last.fm key is configured. Like Discover, everything is best-effort and
// never throws — a thin source just yields fewer top-ups.
//
// Tag-chart candidates are cached on disk (data/mood-pool-cache.json, 24h) so
// steady-state refills cost near-zero Last.fm calls. Honors
// PARTYQUEUE_MOOD_CACHE_FILE for tests.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import { findTrackUri, searchTracksPage } from "./spotify.js";
import { getLastfmApiKey } from "./lastfm.js";
import {
  shuffled,
  primaryArtist,
  artistUnderBudget,
  spendArtistBudget,
} from "./sampler.js";
import { isClosingTime } from "./closing-time.js";
import { fitsExactLane } from "./genre-flow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One pack per decade. `lastfmTags` seed the external hit charts; `years` is
// the release window used to filter the host's own playlist tracks (and the
// Spotify search fallback). Registry is data-only so themed packs (yacht rock,
// one-hit wonders, ...) can be added later without touching the pipeline.
export const MOOD_PACKS = [
  { id: "60s", label: "60's", years: [1960, 1969], lastfmTags: ["60s", "1960s"] },
  { id: "70s", label: "70's", years: [1970, 1979], lastfmTags: ["70s", "1970s"] },
  { id: "80s", label: "80's", years: [1980, 1989], lastfmTags: ["80s", "1980s"] },
  { id: "90s", label: "90's", years: [1990, 1999], lastfmTags: ["90s", "1990s"] },
  { id: "2000s", label: "2000's", years: [2000, 2009], lastfmTags: ["2000s", "00s"] },
  { id: "2010s", label: "2010's", years: [2010, 2019], lastfmTags: ["2010s", "10s"] },
  // Current decade: open-ended in spirit; 2029 upper bound keeps the shape
  // uniform and naturally includes everything released so far.
  { id: "2020s", label: "2020's", years: [2020, 2029], lastfmTags: ["2020s"] },
];

const PACKS_BY_ID = new Map(MOOD_PACKS.map((p) => [p.id, p]));

/** Normalize any client value to a known mood id, or null (= mood off). */
export function normalizeMood(value) {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return PACKS_BY_ID.has(id) ? id : null;
}

/** The pack for a mood id (accepts unnormalized input), or null. */
export function moodPack(value) {
  const id = normalizeMood(value);
  return id ? PACKS_BY_ID.get(id) : null;
}

export function moodLabel(value) {
  return moodPack(value)?.label || null;
}

/**
 * Pure: whether a pool track belongs to the mood's era. Tracks without a
 * release year (pre-v2 pool cache) are excluded — the pool format bump
 * rewarms them with years, and the external top-up covers any gap meanwhile.
 */
export function trackFitsMood(track, pack) {
  if (!pack) return true;
  const y = Number(track?.year);
  return Number.isFinite(y) && y >= pack.years[0] && y <= pack.years[1];
}

// ---------------------------------------------------------------------------
// Candidate cache: per-mood [{ artist, name }] chart entries, 24h on disk.

const CACHE_FILE = () =>
  process.env.PARTYQUEUE_MOOD_CACHE_FILE ||
  path.join(__dirname, "..", "data", "mood-pool-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60_000;
const MAX_CANDIDATES = 300;

let cache = null; // { [moodId]: { at: number, candidates: [{artist,name}] } }

function loadCache() {
  if (cache) return;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE(), "utf8"));
    cache = raw && typeof raw === "object" ? raw : {};
  } catch {
    cache = {};
  }
}

function persistCache() {
  try {
    writeFileAtomic(CACHE_FILE(), JSON.stringify(cache));
  } catch (err) {
    console.error("[moods] cache save failed:", err.message);
  }
}

/** Test hook: drop the in-memory cache so the next call re-reads disk. */
export function resetMoodCacheForTests() {
  cache = null;
}

const LASTFM_URL = "https://ws.audioscrobbler.com/2.0/";
const REQ_GAP_MS = 250; // same throttle as Discover
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lastfmTagTopTracks(tag, page = 1) {
  const params = new URLSearchParams({
    method: "tag.gettoptracks",
    tag,
    limit: "100",
    page: String(page),
    api_key: getLastfmApiKey(),
    format: "json",
  });
  const res = await fetch(`${LASTFM_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const j = await res.json().catch(() => null);
  return (j?.tracks?.track ?? [])
    .map((t) => ({ artist: t.artist?.name ?? "", name: t.name ?? "" }))
    .filter((t) => t.artist && t.name);
}

async function fetchTagCandidates(pack) {
  const seen = new Set();
  const out = [];
  for (const tag of pack.lastfmTags) {
    for (let page = 1; page <= 2; page++) {
      if (out.length >= MAX_CANDIDATES) break;
      await sleep(REQ_GAP_MS);
      let rows = [];
      try {
        rows = await lastfmTagTopTracks(tag, page);
      } catch {
        rows = [];
      }
      if (!rows.length) break; // tag exhausted / unavailable — next tag
      for (const r of rows) {
        const key = `${r.artist.toLowerCase()}|||${r.name.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
        if (out.length >= MAX_CANDIDATES) break;
      }
    }
  }
  return out;
}

/**
 * Chart candidates ({ artist, name }) for a mood, from the 24h disk cache or
 * fresh from Last.fm. Returns [] without a Last.fm key or on failure.
 */
export async function getMoodCandidates(moodId, { force = false } = {}) {
  const pack = moodPack(moodId);
  if (!pack || !getLastfmApiKey()) return [];
  loadCache();
  const hit = cache[pack.id];
  if (
    !force &&
    hit &&
    Date.now() - (Number(hit.at) || 0) < CACHE_TTL_MS &&
    Array.isArray(hit.candidates) &&
    hit.candidates.length
  ) {
    return hit.candidates;
  }
  const candidates = await fetchTagCandidates(pack);
  if (candidates.length) {
    cache[pack.id] = { at: Date.now(), candidates };
    persistCache();
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Era hits: resolve candidates to playable Spotify tracks with the same
// guardrails as Discover.

// Cap Spotify lookups per refill so a mood top-up can't 429 guest search.
const MAX_RESOLVE_CALLS = 20;
// Fallback search pages to sample when Last.fm is unavailable.
const FALLBACK_OFFSETS = [0, 50, 100, 150];

/**
 * Up to `count` era hits ({ uri, id, name, artist }) for the mood, outside
 * `excludeIds`. Applies explicit filter, Closing Time guard, skip-cooldown
 * blocked artists, the shared Random artist budget, an in-batch per-artist
 * cap, and (when `enabledGenres`+`bucketsFor` are given) the host's genre
 * filter. When `preferLane` is set, only exact-lane hits are accepted —
 * neighbors and off-lane era charts are skipped so the decade set stays on
 * Genre. `deps` allows tests to inject sources.
 */
export async function getMoodHits(
  {
    mood,
    count,
    excludeIds,
    filterExplicit = false,
    artistCap = Infinity,
    artistSeedCounts = null,
    blockedArtists = null,
    lastArtist = null,
    moodArtistCap = 1,
    enabledGenres = null,
    bucketsFor = null,
    preferLane = null,
  },
  deps = {}
) {
  const pack = moodPack(mood);
  if (!pack || !Number.isFinite(count) || count <= 0) return [];

  const resolveTrack = deps.resolveTrack || findTrackUri;
  const searchPage = deps.searchPage || searchTracksPage;
  const tagCandidates = deps.tagCandidates || getMoodCandidates;

  const enabled =
    Array.isArray(enabledGenres) && enabledGenres.length
      ? new Set(enabledGenres)
      : null;
  const exclude =
    excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
  const blocked =
    blockedArtists instanceof Set
      ? blockedArtists
      : blockedArtists
        ? new Set(blockedArtists)
        : null;
  const artistCount = new Map();
  if (artistSeedCounts) {
    for (const [artist, n] of artistSeedCounts) {
      const a = primaryArtist(artist);
      if (!a) continue;
      const countN = Number(n) || 0;
      if (countN <= 0) continue;
      artistCount.set(a, (artistCount.get(a) ?? 0) + countN);
    }
  }
  const perBatchCap =
    Number.isFinite(moodArtistCap) && moodArtistCap > 0
      ? moodArtistCap
      : Infinity;
  const batchArtistCount = new Map();
  const chosen = [];
  const chosenIds = new Set();
  let prevArtist = lastArtist ? primaryArtist(lastArtist) : null;

  const bucketCache = new Map();
  const bucketsOf = async (artist) => {
    const a = (artist || "").split(",")[0].trim();
    if (!a || typeof bucketsFor !== "function") return [];
    if (bucketCache.has(a)) return bucketCache.get(a);
    let buckets = [];
    try {
      buckets = (await bucketsFor(a)) || [];
    } catch {
      buckets = [];
    }
    if (!buckets.length) buckets = ["other"];
    bucketCache.set(a, buckets);
    return buckets;
  };

  const passesGenres = (buckets) => {
    if (!enabled) return true;
    if (!buckets.length) return true; // no bucket source → don't block
    return buckets.some((b) => enabled.has(b));
  };

  const accept = (found) => {
    chosen.push({
      uri: found.uri,
      id: found.id,
      name: found.name,
      artist: found.artist,
    });
    chosenIds.add(found.id);
    const spent = spendArtistBudget(found.artist, artistCount);
    spendArtistBudget(found.artist, batchArtistCount);
    if (spent) prevArtist = spent;
  };

  const acceptable = (found) => {
    if (!found?.uri || !found.id) return false;
    if (filterExplicit && found.explicit) return false;
    if (isClosingTime(found.name, found.artist, found.uri)) return false;
    if (exclude.has(found.id) || chosenIds.has(found.id)) return false;
    const artist = primaryArtist(found.artist);
    if (blocked && artist && blocked.has(artist)) return false;
    if (prevArtist && artist === prevArtist && chosen.length + 1 >= count) {
      // Soft back-to-back avoidance only matters for the final slot; earlier
      // picks get shuffled through the batch mix anyway.
      return false;
    }
    if (!artistUnderBudget(found.artist, artistCount, artistCap)) return false;
    if (!artistUnderBudget(found.artist, batchArtistCount, perBatchCap)) return false;
    return true;
  };

  const passesLane = (buckets) => {
    if (!preferLane) return true;
    return fitsExactLane(buckets, preferLane);
  };

  try {
    const candidates = await tagCandidates(pack.id);
    if (candidates.length) {
      // Last.fm chart path: crowd-tagged era hits, resolved via Spotify search.
      // Tag membership is the era evidence — no hard year check (remaster
      // re-release dates would wrongly reject classics). Exact-lane filtering
      // rejects many resolves, so scan a bit further when a lane is set.
      const maxResolveCalls = preferLane
        ? MAX_RESOLVE_CALLS + 10
        : MAX_RESOLVE_CALLS;
      let resolveCalls = 0;
      for (const c of shuffled(candidates)) {
        if (chosen.length >= count) break;
        if (resolveCalls >= maxResolveCalls) break;
        resolveCalls += 1;
        const found = await resolveTrack(c.artist, c.name);
        if (!found || !acceptable(found)) continue;
        const buckets = await bucketsOf(found.artist);
        if (!passesGenres(buckets)) continue;
        if (!passesLane(buckets)) continue;
        accept(found);
      }
      return chosen;
    }

    // Fallback: era-filtered Spotify search (works without a Last.fm key).
    // Results carry release years, so keep the strict window here.
    const query = `year:${pack.years[0]}-${pack.years[1]}`;
    for (const offset of FALLBACK_OFFSETS) {
      if (chosen.length >= count) break;
      let items = [];
      try {
        items = await searchPage(query, { limit: 50, offset });
      } catch (err) {
        console.error("[moods] fallback search failed:", err.message);
        break;
      }
      if (!items.length) break;
      for (const found of shuffled(items)) {
        if (chosen.length >= count) break;
        if (!trackFitsMood(found, pack)) continue;
        if (!acceptable(found)) continue;
        const buckets = await bucketsOf(found.artist);
        if (!passesGenres(buckets)) continue;
        if (!passesLane(buckets)) continue;
        accept(found);
      }
    }
  } catch (err) {
    console.error("[moods] era hits failed:", err.message);
  }
  return chosen;
}
