// Origin / skip badges for the Memory (play history) list.

import { sanitizeDisplayName } from "./guest.js";
import { escapeHtml } from "./format.js";
import { DECADE_LABELS } from "./genre-presets.js";

/**
 * @param {string|null|undefined} source
 * @param {boolean} [skipped]
 * @param {string} [requestedBy]
 * @param {string} [mood]
 */
export function memorySourceBadge(source, skipped, requestedBy, mood) {
  const parts = [];
  switch (source) {
    case "searched": {
      const by = sanitizeDisplayName(requestedBy || "");
      const label = by ? `Requested \u00b7 ${escapeHtml(by)}` : "Requested";
      const title = by
        ? `Requested by ${escapeHtml(by)}`
        : "Guest searched and added this";
      parts.push(
        `<span class="searched-badge" title="${title}">\u{1F50D} ${label}</span>`
      );
      break;
    }
    case "discovered":
      parts.push(
        `<span class="songs-like-badge" title="Added by Discover">\u2728 Discover</span>`
      );
      break;
    case "mood": {
      // Same wording as the queue badges: "80's Hit" when the decade is known.
      const era = mood ? DECADE_LABELS[mood] || null : null;
      const label = era ? `${era} Hit` : "Era Hit";
      parts.push(
        `<span class="mood-badge" title="Era hit added by the Decades mood">\u{1F4FC} ${escapeHtml(label)}</span>`
      );
      break;
    }
    case "filler":
      parts.push(
        `<span class="memory-random-badge" title="Added by Random / Never-Ending">\u{1F3B2} Random</span>`
      );
      break;
    default:
      break;
  }
  if (skipped) {
    parts.push(
      `<span class="memory-skipped-badge" title="Skipped while playing">\u23ED Skipped</span>`
    );
  }
  return parts.join("");
}
