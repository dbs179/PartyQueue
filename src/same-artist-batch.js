/**
 * Same-artist showcase batches for Random / Never-Ending.
 *
 * Automatic every-N when settings.sameArtistBatchEnabled — picks an artist
 * from the current Mood/Genre playlist pool.
 *
 * Counter is in-memory (like mood rotation / DJ set packs).
 */

import { primaryArtist } from "./sampler.js";
import { getRandomnessSettings } from "./settings.js";
import { buildPlaylistPool } from "./spotify.js";
import { artistMatchesGenres } from "./genres.js";
import { moodPack as eraMoodPack, trackFitsMood } from "./moods.js";

/** @type {number} */
let setsSinceLastShowcase = 0;

/** @param {string} name */
export function artistKeyFromName(name) {
  return primaryArtist(name);
}

/**
 * Aggregate primary artists from a filtered playlist pool.
 * @param {Array<{ tracks?: Array<{ artist?: string }> }>} playlists
 * @returns {Array<{ key: string, name: string, trackCount: number }>}
 */
export function listPoolArtists(playlists) {
  /** @type {Map<string, { key: string, name: string, trackCount: number }>} */
  const map = new Map();
  for (const pl of Array.isArray(playlists) ? playlists : []) {
    for (const t of pl.tracks || []) {
      const raw = String(t?.artist || "").trim();
      const key = primaryArtist(raw);
      if (!key) continue;
      const display = (raw.split(",")[0] || raw).trim() || key;
      const row = map.get(key);
      if (row) {
        row.trackCount += 1;
        if (display.length > row.name.length) row.name = display;
      } else {
        map.set(key, { key, name: display, trackCount: 1 });
      }
    }
  }
  return [...map.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

/**
 * Keep only tracks whose primary artist matches `artistKey`.
 * @param {Array<{ tracks?: object[] }>} playlists
 * @param {string} artistKey
 */
export function filterPlaylistsByPrimaryArtist(playlists, artistKey) {
  const want = primaryArtist(artistKey);
  if (!want) return [];
  return (Array.isArray(playlists) ? playlists : [])
    .map((p) => ({
      ...p,
      tracks: (p.tracks || []).filter(
        (t) => primaryArtist(t?.artist) === want
      ),
    }))
    .filter((p) => (p.tracks || []).length > 0);
}

/**
 * Pick a surprise showcase artist from the pool (enough tracks preferred).
 * @param {Array<{ tracks?: object[] }>} playlists
 * @param {{ minTracks?: number, excludeKeys?: Iterable<string>, random?: () => number }} [opts]
 */
export function pickShowcaseArtistFromPlaylists(playlists, opts = {}) {
  const minTracks = Math.max(1, Math.floor(Number(opts.minTracks) || 2));
  const exclude = new Set(
    [...(opts.excludeKeys || [])].map(primaryArtist).filter(Boolean)
  );
  const rand = typeof opts.random === "function" ? opts.random : Math.random;
  const artists = listPoolArtists(playlists).filter(
    (a) => a.trackCount >= minTracks && !exclude.has(a.key)
  );
  const pool =
    artists.length > 0
      ? artists
      : listPoolArtists(playlists).filter((a) => !exclude.has(a.key));
  if (!pool.length) return null;
  const index = Math.min(pool.length - 1, Math.floor(rand() * pool.length));
  return pool[index] || null;
}

export function getSetsSinceLastSameArtistBatch() {
  return setsSinceLastShowcase;
}

/** @param {{ wasShowcase?: boolean }} [opts] */
export function noteRandomSetBuilt({ wasShowcase = false } = {}) {
  if (wasShowcase) {
    setsSinceLastShowcase = 0;
    return;
  }
  setsSinceLastShowcase += 1;
}

export function resetSameArtistBatchCountersForTests() {
  setsSinceLastShowcase = 0;
}

export function getSameArtistBatchState() {
  const cfg = getRandomnessSettings();
  return {
    enabled: !!cfg.sameArtistBatchEnabled,
    everyN: cfg.sameArtistBatchEveryN,
    setsSince: setsSinceLastShowcase,
  };
}

/**
 * Build the same filtered playlist pool Random uses (playlists → genres →
 * explicit → era mood). Shared by Random showcase picking.
 * @param {{
 *   playlistIds?: string[]|null,
 *   genres?: string[]|null,
 *   mood?: string|null,
 *   filterExplicit?: boolean,
 * }} [opts]
 */
export async function buildSameArtistPool(opts = {}) {
  // Dynamic import avoids autofill → sonos → sonos-random → this module cycle.
  const { getAutoFillState } = await import("./autofill.js");
  const autofill = getAutoFillState();
  const playlistIds =
    opts.playlistIds !== undefined ? opts.playlistIds : autofill.playlistIds;
  const genres = opts.genres !== undefined ? opts.genres : autofill.genres;
  const mood = opts.mood !== undefined ? opts.mood : autofill.mood;
  const filterExplicit = !!opts.filterExplicit;

  const playlists = await buildPlaylistPool();
  let usable = playlists.filter((p) => (p.tracks || []).length > 0);

  if (Array.isArray(playlistIds)) {
    const allow = new Set(playlistIds);
    usable = usable.filter((p) => allow.has(p.id));
  }

  if (Array.isArray(genres)) {
    const enabled = new Set(genres);
    usable = usable
      .map((p) => ({
        ...p,
        tracks: (p.tracks || []).filter((t) =>
          artistMatchesGenres(t.artist, enabled)
        ),
      }))
      .filter((p) => p.tracks.length > 0);
  }

  if (filterExplicit) {
    usable = usable
      .map((p) => ({
        ...p,
        tracks: (p.tracks || []).filter((t) => !t.explicit),
      }))
      .filter((p) => p.tracks.length > 0);
  }

  const activeMoodPack = eraMoodPack(mood);
  if (activeMoodPack) {
    usable = usable
      .map((p) => ({
        ...p,
        tracks: (p.tracks || []).filter((t) =>
          trackFitsMood(t, activeMoodPack)
        ),
      }))
      .filter((p) => p.tracks.length > 0);
  }

  return {
    usable,
    artists: listPoolArtists(usable),
    pool: {
      playlistIds: Array.isArray(playlistIds) ? playlistIds : null,
      genres: Array.isArray(genres) ? genres : null,
      mood: activeMoodPack?.id ?? null,
    },
  };
}
