// Mood presets: named genre-bucket bundles ("party", "chill", ...) mirroring
// the Vibe chips in the UI (GENRE_PRESETS in public/js/genre-presets.js). Kept as a
// leaf data module (no imports) so anything server-side — DJ scripts, the
// Never-Ending rotation engine — can resolve a preset without pulling in
// browser code or risking import cycles.

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

/** Host-facing mood chip labels (Mood page chart + UI). */
export const MOOD_PRESET_LABELS = {
  all: "All",
  party: "Party",
  chill: "Chill",
  country: "Country",
  heavy: "Heavy",
  rap: "Rap",
  kids: "Kids",
};

/**
 * Mood → genre chart rows for the Mood page.
 * @param {(id: string) => string} [labelForGenre] maps bucket id → display label
 */
export function moodGenreGuide(labelForGenre = (id) => id) {
  const labelOf = typeof labelForGenre === "function" ? labelForGenre : (id) => id;
  const rows = [
    {
      id: "all",
      label: MOOD_PRESET_LABELS.all,
      genres: "Every genre bucket",
    },
  ];
  for (const id of Object.keys(GENRE_PRESETS)) {
    if (id === "all") continue;
    const list = GENRE_PRESETS[id];
    if (!Array.isArray(list)) continue;
    rows.push({
      id,
      label: MOOD_PRESET_LABELS[id] || id,
      genres: list.map((g) => labelOf(g) || g).join(", "),
    });
  }
  return rows;
}

/** Preset ids that map to a concrete genre list (excludes "all"). */
export const ROTATABLE_PRESET_IDS = Object.keys(GENRE_PRESETS).filter(
  (id) => Array.isArray(GENRE_PRESETS[id])
);

/** Normalize any value to a known preset id, or null. */
export function normalizePresetId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(GENRE_PRESETS, id) ? id : null;
}

/** The genre-bucket ids for a preset ("all" and unknown ids give null). */
export function presetGenres(value) {
  const id = normalizePresetId(value);
  const list = id ? GENRE_PRESETS[id] : null;
  return Array.isArray(list) ? [...list] : null;
}

/** Reverse lookup: the preset whose bucket set matches `genres`, or null. */
export function presetIdForGenres(genres) {
  if (!Array.isArray(genres) || !genres.length) return null; // = "all"
  const want = [...new Set(genres)].sort().join("|");
  for (const id of ROTATABLE_PRESET_IDS) {
    const list = GENRE_PRESETS[id];
    if ([...new Set(list)].sort().join("|") === want) return id;
  }
  return null;
}
