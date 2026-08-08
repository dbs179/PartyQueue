/**
 * Pure Skip policy around DJ announce blocks (ramp → TTS → restore).
 *
 * 1. Music with next item an announce pad → seek near end of the song so the
 *    natural handoff runs (avoids Sonos Next() restarting HTTP TTS).
 * 2. Already on announce pads (or volume-locked on a pad/clip) → jump the
 *    whole block to the next real music track.
 */

import { isAnnounceQueuePad } from "./sonos-queue-policy.js";

/** Seconds before track end when "skip into announce" seeks. */
export const SEEK_END_LEAD_SEC = 1;

/** Format seconds as Sonos RelTime Target (H:MM:SS). */
export function formatSonosRelTime(totalSec) {
  const sec = Math.max(0, Math.floor(Number(totalSec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * 1-based queue track number of the next non-announce music item after the
 * current track. Returns null when none remain.
 * @param {Array<{ TrackUri?: string, uri?: string, Title?: string, title?: string }>} items
 * @param {number} currentTrack1Based
 */
export function findNextMusicTrackNumber(items, currentTrack1Based) {
  const list = Array.isArray(items) ? items : [];
  const current = Math.max(0, Math.floor(Number(currentTrack1Based) || 0));
  // Sonos Track is 1-based; items[current] is the next absolute queue slot.
  const from = current >= 1 ? current : 0;
  for (let i = from; i < list.length; i++) {
    const uri = list[i]?.TrackUri ?? list[i]?.uri;
    const title = list[i]?.Title ?? list[i]?.title ?? "";
    if (!isAnnounceQueuePad(uri, title)) return i + 1;
  }
  return null;
}

/**
 * @param {{
 *   currentUri?: string|null,
 *   currentTitle?: string|null,
 *   nextUri?: string|null,
 *   nextTitle?: string|null,
 *   durationSec?: number|null,
 *   positionSec?: number|null,
 *   volumeLocked?: boolean,
 * }} ctx
 * @returns {{
 *   action: "seekNearEnd"|"jumpAnnounce"|"normalNext",
 *   targetSec?: number,
 *   alreadyNearEnd?: boolean,
 * }}
 */
export function decideSkipAnnounceAction(ctx = {}) {
  const currentUri = ctx.currentUri ?? "";
  const currentTitle = ctx.currentTitle ?? "";
  const nextUri = ctx.nextUri ?? "";
  const nextTitle = ctx.nextTitle ?? "";
  const onPad = isAnnounceQueuePad(currentUri, currentTitle);
  // Volume lock means handoff owns the room — never raw-Next through a pad/clip.
  if (onPad || !!ctx.volumeLocked) {
    return { action: "jumpAnnounce" };
  }
  if (!isAnnounceQueuePad(nextUri, nextTitle)) {
    return { action: "normalNext" };
  }

  const durationSec = Number(ctx.durationSec);
  const positionSec = Number(ctx.positionSec);
  if (!Number.isFinite(durationSec) || durationSec <= SEEK_END_LEAD_SEC + 1) {
    // No usable duration — jump the block instead of Next() onto a pad.
    return { action: "jumpAnnounce" };
  }

  const targetSec = Math.max(0, durationSec - SEEK_END_LEAD_SEC);
  const alreadyNearEnd =
    Number.isFinite(positionSec) && positionSec >= targetSec - 0.25;
  return { action: "seekNearEnd", targetSec, alreadyNearEnd };
}
