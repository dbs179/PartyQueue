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
  announcePadsToSupersede,
  announcePadsForClipUrl,
  songMatchKey,
  isAnnounceQueuePad,
  isTransportPlaying,
  shoutPlaybackHoldDecision,
  findUpcomingTrackPositionInItems,
} from "./sonos-queue-policy.js";
import { ensureOrderedPlayModeOn } from "./sonos-transport.js";
import { spotifyTrackId } from "./sampler.js";
import { getDjVoiceSettings } from "./settings.js";
import {
  markOrigin,
  originOf,
  originSnapshot,
  isFiller,
  clearSearchedOccurrence,
  requestedByUserOf,
} from "./queue-origin.js";
import { sanitizeDisplayName } from "./display-name.js";
import { queueWorkWasPreempted } from "./queue-preempt.js";
import {
  getRefillAnnounceClipUrl,
  clearRefillAnnounceClipUrl,
} from "./refill-announce-guard.js";
import {
  beginAnnounceRampPark,
  endAnnounceRampPark,
  forceEndAnnounceRampPark,
  getAnnounceRampPark,
  isAnnounceRampParkActive,
} from "./announce-ramp-park.js";

/**
 * Live Sonos queue + playhead for request insert. Retries once, then throws
 * so we never append a guest request behind filler on a failed read.
 * Position / media / transport soft-fail; GetQueue must succeed.
 */
export async function readLiveQueueForInsert(coordinator, { attempts = 2 } = {}) {
  const tries = Math.max(1, Math.floor(Number(attempts) || 2));
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const [queue, pos, media, transport] = await Promise.all([
        coordinator.GetQueue(),
        coordinator.AVTransportService.GetPositionInfo().catch(() => ({
          Track: 0,
        })),
        coordinator.AVTransportService.GetMediaInfo({ InstanceID: 0 }).catch(
          () => ({ CurrentURI: "" })
        ),
        coordinator.AVTransportService.GetTransportInfo().catch(() => ({})),
      ]);
      return {
        items: Array.isArray(queue.Result) ? queue.Result : [],
        updateId: Number(queue.UpdateID) || 0,
        currentTrack: Number(pos.Track) || 0,
        playingFromQueue: /^x-rincon-queue:/.test(media.CurrentURI || ""),
        transportState: transport?.CurrentTransportState || "",
      };
    } catch (err) {
      lastErr = err;
      console.error(
        `[queue] live read failed (${i + 1}/${tries}):`,
        err.message
      );
    }
  }
  const error = new Error(
    lastErr?.message || "Could not read the Sonos queue."
  );
  error.cause = lastErr;
  throw error;
}

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
    const transport = await coordinator.AVTransportService.GetTransportInfo().catch(
      () => null
    );
    const state = transport?.CurrentTransportState || "";
    if (isTransportPlaying(state)) {
      console.log("[queue] skip idle hold — music is already playing");
      return false;
    }
    const media = await coordinator.AVTransportService.GetMediaInfo({
      InstanceID: 0,
    }).catch(() => null);
    const onQueue = /^x-rincon-queue:/.test(media?.CurrentURI || "");
    if (!onQueue) await coordinator.SwitchToQueue();
    // Recheck after SwitchToQueue — never Pause a song that started playing.
    const again = await coordinator.AVTransportService.GetTransportInfo().catch(
      () => null
    );
    if (isTransportPlaying(again?.CurrentTransportState)) {
      console.log("[queue] skip idle hold — music started during switch");
      return false;
    }
    // Park idle/stopped rooms only. Sonos sometimes begins the first enqueued
    // track on SwitchToQueue / AddURIToQueue; Pause here is the empty-queue
    // "tease → DJ → restart" guard, not a mid-song interrupt.
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
 * upcoming, and duplicates inside the same payload. Spotify top-tracks often
 * list the same song under different ids (e.g. Country Roads + Original
 * Version); match by Spotify id and songMatchKey. Preserves first-seen order
 * up to `limit`.
 * @param {Array<{ uri: string, name?: string, artist?: string }>} tracks
 * @param {Iterable<string>|Set<string>} [upcomingIds]
 * @param {number} [limit]
 * @param {Iterable<string>|Set<string>} [upcomingSongKeys]
 */
