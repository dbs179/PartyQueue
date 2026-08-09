/**
 * Pure Skip policy around DJ announce blocks (ramp → TTS → restore).
 *
 * 1. Music with next item an announce pad → seek near end of the song so the
 *    natural handoff runs (avoids Sonos Next() restarting HTTP TTS).
 * 2. Already on announce pads (or volume-locked on a pad/clip) → jump the
 *    whole block to the next real music track.
 */

import { isAnnounceQueuePad } from "./sonos-queue-policy.js";
import {
  isDjClipUri,
  isRampSilenceUri,
  isRestoreSilenceUri,
} from "./dj-volume-handoff.js";

/** Seconds before track end when "skip into announce" seeks. */
export const SEEK_END_LEAD_SEC = 1;

/** Default TTS length when queue metadata has no Duration. */
const DEFAULT_ANNOUNCE_DURATION_SEC = 12;

/**
 * Parse silence pad length from a PartyQueue silence URI.
 * @param {string|null|undefined} uri
 * @returns {number|null}
 */
export function parseSilencePadSec(uri) {
  const match = String(uri || "").match(
    /silence(?:-ramp)?-(\d+(?:\.\d+)?)s\.mp3/i
  );
  if (!match) return null;
  const sec = Number(match[1]);
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

function queueItemUri(item) {
  return item?.TrackUri ?? item?.uri ?? "";
}

function queueItemTitle(item) {
  return item?.Title ?? item?.title ?? "";
}

function queueItemDurationSec(item) {
  const raw = item?.Duration ?? item?.duration ?? item?.TrackDuration;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  const text = String(raw || "").trim();
  if (!text) return null;
  const parts = text.split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return null;
}

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

/**
 * Locate an upcoming (or in-progress) announce block so a volume handoff can be
 * re-armed after process restart left pads in Sonos without an in-memory session.
 *
 * @param {Array<{ TrackUri?: string, uri?: string, Title?: string, title?: string, Duration?: string }>} items
 * @param {number} currentTrack1Based
 * @returns {{
 *   rampPosition: number|null,
 *   ttsPosition: number,
 *   restorePosition: number|null,
 *   musicPosition: number,
 *   ttsUri: string,
 *   silenceSec: number,
 *   approxDurationSec: number,
 * }|null}
 */
export function findUpcomingAnnounceHandoffPlan(items, currentTrack1Based) {
  const list = Array.isArray(items) ? items : [];
  const current = Math.max(0, Math.floor(Number(currentTrack1Based) || 0));
  const currentIdx = current >= 1 ? current - 1 : -1;
  const onPad =
    currentIdx >= 0 &&
    isAnnounceQueuePad(queueItemUri(list[currentIdx]), queueItemTitle(list[currentIdx]));
  // When already on a pad, start at that pad; otherwise start at the next slot.
  let i = onPad ? currentIdx : current >= 1 ? current : 0;
  if (i < 0 || i >= list.length) return null;

  // Skip any non-pad gap (shouldn't happen for seekNearEnd) until a pad.
  while (
    i < list.length &&
    !isAnnounceQueuePad(queueItemUri(list[i]), queueItemTitle(list[i]))
  ) {
    i += 1;
  }
  if (i >= list.length) return null;

  let rampPosition = null;
  let silenceSec = 3;
  const firstUri = queueItemUri(list[i]);
  if (isRampSilenceUri(firstUri)) {
    rampPosition = i + 1;
    silenceSec = parseSilencePadSec(firstUri) || silenceSec;
    i += 1;
  }

  if (i >= list.length) return null;
  const ttsUri = queueItemUri(list[i]);
  // Require a real DJ clip after an optional ramp (silence pads alone are not enough).
  if (!isDjClipUri(ttsUri)) return null;
  const ttsPosition = i + 1;
  const approxDurationSec =
    queueItemDurationSec(list[i]) || DEFAULT_ANNOUNCE_DURATION_SEC;
  i += 1;

  let restorePosition = null;
  if (i < list.length && isRestoreSilenceUri(queueItemUri(list[i]))) {
    restorePosition = i + 1;
    const restoreSec = parseSilencePadSec(queueItemUri(list[i]));
    if (restoreSec) silenceSec = silenceSec || restoreSec;
    i += 1;
  }

  const musicPosition =
    findNextMusicTrackNumber(list, ttsPosition) ??
    (restorePosition != null ? restorePosition + 1 : ttsPosition + 1);

  return {
    rampPosition,
    ttsPosition,
    restorePosition,
    musicPosition,
    ttsUri,
    silenceSec,
    approxDurationSec,
  };
}
