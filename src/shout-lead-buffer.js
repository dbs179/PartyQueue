/**
 * Guest request order is FIFO. We never demote a request to make room for TTS —
 * that split set-requests and played later adds before earlier ones.
 *
 * Mid-queue / Set Request paths never Pause a playing song mid-track.
 * Next-up request shouts may hold at the last ~2s (or after the playhead
 * leaves the current song) until pads are inserted, then Play the announce.
 *
 * Helpers below stay for tests / pause eligibility. ensureShoutLeadBuffer is a
 * no-op so route and insert-lock call sites cannot move guest songs.
 */

import { isAnnounceQueuePad } from "./sonos-queue-policy.js";
import { spotifyTrackId } from "./sampler.js";

/** Demote window: prefer filler ahead of the request while music keeps playing. */
export const SHOUT_LEAD_BUFFER_SEC = 45;

/**
 * Hard-pause only when TTS + pad insert likely cannot finish before the song
 * ends (last-song / no-filler edge). Wider remaining times rely on lead buffer.
 */
export const IMMINENT_ANNOUNCE_PAUSE_SEC = 15;

/** Hold at the tail of the current song — never a mid-track cut. */
export const TRACK_END_ANNOUNCE_HOLD_SEC = 2;

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
 * Pure eligibility for the last-song hard pause (no filler to demote behind).
 * Insert at/before next track + playing from queue + rem within pause window.
 */
export function shouldPauseForImminentAnnounce({
  queuePosition,
  currentTrack,
  remainingSec,
  isPlaying,
  playingFromQueue,
  pauseThresholdSec = IMMINENT_ANNOUNCE_PAUSE_SEC,
} = {}) {
  if (!playingFromQueue || !isPlaying) return false;
  const pos = Math.floor(Number(queuePosition));
  const track = Math.floor(Number(currentTrack));
  if (!Number.isFinite(pos) || pos < 1) return false;
  if (!Number.isFinite(track) || track < 1) return false;
  if (pos > track + 1) return false;
  if (remainingSec == null || remainingSec === "") return false;
  const rem = Number(remainingSec);
  if (!Number.isFinite(rem)) return false;
  const threshold = Number(pauseThresholdSec);
  if (!Number.isFinite(threshold) || threshold < 0) return false;
  return rem <= threshold;
}

/**
 * Next-up shout hold: current song plays out. True when remaining time is at
 * the tail, or the playhead already left the track we started on.
 */
export function shouldHoldAtTrackEndForAnnounce({
  nextUp = false,
  remainingSec,
  currentTrack,
  startedOnTrack,
  playingFromQueue,
  holdSec = TRACK_END_ANNOUNCE_HOLD_SEC,
} = {}) {
  if (!nextUp || !playingFromQueue) return false;
  const cur = Math.floor(Number(currentTrack));
  const start = Math.floor(Number(startedOnTrack));
  if (Number.isFinite(cur) && Number.isFinite(start) && cur !== start) {
    return true;
  }
  if (remainingSec == null || remainingSec === "") return false;
  const rem = Number(remainingSec);
  if (!Number.isFinite(rem)) return false;
  const threshold = Number(holdSec);
  if (!Number.isFinite(threshold) || threshold < 0) return false;
  return rem <= threshold;
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
