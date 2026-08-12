// Party Stats payload builder + short TTL cache.
// Guests open Stats (and refresh on reactions); avoid re-summarizing and
// Spotify title fills on every hit within a few seconds.

import { getTracksByIds } from "./spotify.js";
import {
  getRequests,
  summarizeRequests,
  topRequesters,
  topSets,
  listDedications,
} from "./request-log.js";
import {
  listKaraokeTracks,
  listReactedTracks,
  listTopLikedTracks,
  listPartyMusicTracks,
  listMostHatedTracks,
} from "./reactions.js";

export const STATS_WINDOW_HOURS = 12;
const DEFAULT_TTL_MS = 3000;

let nowFn = Date.now;
let ttlMs = DEFAULT_TTL_MS;
let generation = 0;
/** @type {{ at: number, payload: object } | null} */
let cached = null;
/** @type {Promise<object> | null} */
let inflight = null;

/** Drop cached payload (mutations / tests). */
export function invalidatePartyStatsCache() {
  generation += 1;
  cached = null;
}

/**
 * @param {{ now?: () => number, ttlMs?: number }} [opts]
 */
export function configurePartyStatsCacheForTests(opts = {}) {
  if (typeof opts.now === "function") nowFn = opts.now;
  if (typeof opts.ttlMs === "number" && opts.ttlMs >= 0) ttlMs = opts.ttlMs;
  invalidatePartyStatsCache();
  inflight = null;
}

/** @returns {{ generation: number, hasCache: boolean, ageMs: number|null }} */
export function partyStatsCacheInfoForTests() {
  return {
    generation,
    hasCache: !!cached,
    ageMs: cached ? nowFn() - cached.at : null,
  };
}

/**
 * @param {{
 *   getTracksByIds?: (ids: string[]) => Promise<Map<string, { title?: string, artist?: string }>>,
 * }} [deps]
 */
export async function buildPartyStatsPayload(deps = {}) {
  const fetchTracks =
    typeof deps.getTracksByIds === "function" ? deps.getTracksByIds : getTracksByIds;

  const events = getRequests();
  const sinceTonight = nowFn() - STATS_WINDOW_HOURS * 60 * 60_000;
  // UI boxes show 5 rows with scroll; keep a deeper leaderboard behind that.
  const LIST_LIMIT = 25;
  const tonight = summarizeRequests(events, sinceTonight, LIST_LIMIT);
  const allTime = summarizeRequests(events, 0, LIST_LIMIT);
  const karaoke = listKaraokeTracks(LIST_LIMIT);
  const reacted = listReactedTracks(LIST_LIMIT);
  const topLiked = listTopLikedTracks(LIST_LIMIT);
  const partyMusic = listPartyMusicTracks(LIST_LIMIT);
  const mostHated = listMostHatedTracks(LIST_LIMIT);
  const reactionLists = [karaoke, reacted, topLiked, partyMusic, mostHated];

  const needIds = [
    ...new Set(reactionLists.flat().filter((k) => !k.name).map((k) => k.id)),
  ];
  if (needIds.length) {
    try {
      const map = await fetchTracks(needIds);
      for (const row of reactionLists.flat()) {
        if (row.name) continue;
        const info = map.get(row.id);
        if (info) {
          row.name = info.title || "";
          row.artist = info.artist || "";
        }
      }
    } catch (err) {
      console.warn("[stats] reaction title lookup:", err.message);
    }
  }

  return {
    windowHours: STATS_WINDOW_HOURS,
    karaoke,
    reacted,
    topLiked,
    partyMusic,
    mostHated,
    tonight: {
      ...tonight,
      topSets: topSets(events, sinceTonight, LIST_LIMIT),
      topRequesters: topRequesters(events, sinceTonight, LIST_LIMIT),
      dedications: listDedications(sinceTonight, LIST_LIMIT),
    },
    allTime: {
      ...allTime,
      topSets: topSets(events, 0, LIST_LIMIT),
      topRequesters: topRequesters(events, 0, LIST_LIMIT),
      dedications: listDedications(0, LIST_LIMIT),
    },
  };
}

/**
 * Cached Party Stats JSON body. Short TTL; invalidated on request/reaction writes.
 * @param {{
 *   getTracksByIds?: (ids: string[]) => Promise<Map<string, { title?: string, artist?: string }>>,
 * }} [deps]
 */
export async function getPartyStatsPayload(deps = {}) {
  const now = nowFn();
  if (cached && now - cached.at < ttlMs) {
    return cached.payload;
  }
  if (inflight) return inflight;

  const gen = generation;
  inflight = buildPartyStatsPayload(deps)
    .then((payload) => {
      if (gen === generation) {
        cached = { at: nowFn(), payload };
      }
      return payload;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}
