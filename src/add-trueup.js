// Reconciles the pending-add outbox against the live Sonos queue.
//
// This is what makes retrying safe. The ugly failure mode on party night was
// the ambiguous timeout: AddURIToQueue is slow, the call gives up, and we have
// no idea whether the song landed. Retrying blind turns a slow party into one
// where songs play twice. So before the drainer gets another attempt, this
// pass reads the real queue and retires any entry it can actually see there -
// turning at-least-once delivery into effectively exactly-once.
//
// Direction matters: this only ever CONFIRMS or hands back for another attempt.
// It never removes anything from Sonos and never re-adds a retired entry. An
// entry that is missing from the queue is not evidence of failure - songs leave
// the queue constantly once they have played (queue-maintenance trims them, the
// host skips, Clear Queue wipes them). Only entries we never confirmed are
// eligible, and confirmation deletes them from the outbox for good.

import { spotifyTrackId } from "./sampler.js";
import {
  isDjVolumeHandoffArmed,
  isDjVolumeHandoffActive,
} from "./dj-volume-handoff-state.js";
import { listPendingAdds, markPlaced } from "./pending-adds.js";

function sameUser(a, b) {
  if (!a || !b) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function queueRows(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  return snapshot?.tracks || [];
}

/**
 * Confirm pending adds that are already sitting in the Sonos queue.
 *
 * @param {{ getQueueList: () => Promise<any> }} deps
 * @returns {Promise<{ confirmed: number, waiting: number, skipped?: string }>}
 */
export async function runAddTrueUp({ getQueueList }) {
  const candidates = listPendingAdds().filter(
    (e) => e.state === "pending" && !e.placing
  );
  if (!candidates.length) return { confirmed: 0, waiting: 0 };

  // The DJ machinery inserts and removes announce pads as it works, so the
  // queue is a moving target mid-handoff. Nothing here would corrupt it, but a
  // read taken now is worth little - wait for the next pass.
  if (isDjVolumeHandoffActive() || isDjVolumeHandoffArmed()) {
    return { confirmed: 0, waiting: candidates.length, skipped: "dj-announce-armed" };
  }

  const rows = queueRows(await getQueueList());

  // Count live copies per track so two pending entries for the same song can't
  // both be confirmed by a single queue row.
  const available = new Map();
  for (const row of rows) {
    const id = row?.id || spotifyTrackId(row?.uri);
    if (!id) continue;
    const list = available.get(id) || [];
    list.push(row);
    available.set(id, list);
  }

  let confirmed = 0;
  for (const entry of candidates) {
    const copies = available.get(entry.trackId);
    if (!copies?.length) continue;

    // Prefer a copy attributed to this guest; fall back to any copy of the
    // track. The looser match is deliberate: if the song is in the queue the
    // guest gets what they asked for, and queueing it twice would not be.
    let at = copies.findIndex((row) =>
      sameUser(row?.requestedByUser || row?.requestedBy, entry.requestedByUser)
    );
    if (at === -1) at = 0;
    copies.splice(at, 1);
    if (!copies.length) available.delete(entry.trackId);

    markPlaced(entry.id);
    confirmed += 1;
    console.log(
      `[true-up] confirmed "${entry.name}" for ${entry.requestedByUser} was already queued`
    );
  }

  return { confirmed, waiting: candidates.length - confirmed };
}
