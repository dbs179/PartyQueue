import { MetaDataHelper } from "@svrooij/sonos";
import { withSonosWriteLock } from "./sonos-lock.js";
import {
  getManager,
  resolveCoordinator,
  resolveRegion,
  isNotCoordinatorError,
} from "./sonos-core.js";
import { invalidateSonosSnapshots } from "./sonos-snapshots.js";
import {
  removeRangeFor,
  autoStartDecision,
  findInsertPosition,
  findUpcomingAnnouncePadIndices,
  songMatchKey,
  isAnnounceQueuePad,
} from "./sonos-queue-policy.js";
import {
  needsShoutLeadBuffer,
  findShoutBufferTrackNumber,
  requestPosAfterShoutBuffer,
  SHOUT_LEAD_BUFFER_SEC,
} from "./shout-lead-buffer.js";
import { spotifyTrackId } from "./sampler.js";
import { recordPlayed } from "./play-history.js";
import { getDjVoiceSettings } from "./settings.js";
import {
  markOrigin,
  originOf,
  originSnapshot,
  isFiller,
} from "./queue-origin.js";
import { parseSonosTime } from "./sonos-snapshots.js";

// Remove already-played songs (everything before the current track) so the queue
// stays lean and newly added songs are never buried under a night's history.
// Only acts while the QUEUE is the active source and at least one song sits
// behind the pointer. Best-effort: never throws. A module flag prevents this
// from overlapping itself (the periodic timer is the only caller).
let trimming = false;
let trimPausedUntil = 0;

// Pause queue trimming briefly after DJ Voice inserts a clip at the front —
// otherwise a stale playhead (still pointing at the first Spotify track, now
// shifted to position 2) makes trim delete the TTS as "already played".
export function pauseQueueTrim(ms = 20000) {
  trimPausedUntil = Date.now() + Math.max(0, Number(ms) || 0);
}

export async function trimPlayedTracks(...args) {
  return withSonosWriteLock(() => trimPlayedTracksUnlocked(...args));
}

