import { viewNameFromHash } from "./party-display-viewport.js";

/** Hash for a named view. Extra query is preserved for TV preview/kiosk. */
export function hashForView(name, query = "") {
  const q = String(query || "").replace(/^\?/, "");
  if (!name || name === "main") return q ? `#/?${q}` : "#/";
  return q ? `#/${name}?${q}` : `#/${name}`;
}

/**
 * @param {string} hash
 * @param {Record<string, unknown>|null} [views]
 */
export function resolveViewName(hash, views = null) {
  let h = viewNameFromHash(hash);
  if (h === "options" || h === "settings") h = "booth";
  if (h === "mood") h = "mix";
  if (!h) return "main";
  if (views && !views[h]) return "main";
  return h;
}

/**
 * Phone back while the home search overlay is open should dismiss search
 * first, not skip to an older hash (often DJ Booth + PIN).
 *
 * `restore-main`: the swipe already popped to another view — replace that
 * entry with home instead of pushing home on top (which would leave Booth
 * under the next swipe).
 *
 * @returns {"navigate" | "close-only" | "restore-main"}
 */
export function searchBackAction({ currentView, nextView, searchOpen }) {
  if (!searchOpen) return "navigate";
  if (currentView !== "main") return "navigate";
  if (nextView !== "main") return "restore-main";
  return "close-only";
}

/** History state for an open home search so the first back dismisses it. */
export function withSearchOverlayState(prev) {
  const base = prev && typeof prev === "object" ? { ...prev } : {};
  return { ...base, pq: 1, pqSearch: true };
}

export function isSearchOverlayState(state) {
  return !!state?.pqSearch;
}
