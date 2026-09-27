// Builds what guests and the party display actually see.
//
// Two things the raw Sonos queue can't tell them:
//
//   1. Adds that have been accepted but not placed yet. Without these a guest
//      taps Add, gets told "queued", and then sees nothing in the list until
//      the drainer catches up - which looks exactly like the app losing the
//      song. Pending rows go at the end because they are not in the Sonos
//      queue yet and we will not pretend to know where they will land.
//
//   2. That the queue is stale. Every phone and the TV poll this; on party
//      night those reads were failing at the same moment people were staring
//      at them. Serving the last known good snapshot with a flag beats an
//      error - the party keeps its list, just marked as reconnecting.
//
// The stale snapshot is display-only. The true-up never reconciles against it
// (see add-trueup.js), because confirming a placement from stale data could
// retire an add that never actually landed.

import { listPendingAdds } from "./pending-adds.js";
import { asyncAddsEnabled } from "./async-adds.js";
import { spotifyTrackId } from "./sampler.js";

export function queueRowsOf(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  return snapshot?.tracks || [];
}

// Sonos failures carry SOAP URLs and speaker IPs ("request to
// http://10.10.20.196:1400/MediaRenderer/... failed"). That belongs in the
// server log, not on a guest's phone, and it tells them nothing useful anyway.
// The real error stays on the entry as lastError.
export const GUEST_FAILURE_REASON =
  "The speaker didn\u2019t take this song. Tap Retry to try again.";

/**
 * Pending and failed outbox entries as queue rows the UI can render.
 *
 * Returns nothing when write-behind adds are off, so the flag is a real kill
 * switch: rolling back must not leave a stale store file painting songs that
 * nothing is going to place.
 *
 * `snapshotRows` closes the handover gap. AddURIToQueue succeeding and
 * markPlaced() retiring the entry are not the same instant - on the first song
 * of the night the drainer holds idle for the DJ shout in between - so for a
 * second or so the song is in the Sonos queue AND still in the outbox, and the
 * guest sees it twice. Only entries actually mid-placement are suppressed, so
 * an add that is merely waiting its turn still shows up.
 */
export function pendingViewRows(snapshotRows = []) {
  if (!asyncAddsEnabled()) return [];
  const live = new Set();
  for (const row of snapshotRows) {
    const id = row?.id || spotifyTrackId(row?.uri);
    if (id) live.add(id);
  }
  const landed = (entry) => entry.placing && entry.trackId && live.has(entry.trackId);
  return listPendingAdds().filter((entry) => !landed(entry)).map((entry) => ({
    uri: entry.uri,
    id: entry.trackId,
    title: entry.name,
    artist: entry.artist,
    searched: true,
    requestedBy: entry.requestedBy,
    requestedByUser: entry.requestedByUser,
    dedication: entry.dedication,
    pending: entry.state === "pending",
    failed: entry.state === "failed",
    failedReason: entry.state === "failed" ? GUEST_FAILURE_REASON : null,
    pendingId: entry.id,
  }));
}

/**
 * @param {any} snapshot raw getQueueList() result (array or { tracks })
 * @param {{ stale?: boolean, staleAt?: number }} [meta]
 */
export function buildQueuePayload(snapshot, meta = {}) {
  const rows = queueRowsOf(snapshot);
  const tracks = [...rows, ...pendingViewRows(rows)];
  const payload = { tracks };
  if (meta.stale) {
    payload.stale = true;
    payload.staleAt = meta.staleAt || 0;
  }
  return payload;
}

/**
 * Read the queue for display, degrading to the last known good snapshot rather
 * than to an error. `reader` is the cached reader from sonos.js (or a test
 * fake); only the real one has peek(), so fakes simply propagate their error.
 */
export async function readQueueForDisplay(reader) {
  try {
    return buildQueuePayload(await reader());
  } catch (err) {
    const peeked = typeof reader?.peek === "function" ? reader.peek() : null;
    if (!peeked?.value) throw err;
    return buildQueuePayload(peeked.value, { stale: true, staleAt: peeked.at });
  }
}
