// Pure Sonos queue / display helpers (no SOAP, no manager).
// Kept separate so sonos.js can stay a thin facade while these stay easy to test.

import { spotifyTrackId, mixPlaylistAndDiscovery } from "./sampler.js";
import { isTrackInPlaylistPool } from "./spotify.js";
import {
  bucketsForArtistSync,
  GENRE_BUCKETS,
} from "./genres.js";
import { dominantBucket } from "./genre-flow.js";
import {
  originOf,
  originSnapshot,
  originMetaForOccurrence,
} from "./queue-origin.js";

// Pure: pick the zone group that matches a target room name (coordinator or any
// member, case-insensitive). Returns null when no match; callers fall back.
export function pickGroupByTarget(groups, targetRoom) {
  if (!groups?.length) return null;
  if (!targetRoom) return groups[0];
  const t = targetRoom.toLowerCase();
  return (
    groups.find((g) => g.coordinator?.name?.toLowerCase() === t) ||
    groups.find((g) => g.members?.some((m) => m.name?.toLowerCase() === t)) ||
    null
  );
}

// Pure: given the current 1-based track pointer, the range of already-played
// tracks to remove (everything before the current song). Returns null when
// nothing precedes the current track. Exported for unit testing.
export function removeRangeFor(track) {
  const t = Number(track) || 0;
  if (t <= 1) return null;
  return { StartingIndex: 1, NumberOfTracks: t - 1 };
}

/** True when Sonos PlayMode includes shuffle (order is not queue index order). */
export function isShufflePlayMode(mode) {
  return /SHUFFLE/.test(String(mode || ""));
}

/**
 * Strip shuffle from a Sonos PlayMode while preserving repeat.
 * PartyQueue inserts / Skip / DJ pads use absolute queue indices — Shuffle
 * breaks that contract.
 */
export function orderedPlayMode(mode) {
  switch (String(mode || "NORMAL")) {
    case "SHUFFLE":
      return "REPEAT_ALL";
    case "SHUFFLE_REPEAT_ONE":
      return "REPEAT_ONE";
    case "SHUFFLE_NOREPEAT":
      return "NORMAL";
    default:
      return isShufflePlayMode(mode) ? "NORMAL" : String(mode || "NORMAL");
  }
}

// Pure: decide whether adding a song should kick off playback.
//   "skip"  -> leave playback alone: the queue is already playing, a real
//              external source (radio/SiriusXM/line-in) is playing and we won't
//              hijack it, or the host deliberately paused.
//   "start" -> the system is idle/stopped, so resume the queue in order.
// Exported for unit testing.
export function autoStartDecision(state) {
  const s = String(state || "").toUpperCase();
  if (s === "PLAYING") return "skip";
  if (s === "PAUSED_PLAYBACK" || s === "PAUSED") return "skip";
  if (s === "TRANSITIONING") return "skip";
  return "start";
}

// Pure: whether Random+DJ may wipe the Sonos queue before enqueueing a fresh
// set. Only safe when the queue is already empty (clear still runs Stop() to
// reset the playhead). Never clear when tracks are waiting — guest requests
// must survive Random. An older check also cleared on !isPlaying or
// !playingFromQueue, which deleted searched songs during DJ pause/transition
// windows. Exported for unit testing.
export function shouldClearQueueForRandomDj(status) {
  return (Number(status?.total) || 0) === 0;
}

/**
 * Pure: how Random+DJ should announce after tracks were appended.
 * - Empty / cleared queue + idle → fresh set at #1 and start playback.
 * - Queue already had tracks → set announce immediately before the new batch
 *   (session_refill), never at #1 (that would land ahead of guest requests).
 * - Idle with leftover queue → still before-batch; caller may resume Play
 *   without seeking to the announce.
 * Exported for unit testing.
 */
export function randomDjAnnouncePlan({
  djReady = false,
  added = 0,
  queueTotalBefore = 0,
  clearForDj = false,
  deferredStart = false,
  firstAppendPosition = 0,
} = {}) {
  if (!djReady || !(Number(added) > 0)) {
    return { action: "none" };
  }
  const fresh = !!clearForDj || (Number(queueTotalBefore) || 0) === 0;
  if (fresh) {
    if (!deferredStart) return { action: "none" };
    return {
      action: "fresh_set",
      queuePosition: 1,
      startPlayback: true,
      resumePlay: false,
    };
  }
  const pos = Math.max(
    1,
    Number(firstAppendPosition) || (Number(queueTotalBefore) || 0) + 1
  );
  return {
    action: "before_batch",
    queuePosition: pos,
    startPlayback: false,
    resumePlay: !!deferredStart,
  };
}

