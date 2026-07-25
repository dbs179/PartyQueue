// Exact-lane Spotify top-ups for Random / Never-Ending.
//
// When the host's playlists (and Discover / era slots) can't fill a set for the
// active genre lane, pull Last.fm tag-chart hits for that lane, resolve them on
// Spotify, and accept only artists whose genre buckets exact-match the lane.
// Never pads with off-lane tracks — a thin outside pool just shortens the batch.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import { findTrackUri, searchTracksPage } from "./spotify.js";
import { getLastfmApiKey } from "./lastfm.js";
import { fitsExactLane } from "./genre-flow.js";
import {
  shuffled,
  primaryArtist,
  artistUnderBudget,
  spendArtistBudget,
} from "./sampler.js";
import { isClosingTime } from "./closing-time.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Last.fm tags + Spotify search terms per PartyQueue genre bucket. */
export const LANE_SOURCES = {
  rock: { lastfmTags: ["rock", "classic rock"], searchTerms: ["rock"] },
  metal: { lastfmTags: ["metal", "heavy metal"], searchTerms: ["metal"] },
  country: { lastfmTags: ["country"], searchTerms: ["country"] },
  hiphop: { lastfmTags: ["hip-hop", "rap", "hip hop"], searchTerms: ["hip hop", "rap"] },
  electronic: {
    lastfmTags: ["electronic", "edm", "house"],
    searchTerms: ["electronic", "edm"],
  },
  pop: { lastfmTags: ["pop", "pop rock"], searchTerms: ["pop"] },
  folk: { lastfmTags: ["folk", "indie folk"], searchTerms: ["folk"] },
  punk: { lastfmTags: ["punk", "punk rock"], searchTerms: ["punk"] },
  soul: {
    lastfmTags: ["soul", "funk", "rnb", "r&b"],
    searchTerms: ["soul", "funk", "r&b"],
  },
  jazz: { lastfmTags: ["jazz"], searchTerms: ["jazz"] },
  blues: { lastfmTags: ["blues"], searchTerms: ["blues"] },
  classical: { lastfmTags: ["classical"], searchTerms: ["classical"] },
  soundtrack: {
    lastfmTags: ["soundtrack", "score"],
    searchTerms: ["soundtrack"],
  },
  oldies: {
    lastfmTags: ["oldies", "classic rock"],
    searchTerms: ["oldies"],
  },
  kids: { lastfmTags: ["children's music", "kids"], searchTerms: ["kids"] },
};

const CACHE_FILE = () =>
  process.env.PARTYQUEUE_LANE_CACHE_FILE ||
  path.join(__dirname, "..", "data", "lane-pool-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60_000;
const MAX_CANDIDATES = 300;
const MAX_RESOLVE_CALLS = 24;
const FALLBACK_OFFSETS = [0, 50, 100];
const LASTFM_URL = "https://ws.audioscrobbler.com/2.0/";
const REQ_GAP_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cache = null;

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
    console.error("[lane-hits] cache save failed:", err.message);
  }
}

/** Test hook: drop the in-memory cache so the next call re-reads disk. */
export function resetLaneCacheForTests() {
  cache = null;
}

export function laneSource(lane) {
  const id = String(lane || "").trim().toLowerCase();
  return id && LANE_SOURCES[id] ? { id, ...LANE_SOURCES[id] } : null;
}

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

async function fetchTagCandidates(source) {
  const seen = new Set();
  const out = [];
  for (const tag of source.lastfmTags) {
    for (let page = 1; page <= 2; page++) {
      if (out.length >= MAX_CANDIDATES) break;
      await sleep(REQ_GAP_MS);
      let rows = [];
      try {
        rows = await lastfmTagTopTracks(tag, page);
      } catch {
        rows = [];
      }
      if (!rows.length) break;
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

export async function getLaneCandidates(lane, { force = false } = {}) {
  const source = laneSource(lane);
  if (!source || !getLastfmApiKey()) return [];
  loadCache();
  const hit = cache[source.id];
  if (
    !force &&
    hit &&
    Date.now() - (Number(hit.at) || 0) < CACHE_TTL_MS &&
    Array.isArray(hit.candidates) &&
    hit.candidates.length
  ) {
    return hit.candidates;
  }
  const candidates = await fetchTagCandidates(source);
  if (candidates.length) {
    cache[source.id] = { at: Date.now(), candidates };
    persistCache();
  }
  return candidates;
}

/**
 * Up to `count` exact-lane hits ({ uri, id, name, artist }) outside excludeIds.
 * Verifies buckets via bucketsFor after Spotify resolve. `deps` for tests.
 */
export async function getLaneHits(
  {
    lane,
    count,
    excludeIds,
    filterExplicit = false,
    artistCap = Infinity,
    artistSeedCounts = null,
    blockedArtists = null,
    lastArtist = null,
    laneArtistCap = 1,
    enabledGenres = null,
    bucketsFor = null,
  },
  deps = {}
) {
  const source = laneSource(lane);
  if (!source || !Number.isFinite(count) || count <= 0) return [];

  const resolveTrack = deps.resolveTrack || findTrackUri;
  const searchPage = deps.searchPage || searchTracksPage;
  const tagCandidates = deps.tagCandidates || getLaneCandidates;

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
    Number.isFinite(laneArtistCap) && laneArtistCap > 0
      ? laneArtistCap
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

  const passesFilters = (buckets) => {
    if (!fitsExactLane(buckets, source.id)) return false;
    if (enabled && !buckets.some((b) => enabled.has(b))) return false;
    return true;
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
      return false;
    }
    if (!artistUnderBudget(found.artist, artistCount, artistCap)) return false;
    if (!artistUnderBudget(found.artist, batchArtistCount, perBatchCap)) {
      return false;
    }
    return true;
  };

  try {
    const candidates = await tagCandidates(source.id);
    if (candidates.length) {
      let resolveCalls = 0;
      for (const c of shuffled(candidates)) {
        if (chosen.length >= count) break;
        if (resolveCalls >= MAX_RESOLVE_CALLS) break;
        resolveCalls += 1;
        const found = await resolveTrack(c.artist, c.name);
        if (!found || !acceptable(found)) continue;
        const buckets = await bucketsOf(found.artist);
        if (!passesFilters(buckets)) continue;
        accept(found);
      }
      if (chosen.length >= count) return chosen;
    }

    // Fallback: Spotify search by lane terms when Last.fm is thin / unavailable.
    for (const term of source.searchTerms) {
      if (chosen.length >= count) break;
      for (const offset of FALLBACK_OFFSETS) {
        if (chosen.length >= count) break;
        let items = [];
        try {
          items = await searchPage(`genre:${term}`, { limit: 50, offset });
          if (!items.length) {
            items = await searchPage(term, { limit: 50, offset });
          }
        } catch (err) {
          console.error("[lane-hits] fallback search failed:", err.message);
          break;
        }
        if (!items.length) break;
        for (const found of shuffled(items)) {
          if (chosen.length >= count) break;
          if (!acceptable(found)) continue;
          const buckets = await bucketsOf(found.artist);
          if (!passesFilters(buckets)) continue;
          accept(found);
        }
      }
    }
  } catch (err) {
    console.error("[lane-hits] lane hits failed:", err.message);
  }
  return chosen;
}
