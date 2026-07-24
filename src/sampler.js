// Pure random-song picker, kept free of any Sonos/Spotify I/O so it is easy to
// reason about and unit-test. This is the brain behind the "random" button and
// the Never-Ending Queue: given the per-playlist track pool plus what to avoid,
// it returns track URIs in intended play order.
//
// Mirrors the Android app's `Sampler` (PartyPlayer): one random song per
// randomly-ordered playlist per round, avoid the same artist back-to-back, and
// (new) honor a recent-song memory and a per-artist budget so a long party
// doesn't keep leaning on the same songs and artists.

import { isClosingTime } from "./closing-time.js";
import { genreFlowScore } from "./genre-flow.js";

// Pull the bare spotify:track:<id> out of whatever URI form Sonos stores in the
// queue, e.g. "x-sonos-spotify:spotify%3atrack%3a<id>?sid=9&flags=8224&sn=7".
export function spotifyTrackId(uri) {
  if (!uri) return null;
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    /* leave as-is if it isn't valid percent-encoding */
  }
  const match = decoded.match(/spotify:track:([A-Za-z0-9]+)/);
  return match ? match[1] : null;
}

// Return a shuffled copy of an array (Fisher-Yates).
export function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Normalize an artist name for comparison (case/whitespace-insensitive).
export function normArtist(name) {
  return (name || "").trim().toLowerCase();
}

// Budget / back-to-back key: primary artist only (first comma-separated name).
// "Tyga, Doja Cat" and "Tyga" share one slot under artistCap.
export function primaryArtist(name) {
  const raw = String(name || "");
  const primary = raw.split(",")[0] || raw;
  return normArtist(primary);
}

// Pure: whether a candidate artist is still under the shared Random artist
// budget. Used by Discover and era Moods (lives here so both can import it
// without creating a similar.js <-> moods.js <-> genres.js cycle).
export function artistUnderBudget(artist, artistCount, artistCap) {
  const a = primaryArtist(artist);
  if (!a) return true;
  const cap =
    Number.isFinite(artistCap) && artistCap > 0 ? artistCap : Infinity;
  return (artistCount.get(a) ?? 0) < cap;
}

// Pure: bump the in-batch artist count after accepting a pick.
export function spendArtistBudget(artist, artistCount) {
  const a = primaryArtist(artist);
  if (!a) return null;
  artistCount.set(a, (artistCount.get(a) ?? 0) + 1);
  return a;
}

// Soft mood continuity: does this track share any genre bucket with the recent
// session tags? `bucketsFor` is injected so the pure sampler stays I/O-free.
export function sharesMood(track, recentBuckets, bucketsFor) {
  if (!(recentBuckets instanceof Set) || recentBuckets.size === 0) return false;
  if (typeof bucketsFor !== "function") return false;
  let buckets = bucketsFor(track?.artist) || [];
  if (!buckets.length) buckets = ["other"];
  return buckets.some((b) => recentBuckets.has(b));
}

function artistBucketsOf(track, bucketsFor) {
  if (typeof bucketsFor !== "function") return ["other"];
  let buckets = bucketsFor(track?.artist) || [];
  if (!buckets.length) buckets = ["other"];
  return buckets;
}