async function trimPlayedTracksUnlocked() {
  if (trimming) return { removed: 0 };
  if (Date.now() < trimPausedUntil) return { removed: 0 };
  trimming = true;
  try {
    const m = await getManager();
    const coordinator = await resolveCoordinator(m);
    const [pos, media, queue] = await Promise.all([
      coordinator.AVTransportService.GetPositionInfo().catch(() => ({ Track: 0 })),
      coordinator.AVTransportService.GetMediaInfo({ InstanceID: 0 }).catch(() => ({
        CurrentURI: "",
      })),
      coordinator.GetQueue().catch(() => ({ Result: [], UpdateID: 0 })),
    ]);

    // Only the local queue source has a meaningful "played" history to trim;
    // radio/line-in keep a stale pointer we must not act on.
    const playingFromQueue = /^x-rincon-queue:/.test(media.CurrentURI || "");
    if (!playingFromQueue) return { removed: 0 };

    // Never trim while the current track is our HTTP DJ clip (or we're still
    // on track 1 of a fresh set).
    const trackUri = String(pos.TrackURI || "");
    if (/tts_proxy|\/media\/tts\//i.test(trackUri)) return { removed: 0 };

    const range = removeRangeFor(pos.Track);
    if (!range) return { removed: 0 };

    await coordinator.AVTransportService.RemoveTrackRangeFromQueue({
      InstanceID: 0,
      UpdateID: Number(queue.UpdateID) || 0,
      StartingIndex: range.StartingIndex,
      NumberOfTracks: range.NumberOfTracks,
    });
    invalidateSonosSnapshots();
    return { removed: range.NumberOfTracks };
  } catch (err) {
    console.error("[trim] failed:", err.message);
    return { removed: 0 };
  } finally {
    trimming = false;
  }
}

export async function autoStartIfIdle(coordinator) {
  try {
    const transport = await coordinator.AVTransportService.GetTransportInfo();
    if (autoStartDecision(transport.CurrentTransportState) !== "start") return false;
    await coordinator.SwitchToQueue();
    await coordinator.Play();
    return true;
  } catch (err) {
    console.error("[autostart] failed:", err.message);
    return false;
  }
}

// The set of guest-searched track IDs from the origin store. Used to find where
// a new request belongs: just after the last searched song, ahead of everything
// else. Relying on "searched" (always tagged on add) rather than "filler" keeps
// insertion correct even for untracked filler from older sessions.
function searchedIdSet() {
  const set = new Set();
  for (const [id, meta] of originSnapshot()) {
    if (meta?.source === "searched") set.add(id);
  }
  return set;
}

export async function addTrackToQueue(...args) {
  return withSonosWriteLock(() => addTrackToQueueUnlocked(...args));
}

async function addTrackToQueueUnlocked(
  trackUri,
  {
    name = "",
    artist = "",
    force = false,
    requestedBy = null,
    requestedByUser = null,
    dedication = null,
  } = {}
) {
  if (!trackUri || !trackUri.startsWith("spotify:track:")) {
    throw new Error(`Invalid Spotify track URI: ${trackUri}`);
  }

  const m = await getManager();
  const meta = MetaDataHelper.GuessMetaDataAndTrackUri(trackUri, resolveRegion());
  const coordinator = await resolveCoordinator(m);
  const id = spotifyTrackId(trackUri);
  const wantKey = songMatchKey(name, artist);

  // Read the live queue once: we use it both to find the searched insert spot
  // (ahead of filler, after any waiting searched songs) and to detect whether
  // this exact song is already sitting in the queue. Best-effort - if the read
  // fails we fall back to a plain append.
  let items = [];
  let updateId = 0;
  let currentTrack = 0;
  let playingFromQueue = false;
  try {
    const [queue, pos, media] = await Promise.all([
      coordinator.GetQueue(),
      coordinator.AVTransportService.GetPositionInfo().catch(() => ({ Track: 0 })),
      coordinator.AVTransportService.GetMediaInfo({ InstanceID: 0 }).catch(() => ({
        CurrentURI: "",
      })),
    ]);
    items = Array.isArray(queue.Result) ? queue.Result : [];
    updateId = Number(queue.UpdateID) || 0;
    currentTrack = Number(pos.Track) || 0;
    playingFromQueue = /^x-rincon-queue:/.test(media.CurrentURI || "");
  } catch (err) {
    console.error("[queue] live read failed, appending:", err.message);
  }

  const insertPos = findInsertPosition(items, {
    currentTrack,
    playingFromQueue,
    searchedIds: searchedIdSet(),
  });

  // Is there already an UPCOMING copy of this song? (Skip the current track.)
  // Match by track ID OR by song key, since the same song can have several
  // Spotify IDs - that way we promote the existing copy instead of duplicating.
  // `force` (guest chose "add this version anyway") drops the song-key match so
  // a deliberate alternate version can be added; the exact-ID guard still stands
  // so we never stack two copies of the very same recording.
  const start = playingFromQueue && currentTrack >= 1 ? currentTrack : 0;
  let existing = null; // { pos, id }
  for (let i = start; i < items.length; i++) {
    const it = items[i];
    const itId = spotifyTrackId(it.TrackUri ?? it.uri);
    const sameId = id && itId === id;
    const sameSong = !force && wantKey && songMatchKey(it.Title, it.Artist) === wantKey;
    if (sameId || sameSong) {
      existing = { pos: i + 1, id: itId };
      break;
    }
  }

  let promoted = false;
  let duplicated = false;
  const existingWasRequested =
    !!existing?.id && originOf(existing.id) === "searched";
  const byOpts = { requestedBy, requestedByUser, dedication };
  if (existing && !existingWasRequested) {
    // Already queued as filler (Random / Never-Ending / discovery): move that
    // copy into the searched block and re-tag it — no duplicate.
    let insertBefore = insertPos || items.length + 1;
    insertBefore = Math.max(1, Math.min(insertBefore, items.length + 1));
    if (insertBefore !== existing.pos && insertBefore !== existing.pos + 1) {
      try {
        await coordinator.AVTransportService.ReorderTracksInQueue({
          InstanceID: 0,
          StartingIndex: existing.pos,
          NumberOfTracks: 1,
          InsertBefore: insertBefore,
          UpdateID: updateId,
        });
      } catch (err) {
        console.error("[queue] promote reorder failed:", err.message);
      }
    }
    promoted = true;
    if (existing.id) markOrigin([existing.id], "searched", byOpts);
  } else if (existing && existingWasRequested) {
    // Already a guest request — allow another copy so Maria / Dave / Owen can
    // each dedicate the same song with its own live note + stats row.
    await enqueueMeta(m, meta, insertPos);
    if (id) {
      markOrigin([id], "searched", { ...byOpts, appendInstance: true });
    }
    duplicated = true;
    existing = null;
  } else {
    // Not already waiting in the queue -> insert a fresh copy ahead of filler.
    await enqueueMeta(m, meta, insertPos);
    if (id) markOrigin([id], "searched", byOpts);
  }

  // Guest requests enter song history too, so Random won't re-pick them the
  // moment they leave the live queue (within the songMemory window).
  if (id) {
    recordPlayed([{ id, artist, name, source: "searched", requestedBy }]);
  }

  const queueWasEmpty = items.length === 0;
  // Empty queue + shout-outs: skip auto-start so the DJ clip can lead.
  const dj = getDjVoiceSettings();
  const deferStartForShout =
    queueWasEmpty && !!dj.djVoiceEnabled && !!dj.djShoutEnabled;

  const started = deferStartForShout
    ? false
    : await autoStartIfIdle(coordinator);
  invalidateSonosSnapshots();

  // Guest-facing queue spot (#1 = next up). Absolute Sonos index minus the
  // now-playing offset when we're playing from the queue.
  const offset = playingFromQueue && currentTrack >= 1 ? currentTrack : 0;
  let absPos;
  if (existing) {
    absPos = promoted ? insertPos || existing.pos : existing.pos;
  } else {
    absPos = insertPos || items.length + 1;
  }
  const queuePosition = Math.max(1, (Number(absPos) || 1) - offset);

  return {
    room: coordinator.Name,
    group: coordinator.GroupName,
    started,
    promoted,
    duplicated,
    requestCreated: !existing || promoted || duplicated,
    alreadyRequested: false,
    queueWasEmpty,
    deferredStart: deferStartForShout,
    queuePosition,
    // Absolute 1-based Sonos index (for DJ TTS inserts). queuePosition above is
    // guest-facing (#1 = next up) and is wrong for AddURIToQueue placement.
    absoluteQueuePosition: Math.max(1, Number(absPos) || 1),
  };
}

// Append a whole Spotify PLAYLIST to the end of the queue in a single call.
// The Sonos library maps spotify:playlist:<id> to a playlist container, so the
// playlist's tracks expand into the queue (append-only, never replace/skip).
export async function addPlaylistToQueue(...args) {
  return withSonosWriteLock(() => addPlaylistToQueueUnlocked(...args));
}

async function addPlaylistToQueueUnlocked(playlistUri) {
  if (!playlistUri || !/^spotify:(user:[^:]+:)?playlist:/.test(playlistUri)) {
    throw new Error(`Invalid Spotify playlist URI: ${playlistUri}`);
  }
  const m = await getManager();
  const meta = MetaDataHelper.GuessMetaDataAndTrackUri(playlistUri, resolveRegion());
  const coordinator = await enqueueMeta(m, meta);
  const started = await autoStartIfIdle(coordinator);
  invalidateSonosSnapshots();
  return { room: coordinator.Name, group: coordinator.GroupName, started };
}

export function httpAudioMeta(url) {
  return { trackUri: url, metadata: "" };
}

export async function enqueueMeta(m, meta, position = 0) {
  const enqueue = (coordinator) =>
    coordinator.AVTransportService.AddURIToQueue({
      InstanceID: 0,
      EnqueuedURI: meta.trackUri,
      EnqueuedURIMetaData: meta.metadata,
      DesiredFirstTrackNumberEnqueued: Number(position) || 0,
      EnqueueAsNext: false,
    });

  let coordinator = await resolveCoordinator(m);
  try {
    await enqueue(coordinator);
  } catch (err) {
    if (!isNotCoordinatorError(err)) throw err;
    coordinator = await resolveCoordinator(m, { fresh: true });
    await enqueue(coordinator);
  }
  return coordinator;
}

// Insert (or append) an HTTP MP3 into the Sonos queue. Sonos fetches `url`
// itself, so it must be a LAN-reachable http:// address (not localhost).
export async function enqueueHttpAudio(...args) {
  return withSonosWriteLock(() => enqueueHttpAudioUnlocked(...args));
}

async function enqueueHttpAudioUnlocked(
  url,
  { title, artist, durationSec, position = 0 } = {}
) {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error("enqueueHttpAudio requires an http(s) URL Sonos can reach.");
  }
  const m = await getManager();
  const meta = httpAudioMeta(url, { title, artist, durationSec });
  const coordinator = await enqueueMeta(m, meta, position);
  invalidateSonosSnapshots();
  return { room: coordinator.Name, group: coordinator.GroupName, url, position };
}

