// "Songs Like" discovery.
//
// Given seed songs from the host's (genre-filtered) playlists, ask Last.fm for
// similar music, resolve those suggestions to real Spotify tracks, and return
// ones that are OUTSIDE the host's library so each random / never-ending batch
// can sprinkle in fresh discoveries.
//
// Strategy is hybrid: try song-to-song similarity first (precise), and when a
// seed has little data fall back to similar-artists -> their top tracks
// (broader). Everything is best-effort and never throws; a thin batch just
// yields fewer discoveries.

import { findTrackUri } from "./spotify.js";
import { bucketsForArtist } from "./genres.js";
import { fitsLane } from "./genre-flow.js";
import {
  shuffled,
  primaryArtist,
  artistUnderBudget,
  spendArtistBudget,
} from "./sampler.js";
import { getLastfmApiKey } from "./lastfm.js";
import { isClosingTime } from "./closing-time.js";

// Re-exported from sampler.js (moved there so era Moods can share them without
// an import cycle); kept here for existing consumers and unit tests.
export { artistUnderBudget, spendArtistBudget };

const LASTFM_URL = "https://ws.audioscrobbler.com/2.0/";
const REQ_GAP_MS = 250; // throttle Last.fm (well under their ~5 req/sec)
const MIN_MATCH = 0.1; // ignore weak similarity scores
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apiKey() {
  return getLastfmApiKey();
}

export function isDiscoveryAvailable() {
  return !!apiKey();
}

