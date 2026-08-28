/** Mood / Genre header copy for Now Playing and Party Display. */

import { DECADE_LABELS, presetNameForIds } from "./genre-presets.js";

/**
 * @param {string|null|undefined} serverMixMood
 * @param {string|null|undefined} localEraMood
 */
export function resolveActiveEraMoodId(serverMixMood, localEraMood) {
  return serverMixMood !== undefined ? serverMixMood : localEraMood;
}

/**
 * @param {string[]|null|undefined} serverMixGenres
 * @param {string[]} localGenreIds
 */
export function resolveMixGenres(serverMixGenres, localGenreIds) {
  return serverMixGenres !== undefined ? serverMixGenres : localGenreIds;
}

/**
 * @param {string} presetName
 * @param {string|null|undefined} eraLabel
 */
export function formatMoodMixText(presetName, eraLabel) {
  const preset = presetName || "All";
  return eraLabel ? `Mood: ${preset} - ${eraLabel}` : `Mood: ${preset}`;
}

/** Stable label when a track has no matched genre yet. */
export const UNKNOWN_GENRE_DISPLAY = "Unknown";

/** @param {unknown} volume */
export function formatVolumeHeaderText(volume) {
  if (volume == null || volume === "") return "";
  const n = Math.round(Number(volume));
  if (!Number.isFinite(n)) return "";
  return `Volume: ${Math.max(0, Math.min(100, n))}`;
}

/** Fast while the DJ is ramping; slower for a live group read. */
export function volumePollMs(ramping) {
  return ramping ? 250 : 2500;
}

/**
 * @param {HTMLElement|null|undefined} el
 * @param {unknown} volume
 */
export function paintVolumeLabel(el, volume) {
  if (!el) return;
  const text = formatVolumeHeaderText(volume);
  if (!text) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = text;
}

/** @param {string|null|undefined} genreLabel */
export function formatGenreHeaderText(genreLabel) {
  const label = String(genreLabel || "").trim();
  return label
    ? `Genre: ${label}`
    : `Genre: ${UNKNOWN_GENRE_DISPLAY}`;
}

/** True when the Genre header shows a real lane/label (not empty / Unknown). */
export function genreHeaderHasKnownValue(genreText) {
  if (typeof genreText !== "string" || !genreText.startsWith("Genre:")) {
    return false;
  }
  const rest = genreText.slice("Genre:".length).trim();
  return !!rest && rest !== UNKNOWN_GENRE_DISPLAY;
}

/**
 * Build Mood + Genre header strings from the current mix snapshot.
 *
 * @param {{
 *   genres?: string[]|null,
 *   mood?: string|null,
 *   genreLabel?: string|null,
 * }} serverMix
 * @param {{
 *   localGenres?: string[],
 *   localMood?: string|null,
 *   allBucketIds?: string[],
 * }} [locals]
 */
export function buildMixLabelTexts(serverMix, locals = {}) {
  const localGenres = Array.isArray(locals.localGenres) ? locals.localGenres : [];
  const allBucketIds = Array.isArray(locals.allBucketIds)
    ? locals.allBucketIds
    : [];
  const genres = resolveMixGenres(serverMix?.genres, localGenres);
  const mood = resolveActiveEraMoodId(serverMix?.mood, locals.localMood);
  const era = mood ? DECADE_LABELS[mood] : null;
  const preset = presetNameForIds(
    Array.isArray(genres) ? genres : [],
    allBucketIds
  );
  const genreLane =
    typeof serverMix?.genreLane === "string" && serverMix.genreLane
      ? serverMix.genreLane
      : null;
  return {
    moodText: formatMoodMixText(preset, era),
    genreText: formatGenreHeaderText(serverMix?.genreLabel),
    genreLane,
  };
}

const GENRE_TONE_PREFIX = "genre-tone-";
const GENRE_TONE_LANES = [
  "rock",
  "metal",
  "country",
  "hiphop",
  "electronic",
  "pop",
  "folk",
  "punk",
  "soul",
  "jazz",
  "blues",
  "classical",
  "soundtrack",
  "oldies",
  "kids",
  "other",
];