// Find a queued track's CURRENT absolute 1-based position from a fresh queue
// read, matching by TrackUri nearest where the user last saw it. This stays
// correct even though positions shift as songs play or other guests edit. For
// duplicate songs it picks the copy closest to the expected spot. Returns null
// when the song is no longer in the queue.
function resolveQueuePosition(items, uri, expected) {
  if (!uri) return null;
  const matches = [];
  items.forEach((t, idx) => {
    if (t.TrackUri && t.TrackUri === uri) matches.push(idx + 1);
  });
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const want = Number(expected) || matches[0];
  return matches.reduce((best, p) =>
    Math.abs(p - want) < Math.abs(best - want) ? p : best
  );
}

// Remove a single song from the queue, re-resolving its live position first.
export async function removeQueueTrack(...args) {
  return withSonosWriteLock(() => removeQueueTrackUnlocked(...args));
}

async function removeQueueTrackUnlocked({ uri, position }) {
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);
  const queue = await coordinator.GetQueue();
  const items = Array.isArray(queue.Result) ? queue.Result : [];

  const pos = resolveQueuePosition(items, uri, position);
  if (!pos) throw new Error("That song is no longer in the queue.");

  await coordinator.AVTransportService.RemoveTrackRangeFromQueue({
    InstanceID: 0,
    UpdateID: Number(queue.UpdateID) || 0,
    StartingIndex: pos,
    NumberOfTracks: 1,
  });
  invalidateSonosSnapshots();
  return { removed: true };
}

