// Client vibe / decade dictionaries + pure set helpers (no DOM).
// Keep GENRE_PRESETS in sync with src/genre-presets.js (server Never-Ending / DJ).

/** One-tap mood mixes. Ids must match GENRE_BUCKETS on the server. `all` = every bucket. */
export const GENRE_PRESETS = {
  party: [
    "rock",
    "metal",
    "country",
    "hiphop",
    "electronic",
    "pop",
    "punk",
  ],
  chill: ["folk", "soul", "jazz", "blues", "pop", "electronic", "oldies", "other"],
  country: ["country", "folk"],
  heavy: ["rock", "metal"],
  rap: ["hiphop"],
  kids: ["kids", "soundtrack"],
  all: null,
};

export const PRESET_ORDER = ["party", "chill", "country", "heavy", "rap", "kids"];

export const DECADE_LABELS = {
  "60s": "60's",
  "70s": "70's",
  "80s": "80's",
  "90s": "90's",
  "2000s": "2000's",
  "2010s": "2010's",
  "2020s": "2020's",
};

/** localStorage key for the selected decade mood. */
export const ERA_MOOD_STORAGE_KEY = "pq.mood";

export function sameIdSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** Preset genre ids filtered to buckets the UI currently knows about. */
export function presetIdsFor(name, allIds) {
  const all = Array.isArray(allIds) ? allIds : [];
  if (!all.length) return [];
  if (name === "all") return all;
  return (GENRE_PRESETS[name] || []).filter((id) => all.includes(id));
}

/**
 * Display name for a genre-id selection ("Party", "All", "Custom", …).
 * @param {string[]} ids
 * @param {string[]} [allBucketIds]
 */
export function presetNameForIds(ids, allBucketIds = []) {
  if (!Array.isArray(ids) || !ids.length) return "All";
  for (const name of PRESET_ORDER) {
    // Bucket-filtered when the bucket list is loaded, raw preset otherwise.
    const preset = presetIdsFor(name, allBucketIds);
    const target = preset.length ? preset : GENRE_PRESETS[name] || [];
    if (target.length && sameIdSet(ids, target)) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }
  if (allBucketIds.length && sameIdSet(ids, allBucketIds)) {
    return "All";
  }
  return "Custom";
}

/** Active mood preset label, or "Custom" when genres don't match a preset. */
export function moodLabelForIds(ids, allBucketIds = []) {
  if (!allBucketIds.length) return null;
  const current = Array.isArray(ids) ? ids : [];
  for (const name of [...PRESET_ORDER, "all"]) {
    const preset = presetIdsFor(name, allBucketIds);
    if (preset.length && sameIdSet(current, preset)) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }
  return "Custom";
}

export function labelForDecade(moodId) {
  return moodId && DECADE_LABELS[moodId] ? DECADE_LABELS[moodId] : null;
}

/**
 * Era label for one queued track. Prefers the decade stamped on the track at
 * add time; falls back to the active decade mood id.
 */
export function trackEraDisplayLabel(track, fallbackMoodId) {
  if (track?.mood && DECADE_LABELS[track.mood]) return DECADE_LABELS[track.mood];
  return labelForDecade(fallbackMoodId);
}

export function loadEraMood() {
  try {
    const raw = localStorage.getItem(ERA_MOOD_STORAGE_KEY);
    return raw && DECADE_LABELS[raw] ? raw : null;
  } catch {
    return null;
  }
}

export function saveEraMood(eraMood) {
  try {
    if (eraMood) localStorage.setItem(ERA_MOOD_STORAGE_KEY, eraMood);
    else localStorage.removeItem(ERA_MOOD_STORAGE_KEY);
  } catch {
    /* ignore storage errors */
  }
}