export function filterSetRequestTracks(
  tracks,
  upcomingIds = [],
  limit = SET_REQUEST_SIZE,
  upcomingSongKeys = []
) {
  const blockedIds =
    upcomingIds instanceof Set ? upcomingIds : new Set(upcomingIds || []);
  const blockedKeys =
    upcomingSongKeys instanceof Set
      ? upcomingSongKeys
      : new Set(upcomingSongKeys || []);
  const max = Math.max(1, Math.floor(Number(limit) || SET_REQUEST_SIZE));
  const seenIds = new Set();
  const seenKeys = new Set();
  const out = [];
  for (const t of Array.isArray(tracks) ? tracks : []) {
    if (!t || typeof t.uri !== "string" || !t.uri.startsWith("spotify:track:")) {
      continue;
    }
    const id = spotifyTrackId(t.uri);
    if (!id || blockedIds.has(id) || seenIds.has(id)) continue;
    const key = songMatchKey(t.name, t.artist);
    if (key && (blockedKeys.has(key) || seenKeys.has(key))) continue;
    seenIds.add(id);
    if (key) seenKeys.add(key);
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

  const live = await readLiveQueueForInsert(coordinator);
  const items = live.items;
  const currentTrack = live.currentTrack;
  const playingFromQueue = live.playingFromQueue;
  const transportState = live.transportState;

  const start = playingFromQueue && currentTrack >= 1 ? currentTrack : 0;
  const upcomingIds = new Set();
  const upcomingKeys = new Set();
  for (let i = start; i < items.length; i++) {
    const it = items[i];
    const itId = spotifyTrackId(it?.TrackUri ?? it?.uri);
    if (itId) upcomingIds.add(itId);
    const key = songMatchKey(it?.Title ?? it?.title, it?.Artist ?? it?.artist);
    if (key) upcomingKeys.add(key);
  }

  if (!filterSetRequestTracks(tracks, [], SET_REQUEST_SIZE).length) {
    throw new Error("No tracks to add for this Set Request.");
  }
  const toAdd = filterSetRequestTracks(
    tracks,
    upcomingIds,
    SET_REQUEST_SIZE,
    upcomingKeys
  );
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
  const hold = shoutPlaybackHoldDecision({
    queueWasEmpty,
    transportState,
    djShoutReady: !!dj.djVoiceEnabled && !!dj.djShoutEnabled,
  });
  let started = false;
  if (hold.holdIdle) {
    await holdIdleForDeferredShout(coordinator);
  } else if (!hold.alreadyPlaying) {
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
    deferredStart: hold.holdIdle,
    alreadyPlaying: hold.alreadyPlaying,
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

  // Live queue is required to insert ahead of filler. Retry once, then fail
  // closed — never append a request behind Random on a dropped GetQueue.
  const live = await readLiveQueueForInsert(coordinator);
  const items = live.items;
  const updateId = live.updateId;
  const currentTrack = live.currentTrack;
  const playingFromQueue = live.playingFromQueue;
  const transportState = live.transportState;

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
    // Same guest re-adding an upcoming request is idempotent. A different guest
    // may still enqueue another copy for their own dedication / stats row.
    const existingUser = existing.id ? requestedByUserOf(existing.id) : null;
    const sameUser =
      !!sanitizeDisplayName(requestedByUser) &&
      !!sanitizeDisplayName(existingUser) &&
      String(sanitizeDisplayName(requestedByUser)).toLowerCase() ===
        String(sanitizeDisplayName(existingUser)).toLowerCase();
    if (sameUser) {
      // Leave `existing` set so queuePosition resolves to the waiting copy.
    } else {
      await enqueueMeta(m, meta, insertPos);
      if (id) {
        markOrigin([id], "searched", { ...byOpts, appendInstance: true });
      }
      duplicated = true;
      existing = null;
    }
  } else {
    // Not already waiting in the queue -> insert a fresh copy ahead of filler.
    await enqueueMeta(m, meta, insertPos);
    if (id) markOrigin([id], "searched", byOpts);
  }

  // Guest requests enter song memory when they are heard (Now Playing) or
  // skipped — not at enqueue — so a host delete before play leaves Random free.

  const queueWasEmpty = items.length === 0;
  // Empty + idle + shout-outs: skip auto-start so the DJ clip can lead.
  // Never Pause when a song is already playing (Set Request / busy night).
  const dj = getDjVoiceSettings();
  const hold = shoutPlaybackHoldDecision({
    queueWasEmpty,
    transportState,
    djShoutReady: !!dj.djVoiceEnabled && !!dj.djShoutEnabled,
  });

  let started = false;
  if (hold.holdIdle) {
    await holdIdleForDeferredShout(coordinator);
  } else if (!hold.alreadyPlaying) {
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

  const alreadyRequested =
    !!existing && existingWasRequested && !promoted && !duplicated;

  return {
    room: coordinator.Name,
    group: coordinator.GroupName,
    started,
    promoted,
    duplicated,
    requestCreated: !existing || promoted || duplicated,
    alreadyRequested,
    queueWasEmpty,
    deferredStart: hold.holdIdle,
    alreadyPlaying: hold.alreadyPlaying,
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
 * stays on the transport lane and does not wait for this lock). A partial
 * insert strips the leftover ramp/TTS before releasing the lock.
 *
 * @param {{
 *   queuePosition?: number,
 *   preemptGeneration?: number,
 *   applyLeadBuffer?: boolean, // re-resolve request position; never reorders
 *   requestUri?: string|null,
 *   replaceWaitingRefill?: boolean, // strip leftover Never-Ending refill pads
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

function clipEnqueueOpts(clip, position) {
  return {
    title: clip.title,
    artist: clip.artist,
    durationSec: clip.durationSec,
    position,
  };
}

/**
 * Live 1-based index of a queued clip URL. Starts at the current track (we may
 * already be holding ON the parked ramp) so played pads left behind by an
 * earlier announce can never be mistaken for this one, and prefers the copy
 * nearest where we last saw it.
 */
/**
 * Does a queue row point at this clip URL? Exact first, then the unique
 * per-announce segment, then the bare filename — Sonos may hand a query back
 * escaped, and a false positive here only over-protects a pad.
 */
function matchesClipUrl(uri, url) {
  const want = String(url || "");
  const value = String(uri || "");
  if (!want || !value) return false;
  if (value === want) return true;
  const segment = want.split("/").pop() || "";
  if (segment && value.includes(segment)) return true;
  const fileName = segment.split("?")[0] || "";
  return !!fileName && value.includes(fileName);
}

function findQueueUrlPosition(
  items,
  url,
  { currentTrack = 0, playingFromQueue = false, expected = null } = {}
) {
  const want = String(url || "");
  if (!want) return null;
  const list = Array.isArray(items) ? items : [];
  const track = Math.floor(Number(currentTrack) || 0);
  const start = playingFromQueue && track >= 1 ? track - 1 : 0;
  const segment = want.split("/").pop() || "";
  // Prefer the unique per-announce token; fall back to the bare filename in
  // case Sonos hands the query back to us escaped.
  const fileName = segment.split("?")[0] || "";
  const wantExpected = Number(expected);
  const nearest = (matches) => {
    if (!matches.length) return null;
    if (matches.length === 1 || !Number.isFinite(wantExpected)) return matches[0];
    return matches.reduce((best, p) =>
      Math.abs(p - wantExpected) < Math.abs(best - wantExpected) ? p : best
    );
  };

  for (const needle of [segment, fileName]) {
    if (!needle) continue;
    const matches = [];
    for (let i = start; i < list.length; i++) {
      const uri = String(list[i]?.TrackUri ?? list[i]?.uri ?? "");
      if (uri === want || uri.includes(needle)) matches.push(i + 1);
    }
    const hit = nearest(matches);
    if (hit != null) return hit;
  }
  return null;
}

/**
 * Queue items plus playhead for announce-park math. `readItems` (tests) may
 * return a bare array; live reads carry the playhead so pads behind it are
 * never matched.
 */
async function readQueueContext(readItems) {
  if (readItems) {
    const raw = await readItems();
    if (Array.isArray(raw)) {
      return { items: raw, currentTrack: 0, playingFromQueue: false };
    }
    return {
      items: Array.isArray(raw?.items) ? raw.items : [],
      currentTrack: Number(raw?.currentTrack) || 0,
      playingFromQueue: !!raw?.playingFromQueue,
    };
  }
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);
  const [queue, pos, media] = await Promise.all([
    coordinator.GetQueue().catch(() => ({ Result: [] })),
    coordinator.AVTransportService.GetPositionInfo().catch(() => ({ Track: 0 })),
    coordinator.AVTransportService.GetMediaInfo({ InstanceID: 0 }).catch(() => ({
      CurrentURI: "",
    })),
  ]);
  return {
    items: Array.isArray(queue.Result) ? queue.Result : [],
    currentTrack: Number(pos.Track) || 0,
    playingFromQueue: /^x-rincon-queue:/.test(media.CurrentURI || ""),
  };
}

/**
 * Insert only the volume-ramp silence immediately before the request so a
 * dying fill-in lands on silence instead of starting the guest song.
 */
export async function parkAnnounceRamp(opts) {
  return withSonosWriteLock(() => parkAnnounceRampUnlocked(opts));
}

async function parkAnnounceRampUnlocked({
  queuePosition = 1,
  requestUri = null,
  ramp,
  preemptGeneration,
  ops = {},
} = {}) {
  const enqueue = ops.enqueue || enqueueHttpAudioUnlocked;
  const pauseTrim = ops.pauseTrim || pauseQueueTrim;
  const readItems = ops.readItems;
  const preempted = () =>
    preemptGeneration != null && queueWorkWasPreempted(preemptGeneration);
  if (preempted()) {
    return { ok: false, skipped: true, reason: "queue-preempted" };
  }
  if (!ramp?.url) {
    throw new Error("parkAnnounceRamp requires a ramp url.");
  }

  pauseTrim(90000);
  let rampPos = Number(queuePosition) || 1;
  if (requestUri || readItems) {
    try {
      const { items, currentTrack, playingFromQueue } =
        await readQueueContext(readItems);
      // includeCurrent: the request may already have started playing (the
      // tease we are here to undo), so the ramp goes in at its own slot.
      const live = findUpcomingTrackPositionInItems(items, {
        uri: requestUri,
        expected: rampPos,
        currentTrack,
        playingFromQueue,
        includeCurrent: true,
      });
      if (live) rampPos = live;
    } catch (err) {
      console.warn("[announce-park] live position read failed:", err.message);
    }
  }
  if (preempted()) {
    return { ok: false, skipped: true, reason: "queue-preempted" };
  }

  await enqueue(ramp.url, clipEnqueueOpts(ramp, rampPos));
  beginAnnounceRampPark({
    rampUrl: ramp.url,
    requestUri: requestUri || null,
  });
  console.log(`[dj-voice] parked volume ramp@${rampPos} until shout is ready`);
  return { ok: true, rampPos, requestPos: rampPos + 1, rampUrl: ramp.url };
}

/**
 * After TTS is ready, glue the DJ clip + restore pad after the parked ramp.
 * Does not strip the ramp (we may already be holding on it).
 */
export async function completeParkedAnnounce(opts) {
  return withSonosWriteLock(() => completeParkedAnnounceUnlocked(opts));
}

async function completeParkedAnnounceUnlocked({
  rampUrl,
  expectedRampPos,
  tts,
  tts2 = null,
  restore,
  preemptGeneration,
  replaceWaitingRefill = false,
  ops = {},
} = {}) {
  const enqueue = ops.enqueue || enqueueHttpAudioUnlocked;
  const readItems = ops.readItems;
  const removePads = ops.removePads || removeUpcomingAnnouncePadsUnlocked;
  const preempted = () =>
    preemptGeneration != null && queueWorkWasPreempted(preemptGeneration);
  if (preempted()) {
    return { ok: false, skipped: true, reason: "queue-preempted" };
  }
  if (!tts?.url || !restore?.url) {
    throw new Error("completeParkedAnnounce requires tts and restore urls.");
  }

  let rampPos = 0;
  try {
    const { items, currentTrack, playingFromQueue } =
      await readQueueContext(readItems);
    const live = findQueueUrlPosition(items, rampUrl, {
      currentTrack,
      playingFromQueue,
      expected: Number(expectedRampPos) || null,
    });
    if (live) rampPos = live;
  } catch (err) {
    console.warn("[announce-park] ramp lookup failed:", err.message);
  }
  // Never fall back to the remembered index: a stale slot would splice the DJ
  // clip into the middle of somebody's request block.
  if (!Number.isFinite(rampPos) || rampPos < 1) {
    return { ok: false, reason: "parked-ramp-missing" };
  }
  if (preempted()) {
    return { ok: false, skipped: true, reason: "queue-preempted" };
  }
  if (replaceWaitingRefill) {
    try {
      // Only the leftover refill block — do not strip the parked ramp we
      // are about to complete.
      const wiped = await removePads({
        beforePosition: rampPos,
        replaceWaitingRefill: true,
        refillOnly: true,
      });
      if (wiped.removedBefore > 0) {
        rampPos = Math.max(1, rampPos - wiped.removedBefore);
      }
    } catch (err) {
      console.warn(
        "[announce-park] leftover refill strip failed:",
        err?.message || err
      );
    }
  }

  const ttsPos = rampPos + 1;
  const tts2Pos = tts2?.url ? ttsPos + 1 : null;
  const restorePos = (tts2Pos || ttsPos) + 1;
  await enqueue(tts.url, clipEnqueueOpts(tts, ttsPos));
  if (preempted()) {
    return {
      ok: false,
      skipped: true,
      reason: "queue-preempted",
      partial: true,
      rampPos,
      ttsPos,
      tts2Pos,
    };
  }
  if (tts2?.url) {
    await enqueue(tts2.url, clipEnqueueOpts(tts2, tts2Pos));
    if (preempted()) {
      return {
        ok: false,
        skipped: true,
        reason: "queue-preempted",
        partial: true,
        rampPos,
        ttsPos,
        tts2Pos,
      };
    }
  }
  await enqueue(restore.url, clipEnqueueOpts(restore, restorePos));
  endAnnounceRampPark();
  console.log(
    `[dj-voice] completed parked announce ramp@${rampPos} TTS@${ttsPos}` +
      (tts2Pos ? ` TTS2@${tts2Pos}` : "") +
      ` restore@${restorePos}`
  );
  return { ok: true, inserted: true, rampPos, ttsPos, tts2Pos, restorePos };
}

/**
 * Drop a parked ramp that never got its DJ clip. Only removes it when it is
 * still upcoming — if the room is already holding on that silence we leave it
 * to play out (3s) rather than deleting the track under the playhead.
 * @returns {Promise<{ removed: boolean, reason?: string, position?: number }>}
 */
export async function releaseParkedRamp(opts) {
  return withSonosWriteLock(() => releaseParkedRampUnlocked(opts));
}

async function releaseParkedRampUnlocked({ rampUrl, ops = {} } = {}) {
  if (!rampUrl) return { removed: false, reason: "no-ramp-url" };
  const readItems = ops.readItems;
  const removeRange = ops.removeRange;
  try {
    const { items, currentTrack, playingFromQueue } =
      await readQueueContext(readItems);
    const pos = findQueueUrlPosition(items, rampUrl, {
      currentTrack,
      playingFromQueue,
    });
    if (!pos) return { removed: false, reason: "not-found" };
    const track = Math.floor(Number(currentTrack) || 0);
    if (playingFromQueue && track >= 1 && pos <= track) {
      return { removed: false, reason: "ramp-is-current", position: pos };
    }
    if (removeRange) {
      await removeRange({ StartingIndex: pos, NumberOfTracks: 1 });
    } else {
      const m = await getManager();
      const coordinator = await resolveCoordinator(m);
      const queue = await coordinator.GetQueue().catch(() => ({ UpdateID: 0 }));
      await coordinator.AVTransportService.RemoveTrackRangeFromQueue({
        InstanceID: 0,
        UpdateID: Number(queue.UpdateID) || 0,
        StartingIndex: pos,
        NumberOfTracks: 1,
      });
    }
    invalidateSonosSnapshots();
    console.log(`[announce-park] removed orphaned volume ramp@${pos}`);
    return { removed: true, position: pos };
  } catch (err) {
    console.warn("[announce-park] ramp release failed:", err.message);
    return { removed: false, reason: "error" };
  }
}

async function insertAnnounceBlockUnlocked({
  queuePosition = 1,
  preemptGeneration,
  ramp,
  tts,
  tts2 = null,
  restore,
  applyLeadBuffer = false,
  requestUri = null,
  replaceWaitingRefill = false,
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

  // Re-resolve the request under this write lock so pads stay glued to it if
  // another add shifted positions during script/TTS. Guest songs are never
  // reordered (lead buffer is a no-op).
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
    wiped = await removePads({
      beforePosition: rampPos,
      replaceWaitingRefill,
    });
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
  const tts2Pos = tts2?.url ? ttsPos + 1 : null;
  const restorePos = (tts2Pos || ttsPos) + 1;
  const clipOpts = (clip, position) => ({
    title: clip.title,
    artist: clip.artist,
    durationSec: clip.durationSec,
    position,
  });

  const abortPartial = async () => {
    let cleaned = false;
    try {
      await removePads({ beforePosition: rampPos });
      cleaned = true;
    } catch (err) {
      console.warn(
        "[announce-block] partial-insert cleanup failed:",
        err?.message || err
      );
    }
    return {
      ok: false,
      skipped: true,
      reason: "queue-preempted",
      partial: true,
      cleaned,
      wiped,
      rampPos,
      ttsPos,
      tts2Pos,
      restorePos,
    };
  };

  await enqueue(ramp.url, clipOpts(ramp, rampPos));
  if (preempted()) {
    return abortPartial();
  }

  await enqueue(tts.url, clipOpts(tts, ttsPos));
  if (preempted()) {
    return abortPartial();
  }

  if (tts2?.url) {
    await enqueue(tts2.url, clipOpts(tts2, tts2Pos));
    if (preempted()) {
      return abortPartial();
    }
  }

  await enqueue(restore.url, clipOpts(restore, restorePos));
  if (preempted()) {
    // Complete block is in; skip handoff/Play so Clear can own the room.
    return {
      ok: false,
      skipped: true,
      reason: "queue-preempted",
      partial: false,
      inserted: true,
      wiped,
      rampPos,
      ttsPos,
      tts2Pos,
      restorePos,
    };
  }

  return {
    ok: true,
    inserted: true,
    rampPos,
    ttsPos,
    tts2Pos,
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
 * Strip unplayed DJ ramp/TTS pads that a new announce replaces.
 * With beforePosition, only the contiguous pad run at that slot is removed
 * (this track's existing shout / dedication). Earlier request-glued shouts
 * stay. Without beforePosition, all upcoming pads are stripped (startup).
 * @param {{ beforePosition?: number, replaceWaitingRefill?: boolean }} [opts]
 *   beforePosition: 1-based insert index; also used to count removed pads
 *   strictly before that index (for adjusting the insert after a wipe).
 *   replaceWaitingRefill: also strip a leftover Never-Ending refill block.
 * @returns {Promise<{
 *   removed: number,
 *   removedBefore: number,
 *   protectedThrough: number
 * }>}
 */
export async function removeUpcomingAnnouncePads(...args) {
  return withSonosWriteLock(() => removeUpcomingAnnouncePadsUnlocked(...args));
}

async function removeUpcomingAnnouncePadsUnlocked({
  beforePosition,
  replaceWaitingRefill = false,
  refillOnly = false,
} = {}) {
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
  // Keep earlier request-glued shouts. Replace the pad run at this slot
  // (plus the shout glued immediately before it) — or strip everything on
  // startup when beforePosition is omitted. `refillOnly` skips the slot
  // wipe so a parked ramp is not deleted out from under a completing shout.
  const slotPads = refillOnly ? [] : announcePadsToSupersede(indices, before);
  let refillPads = [];
  const refillClip = replaceWaitingRefill ? getRefillAnnounceClipUrl() : null;
  if (refillClip) {
    refillPads = announcePadsForClipUrl(items, refillClip, {
      currentTrack: track,
      playingFromQueue,
    });
  }
  const toRemove = [...new Set([...slotPads, ...refillPads])].filter((i) => {
    if (!isAnnounceRampParkActive()) return true;
    const park = getAnnounceRampPark();
    const item = items[i - 1];
    const uri = String(item?.TrackUri ?? item?.uri ?? "");
    // Never strip the pad a shout is currently holding on.
    return !matchesClipUrl(uri, park.rampUrl);
  });
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
  if (refillPads.length && refillPads.some((i) => toRemove.includes(i))) {
    clearRefillAnnounceClipUrl();
    try {
      const voice = await import("./dj-voice.js");
      voice.abandonPendingRefillAnnounce("superseded by later announce");
    } catch {
      /* pending marker is best-effort */
    }
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
 * Guest request order is FIFO — never reorder a request to make room for TTS.
 * Imminent pause in dj-voice covers the last-song race. Kept as a lock-safe
 * no-op so existing route / insert-block call sites stay valid.
 */
export async function ensureShoutLeadBuffer(...args) {
  return withSonosWriteLock(() => ensureShoutLeadBufferUnlocked(...args));
}

async function ensureShoutLeadBufferUnlocked(requestAbsPos) {
  const planned = Math.max(1, Math.floor(Number(requestAbsPos)) || 1);
  return {
    buffered: false,
    absoluteQueuePosition: planned,
    reason: "no-reorder",
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
  // A parked shout has nothing left to glue to — drop the freeze so
  // Never-Ending is not stuck waiting on an announce that will never land.
  forceEndAnnounceRampPark();
  try {
    const { cancelActiveDjVolumeHandoff } = await import(
      "./dj-volume-handoff.js"
    );
    await cancelActiveDjVolumeHandoff("queue cleared");
  } catch {
    /* best-effort */
  }
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