export function isDjVoiceUri(uri) {
  return /tts_proxy|\/media\/tts\//i.test(String(uri || ""));
}

// Quiet pads around a DJ clip (pre-ramp + post-restore). Still /media/tts
// URLs; UI hides these from the queue and keeps DJ branding in Now Playing.
export function isDjSilenceUri(uri) {
  return /silence-ramp-\d+(?:\.\d+)?s\.mp3|silence-\d+(?:\.\d+)?s\.mp3|dj-silence/i.test(
    String(uri || "")
  );
}

export function isDjSilenceTrack(uri, title = "") {
  return (
    isDjSilenceUri(uri) ||
    /PartyQueue Silence Bridge|PartyQueue Volume Ramp/i.test(
      String(title || "")
    )
  );
}

/** DJ ramp silence + TTS clips sitting in the Sonos queue around announces. */
export function isAnnounceQueuePad(uri, title = "") {
  return (
    isDjSilenceUri(uri) ||
    isDjVoiceUri(uri) ||
    /PartyQueue Silence Bridge|PartyQueue Volume Ramp/i.test(String(title || ""))
  );
}

// Pure: 1-based queue position at which to insert a searched song so it lands
// at the bottom of the request block (after any waiting searched songs) and
// still ahead of filler (Random/Never-Ending/discoveries). If all upcoming
// music is already searched we return 0 (append). `searchedIds` is a Set of
// Spotify track IDs known to be guest requests. Exported for unit testing.
//
// Announce pads that sit immediately before filler stay glued to that filler
// batch (Random refill / fresh-set intros). Inserting between those pads and
// the songs they introduce made the DJ announce Random, then play a Set
// Request. Pads that introduce an existing request stay ahead of that request
// — we only pull back across pads that directly precede the filler boundary.
export function findInsertPosition(items, { currentTrack = 0, playingFromQueue = false, searchedIds }) {
  const list = Array.isArray(items) ? items : [];
  const set = searchedIds instanceof Set ? searchedIds : new Set(searchedIds || []);
  // Upcoming starts just after the current track when the queue is the live
  // source; otherwise consider the whole queue.
  const start = playingFromQueue && currentTrack >= 1 ? currentTrack : 0;

  let fillerIndex = -1;
  for (let i = start; i < list.length; i++) {
    const it = list[i];
    const uri = it.TrackUri ?? it.uri;
    const title = it.Title ?? it.title ?? "";
    if (isAnnounceQueuePad(uri, title)) continue;
    const id = spotifyTrackId(uri);
    // First non-searched music track = end of the request block / start of filler.
    if (!id || !set.has(id)) {
      fillerIndex = i;
      break;
    }
  }
  if (fillerIndex < 0) {
    return 0; // everything upcoming (music) is already searched -> append (FIFO)
  }

  // Keep a trailing announce block glued to filler: insert before those pads.
  let insertAt = fillerIndex;
  while (insertAt > start) {
    const prev = list[insertAt - 1];
    const uri = prev.TrackUri ?? prev.uri;
    const title = prev.Title ?? prev.title ?? "";
    if (!isAnnounceQueuePad(uri, title)) break;
    insertAt -= 1;
  }
  return insertAt + 1;
}

// Pure: 1-based queue indices of unplayed DJ ramp/TTS pads (after the current
// track when playing from the queue). Used to strip superseded shout-outs so
// two announces don't play back-to-back. Exported for unit testing.
export function findUpcomingAnnouncePadIndices(
  items,
  { currentTrack = 0, playingFromQueue = false } = {}
) {
  const list = Array.isArray(items) ? items : [];
  let start = playingFromQueue && currentTrack >= 1 ? currentTrack : 0;
  // If an announce block is already playing, preserve every contiguous pad in
  // that active block. Supersede may remove later, wholly-unplayed blocks only.
  const currentIndex = Number(currentTrack) - 1;
  if (
    playingFromQueue &&
    currentIndex >= 0 &&
    currentIndex < list.length &&
    isAnnounceQueuePad(
      list[currentIndex].TrackUri ?? list[currentIndex].uri,
      list[currentIndex].Title ?? list[currentIndex].title ?? ""
    )
  ) {
    while (start < list.length) {
      const item = list[start];
      if (
        !isAnnounceQueuePad(
          item.TrackUri ?? item.uri,
          item.Title ?? item.title ?? ""
        )
      ) {
        break;
      }
      start += 1;
    }
  }
  const indices = [];
  for (let i = start; i < list.length; i++) {
    const it = list[i];
    const uri = it.TrackUri ?? it.uri;
    const title = it.Title ?? it.title ?? "";
    if (isAnnounceQueuePad(uri, title)) indices.push(i + 1);
  }
  return indices;
}

