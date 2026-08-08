/** Shared Spotify track id + loose song-match helpers for search / queue UI. */

/**
 * @param {string|null|undefined} uri
 * @returns {string|null}
 */
export function trackIdFromUri(uri) {
  if (!uri) return null;
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    /* use as-is if it isn't valid percent-encoding */
  }
  const m = /spotify:track:([A-Za-z0-9]+)/.exec(decoded);
  return m ? m[1] : null;
}

/**
 * Loose "same song" key (title + primary artist), mirroring the server.
 * Spotify has many IDs for one song (album vs single vs remaster).
 *
 * @param {string|null|undefined} title
 * @param {string|null|undefined} artist
 */
export function songMatchKey(title, artist) {
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\(.*?\)|\[.*?\]/g, " ")
      .replace(/\s[-\u2013]\s.*$/, " ")
      .replace(/\bfeat\.?\b.*$/, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const t = norm(title);
  const a = norm(String(artist || "").split(",")[0]);
  return t && a ? `${t}|${a}` : "";
}

/**
 * @param {Array<{ uri?: string, title?: string, artist?: string, searched?: boolean }>|null|undefined} tracks
 */
export function buildQueuedPresence(tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  return {
    queuedIds: new Set(
      list.map((t) => trackIdFromUri(t.uri)).filter(Boolean)
    ),
    searchedQueuedIds: new Set(
      list
        .filter((t) => t.searched)
        .map((t) => trackIdFromUri(t.uri))
        .filter(Boolean)
    ),
    queuedKeys: new Set(
      list.map((t) => songMatchKey(t.title, t.artist)).filter(Boolean)
    ),
    searchedQueuedKeys: new Set(
      list
        .filter((t) => t.searched)
        .map((t) => songMatchKey(t.title, t.artist))
        .filter(Boolean)
    ),
  };
}

/**
 * @param {string|null|undefined} id
 * @param {string|null|undefined} key
 * @param {{
 *   queuedIds: Set<string>,
 *   queuedKeys: Set<string>,
 *   nowPlayingId?: string|null,
 *   nowPlayingKey?: string,
 * }} presence
 */
export function isTrackQueued(id, key, presence) {
  if (id && (presence.queuedIds.has(id) || id === presence.nowPlayingId)) {
    return true;
  }
  return (
    !!key &&
    (presence.queuedKeys.has(key) || key === presence.nowPlayingKey)
  );
}

/**
 * @param {string|null|undefined} id
 * @param {string|null|undefined} key
 * @param {{
 *   queuedIds: Set<string>,
 *   searchedQueuedIds: Set<string>,
 *   queuedKeys: Set<string>,
 *   searchedQueuedKeys: Set<string>,
 *   nowPlayingId?: string|null,
 *   nowPlayingKey?: string,
 * }} presence
 * @returns {{ queued: boolean, isRandom: boolean, label: string }|null}
 */
export function queuedResultBadge(id, key, presence) {
  if (!isTrackQueued(id, key, presence)) return null;
  const isSearched =
    (id &&
      (presence.searchedQueuedIds.has(id) || id === presence.nowPlayingId)) ||
    (key &&
      (presence.searchedQueuedKeys.has(key) ||
        key === presence.nowPlayingKey));
  const isRandom = !isSearched;
  return {
    queued: true,
    isRandom,
    label: isRandom ? "\u{1F3B2} In Random queue" : "\u2713 In queue",
  };
}
