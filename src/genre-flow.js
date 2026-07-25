// Genre-lane flow for Random / Never-Ending sets.
//
// Within a set: one primary lane; playlist / Discover / era / Spotify top-ups
// must exact-match that bucket (neighbors do not count). Thin playlist pools
// top up from Spotify lane hits rather than drifting off-lane.
// Across sets: rotate the lane; previous-lane bridging is not used for picks.

import { GENRE_BUCKETS } from "./genres.js";
import { loadSettings, saveSettings } from "./settings.js";

const ALL_BUCKET_IDS = GENRE_BUCKETS.map((b) => b.id);

// Undirected affinity: each bucket lists neighbors that sit comfortably next
// to it (self is always implied). "other" is handled as universal soft-fill.
export const BUCKET_NEIGHBORS = {
  rock: ["metal", "punk", "pop", "folk", "blues", "oldies", "soul"],
  metal: ["rock", "punk"],
  punk: ["rock", "metal"],
  country: ["folk", "oldies", "blues", "pop"],
  hiphop: ["electronic", "pop", "soul"],
  electronic: ["pop", "hiphop", "soundtrack"],
  pop: ["rock", "country", "hiphop", "electronic", "soul", "oldies", "folk"],
  folk: ["country", "rock", "pop", "oldies", "blues"],
  soul: ["hiphop", "pop", "jazz", "blues", "oldies"],
  jazz: ["soul", "blues", "classical", "oldies"],
  blues: ["rock", "country", "folk", "soul", "jazz", "oldies"],
  classical: ["jazz", "soundtrack"],
  soundtrack: ["electronic", "classical", "pop", "kids"],
  oldies: ["rock", "country", "pop", "folk", "soul", "blues"],
  kids: ["soundtrack", "pop"],
  other: [],
};

const LANE_HISTORY_WINDOW = 3;

function uniq(ids) {
  if (ids instanceof Set) return [...ids].map(String).filter(Boolean);
  if (Array.isArray(ids)) return [...new Set(ids.map(String).filter(Boolean))];
  if (ids == null || ids === "") return [];
  return [String(ids)];
}

/** Buckets that comfortably sit next to `bucket` (includes self). */
export function compatibleWith(bucket) {
  const id = String(bucket || "");
  if (!id || id === "other") return new Set(ALL_BUCKET_IDS);
  const neighbors = BUCKET_NEIGHBORS[id] || [];
  return new Set([id, ...neighbors, "other"]);
}

/** True if any bucket in `a` is compatible with any bucket in `b`. */
export function bucketsCompatible(a, b) {
  const left = uniq(a);
  const right = uniq(b);
  if (!left.length || !right.length) return true; // unknown → don't block
  for (const x of left) {
    const ok = compatibleWith(x);
    for (const y of right) {
      if (ok.has(y)) return true;
    }
  }
  return false;
}

/** Soft lane membership: artist touches the lane or a neighbor of it. */
export function fitsLane(artistBuckets, lane) {
  if (!lane) return true;
  const buckets = uniq(artistBuckets);
  if (!buckets.length) return true;
  return bucketsCompatible(buckets, [lane]);
}

/**
 * Hard exact-lane membership for Random / Never-Ending / Discover.
 * Artist must carry the lane bucket itself. Neighbors, empty, and other-only
 * do not count when a lane is set.
 */
export function fitsExactLane(artistBuckets, lane) {
  if (!lane) return true;
  const want = String(lane);
  const buckets = uniq(artistBuckets).filter((b) => b && b !== "other");
  if (!buckets.length) return false;
  return buckets.includes(want);
}

/** Soft neighbor check against the previous pick's buckets. */
export function fitsNeighbor(artistBuckets, previousBuckets) {
  const prev = uniq(previousBuckets);
  if (!prev.length) return true;
  return bucketsCompatible(artistBuckets, prev);
}

/**
 * Bridge window: ease from previousLane into setLane.
 * Prefer tracks compatible with BOTH; at least with the previous lane.
 */
export function fitsBridge(artistBuckets, previousLane, setLane) {
  if (!previousLane) return fitsLane(artistBuckets, setLane);
  const buckets = uniq(artistBuckets);
  if (!buckets.length) return true;
  const fromOk = bucketsCompatible(buckets, [previousLane]);
  if (!fromOk) return false;
  if (!setLane || previousLane === setLane) return true;
  return true; // soft: previous-lane fit is enough; lane fit is a higher tier
}

export function bridgeFitsBoth(artistBuckets, previousLane, setLane) {
  if (!previousLane || !setLane) return fitsBridge(artistBuckets, previousLane, setLane);
  const buckets = uniq(artistBuckets);
  if (!buckets.length) return true;
  return (
    bucketsCompatible(buckets, [previousLane]) &&
    bucketsCompatible(buckets, [setLane])
  );
}