// Contiguous 1-based ranges from a sorted list of indices (for batch removes).
function contiguousIndexRanges(indices) {
  const sorted = [...new Set(indices.map((n) => Number(n) || 0).filter((n) => n >= 1))].sort(
    (a, b) => a - b
  );
  if (!sorted.length) return [];
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
      continue;
    }
    ranges.push({ StartingIndex: start, NumberOfTracks: prev - start + 1 });
    start = prev = sorted[i];
  }
  ranges.push({ StartingIndex: start, NumberOfTracks: prev - start + 1 });
  return ranges;
}

/**
 * Strip unplayed DJ ramp/TTS pads from the upcoming queue so a new announce
 * can supersede ones that haven't started (avoids back-to-back shout-outs).
 * @param {{ beforePosition?: number }} [opts]
 *   beforePosition: count how many removed pads sat strictly before this
 *   1-based index (for adjusting an insert position after the wipe).
 * @returns {Promise<{
 *   removed: number,
 *   removedBefore: number,
 *   protectedThrough: number
 * }>}
 */
export async function removeUpcomingAnnouncePads(...args) {
  return withSonosWriteLock(() => removeUpcomingAnnouncePadsUnlocked(...args));
}

async function removeUpcomingAnnouncePadsUnlocked({ beforePosition } = {}) {
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);
  const [pos, media, queue] = await Promise.all([
    coordinator.AVTransportService.GetPositionInfo().catch(() => ({ Track: 0 })),
    coordinator.AVTransportService.GetMediaInfo({ InstanceID: 0 }).catch(() => ({
      CurrentURI: "",
    })),
    coordinator.GetQueue().catch(() => ({ Result: [], UpdateID: 0 })),
  ]);
  const items = Array.isArray(queue.Result) ? queue.Result : [];
  const playingFromQueue = /^x-rincon-queue:/.test(media.CurrentURI || "");
  const track = Number(pos.Track) || 0;
  let protectedThrough = 0;
  const currentIndex = track - 1;
  if (
    playingFromQueue &&
    currentIndex >= 0 &&
    currentIndex < items.length &&
    isAnnounceQueuePad(
      items[currentIndex].TrackUri ?? items[currentIndex].uri,
      items[currentIndex].Title ?? items[currentIndex].title ?? ""
    )
  ) {
    protectedThrough = track;
    while (protectedThrough < items.length) {
      const item = items[protectedThrough];
      if (
        !isAnnounceQueuePad(
          item.TrackUri ?? item.uri,
          item.Title ?? item.title ?? ""
        )
      ) {
        break;
      }
      protectedThrough += 1;
    }
  }
  const indices = findUpcomingAnnouncePadIndices(items, {
    currentTrack: track,
    playingFromQueue,
  });
  if (!indices.length) {
    return { removed: 0, removedBefore: 0, protectedThrough };
  }

  const before = Number(beforePosition) || 0;
  const removedBefore =
    before >= 1 ? indices.filter((i) => i < before).length : 0;

  // Highest ranges first so earlier indices stay valid after each remove.
  const ranges = contiguousIndexRanges(indices).sort(
    (a, b) => b.StartingIndex - a.StartingIndex
  );
  let updateId = Number(queue.UpdateID) || 0;
  let removed = 0;
  for (const range of ranges) {
    try {
      await coordinator.AVTransportService.RemoveTrackRangeFromQueue({
        InstanceID: 0,
        UpdateID: updateId,
        StartingIndex: range.StartingIndex,
        NumberOfTracks: range.NumberOfTracks,
      });
      removed += range.NumberOfTracks;
      updateId = 0;
    } catch (err) {
      console.error(
        `[dj-voice] remove announce pads #${range.StartingIndex}+${range.NumberOfTracks} failed:`,
        err.message
      );
      break;
    }
  }
  if (removed) {
    invalidateSonosSnapshots();
    console.log(`[dj-voice] removed ${removed} superseded announce pad(s)`);
  }
  return { removed, removedBefore, protectedThrough };
}

