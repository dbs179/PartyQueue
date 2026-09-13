/**
 * Pure Skip policy around DJ announce blocks.
 *
 * Core rule: Skip always goes to the next track. A song skip uses Sonos Next
 * — if that next row is a built announce, the announce plays. An announce skip
 * (already on a pad/clip, or volume-locked) jumps to the next real song, never
 * over a later request.
 *
 * An announce that is not built yet is a stall pad. Next onto that pad holds;
 * Skip while holding goes to the request. The 10s park watchdog is what
 * skips an unbuilt announce automatically.
 */

import {
  isAnnounceQueuePad,
  clipUrlMatchesQueueUri,
} from "./sonos-queue-policy.js";
import {
  isDjClipUri,
  isRampSilenceUri,
  isRestoreSilenceUri,
} from "./dj-volume-handoff.js";
import { isBakedAnnounceUri } from "./dj-announce-bake.js";

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
  const onPad = isAnnounceQueuePad(currentUri, currentTitle);
  // Already on the DJ/stall — Skip means the song it introduces, not the
  // next pad in a leftover 3-row block.
  if (onPad || !!ctx.volumeLocked) {
    return { action: "jumpAnnounce" };
  }
  // Song → anything: Next one row. A built announce plays; a stall pad
  // holds; a request plays. Never seek-near-end (that stays on this song)
  // and never jump over a waiting announce to its request.
  return { action: "normalNext" };
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
 *   tts2Position: number|null,
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
  if (isBakedAnnounceUri(firstUri)) {
    const ttsPosition = i + 1;
    return {
      rampPosition: null,
      ttsPosition,
      tts2Position: null,
      restorePosition: null,
      musicPosition:
        findNextMusicTrackNumber(list, ttsPosition) ?? ttsPosition + 1,
      ttsUri: firstUri,
      silenceSec,
      approxDurationSec:
        queueItemDurationSec(list[i]) || DEFAULT_ANNOUNCE_DURATION_SEC,
    };
  }
  if (isRampSilenceUri(firstUri)) {
    rampPosition = i + 1;
    silenceSec = parseSilencePadSec(firstUri) || silenceSec;
    i += 1;
    if (i < list.length && isBakedAnnounceUri(queueItemUri(list[i]))) {
      const ttsUri = queueItemUri(list[i]);
      const ttsPosition = i + 1;
      return {
        rampPosition,
        ttsPosition,
        tts2Position: null,
        restorePosition: null,
        musicPosition:
          findNextMusicTrackNumber(list, ttsPosition) ?? ttsPosition + 1,
        ttsUri,
        silenceSec,
        approxDurationSec:
          queueItemDurationSec(list[i]) || DEFAULT_ANNOUNCE_DURATION_SEC,
      };
    }
  }

  if (i >= list.length) return null;
  const ttsUri = queueItemUri(list[i]);
  // Require a real DJ clip after an optional ramp (silence pads alone are not enough).
  if (!isDjClipUri(ttsUri)) return null;
  const ttsPosition = i + 1;
  let approxDurationSec =
    queueItemDurationSec(list[i]) || DEFAULT_ANNOUNCE_DURATION_SEC;
  i += 1;

  // Banter: Holy Roller lead then Sister Static punch before the restore pad.
  // Skipping these as "already at restore" made musicPosition land on the punch
  // clip and the volume handoff skip the first song of the set.
  let tts2Position = null;
  while (i < list.length && isDjClipUri(queueItemUri(list[i]))) {
    if (tts2Position == null) tts2Position = i + 1;
    approxDurationSec +=
      queueItemDurationSec(list[i]) || DEFAULT_ANNOUNCE_DURATION_SEC;
    i += 1;
  }

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
    tts2Position,
    restorePosition,
    musicPosition,
    ttsUri,
    silenceSec,
    approxDurationSec,
  };
}

/**
 * Live positions of the announce block whose lead clip is `clipUrl`.
 *
 * Absolute queue indices captured when the block was enqueued go stale the
 * moment maintenance trims played songs off the front of the queue, so every
 * seek inside the volume handoff re-resolves against a fresh GetQueue instead.
 * Prefers the copy at or after the current track (the ramp pad may already be
 * playing). Falls back to the nearest copy behind the playhead, because by the
 * time we are holding on the restore pad the lead clip has already played.
 *
 * Block edges are read outward from the lead clip only — a stacked shout whose
 * pads sit flush against this one must not be swallowed into the range.
 *
 * @param {Array<{ TrackUri?: string, uri?: string, Title?: string, title?: string }>} items
 * @param {string} clipUrl lead TTS clip URL for this announce
 * @param {{ currentTrack?: number, playingFromQueue?: boolean }} [opts]
 * @returns {{
 *   rampPosition: number|null,
 *   ttsPosition: number,
 *   tts2Position: number|null,
 *   restorePosition: number|null,
 *   musicPosition: number|null,
 *   blockStart: number,
 *   blockEnd: number,
 * }|null}
 */
