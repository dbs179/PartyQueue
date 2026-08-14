/** "How this song got here" labels for Now Playing and Party Display. */

import {
  sanitizeDisplayName,
  sanitizeDedication,
  dedicationDisplayLabel,
} from "./guest.js";
import { trackEraDisplayLabel } from "./genre-presets.js";

/**
 * Main Now Playing origin pill model (text + title + CSS class).
 * @param {object|null|undefined} np
 * @param {boolean} hasTrack
 * @returns {{ text: string, title: string, cls: string }|null}
 */
export function nowPlayingOriginLabel(np, hasTrack) {
  if (!hasTrack || !np || np.djVoice) return null;
  const origin =
    np.origin ||
    (np.discovered ? "discovered" : np.searched ? "searched" : null);
  if (origin === "discovered") {
    return {
      text: "Discover",
      title: "Added by Discover (similar to your music)",
      cls: "origin-discovered",
    };
  }
  if (origin === "searched") {
    const dedication = sanitizeDedication(np.dedication || "");
    const requester = sanitizeDisplayName(np.requestedBy || "");
    if (dedication) {
      const label = dedicationDisplayLabel(dedication, requester);
      return {
        text: label,
        title: label,
        cls: "origin-searched",
      };
    }
    if (requester) {
      return {
        text: `Requested · ${requester}`,
        title: `Requested by ${requester}`,
        cls: "origin-searched",
      };
    }
    return {
      text: "Requested",
      title: "A guest searched and added this song",
      cls: "origin-searched",
    };
  }
  if (np.reactionSet === "loved") {
    return {
      text: "Most Loved",
      title: "Most Loved set from guest reactions",
      cls: "origin-loved",
    };
  }
  if (np.reactionSet === "hated") {
    return {
      text: "Most Hated",
      title: "Most Hated set from guest reactions",
      cls: "origin-hated",
    };
  }
  if (np.reactionSet === "requested") {
    return {
      text: "Most Requested",
      title: "Most Requested set from guest requests",
      cls: "origin-requested",
    };
  }
  if (origin === "filler") {
    return {
      text: "Random",
      title: "Added by Random / Never-Ending",
      cls: "origin-random",
    };
  }
  return null;
}

/**
 * Party Display Now Playing pill + Up Next rows:
 * dedication > requested > era hit > Discover > Random.
 *
 * @param {object} track
 * @param {string|null|undefined} [activeEraMood] current Decades mood id
 */
export function displayOriginLabel(track, activeEraMood = null) {
  if (!track) return "Random";
  const requester = sanitizeDisplayName(track.requestedBy || "");
  const dedication = sanitizeDedication(track.dedication || "");
  if (dedication) return dedicationDisplayLabel(dedication, requester);
  if (track.searched) {
    return requester ? `Requested by ${requester}` : "Requested";
  }
  if (track.moodPick) {
    const era = trackEraDisplayLabel(track, activeEraMood);
    return era ? `${era} Hit` : "Era Hit";
  }
  if (track.discovered) return "Discover";
  if (track.reactionSet === "loved") return "Most Loved";
  if (track.reactionSet === "hated") return "Most Hated";
  if (track.reactionSet === "requested") return "Most Requested";
  return "Random";
}

const ORIGIN_TONE_CLASSES = [
  "origin-searched",
  "origin-discovered",
  "origin-random",
  "origin-mood",
  "origin-loved",
  "origin-hated",
  "origin-requested",
];

/**
 * CSS tone class for Party Display origin pill text (background stays grey).
 * @param {object|null|undefined} track
 */
export function displayOriginTone(track) {
  if (!track) return "origin-random";
  const origin =
    track.origin ||
    (track.discovered ? "discovered" : track.searched ? "searched" : null);
  if (origin === "searched" || track.searched) return "origin-searched";
  if (origin === "discovered" || track.discovered) return "origin-discovered";
  if (origin === "mood" || track.moodPick) return "origin-mood";
  if (track.reactionSet === "loved") return "origin-loved";
  if (track.reactionSet === "hated") return "origin-hated";
  if (track.reactionSet === "requested") return "origin-requested";
  return "origin-random";
}

/**
 * @param {HTMLElement|null|undefined} el
 * @param {string|null|undefined} toneClass
 */
export function paintOriginToneClass(el, toneClass) {
  if (!el) return;
  el.classList.remove(...ORIGIN_TONE_CLASSES);
  if (toneClass && ORIGIN_TONE_CLASSES.includes(toneClass)) {
    el.classList.add(toneClass);
  }
}
