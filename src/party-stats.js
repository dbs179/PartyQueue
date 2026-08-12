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
  const tonight = summarizeRequests(events, sinceTonight);
  const allTime = summarizeRequests(events, 0);
  const karaoke = listKaraokeTracks(50);
  const reacted = listReactedTracks(50);
  const topLiked = listTopLikedTracks(50);
  const partyMusic = listPartyMusicTracks(50);
  const mostHated = listMostHatedTracks(50);
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
      topSets: topSets(events, sinceTonight),
      topRequesters: topRequesters(events, sinceTonight),
      dedications: listDedications(sinceTonight, 40),
    },
    allTime: {
      ...allTime,
      topSets: topSets(events, 0),
      topRequesters: topRequesters(events, 0),
      dedications: listDedications(0, 40),
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
