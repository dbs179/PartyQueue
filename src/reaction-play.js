// One mood-reaction play per Now Playing listen. Same track later = new play.

let current = { trackId: "", playId: "", positionSec: null };

/**
 * Keep the live play id while this Spotify track is current. A different
 * track (or the same song starting again after something else played)
 * mints a new id. Empty / DJ gaps do not reset the live play.
 * A playhead jump back to the start (repeat / replay) also mints a new id.
 * @param {string} trackId
 * @param {number} [now]
 * @param {number|null} [positionSec]
 */
export function noteReactionPlayTrack(
  trackId,
  now = Date.now(),
  positionSec = null
) {
  const id = String(trackId || "").trim();
  if (!id) return current.playId;
  const pos = Number(positionSec);
  const nextPos = Number.isFinite(pos) ? pos : null;
  if (current.trackId !== id) {
    current = {
      trackId: id,
      playId: `${id}:${Number(now) || Date.now()}`,
      positionSec: nextPos,
    };
    return current.playId;
  }
  const prev = Number(current.positionSec);
  if (Number.isFinite(prev) && Number.isFinite(pos) && prev >= 20 && pos <= 8) {
    current = {
      trackId: id,
      playId: `${id}:${Number(now) || Date.now()}`,
      positionSec: pos,
    };
    return current.playId;
  }
  if (nextPos != null) current.positionSec = nextPos;
  return current.playId;
}

/** Live play id when `trackId` is the current song; otherwise "". */
export function playIdForTrack(trackId) {
  const id = String(trackId || "").trim();
  if (!id || current.trackId !== id) return "";
  return current.playId;
}

export function currentReactionPlayId() {
  return current.playId;
}

/** Test helper. */
export function resetReactionPlayForTests() {
  current = { trackId: "", playId: "", positionSec: null };
}