// Pure: a loose "same song" key from title + primary artist. Spotify often has
// several track IDs for one song (album vs single vs remaster), so matching by
// ID alone misses dupes. Normalizing title+artist lets us treat them as one
// when deciding whether to promote an existing copy rather than add another.
// Returns "" when there isn't enough to match safely. Exported for testing.
export function songMatchKey(title, artist) {
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\(.*?\)|\[.*?\]/g, " ") // (feat. ...), [live]
      .replace(/\s[-\u2013]\s.*$/, " ") // " - Remastered 2011" / " - Live"
      .replace(/\bfeat\.?\b.*$/, " ") // trailing "feat ..."
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const t = norm(title);
  const a = norm(String(artist || "").split(",")[0]); // primary artist only
  return t && a ? `${t}|${a}` : "";
}

// Spread discovery songs through playlist picks (compat export name).
// Prefer mixPlaylistAndDiscovery for new call sites.
export function interleave(base, extra) {
  return mixPlaylistAndDiscovery(base, extra);
}

/**
 * Find the TTS clip that belongs with a silence pad in an announce block
 * (ramp → TTS → restore). Looks forward from a ramp, backward from restore.
 * @param {Array<{ TrackUri?: string, uri?: string, Title?: string, title?: string }>} items
 * @param {number} currentIndex 0-based index of the silence pad
 * @returns {string|null}
 */
export function findCompanionDjTtsUri(items, currentIndex) {
  const list = Array.isArray(items) ? items : [];
  const idx = Math.floor(Number(currentIndex));
  if (!Number.isFinite(idx) || idx < 0 || idx >= list.length) return null;

  const uriOf = (item) => item?.TrackUri ?? item?.uri ?? null;
  const titleOf = (item) => item?.Title ?? item?.title ?? "";
  const isTts = (item) => {
    const u = uriOf(item);
    return isDjVoiceUri(u) && !isDjSilenceTrack(u, titleOf(item));
  };
  const isPad = (item) => isDjSilenceTrack(uriOf(item), titleOf(item));

  for (let i = idx + 1; i < list.length; i++) {
    if (isPad(list[i])) continue;
    if (isTts(list[i])) return uriOf(list[i]);
    break;
  }
  for (let i = idx - 1; i >= 0; i--) {
    if (isPad(list[i])) continue;
    if (isTts(list[i])) return uriOf(list[i]);
    break;
  }
  return null;
}

const GENRE_LABEL_BY_ID = new Map(GENRE_BUCKETS.map((b) => [b.id, b.label]));

function emptyQueueGenreFields() {
  return {
    genreLane: null,
    genreLabel: null,
    genreLanes: [],
    genreLabels: [],
  };
}

function labelForGenreLane(lane) {
  if (!lane || lane === "other") return null;
  return GENRE_LABEL_BY_ID.get(lane) || String(lane);
}

/**
 * Genre pill fields for an Up Next row.
 * Prefers the enqueue set lane ("matched" genre), else the artist's dominant
 * cached bucket. One pill only — a second genre slot is reserved for
 * "From Playlists".
 */