/**
 * Last call: clear upcoming filler — Random / Never-Ending picks, Discover
 * finds, and era-mood top-ups — so only real requests play out the night.
 * Guest requests, DJ clips, and the current track are untouched.
 * @param {{ beforePosition?: number }} [opts]
 *   beforePosition: count how many removed songs sat strictly before this
 *   1-based index (for adjusting an announce position after the wipe).
 * @returns {Promise<{ removed: number, removedBefore: number }>}
 */
export async function removeUpcomingFillerTracks(...args) {
  return withSonosWriteLock(() => removeUpcomingFillerTracksUnlocked(...args));
}

async function removeUpcomingFillerTracksUnlocked({ beforePosition } = {}) {
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);
  const [pos, media, queue] = await Promise.all([
    coordinator.AVTransportService.GetPositionInfo().catch(() => ({ Track: 0 })),
    coordinator.AVTransportService.GetMediaInfo({ InstanceID: 0 }).catch(() => ({
      CurrentURI: "",
    })),
    coordinator.GetQueue().catch(() => ({ Result: [], UpdateID: 0 })),
  ]);
  const items = Array.isArray(queue.Result) ? queue.Result : [];
  const playingFromQueue = /^x-rincon-queue:/.test(media.CurrentURI || "");
  const track = Number(pos.Track) || 0;
  // First index eligible for removal (0-based): everything strictly after the
  // current track when playing from the queue, else the whole queue.
  const startIdx = playingFromQueue && track >= 1 ? track : 0;
  const indices = [];
  for (let i = startIdx; i < items.length; i++) {
    const id = spotifyTrackId(items[i].TrackUri ?? null);
    if (id && isFiller(id)) indices.push(i + 1);
  }
  if (!indices.length) return { removed: 0, removedBefore: 0 };

  const before = Number(beforePosition) || 0;
  const removedBefore =
    before >= 1 ? indices.filter((i) => i < before).length : 0;

  // Highest ranges first so earlier indices stay valid after each remove.
  const ranges = contiguousIndexRanges(indices).sort(
    (a, b) => b.StartingIndex - a.StartingIndex
  );
  let updateId = Number(queue.UpdateID) || 0;
  let removed = 0;
  for (const range of ranges) {
    try {
      await coordinator.AVTransportService.RemoveTrackRangeFromQueue({
        InstanceID: 0,
        UpdateID: updateId,
        StartingIndex: range.StartingIndex,
        NumberOfTracks: range.NumberOfTracks,
      });
      removed += range.NumberOfTracks;
      updateId = 0;
    } catch (err) {
      console.error(
        `[closing-time] remove filler #${range.StartingIndex}+${range.NumberOfTracks} failed:`,
        err.message
      );
      break;
    }
  }
  if (removed) {
    invalidateSonosSnapshots();
    console.log(`[closing-time] cleared ${removed} filler song(s) for last call`);
  }
  return { removed, removedBefore };
}

