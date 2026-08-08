// Which Spotify playlists feed Random / Never-Ending. Browser-local only.

export const SELECTION_KEY = "pq.randomPlaylists";
export const SELECTION_VERSION_KEY = "pq.selectionVersion";
/** Bump when DEFAULT_UNCHECKED changes so existing browsers re-apply exclusions. */
export const SELECTION_VERSION = "3";

// Playlists that should NOT be auto-included. Matched by name (case-insensitive).
// Hosts can still check them by hand; that choice is remembered.
export const DEFAULT_UNCHECKED = [];

export function isDefaultUnchecked(name) {
  const n = (name || "").trim().toLowerCase();
  return DEFAULT_UNCHECKED.some((x) => x.trim().toLowerCase() === n);
}

/** @returns {Set<string>|null} null = never chosen (default on first render). */
export function loadPlaylistSelection() {
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    return raw == null ? null : new Set(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** @param {Iterable<string>|null|undefined} ids */
export function savePlaylistSelection(ids) {
  try {
    localStorage.setItem(
      SELECTION_KEY,
      JSON.stringify([...(ids || [])])
    );
  } catch {
    /* ignore storage errors (private mode, etc.) */
  }
}

/**
 * Apply first-run defaults and DEFAULT_UNCHECKED version migrations.
 * @param {Array<{ id: string, name?: string }>} playlists
 * @param {Set<string>|null} selectedIds
 * @returns {Set<string>}
 */
export function reconcilePlaylistSelection(playlists, selectedIds) {
  const list = Array.isArray(playlists) ? playlists : [];
  const excludedIds = new Set(
    list.filter((p) => isDefaultUnchecked(p.name)).map((p) => p.id)
  );

  let selection = selectedIds;
  let dirty = false;

  if (selection === null) {
    // First time: include everything except the default-unchecked playlists.
    selection = new Set(
      list.map((p) => p.id).filter((id) => !excludedIds.has(id))
    );
    dirty = true;
  } else if (localStorage.getItem(SELECTION_VERSION_KEY) !== SELECTION_VERSION) {
    // Rules changed: keep host picks but drop newly-excluded playlists.
    selection = new Set(selection);
    for (const id of excludedIds) selection.delete(id);
    dirty = true;
  }

  try {
    localStorage.setItem(SELECTION_VERSION_KEY, SELECTION_VERSION);
  } catch {
    /* ignore */
  }

  if (dirty) savePlaylistSelection(selection);
  return selection;
}
