/** Toast copy after adding or promoting a song in the queue. */

function trackIdFromUri(uri) {
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
 * True when a DJ announce/silence pad sits ahead of the added song.
 *
 * @param {Array<{ uri?: string, djVoice?: boolean }>|null|undefined} tracks
 * @param {string|null|undefined} trackUri
 * @param {number} queuePosition 1-based position from the add response
 */
export function djPadAheadInQueue(tracks, trackUri, queuePosition) {
  const list = Array.isArray(tracks) ? tracks : [];
  const id = trackIdFromUri(trackUri);
  const idx = id
    ? list.findIndex((t) => trackIdFromUri(t.uri) === id)
    : -1;
  if (idx > 0) {
    return list.slice(0, idx).some((t) => t.djVoice);
  }
  const pos = Number(queuePosition);
  if (idx < 0 && Number.isFinite(pos) && pos > 1) {
    return list.slice(0, pos - 1).some((t) => t.djVoice);
  }
  return false;
}

/**
 * @param {{ name?: string }} track
 * @param {{
 *   queuePosition?: number,
 *   started?: boolean,
 *   promoted?: boolean,
 * }} data
 * @param {boolean} [afterDj]
 */
export function formatAddToastMessage(track, data, afterDj = false) {
  const name = track?.name || "song";
  const pos = Number(data?.queuePosition);
  const djSuffix = afterDj ? " \u00b7 after DJ" : "";
  if (data?.started) {
    return `Added "${name}" \u2014 now playing`;
  }
  if (data?.promoted) {
    return Number.isFinite(pos) && pos > 0
      ? `Moved "${name}" up \u2014 you\u2019re #${pos}${djSuffix}`
      : `Moved "${name}" up \u2014 it was already queued`;
  }
  return Number.isFinite(pos) && pos > 0
    ? `Added \u2014 you\u2019re #${pos}${djSuffix}`
    : `Added "${name}" to the queue`;
}

/**
 * @param {{ name?: string, uri?: string }} track
 * @param {{
 *   queuePosition?: number,
 *   started?: boolean,
 *   promoted?: boolean,
 * }} data
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export async function buildAddToastMessage(
  track,
  data,
  { fetchImpl = globalThis.fetch } = {}
) {
  let afterDj = false;
  try {
    const res = await fetchImpl("/api/queue/list");
    if (res.ok) {
      const q = await res.json();
      const tracks = Array.isArray(q) ? q : q?.tracks || [];
      afterDj = djPadAheadInQueue(tracks, track?.uri, data?.queuePosition);
    }
  } catch {
    /* ignore — toast still works without the DJ hint */
  }
  return formatAddToastMessage(track, data, afterDj);
}