// Gather up to `want` fresh tracks by drawing ONE random song from each of a
// randomly-ordered set of playlists per round, then moving on to a new playlist,
// repeating rounds until we have `want` songs or no fresh ones remain. Within
// each pick we prefer a song whose artist differs from the previously chosen one
// to avoid the same artist playing back-to-back (best effort: falls back to any
// fresh song if a playlist only offers the same artist). `exclude` holds track
// IDs to skip (already queued, recently played, already chosen, or previously
// failed). De-dupes by track id. Returns the chosen URIs in intended play order.
//
// `opts` adds an optional per-artist budget:
//   - artistCap:        max times any one artist may appear (Infinity = off)
//   - artistSeedCounts: Map<normalizedArtist, count> of plays already "spent"
//                       in the recent window, so the cap spans history + this batch
//   - preferUnheard:    Set of track IDs already in song memory — soft-prefer
//                       tracks NOT in this set when several are eligible
//   - blockedArtists:   Set of normalized artists on skip cooldown
//   - recentBuckets:    Set of genre bucket ids from the last few heard songs
//   - bucketsFor:       (artist) => string[] genre buckets (for mood continuity)
//   - lastArtist:       primary artist of the prior song (queue tail / last pick)
//                       so the first pick of this call avoids that artist too
//   - flowState:        mutable genre-lane state { lane, previousLane, bridgeLeft,
//                       lastBuckets } — soft-prefer lane + neighbor fit, then fill
export function sampleSongs(playlists, exclude, want, opts = {}) {
  if (want <= 0) return [];

  const artistCap =
    Number.isFinite(opts.artistCap) && opts.artistCap > 0
      ? opts.artistCap
      : Infinity;
  // Seed per-artist counts from the recent-play window so the budget is shared
  // across what already played and what we're about to add this batch.
  // Re-key with primaryArtist so featured-artist strings collapse to one budget.
  const artistCount = new Map();
  if (opts.artistSeedCounts) {
    for (const [artist, count] of opts.artistSeedCounts) {
      const a = primaryArtist(artist);
      if (!a) continue;
      const n = Number(count) || 0;
      if (n <= 0) continue;
      artistCount.set(a, (artistCount.get(a) ?? 0) + n);
    }
  }
  const preferUnheard =
    opts.preferUnheard instanceof Set ? opts.preferUnheard : null;
  const blockedArtists =
    opts.blockedArtists instanceof Set ? opts.blockedArtists : null;
  const recentBuckets =
    opts.recentBuckets instanceof Set ? opts.recentBuckets : null;
  const bucketsFor =
    typeof opts.bucketsFor === "function" ? opts.bucketsFor : null;
  const useMood = !!(recentBuckets && recentBuckets.size && bucketsFor);
  const flowState =
    opts.flowState && typeof opts.flowState === "object" ? opts.flowState : null;
  const useFlow = !!(flowState?.lane && bucketsFor);

  const chosenIds = new Set();
  const chosen = [];
  let lastArtist = opts.lastArtist ? primaryArtist(opts.lastArtist) : null;

  let guard = 0;
  const MAX_ROUNDS = 5000;
  while (chosen.length < want && guard < MAX_ROUNDS) {
    guard++;
    let addedThisRound = 0;

    // Genre flow: each step picks the single best-scoring track across all
    // playlists (so metal doesn't lose a slot to country every round).
    // Without flow: classic one-random-song-per-playlist-per-round.
    if (useFlow) {
      const candidates = [];
      for (const pl of shuffled(playlists)) {
        const fresh = (pl.tracks || []).filter((t) => {
          const id = spotifyTrackId(t.uri);
          if (!id) return false;
          if (isClosingTime(t.name, t.artist, t.uri)) return false;
          if (exclude.has(id) || chosenIds.has(id)) return false;
          const artist = primaryArtist(t.artist);
          if (blockedArtists && artist && blockedArtists.has(artist)) return false;
          if ((artistCount.get(artist) ?? 0) >= artistCap) return false;
          return true;
        });
        if (!fresh.length) continue;
        const pool = shuffled(fresh);
        const unheard = preferUnheard
          ? pool.filter((t) => !preferUnheard.has(spotifyTrackId(t.uri)))
          : pool;
        const heard = preferUnheard
          ? pool.filter((t) => preferUnheard.has(spotifyTrackId(t.uri)))
          : [];
        const ordered = [...unheard, ...heard];
        ordered.sort((a, b) => {
          const sa = genreFlowScore(artistBucketsOf(a, bucketsFor), flowState);
          const sb = genreFlowScore(artistBucketsOf(b, bucketsFor), flowState);
          if (sb !== sa) return sb - sa;
          const aDiff = primaryArtist(a.artist) !== lastArtist ? 1 : 0;
          const bDiff = primaryArtist(b.artist) !== lastArtist ? 1 : 0;
          return bDiff - aDiff;
        });
        if (ordered[0]) candidates.push(ordered[0]);
      }
      if (!candidates.length) break;
      candidates.sort((a, b) => {
        const sa = genreFlowScore(artistBucketsOf(a, bucketsFor), flowState);
        const sb = genreFlowScore(artistBucketsOf(b, bucketsFor), flowState);
        if (sb !== sa) return sb - sa;
        const aDiff = primaryArtist(a.artist) !== lastArtist ? 1 : 0;
        const bDiff = primaryArtist(b.artist) !== lastArtist ? 1 : 0;
        return bDiff - aDiff;
      });
      const pick = candidates[0];
      const artist = primaryArtist(pick.artist);
      const pickBuckets = artistBucketsOf(pick, bucketsFor);
      chosenIds.add(spotifyTrackId(pick.uri));
      chosen.push(pick.uri);
      lastArtist = artist;
      artistCount.set(artist, (artistCount.get(artist) ?? 0) + 1);
      flowState.lastBuckets = new Set(pickBuckets);
      if (flowState.bridgeLeft > 0) flowState.bridgeLeft -= 1;
      addedThisRound++;
    } else {
      for (const pl of shuffled(playlists)) {
        if (chosen.length >= want) break;

        const fresh = (pl.tracks || []).filter((t) => {
          const id = spotifyTrackId(t.uri);
          if (!id) return false;
          // Never let the app auto-add the party-ending anthem.
          if (isClosingTime(t.name, t.artist, t.uri)) return false;
          if (exclude.has(id) || chosenIds.has(id)) return false;
          const artist = primaryArtist(t.artist);
          if (blockedArtists && artist && blockedArtists.has(artist)) return false;
          // Skip artists that have already used up their budget.
          if ((artistCount.get(artist) ?? 0) >= artistCap) {
            return false;
          }
          return true;
        });
        if (fresh.length === 0) continue;

        // Preference tiers (best effort within each):
        //   1) unheard + shares recent mood
        //   2) unheard (any mood)
        //   3) heard + shares recent mood
        //   4) anything left
        // Then prefer a different artist than the last pick inside the chosen tier.
        const pool = shuffled(fresh);
        const unheard = preferUnheard
          ? pool.filter((t) => !preferUnheard.has(spotifyTrackId(t.uri)))
          : pool;
        const heard = preferUnheard
          ? pool.filter((t) => preferUnheard.has(spotifyTrackId(t.uri)))
          : [];

        const splitMood = (list) => {
          if (!useMood) return { match: list, other: [] };
          const match = [];
          const other = [];
          for (const t of list) {
            if (sharesMood(t, recentBuckets, bucketsFor)) match.push(t);
            else other.push(t);
          }
          return { match, other };
        };

        const u = splitMood(unheard);
        const h = splitMood(heard);
        const tiers = [u.match, u.other, h.match, h.other].filter((t) => t.length);

        let pick = null;
        for (const tier of tiers.length ? tiers : [pool]) {
          if (!tier.length) continue;
          pick =
            tier.find((t) => primaryArtist(t.artist) !== lastArtist) ?? tier[0];
          break;
        }
        if (!pick) continue;

        const artist = primaryArtist(pick.artist);
        chosenIds.add(spotifyTrackId(pick.uri));
        chosen.push(pick.uri);
        lastArtist = artist;
        artistCount.set(artist, (artistCount.get(artist) ?? 0) + 1);
        addedThisRound++;
      }
    }

    // A full round added nothing new -> the fresh pool is exhausted.
    if (addedThisRound === 0) break;
  }
  return chosen;
}