/** How many opening songs should bridge from the previous set. */
export function bridgeSlotCount(want) {
  const n = Math.max(0, Math.floor(Number(want) || 0));
  if (n <= 1) return 0;
  if (n <= 3) return 1;
  return 2;
}

/** Dominant bucket for an artist among enabled ones (stable preference order). */
export function dominantBucket(artistBuckets, enabled = null) {
  const buckets = uniq(artistBuckets);
  if (!buckets.length) return "other";
  const allow =
    enabled instanceof Set
      ? enabled
      : Array.isArray(enabled) && enabled.length
        ? new Set(enabled)
        : null;
  const ranked = allow
    ? buckets.filter((b) => allow.has(b))
    : buckets.filter((b) => b !== "other");
  const pool = ranked.length ? ranked : buckets;
  // Prefer a non-other, more specific lane when several apply.
  const preference = [
    "metal",
    "punk",
    "hiphop",
    "country",
    "electronic",
    "jazz",
    "blues",
    "folk",
    "soul",
    "rock",
    "pop",
    "oldies",
    "classical",
    "soundtrack",
    "kids",
    "other",
  ];
  for (const id of preference) {
    if (pool.includes(id)) return id;
  }
  return pool[0];
}

/**
 * Pick the primary lane for this set. Rotates away from the previous lane
 * and recent history when several enabled buckets are available.
 */
export function pickSetLane({
  enabled = null,
  previousLane = null,
  recentLanes = [],
  salt = 0,
  poolCounts = null,
  minPerLane = 3,
} = {}) {
  let pool = Array.isArray(enabled) && enabled.length
    ? enabled.map(String)
    : ALL_BUCKET_IDS.filter((id) => id !== "other");
  // Kids nights stay in kids/soundtrack; don't wander into metal.
  if (pool.includes("kids") && pool.length <= 3) {
    pool = pool.filter((id) => id === "kids" || id === "soundtrack");
  }
  pool = uniq(pool);
  // Only rotate into lanes the current (filtered) pool can actually serve.
  // Rotating into a lane with no exact tracks degrades the whole set into
  // neighbor/fallback picks — genre chaos instead of a coherent set. When no
  // lane qualifies (thin era-filtered library living off chart top-ups) keep
  // the full rotation rather than pinning one lane forever.
  if (poolCounts instanceof Map && poolCounts.size) {
    const viable = pool.filter((id) => (poolCounts.get(id) ?? 0) >= minPerLane);
    if (viable.length) pool = viable;
  }
  if (!pool.length) return "rock";
  if (pool.length === 1) return pool[0];

  const recent = new Set(
    [previousLane, ...(Array.isArray(recentLanes) ? recentLanes : [])]
      .map(String)
      .filter(Boolean)
  );
  const fresh = pool.filter((id) => !recent.has(id));
  const candidates = fresh.length ? fresh : pool.filter((id) => id !== previousLane);
  const list = candidates.length ? candidates : pool;
  const idx = Math.abs(Number(salt) || 0) % list.length;
  return list[idx];
}

export function getGenreFlowState() {
  const s = loadSettings();
  const lastLane =
    typeof s.genreLane === "string" && s.genreLane ? s.genreLane : null;
  const recent = Array.isArray(s.genreLaneHistory)
    ? s.genreLaneHistory.map(String).filter(Boolean).slice(0, LANE_HISTORY_WINDOW)
    : [];
  return { lastLane, recentLanes: recent };
}

export function recordGenreLane(lane) {
  if (!lane) return getGenreFlowState();
  const prev = getGenreFlowState();
  const recent = [lane, ...prev.recentLanes.filter((x) => x !== lane)].slice(
    0,
    LANE_HISTORY_WINDOW
  );
  const next = { ...loadSettings(), genreLane: lane, genreLaneHistory: recent };
  saveSettings(next);
  return { lastLane: lane, recentLanes: recent };
}

/**
 * Score a track inside an exact-lane pool (higher = better).
 * Off-lane / unknown tracks score 0 — callers should hard-filter with
 * fitsExactLane before ranking.
 */
export function genreFlowScore(artistBuckets, flowState) {
  if (!flowState?.lane) return 0;
  const { lane, lastBuckets = null } = flowState;
  if (!fitsExactLane(artistBuckets, lane)) return 0;
  let score = 60;
  if (lastBuckets && lastBuckets.size && fitsNeighbor(artistBuckets, lastBuckets)) {
    score += 20;
  }
  return score;
}
