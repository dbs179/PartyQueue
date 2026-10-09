// Holiday fill for Random / Never-Ending when the library runs short.
//
// Last.fm tag charts (tag.getTopTracks) are the same source Decades and genre
// lanes already use. A holiday tag names the songs people tag for that
// holiday, including ones whose titles never say "Halloween". Those resolve
// to Spotify tracks and skip the title matcher. Spotify search is the
// fallback and still requires a title or album match, so a search for
// "halloween" cannot drag in unrelated hits.

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
import {
  holidayPack,
  isOutOfSeasonHolidayTrack,
  isSoundEffectTrack,
  trackMatchesHoliday,
} from "./holidays.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CACHE_FILE = () =>
  process.env.PARTYQUEUE_HOLIDAY_CACHE_FILE ||
  path.join(__dirname, "..", "data", "holiday-pool-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60_000;
const MAX_CANDIDATES = 100;
const MAX_RESOLVE_CALLS = 24;
const PAGE_OFFSETS = [0, 50, 100];
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
    console.error("[holiday] cache save failed:", err.message);
  }
}

/** Test hook: drop the in-memory cache so the next call re-reads disk. */
export function resetHolidayCacheForTests() {
  cache = null;
}

async function lastfmTagTopTracks(tag, page = 1, signal = null) {
  const params = new URLSearchParams({
    method: "tag.gettoptracks",
    tag,
    limit: "50",
    page: String(page),
    api_key: getLastfmApiKey(),
    format: "json",
  });
  const timeout = AbortSignal.timeout(8000);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const res = await fetch(`${LASTFM_URL}?${params.toString()}`, {
    signal: combined,
  });
  if (!res.ok) return [];
  const j = await res.json().catch(() => null);
  return (j?.tracks?.track ?? [])
    .map((t) => ({ artist: t.artist?.name ?? "", name: t.name ?? "" }))
    .filter((t) => t.artist && t.name);
}

async function fetchTagCandidates(pack, signal = null) {
  const seen = new Set();
  const out = [];
  for (const tag of pack.lastfmTags || []) {
    if (signal?.aborted) break;
    for (let page = 1; page <= 2; page++) {
      if (signal?.aborted || out.length >= MAX_CANDIDATES) break;
      await sleep(REQ_GAP_MS);
      let rows = [];
      try {
        rows = await lastfmTagTopTracks(tag, page, signal);
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

/**
 * Chart rows ({ artist, name }) for a holiday, from the 24h disk cache or
 * fresh from Last.fm. [] when the pack has no tag, no API key, or Last.fm fails.
 */
export async function getHolidayCandidates(
  holidayId,
  { force = false, signal = null } = {}
) {
  const pack = holidayPack(holidayId);
  if (!pack?.lastfmTags?.length || !getLastfmApiKey()) return [];
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
  if (signal?.aborted) return [];
  const candidates = await fetchTagCandidates(pack, signal);
  if (candidates.length) {
    cache[pack.id] = { at: Date.now(), candidates };
    persistCache();
  }
  return candidates;
}

/**
 * Up to `count` holiday tracks ({ uri, id, name, artist }) outside `excludeIds`.
 * Last.fm chart rows are resolved on Spotify and do not need the holiday in
 * the title. Spotify search results still do. Applies the explicit filter,
 * Closing Time guard, skip-cooldown blocked artists, and the shared Random
 * artist budget. Does not apply genre lanes.
 * `deps.searchPage`, `deps.resolveTrack`, and `deps.tagCandidates` let tests
 * inject sources.
 */
export async function getHolidayHits(
  {
    holiday,
    count,
    excludeIds,
    filterExplicit = false,
    artistCap = Infinity,
    artistSeedCounts = null,
    blockedArtists = null,
    lastArtist = null,
    holidayArtistCap = 1,
    now = new Date(),
    signal = null,
  },
  deps = {}
) {
  const pack = holidayPack(holiday);
  if (!pack || !Number.isFinite(count) || count <= 0) return [];
  const aborted = () => !!signal?.aborted;
  const searchPage = deps.searchPage || searchTracksPage;
  const resolveTrack = deps.resolveTrack || findTrackUri;
  const tagCandidates = deps.tagCandidates || getHolidayCandidates;

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
    Number.isFinite(holidayArtistCap) && holidayArtistCap > 0
      ? holidayArtistCap
      : Infinity;
  const batchArtistCount = new Map();
  const chosen = [];
  const chosenIds = new Set();
  let prevArtist = lastArtist ? primaryArtist(lastArtist) : null;

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

  const acceptable = (found, { labeled = true } = {}) => {
    if (!found?.uri || !found.id) return false;
    const matchesSelected = trackMatchesHoliday(found, pack);
    if (labeled && !matchesSelected) return false;
    if (isSoundEffectTrack(found)) return false;
    if (filterExplicit && found.explicit) return false;
    if (isClosingTime(found.name, found.artist, found.uri)) return false;
    // The chip the host picked plays that holiday even outside its date window.
    // Other holidays stay out of season.
    if (isOutOfSeasonHolidayTrack(found, now) && !matchesSelected) return false;
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
    if (!aborted()) {
      const candidates = await tagCandidates(pack.id, { signal });
      const list = Array.isArray(candidates) ? candidates : [];
      let resolveCalls = 0;
      for (const c of shuffled(list)) {
        if (aborted() || chosen.length >= count) break;
        if (resolveCalls >= MAX_RESOLVE_CALLS) break;
        resolveCalls += 1;
        const found = await resolveTrack(c.artist, c.name, { signal });
        if (!found || !acceptable(found, { labeled: false })) continue;
        accept(found);
      }
    }

    for (const query of pack.searchQueries || []) {
      if (aborted() || chosen.length >= count) break;
      for (const offset of PAGE_OFFSETS) {
        if (aborted() || chosen.length >= count) break;
        let items = [];
        try {
          items = await searchPage(query, { limit: 50, offset, signal });
        } catch (err) {
          console.error("[holiday] search failed:", err.message);
          break;
        }
        if (!items.length) break;
        for (const found of shuffled(items)) {
          if (aborted() || chosen.length >= count) break;
          if (!acceptable(found)) continue;
          accept(found);
        }
      }
    }
  } catch (err) {
    console.error("[holiday] hits failed:", err.message);
  }
  return chosen;
}
