/** Suggestion Box: guest inbox labels, filters, and row HTML. */

import { escapeHtml, formatSuggestionWhen } from "./format.js";
import { sanitizeDisplayName } from "./guest.js";

export const SUGGESTION_TEXT_MAX = 32768;

/**
 * @param {number} length
 * @param {number} [_max] unused; kept so callers can pass a safety cap
 */
export function formatSuggestionCharCount(length, _max) {
  return String(Math.max(0, Number(length) || 0));
}

/**
 * @param {HTMLTextAreaElement|HTMLInputElement|null|undefined} textEl
 * @param {HTMLElement|null|undefined} countEl
 * @param {number} [max]
 * @returns {() => void} sync function (call after clearing the textarea)
 */
export function wireSuggestionCharCount(
  textEl,
  countEl,
  _max = SUGGESTION_TEXT_MAX
) {
  function sync() {
    if (!countEl || !textEl) return;
    countEl.textContent = formatSuggestionCharCount(textEl.value.length);
  }
  textEl?.addEventListener("input", sync);
  sync();
  return sync;
}

/**
 * @param {Array<{ done?: boolean }>|null|undefined} all
 * @param {"open"|"done"|"all"|string} filter
 */
export function filterSuggestions(all, filter) {
  const list = Array.isArray(all) ? all : [];
  if (filter === "open") return list.filter((s) => !s.done);
  if (filter === "done") return list.filter((s) => s.done);
  return list;
}

/**
 * @param {Array<{ done?: boolean }>|null|undefined} all
 */
export function suggestionsCountLabel(all) {
  const list = Array.isArray(all) ? all : [];
  if (!list.length) return "";
  const openCount = list.filter((s) => !s.done).length;
  return `(${openCount} open · ${list.length})`;
}

/** @param {"open"|"done"|"all"|string} filter */
export function suggestionsEmptyMessage(filter) {
  if (filter === "done") return "No implemented suggestions yet.";
  if (filter === "open") return "No open suggestions — inbox zero.";
  return "No suggestions yet.";
}

/**
 * @param {{ text?: string, requestedBy?: string, ts?: number, done?: boolean }} s
 * @param {number} [now]
 */
export function suggestionRowHtml(s, now = Date.now()) {
  const who = sanitizeDisplayName(s?.requestedBy || "") || "Guest";
  const when = formatSuggestionWhen(s?.ts, now);
  return `
      <input type="checkbox" class="suggestion-check" ${s?.done ? "checked" : ""} title="Mark implemented" aria-label="Mark implemented" />
      <div class="suggestion-meta">
        <div class="suggestion-text">${escapeHtml(s?.text || "")}</div>
        <div class="suggestion-byline">${escapeHtml(who)}${when ? ` · ${escapeHtml(when)}` : ""}</div>
      </div>
    `;
}
