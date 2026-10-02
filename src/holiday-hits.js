// Spotify search fill for Holiday mode. Library tracks are preferred; this
// covers the shortfall the way Decades fill from era charts. No Last.fm.

import { searchTracksPage } from "./spotify.js";
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
  trackMatchesHoliday,
} from "./holidays.js";

const PAGE_OFFSETS = [0, 50, 100];

/**
 * Up to `count` holiday tracks ({ uri, id, name, artist }) outside `excludeIds`.
 * Applies the explicit filter, Closing Time guard, skip-cooldown blocked
 * artists, and the shared Random artist budget. Does not apply genre lanes.
 * `deps.searchPage` lets tests inject Spotify results.
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

  const acceptable = (found) => {
    if (!found?.uri || !found.id) return false;
    if (!trackMatchesHoliday(found, pack)) return false;
    if (filterExplicit && found.explicit) return false;
    if (isClosingTime(found.name, found.artist, found.uri)) return false;
    if (isOutOfSeasonHolidayTrack(found, now)) return false;
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
