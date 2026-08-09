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
import { ensureOrderedPlayModeOn } from "./sonos-transport.js";
import {
  needsShoutLeadBuffer,
  findShoutBufferTrackNumber,
  requestPosAfterShoutBuffer,
  SHOUT_LEAD_BUFFER_SEC,
} from "./shout-lead-buffer.js";
import { spotifyTrackId } from "./sampler.js";
import { getDjVoiceSettings } from "./settings.js";
import {
  markOrigin,
  originOf,
  originSnapshot,
  isFiller,
  clearSearchedOccurrence,
} from "./queue-origin.js";
import { parseSonosTime } from "./sonos-snapshots.js";
import { queueWorkWasPreempted } from "./queue-preempt.js";

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

/**
 * Empty-queue shout path: park on the queue without Play so the first song
 * can't audibly start while TTS is still generating (then get paused + restarted
 * after the DJ pads insert).
 */
export async function holdIdleForDeferredShout(coordinator) {
  try {
    const media = await coordinator.AVTransportService.GetMediaInfo({
      InstanceID: 0,
    }).catch(() => null);
    const onQueue = /^x-rincon-queue:/.test(media?.CurrentURI || "");
    if (!onQueue) await coordinator.SwitchToQueue();
    // Always Pause after landing on the queue. Sonos sometimes begins the first
    // enqueued track on SwitchToQueue / AddURIToQueue; leaving it PLAYING here
    // is exactly the empty-queue "tease → DJ → restart" glitch.
    try {
      await coordinator.Pause();
    } catch {
      /* already STOPPED is fine */
    }
    console.log("[queue] held idle for deferred DJ shout");
    return true;
  } catch (err) {
    console.warn("[queue] hold for deferred shout failed:", err.message);
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

const SET_REQUEST_SIZE = 5;

/**
 * Pure: pick Set Request tracks to enqueue — drop invalid URIs, songs already
 * upcoming, and duplicate Spotify ids inside the same payload (Spotify top
 * tracks can repeat). Preserves first-seen order up to `limit`.
 * @param {Array<{ uri: string, name?: string, artist?: string }>} tracks
 * @param {Iterable<string>|Set<string>} [upcomingIds]
 * @param {number} [limit]
 */
export function filterSetRequestTracks(
  tracks,
  upcomingIds = [],
  limit = SET_REQUEST_SIZE
) {
  const blocked =
    upcomingIds instanceof Set ? upcomingIds : new Set(upcomingIds || []);
  const max = Math.max(1, Math.floor(Number(limit) || SET_REQUEST_SIZE));
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(tracks) ? tracks : []) {
    if (!t || typeof t.uri !== "string" || !t.uri.startsWith("spotify:track:")) {
      continue;
    }
    const id = spotifyTrackId(t.uri);
    if (!id || blocked.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Guest Set Request: enqueue multiple searched tracks under one write lock so
 * they stay a contiguous block at the end of the request block.
 * @param {Array<{ uri: string, name?: string, artist?: string }>} tracks
 * @param {{ requestedBy?: string|null, requestedByUser?: string|null }} [meta]
 */
export async function addSetRequestToQueue(...args) {
  return withSonosWriteLock(() => addSetRequestToQueueUnlocked(...args));
}

async function addSetRequestToQueueUnlocked(
  tracks,
  { requestedBy = null, requestedByUser = null } = {}
) {
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);
  await ensureOrderedPlayModeOn(coordinator);
  const byOpts = {
    requestedBy,
    requestedByUser,
    setRequest: true,
  };

  let items = [];
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
    currentTrack = Number(pos.Track) || 0;
    playingFromQueue = /^x-rincon-queue:/.test(media.CurrentURI || "");
  } catch (err) {
    console.error("[queue] set-request live read failed:", err.message);
  }

  const start = playingFromQueue && currentTrack >= 1 ? currentTrack : 0;
  const upcomingIds = new Set();
  for (let i = start; i < items.length; i++) {
    const itId = spotifyTrackId(items[i]?.TrackUri ?? items[i]?.uri);
    if (itId) upcomingIds.add(itId);
  }

  if (!filterSetRequestTracks(tracks, [], SET_REQUEST_SIZE).length) {
    throw new Error("No tracks to add for this Set Request.");
  }
  const toAdd = filterSetRequestTracks(tracks, upcomingIds, SET_REQUEST_SIZE);
  if (!toAdd.length) {
    throw new Error(
      "Those songs are already coming up — try another artist."
    );
  }

  // Fresh searchedIds each insert so later set tracks stay after earlier ones.
  let insertPos = findInsertPosition(items, {
    currentTrack,
    playingFromQueue,
    searchedIds: searchedIdSet(),
  });
  // Sonos: 0 = append. For a growing block, keep an absolute cursor.
  let nextPos =
    insertPos === 0 ? items.length + 1 : Math.max(1, Number(insertPos) || 1);
  const added = [];

  for (const t of toAdd) {
    const meta = MetaDataHelper.GuessMetaDataAndTrackUri(
      t.uri,
      resolveRegion()
    );
    await enqueueMeta(m, meta, nextPos);
    const id = spotifyTrackId(t.uri);
    if (id) {
      markOrigin([id], "searched", {
        ...byOpts,
        appendInstance: upcomingIds.has(id),
      });
      upcomingIds.add(id);
      // Song memory waits until Now Playing / Skip — deleted-before-play
      // requests must not burn the anti-repeat window.
    }
    added.push({
      uri: t.uri,
      id: id || null,
      name: t.name || "",
      artist: t.artist || "",
      absoluteQueuePosition: nextPos,
    });
    nextPos += 1;
  }

  const queueWasEmpty = items.length === 0;
  const dj = getDjVoiceSettings();
  const deferStartForShout =
    queueWasEmpty && !!dj.djVoiceEnabled && !!dj.djShoutEnabled;
  let started = false;
  if (deferStartForShout) {
    await holdIdleForDeferredShout(coordinator);
  } else {
    started = await autoStartIfIdle(coordinator);
  }
  invalidateSonosSnapshots();

  const offset = playingFromQueue && currentTrack >= 1 ? currentTrack : 0;
  const firstAbs = added[0]?.absoluteQueuePosition || 1;
  const queuePosition = Math.max(1, firstAbs - offset);

  return {
    room: coordinator.Name,
    group: coordinator.GroupName,
    started,
    added: added.length,
    tracks: added,
    queueWasEmpty,
    deferredStart: deferStartForShout,
    queuePosition,
    absoluteQueuePosition: firstAbs,
    requestCreated: true,
  };
}

export { SET_REQUEST_SIZE };

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
  await ensureOrderedPlayModeOn(coordinator);
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
    let reorderOk = true;
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
        reorderOk = false;
      }
    }
    if (reorderOk) {
      promoted = true;
      if (existing.id) markOrigin([existing.id], "searched", byOpts);
    } else {
      // Reorder failed — leave the filler where it is and enqueue a real request
      // copy. Never mark searched unless we actually placed a request row.
      await enqueueMeta(m, meta, insertPos);
      if (id) markOrigin([id], "searched", byOpts);
      duplicated = true;
      existing = null;
    }
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

  // Guest requests enter song memory when they are heard (Now Playing) or
  // skipped — not at enqueue — so a host delete before play leaves Random free.

  const queueWasEmpty = items.length === 0;
  // Empty queue + shout-outs: skip auto-start so the DJ clip can lead.
  const dj = getDjVoiceSettings();
  const deferStartForShout =
    queueWasEmpty && !!dj.djVoiceEnabled && !!dj.djShoutEnabled;

  let started = false;
  if (deferStartForShout) {
    await holdIdleForDeferredShout(coordinator);
  } else {
    started = await autoStartIfIdle(coordinator);
  }
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