export function queueTrackGenreFields(artist, meta, { djClip = false } = {}) {
  if (djClip) return emptyQueueGenreFields();
  const source = meta?.source ?? null;
  if (
    source !== "filler" &&
    source !== "discovered" &&
    source !== "mood" &&
    source !== "searched"
  ) {
    return emptyQueueGenreFields();
  }

  // Keep the full mapped set until we prioritize the enqueue lane — slicing
  // first can drop the set lane when two Last.fm tags expand to 3 buckets
  // (e.g. Yellowcard: pop punk + punk rock → punk/pop/rock).
  let lanes = [
    ...new Set(
      (bucketsForArtistSync(artist) || []).filter((b) => b && b !== "other")
    ),
  ];

  const setLane =
    typeof meta?.genreLane === "string" &&
    meta.genreLane &&
    meta.genreLane !== "other"
      ? meta.genreLane
      : null;

  // Legacy / untagged: keep a single pill from the set lane if we have one.
  if (!lanes.length && source !== "searched" && setLane) {
    lanes = [setLane];
  }
  if (!lanes.length) {
    const dom = dominantBucket(bucketsForArtistSync(artist));
    if (dom && dom !== "other") lanes = [dom];
  }

  // Matched set-lane genre wins when the artist maps to it.
  if (setLane && lanes.includes(setLane)) {
    lanes = [setLane];
  } else {
    lanes = lanes.slice(0, 1);
  }

  const labels = lanes.map(labelForGenreLane).filter(Boolean);
  if (!labels.length) return emptyQueueGenreFields();
  return {
    genreLane: lanes[0] || null,
    genreLabel: labels[0] || null,
    genreLanes: lanes,
    genreLabels: labels,
  };
}

/**
 * True when the queued track came from (or also lives in) the host's playlists.
 * Random/filler is always playlist-sourced; requests consult the warmed pool.
 */
export function queueTrackFromPlaylist(id, meta) {
  const source = meta?.source ?? null;
  if (source === "filler") return true;
  if (source === "discovered" || source === "mood") return false;
  if (!id) return false;
  return isTrackInPlaylistPool(id);
}

/**
 * Guest-facing view of the upcoming queue. Silence pads are always hidden
 * (they stay in the Sonos queue for volume handoff). DJ TTS rows are kept so
 * people see the announce coming — except while the announce block itself is
 * playing: the block is three queue items (ramp pad → TTS → restore pad) but
 * should read as ONE DJ entry, so once any segment is the current track the
 * rest of that contiguous block is hidden too.
 * @param {Array<{ TrackUri?: string, Title?: string }>} items full Sonos queue
 * @param {number} offset 1-based index of the current track (0 = show all)
 * @returns {Array<{ t: object, absoluteIndex: number }>}
 */
export function visibleUpcomingQueueItems(items, offset) {
  const list = Array.isArray(items) ? items : [];
  const start = Number.isFinite(Number(offset)) && offset > 0 ? Math.floor(offset) : 0;
  const isDjItem = (t) =>
    isDjVoiceUri(t?.TrackUri) || isDjSilenceTrack(t?.TrackUri, t?.Title);
  const current = start >= 1 ? list[start - 1] : null;
  let inPlayingDjBlock = !!current && isDjItem(current);
  const upcoming = [];
  for (let i = start; i < list.length; i++) {
    const t = list[i];
    if (inPlayingDjBlock && isDjItem(t)) continue;
    inPlayingDjBlock = false;
    if (isDjSilenceTrack(t?.TrackUri, t?.Title)) continue;
    upcoming.push({ t, absoluteIndex: i + 1 });
  }
  return upcoming;
}

/**
 * First non-DJ music track after the current queue position, shaped for the
 * Now Playing genre header during announce/silence pads. Built from a raw
 * GetQueue result so silence-path NP can reuse the companion-URI fetch.
 *
 * @param {object[]} items
 * @param {number} trackNum 1-based Sonos Track index of the current item
 */
export function upcomingGenreHintFromQueueItems(items, trackNum) {
  const track = Math.floor(Number(trackNum) || 0);
  const offset = track >= 1 ? track : 0;
  const upcoming = visibleUpcomingQueueItems(items, offset);
  const rollup = originSnapshot();
  for (const { t } of upcoming) {
    const uri = t?.TrackUri ?? null;
    if (!uri) continue;
    // Up Next still lists the TTS clip; genre follows the song after the pad.
    if (isDjVoiceUri(uri) && !isDjSilenceTrack(uri, t?.Title)) continue;
    const title = t?.Title ?? "";
    const artist = t?.Artist ?? "";
    if (!title && !artist) continue;
    const id = spotifyTrackId(uri);
    const meta = id
      ? originMetaForOccurrence(id, 0) || rollup.get(id) || null
      : null;
    const source = meta?.source ?? (id ? originOf(id) : null);
    return {
      uri,
      title: title || null,
      artist: artist || null,
      origin: source,
      genreLane:
        source === "filler" ||
        source === "discovered" ||
        source === "mood"
          ? meta?.genreLane || null
          : null,
    };
  }
  return null;
}