export function locateAnnounceBlockByClipUrl(
  items,
  clipUrl,
  { currentTrack = 0, playingFromQueue = false } = {}
) {
  const list = Array.isArray(items) ? items : [];
  const want = String(clipUrl || "").trim();
  if (!want) return null;
  const track = Math.floor(Number(currentTrack) || 0);
  const start = playingFromQueue && track >= 1 ? Math.max(0, track - 1) : 0;
  const isWanted = (index) => {
    const uri = queueItemUri(list[index]);
    return (
      (isDjClipUri(uri) || isBakedAnnounceUri(uri)) &&
      clipUrlMatchesQueueUri(uri, want)
    );
  };

  let hit = -1;
  for (let i = start; i < list.length; i++) {
    if (isWanted(i)) {
      hit = i;
      break;
    }
  }
  for (let i = start - 1; hit < 0 && i >= 0; i--) {
    if (isWanted(i)) hit = i;
  }
  if (hit < 0) return null;

  const hitUri = queueItemUri(list[hit]);
  const ttsPosition = hit + 1;
  const rampPosition =
    hit >= 1 && isRampSilenceUri(queueItemUri(list[hit - 1])) ? hit : null;

  // One baked row is the whole announce. Do not walk the next song — or a
  // stacked neighbour shout — as a punch/restore pad.
  if (isBakedAnnounceUri(hitUri)) {
    return {
      rampPosition,
      ttsPosition,
      tts2Position: null,
      restorePosition: null,
      musicPosition: findNextMusicTrackNumber(list, ttsPosition),
      blockStart: rampPosition ?? ttsPosition,
      blockEnd: ttsPosition,
    };
  }

  // Banter: Sister Static's punch clip sits between the lead and the restore.
  let tts2Position = null;
  let i = hit + 1;
  while (i < list.length && isDjClipUri(queueItemUri(list[i]))) {
    if (tts2Position == null) tts2Position = i + 1;
    i += 1;
  }

  let restorePosition = null;
  if (i < list.length && isRestoreSilenceUri(queueItemUri(list[i]))) {
    restorePosition = i + 1;
  }

  return {
    rampPosition,
    ttsPosition,
    tts2Position,
    restorePosition,
    musicPosition: findNextMusicTrackNumber(list, ttsPosition),
    blockStart: rampPosition ?? ttsPosition,
    blockEnd: restorePosition ?? tts2Position ?? ttsPosition,
  };
}

/**
 * Live Play target for a baked announce or stall pad, by URL only.
 * If the row is gone, refuse — never fall back to a stored index.
 *
 * @param {{
 *   items?: Array,
 *   clipUrl?: string,
 *   currentTrack?: number,
 *   currentUri?: string,
 *   playingFromQueue?: boolean,
 * }} [opts]
 * @returns {{
 *   found: boolean,
 *   alreadyOnTarget: boolean,
 *   trackNumber: number|null,
 *   musicPosition: number|null,
 * }}
 */
export function resolveAnnouncePlayTarget({
  items,
  clipUrl,
  currentTrack = 0,
  currentUri = "",
  playingFromQueue = false,
} = {}) {
  const want = String(clipUrl || "").trim();
  if (!want) {
    return {
      found: false,
      alreadyOnTarget: false,
      trackNumber: null,
      musicPosition: null,
    };
  }
  const list = Array.isArray(items) ? items : [];
  const track = Math.floor(Number(currentTrack) || 0);

  if (clipUrlMatchesQueueUri(currentUri, want)) {
    const located = locateAnnounceBlockByClipUrl(list, want, {
      currentTrack,
      playingFromQueue,
    });
    return {
      found: true,
      alreadyOnTarget: true,
      trackNumber: located?.ttsPosition ?? (track >= 1 ? track : null),
      musicPosition: located?.musicPosition ?? null,
    };
  }

  const located = locateAnnounceBlockByClipUrl(list, want, {
    currentTrack,
    playingFromQueue,
  });
  if (located) {
    return {
      found: true,
      alreadyOnTarget: false,
      trackNumber: located.ttsPosition,
      musicPosition: located.musicPosition,
    };
  }

  for (let i = 0; i < list.length; i++) {
    if (clipUrlMatchesQueueUri(queueItemUri(list[i]), want)) {
      return {
        found: true,
        alreadyOnTarget: false,
        trackNumber: i + 1,
        musicPosition: findNextMusicTrackNumber(list, i + 1),
      };
    }
  }

  return {
    found: false,
    alreadyOnTarget: false,
    trackNumber: null,
    musicPosition: null,
  };
}
