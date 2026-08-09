/**
 * Mid-set shout lead buffer: when a guest request would be next-up and the
 * current song ends before TTS can land, demote the request behind one
 * non-request track so music keeps playing (no hard-pause). Announce still
 * inserts immediately before the request.
 *
 * Last-song / empty-buffer edge case keeps the imminent pause in dj-voice.
 */

import { isAnnounceQueuePad } from "./sonos-queue-policy.js";
import { spotifyTrackId } from "./sampler.js";

/** Same window as the old hard-pause race guard (TTS + script latency). */
export const SHOUT_LEAD_BUFFER_SEC = 45;

/**
 * True when the request is next-up and remaining time is too short to rely on
 * inserting announce pads before the current song ends.
 */
export function needsShoutLeadBuffer({
  requestAbsPos,
  currentTrack,
  remainingSec,
  thresholdSec = SHOUT_LEAD_BUFFER_SEC,
} = {}) {
  const pos = Math.floor(Number(requestAbsPos));
  const track = Math.floor(Number(currentTrack));
  if (!Number.isFinite(pos) || pos < 1) return false;
  if (!Number.isFinite(track) || track < 1) return false;
  if (pos !== track + 1) return false;
  // Number(null) === 0 — treat missing remaining as "unknown, don't buffer".
  if (remainingSec == null || remainingSec === "") return false;
  const rem = Number(remainingSec);
  if (!Number.isFinite(rem)) return false;
  return rem <= thresholdSec;
}

/**
 * 1-based queue index of the first non-request music track after the request.
 * Returns null when nothing is available to buffer with (e.g. last song of the
 * night, Never-Ending off), or when announce pads sit before that filler
 * (demoting past a Random refill intro would reorder the night wrong).
 * @param {Array<{ TrackUri?: string, uri?: string, Title?: string, title?: string }>} items
 * @param {{ requestAbsPos: number, searchedIds?: Iterable<string>|Set<string> }} opts
 */
export function findShoutBufferTrackNumber(
  items,
  { requestAbsPos, searchedIds } = {}
) {
  const list = Array.isArray(items) ? items : [];
  const set =
    searchedIds instanceof Set ? searchedIds : new Set(searchedIds || []);
  const req = Math.floor(Number(requestAbsPos));
  if (!Number.isFinite(req) || req < 1) return null;
  // items[req] is the first slot after the request (0-based index = req).
  for (let i = req; i < list.length; i++) {
    const uri = list[i]?.TrackUri ?? list[i]?.uri;
    const title = list[i]?.Title ?? list[i]?.title ?? "";
    // Do not demote past a pending set/refill announce — that would play the
    // Random intro before the guest request we just prioritized.
    if (isAnnounceQueuePad(uri, title)) return null;
    const id = spotifyTrackId(uri);
    if (!id || !set.has(id)) return i + 1;
  }
  return null;
}

/**
 * Absolute 1-based position of the request after demoting it behind the buffer
 * track (Sonos ReorderTracksInQueue with InsertBefore = bufferPos + 1).
 */
export function requestPosAfterShoutBuffer(requestAbsPos, bufferAbsPos) {
  const req = Math.floor(Number(requestAbsPos));
  const buf = Math.floor(Number(bufferAbsPos));
  if (!Number.isFinite(req) || !Number.isFinite(buf) || req < 1 || buf < 1) {
    return req;
  }
  if (req < buf) return buf;
  return req;
}