/**
 * Strip superseded announce pads and insert ramp → TTS → restore under a
 * single write lock so guest adds / Random cannot split the block. Checks
 * preempt between Sonos calls so Clear Queue can abort mid-insert (Pause
 * stays on the transport lane and does not wait for this lock).
 *
 * @param {{
 *   queuePosition?: number,
 *   preemptGeneration?: number,
 *   applyLeadBuffer?: boolean,
 *   requestUri?: string|null,
 *   ramp: { url: string, title?: string, artist?: string, durationSec?: number },
 *   tts: { url: string, title?: string, artist?: string, durationSec?: number },
 *   restore: { url: string, title?: string, artist?: string, durationSec?: number },
 *   ops?: {
 *     removePads?: Function,
 *     enqueue?: Function,
 *     pauseTrim?: Function,
 *     ensureLeadBuffer?: Function,
 *   }
 * }} opts
 */
export async function insertAnnounceBlock(opts) {
  return withSonosWriteLock(() => insertAnnounceBlockUnlocked(opts));
}

async function insertAnnounceBlockUnlocked({
  queuePosition = 1,
  preemptGeneration,
  ramp,
  tts,
  restore,
  applyLeadBuffer = false,
  requestUri = null,
  ops = {},
} = {}) {
  const removePads = ops.removePads || removeUpcomingAnnouncePadsUnlocked;
  const enqueue = ops.enqueue || enqueueHttpAudioUnlocked;
  const pauseTrim = ops.pauseTrim || pauseQueueTrim;
  const ensureLeadBuffer =
    ops.ensureLeadBuffer || ensureShoutLeadBufferUnlocked;
  const ensurePlayMode =
    ops.ensurePlayMode ||
    (async () => {
      const m = await getManager();
      const coordinator = await resolveCoordinator(m);
      await ensureOrderedPlayModeOn(coordinator);
    });
  const preempted = () =>
    preemptGeneration != null && queueWorkWasPreempted(preemptGeneration);

  if (preempted()) {
    return { ok: false, skipped: true, reason: "queue-preempted" };
  }
  if (!ramp?.url || !tts?.url || !restore?.url) {
    throw new Error("insertAnnounceBlock requires ramp, tts, and restore urls.");
  }

  try {
    await ensurePlayMode();
  } catch (err) {
    console.warn("[announce-block] playmode check failed:", err?.message || err);
  }

  pauseTrim(25000);
  let rampPos = Number(queuePosition) || 1;

  // Mid-set guest shouts: re-resolve + demote under this same write lock so the
  // pads cannot land after another mutation shifted the request back to next-up
  // during script/TTS (route demote alone leaves that gap).
  if (applyLeadBuffer) {
    try {
      if (requestUri) {
        const m = await getManager();
        const coordinator = await resolveCoordinator(m);
        const queue = await coordinator.GetQueue().catch(() => ({ Result: [] }));
        const items = Array.isArray(queue.Result) ? queue.Result : [];
        const live = resolveQueuePosition(items, requestUri, rampPos);
        if (live) rampPos = live;
      }
      const lead = await ensureLeadBuffer(rampPos);
      if (Number.isFinite(lead?.absoluteQueuePosition)) {
        if (lead.absoluteQueuePosition !== rampPos) {
          console.log(
            `[announce-block] lead buffer under insert lock: #${rampPos} → #${lead.absoluteQueuePosition}` +
              (lead.reason ? ` (${lead.reason})` : "")
          );
        }
        rampPos = lead.absoluteQueuePosition;
      }
    } catch (err) {
      console.warn(
        "[announce-block] lead buffer under insert lock failed:",
        err?.message || err
      );
    }
  }

  if (preempted()) {
    return { ok: false, skipped: true, reason: "queue-preempted" };
  }

  let wiped = { removed: 0, removedBefore: 0, protectedThrough: 0 };
  try {
    wiped = await removePads({ beforePosition: rampPos });
    if (wiped.removedBefore > 0) {
      rampPos = Math.max(1, rampPos - wiped.removedBefore);
    }
    if (wiped.protectedThrough >= rampPos) {
      rampPos = wiped.protectedThrough + 1;
    }
  } catch (err) {
    console.warn(
      "[announce-block] supersede pad strip failed:",
      err?.message || err
    );
  }

  if (preempted()) {
    return { ok: false, skipped: true, reason: "queue-preempted", wiped };
  }

  const ttsPos = rampPos + 1;
  const restorePos = ttsPos + 1;
  const clipOpts = (clip, position) => ({
    title: clip.title,
    artist: clip.artist,
    durationSec: clip.durationSec,
    position,
  });

  await enqueue(ramp.url, clipOpts(ramp, rampPos));
  if (preempted()) {
    return {
      ok: false,
      skipped: true,
      reason: "queue-preempted",
      partial: true,
      wiped,
      rampPos,
      ttsPos,
      restorePos,
    };
  }

  await enqueue(tts.url, clipOpts(tts, ttsPos));
  if (preempted()) {
    return {
      ok: false,
      skipped: true,
      reason: "queue-preempted",
      partial: true,
      wiped,
      rampPos,
      ttsPos,
      restorePos,
    };
  }

  await enqueue(restore.url, clipOpts(restore, restorePos));
  if (preempted()) {
    // Pads are fully in; still skip handoff/Play so Clear can own the room.
    return {
      ok: false,
      skipped: true,
      reason: "queue-preempted",
      partial: true,
      wiped,
      rampPos,
      ttsPos,
      restorePos,
    };
  }

  return {
    ok: true,
    rampPos,
    ttsPos,
    restorePos,
    wiped,
  };
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
  const [queue, posInfo, media] = await Promise.all([
    coordinator.GetQueue(),
    coordinator.AVTransportService.GetPositionInfo().catch(() => ({
      Track: 0,
    })),
    coordinator.AVTransportService.GetMediaInfo({ InstanceID: 0 }).catch(
      () => ({ CurrentURI: "" })
    ),
  ]);
  const items = Array.isArray(queue.Result) ? queue.Result : [];

  const pos = resolveQueuePosition(items, uri, position);
  if (!pos) throw new Error("That song is no longer in the queue.");

  const trackId = spotifyTrackId(uri || items[pos - 1]?.TrackUri || null);
  const currentTrack = Number(posInfo.Track) || 0;
  const playingFromQueue = /^x-rincon-queue:/.test(media.CurrentURI || "");
  // Only clear live instances for unplayed / now-playing copies. Tracks behind
  // the playhead were already consumed when they left Now Playing.
  if (
    trackId &&
    originOf(trackId) === "searched" &&
    !(playingFromQueue && currentTrack >= 1 && pos < currentTrack)
  ) {
    const occ = searchedOccurrenceIndexForPosition(items, {
      trackId,
      absolutePos: pos,
      currentTrack,
      playingFromQueue,
    });
    if (occ != null) clearSearchedOccurrence(trackId, occ);
  }

  await coordinator.AVTransportService.RemoveTrackRangeFromQueue({
    InstanceID: 0,
    UpdateID: Number(queue.UpdateID) || 0,
    StartingIndex: pos,
    NumberOfTracks: 1,
  });
  invalidateSonosSnapshots();
  return { removed: true };
}