/**
 * @param {HTMLElement|null|undefined} el
 * @param {string|null|undefined} lane
 */
export function paintGenreToneClass(el, lane) {
  if (!el?.classList) return;
  for (const id of GENRE_TONE_LANES) {
    el.classList.remove(`${GENRE_TONE_PREFIX}${id}`);
  }
  const next = typeof lane === "string" ? lane : "";
  if (next && GENRE_TONE_LANES.includes(next)) {
    el.classList.add(`${GENRE_TONE_PREFIX}${next}`);
  }
}

/**
 * @param {object|null|undefined} np
 * @returns {string|null|undefined} undefined = no genre fields on payload
 */
export function resolveMixGenreLabelFromNowPlaying(np) {
  if (!np || (!("mixGenreLabel" in np) && !("mixGenreLane" in np))) {
    return undefined;
  }
  if (typeof np.mixGenreLabel === "string" && np.mixGenreLabel) {
    return np.mixGenreLabel;
  }
  if (typeof np.mixGenreLane === "string" && np.mixGenreLane) {
    return np.mixGenreLane;
  }
  return null;
}

/**
 * @param {object|null|undefined} party
 * @returns {{ genres?: string[]|null, mood?: string|null }|null}
 */
export function mixSelectionPatchFromParty(party) {
  if (!party || (!("mixGenres" in party) && !("mixMood" in party))) return null;
  const patch = {};
  if ("mixGenres" in party) {
    patch.genres = Array.isArray(party.mixGenres) ? party.mixGenres : null;
  }
  if ("mixMood" in party) {
    patch.mood = typeof party.mixMood === "string" ? party.mixMood : null;
  }
  return patch;
}

/**
 * @param {string|null|undefined} moodLabel
 * @param {string|null|undefined} eraLabel
 */
export function formatMixHubMoodLine(moodLabel, eraLabel) {
  return [moodLabel, eraLabel].filter(Boolean).join(" \u00b7 ") || "—";
}

/**
 * @param {number} selected
 * @param {number} total
 */
export function formatSelectedOfTotal(selected, total) {
  if (!total) return "—";
  return `${selected} of ${total} selected`;
}

/**
 * @param {{
 *   npMoodLabel?: HTMLElement|null,
 *   npGenreLabel?: HTMLElement|null,
 *   displayMixPill?: HTMLElement|null,
 *   displayGenrePill?: HTMLElement|null,
 * }} els
 * @param {{ moodText: string, genreText: string, genreLane?: string|null }} texts
 */
export function paintMixLabels(els, texts) {
  const { npMoodLabel, npGenreLabel, displayMixPill, displayGenrePill } =
    els || {};
  const moodText = texts?.moodText || "Mood: All";
  const genreText =
    texts?.genreText || `Genre: ${UNKNOWN_GENRE_DISPLAY}`;
  const genreLane = texts?.genreLane || null;
  const hasKnownGenre = genreHeaderHasKnownValue(genreText);

  if (npMoodLabel) {
    npMoodLabel.textContent = moodText;
    npMoodLabel.hidden = false;
  }
  if (npGenreLabel) {
    // Keep the Genre affordance clickable; Unknown when nothing matched yet.
    npGenreLabel.textContent = genreText;
    npGenreLabel.hidden = false;
    npGenreLabel.classList?.toggle?.("is-unknown", !hasKnownGenre);
  }
  if (displayMixPill) {
    displayMixPill.textContent = moodText;
    displayMixPill.hidden = false;
  }
  if (displayGenrePill) {
    displayGenrePill.textContent = genreText;
    displayGenrePill.hidden = false;
    paintGenreToneClass(displayGenrePill, hasKnownGenre ? genreLane : null);
    displayGenrePill.classList?.toggle?.("is-unknown", !hasKnownGenre);
  }
}