// Move a song so it sits just before `beforeUri` (or to the end when null).
// Both the moved song and the target neighbor are re-resolved from a live read
// so the move lands correctly even if the queue shifted. Sonos interprets
// InsertBefore in the queue's current numbering, so the neighbor's live
// position is exactly the value we need.
/**
 * When a mid-set shout would race the end of the current song, demote the
 * request behind one non-request track so that song plays first (no pause).
 * Returns the (possibly updated) absolute queue position of the request.
 */
export async function ensureShoutLeadBuffer(...args) {
  return withSonosWriteLock(() => ensureShoutLeadBufferUnlocked(...args));
}

async function ensureShoutLeadBufferUnlocked(
  requestAbsPos,
  { thresholdSec = SHOUT_LEAD_BUFFER_SEC } = {}
) {
  const planned = Math.max(1, Math.floor(Number(requestAbsPos)) || 1);
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);

  let items = [];
  let updateId = 0;
  let currentTrack = 0;
  let playingFromQueue = false;
  let remainingSec = null;
  try {
    const [queue, pos, media] = await Promise.all([
      coordinator.GetQueue(),
      coordinator.AVTransportService.GetPositionInfo().catch(() => ({
        Track: 0,
        RelTime: "",
        TrackDuration: "",
      })),
      coordinator.AVTransportService.GetMediaInfo({ InstanceID: 0 }).catch(
        () => ({ CurrentURI: "" })
      ),
    ]);
    items = Array.isArray(queue.Result) ? queue.Result : [];
    updateId = Number(queue.UpdateID) || 0;
    currentTrack = Number(pos.Track) || 0;
    playingFromQueue = /^x-rincon-queue:/.test(media.CurrentURI || "");
    const durationSec = parseSonosTime(pos.TrackDuration);
    const positionSec = parseSonosTime(pos.RelTime);
    if (
      Number.isFinite(durationSec) &&
      durationSec > 0 &&
      Number.isFinite(positionSec)
    ) {
      remainingSec = Math.max(0, durationSec - positionSec);
    }
  } catch (err) {
    console.warn("[queue] shout lead buffer read failed:", err.message);
    return {
      buffered: false,
      absoluteQueuePosition: planned,
      reason: "read-failed",
    };
  }

  if (!playingFromQueue) {
    return {
      buffered: false,
      absoluteQueuePosition: planned,
      reason: "not-on-queue",
    };
  }

  if (
    !needsShoutLeadBuffer({
      requestAbsPos: planned,
      currentTrack,
      remainingSec,
      thresholdSec,
    })
  ) {
    return {
      buffered: false,
      absoluteQueuePosition: planned,
      reason: "not-needed",
    };
  }

  const bufferPos = findShoutBufferTrackNumber(items, {
    requestAbsPos: planned,
    searchedIds: searchedIdSet(),
  });
  if (bufferPos == null) {
    // Last song / only requests — keep request next-up; imminent pause applies.
    return {
      buffered: false,
      absoluteQueuePosition: planned,
      reason: "no-buffer",
    };
  }

  const insertBefore = bufferPos + 1;
  if (insertBefore === planned || insertBefore === planned + 1) {
    return {
      buffered: false,
      absoluteQueuePosition: planned,
      reason: "already-buffered",
    };
  }

  try {
    await coordinator.AVTransportService.ReorderTracksInQueue({
      InstanceID: 0,
      StartingIndex: planned,
      NumberOfTracks: 1,
      InsertBefore: insertBefore,
      UpdateID: updateId,
    });
  } catch (err) {
    console.warn("[queue] shout lead buffer reorder failed:", err.message);
    return {
      buffered: false,
      absoluteQueuePosition: planned,
      reason: "reorder-failed",
    };
  }

  const nextPos = requestPosAfterShoutBuffer(planned, bufferPos);
  invalidateSonosSnapshots();
  console.log(
    `[queue] shout lead buffer: demoted request #${planned} behind #${bufferPos} → #${nextPos} (${Math.round(remainingSec)}s left)`
  );
  return {
    buffered: true,
    absoluteQueuePosition: nextPos,
    bufferTrack: bufferPos,
    reason: "demoted",
  };
}