/**
 * Prefer Sonos NewUpdateID after a queue mutation; fall back to a live
 * GetQueue read so chained removes never send UpdateID 0.
 * @param {{ NewUpdateID?: number|string }|null|undefined} removeResult
 * @param {number} previous
 * @param {{ GetQueue?: Function }|null} [coordinator]
 */
export async function refreshQueueUpdateId(
  removeResult,
  previous,
  coordinator = null
) {
  const fromResult = Number(removeResult?.NewUpdateID);
  if (Number.isFinite(fromResult)) return fromResult;
  if (typeof coordinator?.GetQueue === "function") {
    try {
      const queue = await coordinator.GetQueue();
      const live = Number(queue?.UpdateID);
      if (Number.isFinite(live)) return live;
    } catch {
      /* keep previous */
    }
  }
  const prev = Number(previous);
  return Number.isFinite(prev) ? prev : 0;
}

/**
 * Occurrence index (0 = now playing / next-up) for a Spotify id at an absolute
 * 1-based queue position — matches queue-list badge mapping.
 */
export function searchedOccurrenceIndexForPosition(
  items,
  {
    trackId,
    absolutePos,
    currentTrack = 0,
    playingFromQueue = false,
  } = {}
) {
  if (!trackId) return null;
  const pos = Math.floor(Number(absolutePos) || 0);
  if (pos < 1) return null;
  const list = Array.isArray(items) ? items : [];
  const startIdx =
    playingFromQueue && Number(currentTrack) >= 1
      ? Math.floor(Number(currentTrack)) - 1
      : 0;
  let occ = 0;
  for (let i = startIdx; i < list.length; i++) {
    const id = spotifyTrackId(list[i]?.TrackUri ?? list[i]?.uri ?? null);
    if (id !== trackId) continue;
    if (i + 1 === pos) return occ;
    occ += 1;
  }
  return null;
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
  // When inserting a new announce, only supersede pads that would play at or
  // before that slot. Later refill/set pads (after guest requests / music)
  // stay glued to their batch — wiping them made Set Request shouts erase a
  // pending Random intro that should still fire after the request set.
  let toRemove = indices;
  if (before >= 1) {
    const indexSet = new Set(indices);
    toRemove = indices.filter((i) => {
      if (i < before) return true;
      // Contiguous pad run starting exactly at the insert position.
      for (let j = before; j <= i; j++) {
        if (!indexSet.has(j)) return false;
      }
      return true;
    });
  }
  if (!toRemove.length) {
    return { removed: 0, removedBefore: 0, protectedThrough };
  }

  const removedBefore =
    before >= 1 ? toRemove.filter((i) => i < before).length : 0;

  // Highest ranges first so earlier indices stay valid after each remove.
  const ranges = contiguousIndexRanges(toRemove).sort(
    (a, b) => b.StartingIndex - a.StartingIndex
  );
  let updateId = Number(queue.UpdateID) || 0;
  let removed = 0;
  for (const range of ranges) {
    try {
      const removeResult =
        await coordinator.AVTransportService.RemoveTrackRangeFromQueue({
          InstanceID: 0,
          UpdateID: updateId,
          StartingIndex: range.StartingIndex,
          NumberOfTracks: range.NumberOfTracks,
        });
      removed += range.NumberOfTracks;
      updateId = await refreshQueueUpdateId(
        removeResult,
        updateId,
        coordinator
      );
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
      const removeResult =
        await coordinator.AVTransportService.RemoveTrackRangeFromQueue({
          InstanceID: 0,
          UpdateID: updateId,
          StartingIndex: range.StartingIndex,
          NumberOfTracks: range.NumberOfTracks,
        });
      removed += range.NumberOfTracks;
      updateId = await refreshQueueUpdateId(
        removeResult,
        updateId,
        coordinator
      );
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