// Pick up to `want` URIs with graduated relaxation so variety is maximized but
// the queue never comes back short just because our filters got greedy:
//   Pass 1: full rules - skip recently-played songs AND cap per-artist plays.
//   Pass 2: relax the artist cap (keep skipping recently-played songs).
//   Pass 3: relax the recent-song memory too (only the live queue / already
//           picked stay excluded), so a small playlist pool still fills.
// When `cfg.strictFill` is true, Pass 3 is skipped: better a short batch than
// re-adding songs the host asked the DJ to remember.
// Soft-prefers unheard tracks + recent mood in every pass.
// `baseExclude` is the always-on skip set (live Sonos queue + this call's picks).
//
// Returns { uris, relaxedArtist, relaxedMemory, memoryReuseCount } so the UI
// can tell the host when filters had to bend.
export function pickWithRelaxation(
  playlists,
  baseExclude,
  want,
  recentIds,
  artistSeed,
  cfg = {},
) {
  const chosen = [];
  const chosenIds = new Set();
  let relaxedArtist = false;
  let relaxedMemory = false;
  let memoryReuseCount = 0;
  let lastArtist = cfg.lastArtist ? primaryArtist(cfg.lastArtist) : null;

  const artistByUri = new Map();
  for (const pl of playlists || []) {
    for (const t of pl.tracks || []) {
      if (t?.uri) artistByUri.set(t.uri, t.artist ?? "");
    }
  }

  const sampleOpts = (extra = {}) => ({
    preferUnheard: recentIds,
    blockedArtists: cfg.blockedArtists,
    recentBuckets: cfg.recentBuckets,
    bucketsFor: cfg.bucketsFor,
    lastArtist,
    flowState: cfg.flowState || null,
    ...extra,
  });

  const collect = (excludeSet, opts) => {
    if (chosen.length >= want) return;
    const picks = sampleSongs(
      playlists,
      excludeSet,
      want - chosen.length,
      sampleOpts(opts)
    );
    for (const uri of picks) {
      const id = spotifyTrackId(uri);
      if (id && !chosenIds.has(id)) {
        chosen.push(uri);
        chosenIds.add(id);
        const a = primaryArtist(artistByUri.get(uri));
        if (a) lastArtist = a;
      }
    }
  };

  // Pass 1: recent-song memory + per-artist cap (+ skip cooldowns).
  collect(new Set([...baseExclude, ...recentIds]), {
    artistCap: cfg.artistCap,
    artistSeedCounts: artistSeed,
  });

  // Pass 2: drop the artist cap, still avoid recently-played songs / cooldowns.
  if (chosen.length < want) {
    const before = chosen.length;
    collect(new Set([...baseExclude, ...recentIds, ...chosenIds]), {});
    if (chosen.length > before) relaxedArtist = true;
  }

  // Pass 3: drop the recent-song memory, keep only live queue + already picked.
  // Skipped in strict mode so song memory is never sacrificed to fill a batch.
  // Soft-prefer still leans unheard / mood first among the now-eligible songs.
  if (chosen.length < want && !cfg.strictFill) {
    const before = chosen.length;
    collect(new Set([...baseExclude, ...chosenIds]), {});
    memoryReuseCount = chosen.length - before;
    if (memoryReuseCount > 0) relaxedMemory = true;
  }

  return {
    uris: chosen,
    relaxedArtist,
    relaxedMemory,
    memoryReuseCount,
  };
}