export async function reorderQueueTrack(...args) {
  return withSonosWriteLock(() => reorderQueueTrackUnlocked(...args));
}

async function reorderQueueTrackUnlocked({
  uri,
  fromPosition,
  beforeUri,
  beforePosition,
}) {
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);
  const queue = await coordinator.GetQueue();
  const items = Array.isArray(queue.Result) ? queue.Result : [];

  const from = resolveQueuePosition(items, uri, fromPosition);
  if (!from) throw new Error("That song is no longer in the queue.");

  let insertBefore;
  if (!beforeUri) {
    insertBefore = items.length + 1; // dropped at the end
  } else {
    insertBefore =
      resolveQueuePosition(items, beforeUri, beforePosition) ?? items.length + 1;
  }
  insertBefore = Math.max(1, Math.min(insertBefore, items.length + 1));

  // No-op if it would land in the same place.
  if (insertBefore === from || insertBefore === from + 1) {
    return { moved: false };
  }

  await coordinator.AVTransportService.ReorderTracksInQueue({
    InstanceID: 0,
    StartingIndex: from,
    NumberOfTracks: 1,
    InsertBefore: insertBefore,
    UpdateID: Number(queue.UpdateID) || 0,
  });
  invalidateSonosSnapshots();
  return { moved: true };
}

// Host-only action: wipe the whole queue for the target group.
export async function clearQueue(...args) {
  return withSonosWriteLock(() => clearQueueUnlocked(...args));
}

async function clearQueueUnlocked() {
  const m = await getManager();
  let coordinator = await resolveCoordinator(m);

  const stop = async (c) => {
    try {
      await c.Stop();
    } catch {
      /* best effort */
    }
  };
  const removeAll = (c) =>
    c.AVTransportService.RemoveAllTracksFromQueue({ InstanceID: 0 });

  // Stop first so Clear is immediately audible once it owns the write lock.
  await stop(coordinator);
  let alreadyEmpty = false;
  try {
    await removeAll(coordinator);
  } catch (err) {
    // Error 804 means the queue is already empty \u2014 treat that as success.
    if (/\b804\b/.test(err?.message ?? "")) {
      alreadyEmpty = true;
    } else {
      // Stale topology: re-resolve against the live coordinator and retry once.
      if (!isNotCoordinatorError(err)) throw err;
      coordinator = await resolveCoordinator(m, { fresh: true });
      await stop(coordinator);
      try {
        await removeAll(coordinator);
      } catch (retryErr) {
        if (!/\b804\b/.test(retryErr?.message ?? "")) throw retryErr;
        alreadyEmpty = true;
      }
    }
  }

  invalidateSonosSnapshots();
  return {
    room: coordinator.Name,
    group: coordinator.GroupName,
    ...(alreadyEmpty ? { alreadyEmpty: true } : {}),
  };
}
