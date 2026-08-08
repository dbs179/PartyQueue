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

/** @param {string|null|undefined} genreLabel */
export function formatGenreHeaderText(genreLabel) {
  return genreLabel ? `Genre: ${genreLabel}` : "Genre:";
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
  return {
    moodText: formatMoodMixText(preset, era),
    genreText: formatGenreHeaderText(serverMix?.genreLabel),
  };
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
 * @param {{ moodText: string, genreText: string }} texts
 */
export function paintMixLabels(els, texts) {
  const { npMoodLabel, npGenreLabel, displayMixPill, displayGenrePill } =
    els || {};
  const moodText = texts?.moodText || "Mood: All";
  const genreText = texts?.genreText || "Genre:";

  if (npMoodLabel) {
    npMoodLabel.textContent = moodText;
    npMoodLabel.hidden = false;
  }
  if (npGenreLabel) {
    // Keep the "Genre" affordance clickable even when idle — only clear the value.
    npGenreLabel.textContent = genreText;
    npGenreLabel.hidden = false;
  }
  if (displayMixPill) {
    displayMixPill.textContent = moodText;
    displayMixPill.hidden = false;
  }
  if (displayGenrePill) {
    displayGenrePill.textContent = genreText;
    displayGenrePill.hidden = false;
  }
}