// Plan playlist vs discovery for one Random / Never-Ending batch.
// Large Random (count >= Discovery): Discovery slots are carved out of the
// batch — Random 25 + Discovery 5 => 20 playlist + 5 discoveries = 25.
// Small Random (count < Discovery): floor the batch to Discovery so playlist
// picks stay as requested — Random 2 + Discovery 5 => 2 playlist + 3 discoveries = 5.
export function discoveryPlan(count, similarCount) {
  const totalTarget = Math.max(0, Math.floor(Number(count) || 0));
  const discCap = Math.max(0, Math.min(50, Math.round(Number(similarCount) || 0)));
  if (discCap === 0 || totalTarget < 2) {
    return {
      playlistWant: totalTarget,
      similarWant: 0,
      totalTarget,
    };
  }
  // Discovery is carved out of the requested total, while retaining at least
  // half the batch from selected playlists. Random 2 therefore becomes one
  // playlist song + one discovery instead of two discoveries.
  const similarWant = Math.min(discCap, Math.floor(totalTarget / 2));
  return {
    playlistWant: totalTarget - similarWant,
    similarWant,
    totalTarget,
  };
}

// Discovery slots only (compat / tests). Prefer discoveryPlan for new call sites.
export function discoverySlots(count, similarCount) {
  return discoveryPlan(count, similarCount).similarWant;
}

/**
 * Mix discovery items into playlist items so Songs Like aren't adjacent unless
 * discoveries outnumber the available gaps.
 * Always leads with a playlist pick when any exist — never open a set on a
 * Discovered track (DJ "starting with" copy and play order stay aligned).
 * Items are opaque objects that may include `{ artist, discovered }`.
 * Best-effort swap pass reduces same-primary-artist adjacency afterward.
 */
export function mixPlaylistAndDiscovery(playlistItems, discoveryItems) {
  const base = Array.isArray(playlistItems) ? playlistItems.slice() : [];
  const extra = Array.isArray(discoveryItems) ? discoveryItems.slice() : [];
  if (!extra.length) return base;
  if (!base.length) return extra;

  // Gaps AFTER each playlist track only (never before the first).
  const gapCount = base.length;
  const gaps = Array.from({ length: gapCount }, () => []);

  // First: at most one discovery per gap (no adjacent D while D <= P).
  let i = 0;
  for (; i < extra.length && i < gapCount; i++) {
    gaps[i].push(extra[i]);
  }
  // Overflow: round-robin into gaps (adjacent Songs Like unavoidable).
  for (; i < extra.length; i++) {
    gaps[i % gapCount].push(extra[i]);
  }

  const out = [];
  for (let g = 0; g < base.length; g++) {
    out.push(base[g]);
    out.push(...gaps[g]);
  }
  const mixed = avoidAdjacentSameArtist(out);
  // Swaps must never promote a discovery into the lead slot.
  if (mixed[0]?.discovered) {
    const swapAt = mixed.findIndex((x, idx) => idx > 0 && !x?.discovered);
    if (swapAt > 0) {
      const tmp = mixed[0];
      mixed[0] = mixed[swapAt];
      mixed[swapAt] = tmp;
    }
  }
  return mixed;
}

// Best-effort: if two neighbors share a primary artist, swap the later one
// with a later item that breaks the clash without creating a new one.
function avoidAdjacentSameArtist(items) {
  const out = items.slice();
  for (let i = 1; i < out.length; i++) {
    const prev = primaryArtist(out[i - 1]?.artist);
    const cur = primaryArtist(out[i]?.artist);
    if (!prev || !cur || prev !== cur) continue;
    for (let j = i + 1; j < out.length; j++) {
      const cand = primaryArtist(out[j]?.artist);
      if (!cand || cand === prev) continue;
      const afterJ = primaryArtist(out[j + 1]?.artist);
      const beforeJ = primaryArtist(out[j - 1]?.artist);
      // After swap: position i gets cand (≠ prev); position j gets cur.
      // Neighbors of j must not clash with cur.
      if (beforeJ && beforeJ === cur) continue;
      if (afterJ && afterJ === cur) continue;
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
      break;
    }
  }
  return out;
}
