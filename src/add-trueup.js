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
// eligible, and confirmation puts them permanently beyond the drainer's reach.

import { spotifyTrackId } from "./sampler.js";
import {
  isDjVolumeHandoffArmed,
  isDjVolumeHandoffActive,
} from "./dj-volume-handoff-state.js";
import {
  listPendingAdds,
  markPlaced,
  retirePlacedAdd,
  whenPendingAddsDurable,
} from "./pending-adds.js";

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
  const live = listPendingAdds();
  const candidates = live.filter((e) => e.state === "pending" && !e.placing);
  // Placed entries are the shadow rows covering the gap between handing a song
  // to Sonos and Sonos showing it. Seeing the row is what retires them.
  const placed = live.filter((e) => e.state === "placed");
  if (!candidates.length && !placed.length) {
    return { confirmed: 0, retired: 0, waiting: 0 };
  }

  // The DJ machinery inserts and removes announce pads as it works, so the
  // queue is a moving target mid-handoff. Nothing here would corrupt it, but a
  // read taken now is worth little - wait for the next pass.
  if (isDjVolumeHandoffActive() || isDjVolumeHandoffArmed()) {
    return {
      confirmed: 0,
      retired: 0,
      waiting: candidates.length,
      skipped: "dj-announce-armed",
    };
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

  // Retire shadow rows first so the copies they account for cannot also be used
  // to confirm a pending entry that was never actually placed.
  //
  // Both loops resolve the store BEFORE spending the copy. The queue read above
  // is awaited, so the outbox can move underneath us - Clear Queue is the
  // obvious one - and an entry that is already gone must leave its copy for the
  // next candidate rather than swallowing it on the way out.
  let retired = 0;
  for (const entry of placed) {
    const copies = available.get(entry.trackId);
    if (!copies?.length) continue;
    if (!retirePlacedAdd(entry.id)) continue;
    copies.shift();
    if (!copies.length) available.delete(entry.trackId);
    retired += 1;
  }

  let confirmed = 0;
  for (const entry of candidates) {
    const copies = available.get(entry.trackId);
    if (!copies?.length) continue;

    // Only a copy already attributed to this guest. A Random / Never-Ending
    // filler row shares the track id and has no requester; confirming it would
    // skip promotion and leave the song buried, unbadged, and unshouted. The
    // drainer still promotes that filler. An ambiguous timeout that already
    // stamped this guest on the row still confirms, so it is not queued twice.
    const at = copies.findIndex((row) =>
      sameUser(row?.requestedByUser || row?.requestedBy, entry.requestedByUser)
    );
    if (at === -1) continue;

    if (!markPlaced(entry.id)) continue;
    copies.splice(at, 1);
    if (!copies.length) available.delete(entry.trackId);
    confirmed += 1;
    console.log(
      `[true-up] confirmed "${entry.name}" for ${entry.requestedByUser} was already queued`
    );
  }

  if (retired || confirmed) await whenPendingAddsDurable();
  return { confirmed, retired, waiting: candidates.length - confirmed };
}
