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
  return "Random";
}