async function lastfm(params) {
  const p = new URLSearchParams({
    ...params,
    api_key: apiKey(),
    autocorrect: "1",
    format: "json",
  });
  const res = await fetch(`${LASTFM_URL}?${p.toString()}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  return res.json();
}

// Song-to-song similar tracks for a seed: [{ artist, name, match }].
async function similarTracksFor(seed) {
  try {
    const j = await lastfm({
      method: "track.getsimilar",
      artist: seed.artist,
      track: seed.name,
      limit: "30",
    });
    return (j?.similartracks?.track ?? [])
      .map((t) => ({ artist: t.artist?.name, name: t.name, match: Number(t.match) || 0 }))
      .filter((c) => c.artist && c.name && c.match >= MIN_MATCH);
  } catch {
    return [];
  }
}

// Fallback: similar artists, then a couple of each one's top tracks.
async function similarArtistTracksFor(seed) {
  let artists = [];
  try {
    const j = await lastfm({
      method: "artist.getsimilar",
      artist: seed.artist,
      limit: "12",
    });
    artists = (j?.similarartists?.artist ?? [])
      .map((a) => ({ name: a.name, match: Number(a.match) || 0 }))
      .filter((a) => a.name);
  } catch {
    artists = [];
  }

  const candidates = [];
  for (const a of artists.slice(0, 5)) {
    await sleep(REQ_GAP_MS);
    try {
      const j = await lastfm({
        method: "artist.gettoptracks",
        artist: a.name,
        limit: "3",
      });
      for (const t of j?.toptracks?.track ?? []) {
        if (t?.name) candidates.push({ artist: a.name, name: t.name, match: a.match });
      }
    } catch {
      /* skip this artist */
    }
    if (candidates.length >= 12) break;
  }
  return candidates;
}

// Resolve up to `count` discovery tracks (Spotify URIs) similar to the seeds but
// outside the host's library.
//   seeds        - [{ artist, name }] drawn from the (filtered) playlist pool
//   count        - how many discoveries to return
//   excludeIds   - Set of Spotify track IDs to avoid (whole library + queue +
//                  recent memory); guarantees results are "outside my playlists"
//   enabledGenres- array of bucket ids to keep, or null for no genre filter
//   filterExplicit- when true, drop tracks Spotify flags as explicit
//   artistCap / artistSeedCounts / lastArtist - same anti-repeat budget as
//                  playlist picks so discoveries don't step on Random settings
//   discoveryArtistCap - max discoveries from one artist in THIS batch (default 1)
//   blockedArtists - skip-cooldown primary artists (hard reject)
//   preferLane - hard-require discoveries that fit this genre lane (or a
//                neighbor). Off-lane Songs Like are dropped; shortfall is
//                filled from playlist picks instead of mismatched discoveries.
export async function getSimilarUris({
  seeds,
  count,
  excludeIds,
  enabledGenres,
  filterExplicit = false,
  artistCap = Infinity,
  artistSeedCounts = null,
  lastArtist = null,
  discoveryArtistCap = 1,
  blockedArtists = null,
  preferLane = null,
  flowState = null,
}) {
  if (!apiKey() || !count || count <= 0 || !seeds?.length) return [];

  const enabled = Array.isArray(enabledGenres) ? new Set(enabledGenres) : null;
  const exclude = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
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
  const discArtistCap =
    Number.isFinite(discoveryArtistCap) && discoveryArtistCap > 0
      ? discoveryArtistCap
      : Infinity;
  const discArtistCount = new Map();
  const chosen = [];
  const chosenIds = new Set();
  let prevArtist = lastArtist ? primaryArtist(lastArtist) : null;
  const lane = preferLane || flowState?.lane || null;

  // Try a generous number of seeds so we can still hit `count` when some seeds
  // have thin similarity data or resolve to already-excluded songs.
  const seedQueue = shuffled(seeds).slice(0, Math.max(count * 4, 12));

  const accept = (found, _artist) => {
    chosen.push({
      uri: found.uri,
      id: found.id,
      name: found.name,
      artist: found.artist,
    });
    chosenIds.add(found.id);
    const spent = spendArtistBudget(found.artist, artistCount);
    spendArtistBudget(found.artist, discArtistCount);
    if (spent) prevArtist = spent;
  };

  // Cap Spotify search calls per refill so a discovery burst can't 429 guest search.
  const MAX_FIND_TRACK_CALLS = 20;
  let findTrackCalls = 0;

  for (const seed of seedQueue) {
    if (chosen.length >= count) break;
    if (findTrackCalls >= MAX_FIND_TRACK_CALLS) break;
    if (!seed?.artist || !seed?.name) continue;

    await sleep(REQ_GAP_MS);
    let candidates = await similarTracksFor(seed);
    if (candidates.length === 0) {
      await sleep(REQ_GAP_MS);
      candidates = await similarArtistTracksFor(seed);
    }
    candidates.sort((a, b) => b.match - a.match);
    // Prefer a different artist than the previous pick when several candidates
    // are viable (mirrors sampleSongs back-to-back avoidance).
    if (prevArtist) {
      const different = candidates.filter(
        (c) => primaryArtist(c.artist) !== prevArtist
      );
      const same = candidates.filter(
        (c) => primaryArtist(c.artist) === prevArtist
      );
      candidates = different.length ? [...different, ...same] : candidates;
    }

    for (const c of candidates) {
      if (chosen.length >= count) break;
      if (findTrackCalls >= MAX_FIND_TRACK_CALLS) break;
      findTrackCalls += 1;
      const found = await findTrackUri(c.artist, c.name);
      if (!found) continue;
      if (filterExplicit && found.explicit) continue;
      if (isClosingTime(found.name, found.artist, found.uri)) continue;
      if (exclude.has(found.id) || chosenIds.has(found.id)) continue;
      const artist = primaryArtist(found.artist);
      if (blocked && artist && blocked.has(artist)) continue;
      if (!artistUnderBudget(found.artist, artistCount, artistCap)) continue;
      // Extra per-batch diversity: don't stack multiple discoveries from one artist.
      if (!artistUnderBudget(found.artist, discArtistCount, discArtistCap)) continue;

      let buckets = ["other"];
      {
        const primary = (found.artist || "").split(",")[0].trim();
        buckets = await bucketsForArtist(primary);
        if (!buckets.length) buckets = ["other"];
      }
      if (enabled && !buckets.some((b) => enabled.has(b))) continue;

      // Hard lane: discoveries must match the set lane (or a neighbor), same
      // affinity graph as Random fillers. Never inject country into a metal set.
      if (lane && !discoveryFitsLane(buckets, lane)) continue;

      accept(found, artist);
    }
  }

  return chosen;
}

/**
 * Hard gate for Songs Like / Discover against the Random set lane.
 * Unknown / other-only artists are rejected when a lane is set so they can't
 * punch holes in an otherwise coherent batch.
 */
export function discoveryFitsLane(artistBuckets, lane) {
  if (!lane) return true;
  const buckets = Array.isArray(artistBuckets)
    ? artistBuckets.map(String).filter((b) => b && b !== "other")
    : [];
  if (!buckets.length) return false;
  return fitsLane(buckets, lane);
}
