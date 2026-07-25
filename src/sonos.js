// Sonos local control via @svrooij/sonos.
//
// The ONLY action this module exposes is "append a track to the end of the
// group's queue". There is deliberately no play / pause / replace-queue / skip
// here, so the web app physically cannot disrupt what's currently playing.

import { SonosManager, MetaDataHelper } from "@svrooij/sonos";
import { withSonosWriteLock, withSonosTransportLane } from "./sonos-lock.js";
import { isDjVolumeHandoffActive } from "./dj-volume-handoff.js";
import { buildPlaylistPool } from "./spotify.js";
import { spotifyTrackId, pickWithRelaxation, discoveryPlan, primaryArtist, mixPlaylistAndDiscovery } from "./sampler.js";
import {
  recentTrackIds,
  recentEntries,
  artistCountsInWindow,
  artistCooldowns,
  recordPlayed,
  recordSkip,
  tickArtistCooldowns,
} from "./play-history.js";
import {
  getRandomnessSettings,
  getSonosTargetRoom,
  setSonosTargetRoom,
  getDjVoiceSettings,
  DJ_VOICE_DEFAULTS,
  DJ_ICON_DEFAULT_URL,
} from "./settings.js";
import { taglineForClip } from "./dj-taglines.js";
import { artistMatchesGenres, bucketsForArtistSync, bucketsForArtist } from "./genres.js";
import { moodPack as eraMoodPack, getMoodHits, trackFitsMood } from "./moods.js";
import {
  pickSetLane,
  bridgeSlotCount,
  getGenreFlowState,
  recordGenreLane,
} from "./genre-flow.js";
import { getSimilarUris, isDiscoveryAvailable } from "./similar.js";
import { markOrigin, originOf, moodOf, originSnapshot, isFiller } from "./queue-origin.js";
import { warmLyrics } from "./lyrics.js";
import { queueWorkWasPreempted } from "./queue-preempt.js";

// Sonos Spotify "region" codes used when building track metadata.
// These map to the SA_RINCON<region> service id the library embeds.
const SPOTIFY_REGION_EU = "2311";
const SPOTIFY_REGION_US = "3079";

let manager = null;
let initializing = null;

/** Drop the cached SonosManager so the next call rediscovers (e.g. after SONOS_HOST change). */
export function resetSonosManager() {
  manager = null;
  initializing = null;
}

function resolveRegion() {
  const region = (process.env.SONOS_REGION || "NorthAmerica").toLowerCase();
  return region === "eu" || region === "europe"
    ? SPOTIFY_REGION_EU
    : SPOTIFY_REGION_US;
}

async function getManager() {
  if (manager) return manager;
  // Guard against concurrent requests triggering multiple discoveries.
  if (initializing) return initializing;

  initializing = (async () => {
    const m = new SonosManager();
    // Prefer Settings → Connections (data/sonos.json / .env via sonos-config).
    const { getSonosHost } = await import("./sonos-config.js");
    const host = String(getSonosHost() || "").trim();

    if (host) {
      await m.InitializeFromDevice(host);
    } else {
      const found = await m.InitializeWithDiscovery(10);
      if (!found || m.Devices.length === 0) {
        throw new Error(
          "No Sonos devices found on the network. Set a speaker IP under DJ Booth → Settings → Connections (or SONOS_HOST), especially across VLANs/VPNs."
        );
      }
    }

    manager = m;
    initializing = null;
    return manager;
  })();

  try {
    return await initializing;
  } catch (err) {
    initializing = null;
    throw err;
  }
}

export async function listRooms() {
  const m = await getManager();
  return m.Devices.map((d) => ({
    name: d.Name,
    group: d.GroupName,
    isCoordinator: d.Coordinator?.Uuid === d.Uuid,
  }));
}

// Human-readable label for a zone group in the picker UI.
function groupLabel(group) {
  const members = group.members ?? [];
  if (members.length <= 1) return group.coordinator?.name ?? group.name ?? "Unknown";
  const names = members.map((m) => m.name).filter(Boolean);
  return names.length ? names.join(" + ") : (group.name ?? "Group");
}

async function isGroupPlaying(m, group) {
  const coordinator = deviceForMember(m, group.coordinator);
  if (!coordinator) return false;
  try {
    const transport = await coordinator.AVTransportService.GetTransportInfo();
    return transport.CurrentTransportState === "PLAYING";
  } catch {
    return false;
  }
}

function groupMatchesTarget(group, targetRoom) {
  if (!targetRoom) return false;
  const t = targetRoom.toLowerCase();
  if (group.coordinator?.name?.toLowerCase() === t) return true;
  return group.members?.some((m) => m.name?.toLowerCase() === t) ?? false;
}

// All current Sonos groups for the UI picker, with which one is targeted.
// Also returns a flat speaker list for Edit-groups mode.
async function listGroupsRaw() {
  const m = await getManager();
  const targetRoom = getSonosTargetRoom();

  let groups = [];
  try {
    groups = await getZoneGroups(m);
  } catch (err) {
    throw new Error(err.message || "Could not read Sonos groups.");
  }

  const playing = await Promise.all(groups.map((g) => isGroupPlaying(m, g)));

  const out = groups.map((group, i) => {
    const members = (group.members ?? []).map((mem) => mem.name).filter(Boolean);
    const coordinator = group.coordinator?.name ?? members[0] ?? "";
    return {
      groupId: group.groupId,
      label: groupLabel(group),
      coordinator,
      members,
      memberCount: members.length,
      isPlaying: playing[i],
      isTarget: groupMatchesTarget(group, targetRoom),
    };
  });

  // When nothing is explicitly targeted yet, mark the default (first group).
  if (!targetRoom && out.length) out[0].isTarget = true;

  const target =
    out.find((g) => g.isTarget) || (out.length ? out[0] : null);
  const targetMembers = new Set(
    (target?.members || []).map((n) => String(n).toLowerCase())
  );
  const targetCoordinator = String(target?.coordinator || "").toLowerCase();

  const speakers = m.Devices.map((d) => {
    const name = d.Name;
    const key = String(name || "").toLowerCase();
    return {
      name,
      inTargetGroup: targetMembers.has(key),
      isTargetCoordinator: key === targetCoordinator,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return {
    targetRoom: target?.coordinator || targetRoom || null,
    targetLabel: target?.label || null,
    groups: out,
    speakers,
  };
}

// Switch which Sonos group PartyQueue controls. `room` is a coordinator or
// member name from the live topology.
export async function selectGroup(room) {
  const name = String(room || "").trim();
  if (!name) throw new Error("Missing room name.");

  const m = await getManager();
  zoneCache = { at: 0, groups: null };
  const groups = await getZoneGroups(m, { fresh: true });
  const group = pickGroupByTarget(groups, name);
  if (!group) {
    const available = groups
      .flatMap((g) => g.members?.map((mem) => mem.name) ?? [])
      .join(", ");
    throw new Error(`Sonos room "${name}" not found. Available: ${available || "(none)"}`);
  }

  const coordinator = group.coordinator?.name ?? name;
  setSonosTargetRoom(coordinator);
  invalidateSonosSnapshots();

  const members = (group.members ?? []).map((mem) => mem.name).filter(Boolean);
  return {
    targetRoom: coordinator,
    label: groupLabel(group),
    coordinator,
    members,
    memberCount: members.length,
  };
}

// Live zone-group topology, cached very briefly. We re-query Sonos directly
// (instead of trusting the library's cached group state, which can go stale if
// group-change events aren't received) so we always target the REAL current
// coordinator even after speakers are regrouped. The short TTL keeps the 5s
// polls (now playing + queue) from issuing duplicate topology calls.
let zoneCache = { at: 0, groups: null };
let zoneInFlight = null;
const ZONE_TTL_MS = 2000;

async function getZoneGroups(m, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && zoneCache.groups && now - zoneCache.at < ZONE_TTL_MS) {
    return zoneCache.groups;
  }
  // Collapse concurrent topology reads (many phones + DJ watch + autofill).
  if (zoneInFlight) return zoneInFlight;
  zoneInFlight = (async () => {
    try {
      const groups = await m.Devices[0].GetZoneGroupState();
      zoneCache = { at: Date.now(), groups };
      return groups;
    } finally {
      zoneInFlight = null;
    }
  })();
  return zoneInFlight;
}

// Map a topology member (uuid/host) back to a managed SonosDevice instance.
function deviceForMember(m, member) {
  if (!member) return null;
  return (
    m.Devices.find((d) => d.Uuid === member.uuid) ||
    m.Devices.find((d) => d.Host === member.host) ||
    null
  );
}

// Cached-topology fallback, used only if a live topology query fails.
function resolveCoordinatorCached(m, targetRoom) {
  if (targetRoom) {
    const device = m.Devices.find(
      (d) => d.Name.toLowerCase() === targetRoom.toLowerCase()
    );
    if (!device) {
      const available = m.Devices.map((d) => d.Name).join(", ");
      throw new Error(
        `Sonos room "${targetRoom}" not found. Available rooms: ${available || "(none)"}`
      );
    }
    return device.Coordinator ?? device;
  }
  const first = m.Devices[0];
  return first.Coordinator ?? first;
}

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

// Resolve the target group from live topology: its real coordinator plus all
// member devices. Uses the persisted/UI target room, then SONOS_ROOM from env;
// otherwise the first group.
async function resolveGroup(m, opts = {}) {
  const targetRoom = getSonosTargetRoom();

  let groups = null;
  try {
    groups = await getZoneGroups(m, opts);
  } catch {
    groups = null;
  }

  if (groups && groups.length) {
    let group;
    if (targetRoom) {
      group = pickGroupByTarget(groups, targetRoom);
      if (!group) {
        const available = groups
          .flatMap((g) => g.members?.map((mem) => mem.name) ?? [])
          .join(", ");
        throw new Error(
          `Sonos room "${targetRoom}" not found. Available rooms: ${available || "(none)"}`
        );
      }
    } else {
      group = groups[0];
    }

    const coordinator = deviceForMember(m, group.coordinator);
    const members = (group.members ?? [])
      .map((mem) => deviceForMember(m, mem))
      .filter(Boolean);

    if (coordinator) {
      return { coordinator, members: members.length ? members : [coordinator] };
    }
  }

  // Live query failed (or device not found): fall back to cached topology.
  const coordinator = resolveCoordinatorCached(m, targetRoom);
  const members = m.Devices.filter(
    (d) => d.GroupName && d.GroupName === coordinator.GroupName
  );
  return { coordinator, members: members.length ? members : [coordinator] };
}

// Find the coordinator that owns the queue we should add to / control.
async function resolveCoordinator(m, opts = {}) {
  return (await resolveGroup(m, opts)).coordinator;
}

// True when a Sonos error means "you sent a coordinator-only command to a
// speaker that isn't the coordinator" (happens when our topology was stale).
function isNotCoordinatorError(err) {
  return /\b800\b/.test(err?.message ?? "");
}

// Pure: given the current 1-based track pointer, the range of already-played
// tracks to remove (everything before the current song). Returns null when
// nothing precedes the current track. Exported for unit testing.
export function removeRangeFor(track) {
  const t = Number(track) || 0;
  if (t <= 1) return null;
  return { StartingIndex: 1, NumberOfTracks: t - 1 };
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

// Resume playback when the system is idle, so adding a song to a quiet room
// starts the music in queue order. Never hijacks a real external source and
// respects a deliberate pause (see autoStartDecision). Best-effort: never
// throws. Returns true if it actually started playback.
async function autoStartIfIdle(coordinator) {
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

// Pure: 1-based queue position at which to insert a searched song so it lands
// at the bottom of the request block (after any waiting searched songs) and
// still ahead of filler (Random/Never-Ending/discoveries). If all upcoming
// music is already searched we return 0 (append). `searchedIds` is a Set of
// Spotify track IDs known to be guest requests. Exported for unit testing.
export function findInsertPosition(items, { currentTrack = 0, playingFromQueue = false, searchedIds }) {
  const list = Array.isArray(items) ? items : [];
  const set = searchedIds instanceof Set ? searchedIds : new Set(searchedIds || []);
  // Upcoming starts just after the current track when the queue is the live
  // source; otherwise consider the whole queue.
  const start = playingFromQueue && currentTrack >= 1 ? currentTrack : 0;
  // Walk upcoming music only. DJ ramp/TTS pads are neither requests nor filler
  // — inserting before them was putting new requests "up next" and ahead of
  // the existing request block after 5.9's pre-DJ silence pads.
  for (let i = start; i < list.length; i++) {
    const it = list[i];
    const uri = it.TrackUri ?? it.uri;
    const title = it.Title ?? it.title ?? "";
    if (isAnnounceQueuePad(uri, title)) continue;
    const id = spotifyTrackId(uri);
    // First non-searched music track = end of the request block / start of filler.
    if (!id || !set.has(id)) return i + 1;
  }
  return 0; // everything upcoming (music) is already searched -> append (FIFO)
}

/** DJ ramp silence + TTS clips sitting in the Sonos queue around announces. */
function isAnnounceQueuePad(uri, title = "") {
  return (
    isDjSilenceUri(uri) ||
    isDjVoiceUri(uri) ||
    /PartyQueue Silence Bridge|PartyQueue Volume Ramp/i.test(String(title || ""))
  );
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
  const existingWasRequested =
    !!existing?.id && originOf(existing.id) === "searched";
  const byOpts = { requestedBy, requestedByUser, dedication };
  if (existing) {
    // Already queued. If it's filler (Random / Never-Ending / discovery), move
    // that copy to the end of the searched block (just before the first filler)
    // and re-tag it as searched - no duplicate. If it's already searched, leave
    // it where it is (still no duplicate).
    if (!existingWasRequested) {
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
    }
    // A repeated tap on an existing guest request is an idempotent no-op. Keep
    // the original requester attribution instead of letting another guest take
    // ownership of that queue slot.
    if (existing.id && !existingWasRequested) {
      markOrigin([existing.id], "searched", byOpts);
    }
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
    requestCreated: !existing || promoted,
    alreadyRequested: !!existing && !promoted,
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

// Sonos accepts plain HTTP MP3 URIs with empty metadata. Custom DIDL often
// returns UPnP 402 Invalid args on AddURIToQueue.
function httpAudioMeta(url) {
  return { trackUri: url, metadata: "" };
}

// Shared enqueue: add to the group's queue, retrying once against freshly-
// resolved topology if we hit a stale non-coordinator.
//   DesiredFirstTrackNumberEnqueued: 0 -> append to the END of the queue;
//     any 1-based N inserts at that position (used to slot searched songs ahead
//     of filler), pushing the existing track N and later down.
//   EnqueueAsNext: false               -> do NOT use Sonos's own "play next"
async function enqueueMeta(m, meta, position = 0) {
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

// Add `count` random tracks drawn from the host's playlists. Picks one song per
// randomly-chosen playlist (rotating playlists), avoids the same artist back-to-
// back, skips anything already in the queue, skips songs/artists played too
// recently (recent-song memory + per-artist budget), never repeats a song, and
// keeps topping up (re-sampling) until `count` songs are actually enqueued or
// the pool of new songs runs out. Uses the cached per-playlist pool.
export async function addRandomFromPlaylists(...args) {
  return withSonosWriteLock(() => addRandomFromPlaylistsUnlocked(...args));
}

async function addRandomFromPlaylistsUnlocked(
  count = 50,
  playlistIds = null,
  genres = null,
  opts = {}
) {
  const wasPreempted = () =>
    opts.preemptGeneration != null &&
    queueWorkWasPreempted(opts.preemptGeneration);
  const m = await getManager();

  const playlists = await buildPlaylistPool();
  let usable = playlists.filter((p) => (p.tracks || []).length > 0);

  // When a specific set of playlist IDs is provided, only draw from those.
  // (null/undefined = draw from all playlists.)
  if (Array.isArray(playlistIds)) {
    const allow = new Set(playlistIds);
    usable = usable.filter((p) => allow.has(p.id));
    if (usable.length === 0) {
      throw new Error("No tracks in the selected playlists.");
    }
  } else if (usable.length === 0) {
    throw new Error("No tracks found in your playlists.");
  }

  // Genre filter: keep only tracks whose artist falls in an enabled bucket.
  // null/undefined = no filtering. Unresolved artists count as "Other".
  if (Array.isArray(genres)) {
    const enabled = new Set(genres);
    usable = usable
      .map((p) => ({
        ...p,
        tracks: (p.tracks || []).filter((t) => artistMatchesGenres(t.artist, enabled)),
      }))
      .filter((p) => p.tracks.length > 0);
    if (usable.length === 0) {
      throw new Error("No songs match the selected genres.");
    }
  }

  // Content filter: drop explicit tracks when the host has the filter on.
  if (opts.filterExplicit) {
    usable = usable
      .map((p) => ({ ...p, tracks: (p.tracks || []).filter((t) => !t.explicit) }))
      .filter((p) => p.tracks.length > 0);
    if (usable.length === 0) {
      throw new Error("No non-explicit songs available with the current filters.");
    }
  }

  // Era mood: keep only playlist tracks released in the mood's window. Unlike
  // the genre filter, an empty result is NOT an error — the mood's whole point
  // is that the external era top-up covers what the library can't.
  const activeMoodPack = eraMoodPack(opts.mood);
  if (activeMoodPack) {
    usable = usable
      .map((p) => ({
        ...p,
        tracks: (p.tracks || []).filter((t) => trackFitsMood(t, activeMoodPack)),
      }))
      .filter((p) => p.tracks.length > 0);
    if (usable.length === 0) {
      console.log(
        `[moods] no ${activeMoodPack.id} tracks in the selected playlists — filling from era charts`
      );
    }
  }

  // Track IDs to avoid: already in the queue, plus (as we go) ones we've already
  // enqueued or that failed to enqueue. This lets us re-sample to fill `count`.
  const coordinator = await resolveCoordinator(m);
  const queue = await coordinator.GetQueue();
  const queueItems = Array.isArray(queue.Result) ? queue.Result : [];
  // 1-based index where this batch will land (append). DJ set announce inserts
  // immediately before this so Random/Discover stay under guest requests.
  const firstAppendPosition = queueItems.length + 1;
  const exclude = new Set(
    queueItems.map((t) => spotifyTrackId(t.TrackUri)).filter(Boolean)
  );

  // Prefer not starting a new batch with the same artist that's already at the
  // end of the live queue (or currently playing if the queue is empty/idle).
  let queueTailArtist = null;
  for (let i = queueItems.length - 1; i >= 0; i--) {
    const t = queueItems[i];
    if (isDjSilenceTrack(t.TrackUri, t.Title)) continue;
    if (isDjVoiceUri(t.TrackUri) && !isDjSilenceUri(t.TrackUri)) continue;
    queueTailArtist = primaryArtist(t.Artist);
    if (queueTailArtist) break;
  }
  if (!queueTailArtist) {
    try {
      const np = await getNowPlayingFresh();
      if (np && !np.djVoice && !np.djSilence) {
        queueTailArtist = primaryArtist(np.artist);
      }
    } catch {
      /* ignore */
    }
  }

  // Randomness memory: skip songs played too recently (Settings → songMemory
  // window only), and keep any one artist from dominating the recent window.
  // History on disk keeps up to HISTORY_CAP for the Memory UI; that longer
  // list is NOT the Random anti-repeat set.
  // Seeded from persisted history; refreshed from disk before top-up so the
  // budget stays accurate after recordPlayed. Also soft-prefer genre continuity
  // with the last few heard songs, and hard-block artists on skip cooldown.
  const cfg = getRandomnessSettings();
  const recentIds = recentTrackIds(cfg.songMemory);
  let artistSeed = artistCountsInWindow(cfg.artistWindow);
  const blockedArtists = new Set(
    [...artistCooldowns().keys()].map(primaryArtist).filter(Boolean)
  );
  const recentBuckets = new Set();
  for (const e of recentEntries(3)) {
    let buckets = bucketsForArtistSync(e.artist);
    if (!buckets.length) buckets = ["other"];
    for (const b of buckets) recentBuckets.add(b);
  }
  cfg.blockedArtists = blockedArtists;
  cfg.recentBuckets = recentBuckets;
  cfg.bucketsFor = bucketsForArtistSync;
  cfg.lastArtist = queueTailArtist;

  // Discovery is carved out of the requested count, with at least half of every
  // batch retained for selected playlists (Random 2 => one playlist + one discovery).
  const plan = discoveryPlan(
    count,
    Math.max(0, Math.min(50, Math.round(opts.similarCount || 0)))
  );
  const similarWant = plan.similarWant;
  const playlistWant = plan.playlistWant;
  const totalTarget = plan.totalTarget;

  // Genre-lane flow: rotate primary lane across sets, bridge the first picks
  // from the previous lane, soft-prefer compatible neighbors within the set.
  const enabledLanePool = Array.isArray(genres) ? genres : null;
  const flowPrev = getGenreFlowState();
  const setLane = pickSetLane({
    enabled: enabledLanePool,
    previousLane: flowPrev.lastLane,
    recentLanes: flowPrev.recentLanes,
    salt:
      (playlistWant || count || 0) +
      (recentBuckets.size || 0) +
      String(queueTailArtist || "").length,
  });
  let tailBuckets = [];
  if (queueTailArtist) {
    tailBuckets = bucketsForArtistSync(queueTailArtist);
    if (!tailBuckets.length) tailBuckets = ["other"];
  } else if (recentBuckets.size) {
    tailBuckets = [...recentBuckets];
  }
  const bridgeLeft =
    flowPrev.lastLane && flowPrev.lastLane !== setLane
      ? bridgeSlotCount(playlistWant)
      : 0;
  cfg.flowState = {
    lane: setLane,
    previousLane: flowPrev.lastLane,
    bridgeLeft,
    lastBuckets: new Set(tailBuckets),
  };
  console.log(
    `[random] genre lane=${setLane}` +
      (flowPrev.lastLane ? ` (was ${flowPrev.lastLane})` : "") +
      (bridgeLeft ? ` bridge=${bridgeLeft}` : "")
  );

  const artistByUri = new Map();
  const nameByUri = new Map();
  for (const pl of usable) {
    for (const t of pl.tracks || []) {
      artistByUri.set(t.uri, t.artist ?? "");
      nameByUri.set(t.uri, t.name ?? "");
    }
  }

  // 1) Collect the playlist picks up front (pure, no enqueue) so we can mix the
  // discoveries in rather than tacking them on at the end. Mark them excluded so
  // discovery can't duplicate them.
  let relaxedArtist = false;
  let relaxedMemory = false;
  let memoryReuseCount = 0;
  const firstPick = pickWithRelaxation(
    usable,
    exclude,
    playlistWant,
    recentIds,
    artistSeed,
    cfg
  );
  const playlistUris = firstPick.uris;
  relaxedArtist = firstPick.relaxedArtist;
  relaxedMemory = firstPick.relaxedMemory;
  memoryReuseCount = firstPick.memoryReuseCount;
  for (const uri of playlistUris) {
    const id = spotifyTrackId(uri);
    if (id) exclude.add(id);
  }

  // Prefer discoveries from a different artist than the last playlist pick.
  let lastPlaylistArtist = queueTailArtist;
  for (const uri of playlistUris) {
    const artist = primaryArtist(artistByUri.get(uri));
    if (artist) lastPlaylistArtist = artist;
  }

  // 2) "Songs Like" discovery: pull songs similar to the (filtered) pool but
  // OUTSIDE the entire library. Excludes the whole library, the live queue, and
  // recent memory so suggestions are genuinely new. Prefer the set genre lane
  // (neighbors OK); if that yields nothing, retry without the lane (still
  // within enabled genres) before filling from playlists. Caps discoveries to
  // one per artist per batch for diversity.
  let discoveries = [];
  if (similarWant > 0 && activeMoodPack) {
    // Era mood: the outside-library slots come from the era's charts instead
    // of Songs Like, so Discover can't dilute the decade with cross-era picks.
    // The set's genre lane still applies (soft, neighbors OK) so a decade
    // chart can't whiplash a set between hard rock and country.
    const libraryIds = new Set();
    for (const pl of playlists) {
      for (const t of pl.tracks || []) {
        const id = spotifyTrackId(t.uri);
        if (id) libraryIds.add(id);
      }
    }
    try {
      discoveries = await getMoodHits({
        mood: activeMoodPack.id,
        count: similarWant,
        excludeIds: new Set([...libraryIds, ...exclude, ...recentIds]),
        filterExplicit: !!opts.filterExplicit,
        artistCap: cfg.artistCap,
        lastArtist: lastPlaylistArtist,
        moodArtistCap: 1,
        blockedArtists,
        enabledGenres: Array.isArray(genres) ? genres : null,
        bucketsFor: bucketsForArtist,
        preferLane: setLane,
      });
      console.log(
        `[moods] ${activeMoodPack.id}: filled ${discoveries.length}/${similarWant} outside slots from era charts (lane=${setLane})`
      );
    } catch (err) {
      console.error("[moods] era slot fill failed:", err.message);
    }
  } else if (similarWant > 0 && isDiscoveryAvailable()) {
    const libraryIds = new Set();
    for (const pl of playlists) {
      for (const t of pl.tracks || []) {
        const id = spotifyTrackId(t.uri);
        if (id) libraryIds.add(id);
      }
    }
    const discExclude = new Set([...libraryIds, ...exclude, ...recentIds]);
    const seeds = [];
    for (const pl of usable) {
      for (const t of pl.tracks || []) seeds.push({ artist: t.artist, name: t.name });
    }
    const discOpts = {
      seeds,
      excludeIds: discExclude,
      enabledGenres: Array.isArray(genres) ? genres : null,
      filterExplicit: !!opts.filterExplicit,
      // Don't inherit the Random artist-window budget: with artistCap 1 that
      // window is often fully spent, so every popular similar artist is
      // rejected and Discover silently fills from playlists. Song memory +
      // library exclude already keep discoveries fresh; discoveryArtistCap
      // keeps this batch diverse; lastArtist avoids back-to-back repeats.
      artistCap: cfg.artistCap,
      artistSeedCounts: null,
      lastArtist: lastPlaylistArtist,
      discoveryArtistCap: 1,
      blockedArtists,
      flowState: cfg.flowState,
    };
    try {
      discoveries = await getSimilarUris({
        ...discOpts,
        count: similarWant,
        preferLane: setLane,
      });
      const laneHit = discoveries.length;
      if (discoveries.length < similarWant) {
        for (const d of discoveries) {
          if (d.id) discExclude.add(d.id);
        }
        const need = similarWant - discoveries.length;
        const more = await getSimilarUris({
          ...discOpts,
          excludeIds: discExclude,
          count: need,
          preferLane: null,
          flowState: null,
        });
        if (more.length) {
          console.log(
            `[discover] lane=${setLane || "?"} got ${laneHit}/${similarWant}; ` +
              `filled ${more.length} more without lane gate`
          );
          discoveries = discoveries.concat(more);
        } else if (laneHit === 0) {
          console.log(
            `[discover] lane=${setLane || "?"} got 0/${similarWant}; fallback also empty`
          );
        } else {
          console.log(
            `[discover] lane=${setLane || "?"} got ${laneHit}/${similarWant}; fallback empty`
          );
        }
      } else {
        console.log(
          `[discover] lane=${setLane || "?"} got ${laneHit}/${similarWant}`
        );
      }
    } catch (err) {
      console.error("[discover] failed:", err.message);
    }
  }

  // If discovery came up short, fill leftover slots from playlists so the batch
  // still aims for `totalTarget` songs.
  const discoveryShortfall = Math.max(0, similarWant - discoveries.length);
  if (discoveryShortfall > 0) {
    artistSeed = artistCountsInWindow(cfg.artistWindow);
    cfg.lastArtist = lastPlaylistArtist;
    const fill = pickWithRelaxation(
      usable,
      exclude,
      discoveryShortfall,
      recentIds,
      artistSeed,
      cfg
    );
    for (const uri of fill.uris) {
      playlistUris.push(uri);
      const id = spotifyTrackId(uri);
      if (id) exclude.add(id);
      const artist = primaryArtist(artistByUri.get(uri));
      if (artist) lastPlaylistArtist = artist;
    }
    relaxedArtist = relaxedArtist || fill.relaxedArtist;
    relaxedMemory = relaxedMemory || fill.relaxedMemory;
    memoryReuseCount += fill.memoryReuseCount;
  }

  // 3) Mix discoveries through playlist picks (always lead with a playlist
  // pick when any exist). Avoid adjacent Songs Like unless discoveries
  // outnumber the available after-track gaps.
  const playlistItems = playlistUris.map((uri) => ({
    uri,
    id: spotifyTrackId(uri),
    artist: artistByUri.get(uri) ?? "",
    name: nameByUri.get(uri) ?? "",
    discovered: false,
  }));
  // Under an era mood the outside-slot picks are chart hits, not Songs Like —
  // they get their own "mood" origin so the UI badges them by era.
  const discoveryItems = discoveries.map((d) => ({
    uri: d.uri,
    id: d.id,
    artist: d.artist ?? "",
    name: d.name ?? "",
    discovered: !activeMoodPack,
    moodPick: !!activeMoodPack,
  }));
  const order = mixPlaylistAndDiscovery(playlistItems, discoveryItems);

  // 4) Enqueue in that order. `added` = total enqueued (playlist + discovery);
  // `similarAdded` is the discovery subset so the UI can badge the mix.
  let added = 0;
  let similarAdded = 0;
  let moodAdded = 0;
  const recorded = [];
  const discoveredIds = [];
  const moodIds = [];
  const fillerIds = [];
  for (const item of order) {
    if (wasPreempted()) break;
    try {
      const meta = MetaDataHelper.GuessMetaDataAndTrackUri(item.uri, resolveRegion());
      await enqueueMeta(m, meta);
      added++;
      if (item.moodPick) {
        moodAdded++;
        if (item.id) moodIds.push(item.id);
      } else if (item.discovered) {
        similarAdded++;
        if (item.id) discoveredIds.push(item.id);
      } else if (item.id) {
        fillerIds.push(item.id);
      }
      if (item.id) recentIds.add(item.id);
      recorded.push({
        id: item.id,
        artist: item.artist,
        name: item.name,
        source: item.moodPick
          ? "mood"
          : item.discovered
            ? "discovered"
            : "filler",
        mood: item.moodPick ? activeMoodPack?.id || null : null,
      });
    } catch (err) {
      console.error(`[random] failed to add ${item.uri}:`, err.message);
    }
  }
  if (recorded.length) recordPlayed(recorded);
  if (discoveredIds.length) markOrigin(discoveredIds, "discovered");
  if (moodIds.length)
    markOrigin(moodIds, "mood", { mood: activeMoodPack?.id || null });
  if (fillerIds.length) markOrigin(fillerIds, "filler");

  // 5) Top up if some enqueues failed (or discovery shortfall left us under
  // totalTarget), appended at the end. Refresh the artist seed from disk so the
  // budget includes what we just recorded.
  while (added < totalTarget && !wasPreempted()) {
    artistSeed = artistCountsInWindow(cfg.artistWindow);
    const more = pickWithRelaxation(
      usable,
      exclude,
      totalTarget - added,
      recentIds,
      artistSeed,
      cfg
    );
    if (!more.uris.length) break;
    relaxedArtist = relaxedArtist || more.relaxedArtist;
    relaxedMemory = relaxedMemory || more.relaxedMemory;
    memoryReuseCount += more.memoryReuseCount;
    let progressed = false;
    const rec2 = [];
    const filler2 = [];
    for (const uri of more.uris) {
      if (wasPreempted()) break;
      const id = spotifyTrackId(uri);
      exclude.add(id);
      try {
        const meta = MetaDataHelper.GuessMetaDataAndTrackUri(uri, resolveRegion());
        await enqueueMeta(m, meta);
        added++;
        progressed = true;
        if (id) {
          recentIds.add(id);
          filler2.push(id);
        }
        rec2.push({
          id,
          artist: artistByUri.get(uri) ?? "",
          name: nameByUri.get(uri) ?? "",
          source: "filler",
        });
        if (added >= totalTarget) break;
      } catch (err) {
        console.error(`[random] failed to add ${uri}:`, err.message);
      }
    }
    if (rec2.length) recordPlayed(rec2);
    if (filler2.length) markOrigin(filler2, "filler");
    if (!progressed) break;
  }

  // Era top-up: the mood's promise. When the (era-filtered) playlists ran dry
  // before the batch hit its target, fill the remainder with era chart hits
  // from outside the library. Excludes everything queued this batch plus the
  // song-memory window; the library itself is fair game here (anything still
  // eligible would already have been picked above).
  if (activeMoodPack && added < totalTarget && !wasPreempted()) {
    try {
      const hits = await getMoodHits({
        mood: activeMoodPack.id,
        count: totalTarget - added,
        excludeIds: new Set([...exclude, ...recentIds]),
        filterExplicit: !!opts.filterExplicit,
        artistCap: cfg.artistCap,
        artistSeedCounts: artistCountsInWindow(cfg.artistWindow),
        lastArtist: lastPlaylistArtist,
        moodArtistCap: 1,
        blockedArtists,
        enabledGenres: Array.isArray(genres) ? genres : null,
        bucketsFor: bucketsForArtist,
        preferLane: setLane,
      });
      if (hits.length) {
        console.log(
          `[moods] ${activeMoodPack.id}: topping up ${hits.length} era hit(s) — playlists ran dry at ${added}/${totalTarget}`
        );
      }
      const rec3 = [];
      const moodIds3 = [];
      for (const h of hits) {
        if (wasPreempted()) break;
        try {
          const meta = MetaDataHelper.GuessMetaDataAndTrackUri(h.uri, resolveRegion());
          await enqueueMeta(m, meta);
          added++;
          moodAdded++;
          if (h.id) {
            exclude.add(h.id);
            recentIds.add(h.id);
            moodIds3.push(h.id);
          }
          rec3.push({
            id: h.id,
            artist: h.artist,
            name: h.name,
            source: "mood",
            mood: activeMoodPack.id,
          });
          if (added >= totalTarget) break;
        } catch (err) {
          console.error(`[moods] failed to add ${h.uri}:`, err.message);
        }
      }
      if (rec3.length) recordPlayed(rec3);
      if (moodIds3.length)
        markOrigin(moodIds3, "mood", { mood: activeMoodPack.id });
    } catch (err) {
      console.error("[moods] era top-up failed:", err.message);
    }
  }

  // Auto-start playback if the system is idle (stopped), resuming the queue in
  // order. Never hijacks an external source (radio/SiriusXM/line-in) or a
  // deliberate pause (see autoStartDecision). When deferAutoStart is set (DJ
  // voice), we only report that we WOULD have started so the caller can announce
  // first, then Play.
  let started = false;
  let deferredStart = false;
  if (added > 0 && !wasPreempted()) {
    if (opts.deferAutoStart) {
      try {
        const transport = await coordinator.AVTransportService.GetTransportInfo();
        if (autoStartDecision(transport.CurrentTransportState) === "start") {
          deferredStart = true;
        }
      } catch {
        deferredStart = false;
      }
    } else {
      started = await autoStartIfIdle(coordinator);
    }
  }

  // Skip cooldowns tick down by how many songs we actually added this batch.
  if (added > 0) tickArtistCooldowns(added);

  // Remember this set's lane so the next Random / Never-Ending batch rotates.
  if (added > 0 && setLane) recordGenreLane(setLane);

  if (added > 0) invalidateSonosSnapshots();

  // First few tracks for DJ voice copy (artist/title + discovery flag).
  const highlights = recorded.slice(0, 8).map((t) => ({
    artist: t.artist || "",
    name: t.name || "",
    discovered: !!t.discovered,
  }));

  if (added > 0) {
    const discNote =
      similarWant > 0
        ? similarAdded > 0
          ? ` (${added - similarAdded} playlists + ${similarAdded} discoveries)`
          : ` (${added} playlists, 0/${similarWant} discoveries)`
        : "";
    const moodNote = activeMoodPack
      ? ` mood=${activeMoodPack.id} (${moodAdded} era hits)`
      : "";
    console.log(`[random] added ${added}${discNote}${moodNote} lane=${setLane || "?"}`);
  }

  return {
    requested: count,
    batchTarget: totalTarget,
    added,
    started,
    deferredStart,
    firstAppendPosition,
    queueTotalBefore: queueItems.length,
    highlights,
    similarRequested: similarWant,
    similarAdded,
    mood: activeMoodPack?.id ?? null,
    moodAdded,
    relaxedArtist,
    relaxedMemory,
    memoryReuseCount,
    genreLane: setLane,
    preempted: wasPreempted(),
  };
}

// Spread discovery songs through playlist picks (compat export name).
// Prefer mixPlaylistAndDiscovery for new call sites.
export function interleave(base, extra) {
  return mixPlaylistAndDiscovery(base, extra);
}

// DJ Voice clips are HTTP TTS URLs with empty/ugly Sonos metadata. The app
// presents them as the configured DJ name (title line) plus a fun tagline
// from the pack on the artist line (where "PartyQueue" used to sit). Silence
// pads (ramp/restore) must reuse the companion TTS clip's tagline — minting
// one from the silence URL made Now Playing disagree with Up Next.
let lastNowPlayingDjTagline = null;

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

function djVoiceDisplay(
  uri = null,
  { silence = false, remember = false, companionUri = null } = {}
) {
  const dj = getDjVoiceSettings();
  let tagline;
  if (silence) {
    // Never taglineForClip(silenceUri) — that burns a pack slot and drifts
    // from the Up Next TTS row during the lead-in pad.
    if (!lastNowPlayingDjTagline && companionUri) {
      lastNowPlayingDjTagline = taglineForClip(companionUri);
    }
    tagline =
      lastNowPlayingDjTagline ||
      (companionUri ? taglineForClip(companionUri) : "Live from the Booth");
  } else {
    tagline = taglineForClip(uri);
    if (remember) lastNowPlayingDjTagline = tagline;
  }
  return {
    title: dj.djName || DJ_VOICE_DEFAULTS.djName,
    artist: tagline,
    album: "DJ Voice",
    albumArt: dj.djIconUrl || DJ_ICON_DEFAULT_URL,
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

function isDjSilenceTrack(uri, title = "") {
  return (
    isDjSilenceUri(uri) ||
    /PartyQueue Silence Bridge|PartyQueue Volume Ramp/i.test(
      String(title || "")
    )
  );
}

function albumArtUrl(albumArtUri, host) {
  if (!albumArtUri) return null;
  const absolute = albumArtUri.startsWith("http")
    ? albumArtUri
    : `http://${host}:1400${albumArtUri}`;
  return `/api/albumart?u=${encodeURIComponent(absolute)}`;
}

// ---- Shared read snapshots (now-playing + queue) --------------------------
// At a party every open phone polls now-playing AND the queue every few seconds.
// Without sharing, each client triggers its own burst of SOAP calls against one
// speaker, so the load on Sonos scales with the number of guests (10 phones ->
// ~16 calls/sec, 25 -> ~40). We coalesce those reads behind a short-lived
// snapshot: any caller within the TTL window reuses the last result, and
// concurrent callers share a single in-flight request. Sonos load becomes a
// flat ~one read per TTL no matter how many phones are connected. Mutations
// (add/remove/skip/etc.) bust the snapshot so a guest's own action shows up on
// the very next poll instead of waiting out the TTL.
export const NOW_PLAYING_TTL_MS = 1000;
export const SNAPSHOT_TTL_MS = 3000;

export function makeCachedReader(fn, ttlMs) {
  let cache = { at: 0, value: null };
  let inFlight = null;
  let generation = 0;
  const read = async () => {
    if (cache.value && Date.now() - cache.at < ttlMs) return cache.value;
    if (inFlight) return inFlight; // collapse concurrent callers into one read
    const readGeneration = generation;
    const request = (async () => {
      try {
        const value = await fn();
        // A mutation may have invalidated snapshots while this request was in
        // flight. Return its result to the original caller, but never let that
        // stale result repopulate the shared cache.
        if (readGeneration === generation) {
          cache = { at: Date.now(), value };
        }
        return value;
      } finally {
        // Do not let an older invalidated request clear a newer in-flight read.
        if (inFlight === request) inFlight = null;
      }
    })();
    inFlight = request;
    return request;
  };
  read.bust = () => {
    generation += 1;
    cache = { at: 0, value: null };
    // New callers must start a post-mutation read instead of joining an older
    // request. The original caller may still finish, guarded by generation.
    inFlight = null;
  };
  return read;
}

// Last Spotify track ID we recorded from a now-playing change. Dedupes so the
// coalesced poll (many phones) only writes history once per track transition.
let lastHeardTrackId = null;
// Dedupes background lyrics warm so polls don't re-hit LRClib.
let lastWarmedLyricsCurrent = "";
let lastWarmedLyricsNext = "";

function scheduleLyricsWarm(q, slot) {
  const title = String(q?.title || "").trim();
  const artist = String(q?.artist || "").trim();
  if (!title || !artist) return;
  const album = String(q?.album || "").trim();
  const duration =
    q?.duration != null && Number.isFinite(Number(q.duration))
      ? Math.round(Number(q.duration))
      : "";
  const uri = String(q?.uri || "").trim().toLowerCase();
  const key = `${uri}|${title.toLowerCase()}|${artist.toLowerCase()}|${album.toLowerCase()}|${duration}`;
  if (slot === "next") {
    if (key === lastWarmedLyricsNext) return;
    lastWarmedLyricsNext = key;
  } else {
    if (key === lastWarmedLyricsCurrent) return;
    lastWarmedLyricsCurrent = key;
  }
  // Don't block Sonos snapshot reads on LRClib.
  setImmediate(() => warmLyrics(q));
}

async function getNowPlayingRaw() {
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);

  const [pos, transport, groupMute, settings, media] = await Promise.all([
    coordinator.AVTransportService.GetPositionInfo(),
    coordinator.AVTransportService.GetTransportInfo(),
    coordinator.GroupRenderingControlService.GetGroupMute({ InstanceID: 0 }).catch(
      () => ({ CurrentMute: false })
    ),
    coordinator.AVTransportService.GetTransportSettings({ InstanceID: 0 }).catch(
      () => ({ PlayMode: "NORMAL" })
    ),
    coordinator.AVTransportService.GetMediaInfo({ InstanceID: 0 }).catch(
      () => ({ CurrentURI: "" })
    ),
  ]);
  // Shared snapshots can be reused for up to a few seconds. Clients use this
  // observation time to advance RelTime by the snapshot's age.
  const positionObservedAt = Date.now();

  const meta = typeof pos.TrackMetaData === "object" ? pos.TrackMetaData : null;
  const state = transport.CurrentTransportState;
  const hasTrack = meta && (meta.Title || meta.Artist);
  // The local queue is the active source only when CurrentURI is the
  // x-rincon-queue:... URI; SiriusXM/radio/line-in use other schemes.
  const playingFromQueue = /^x-rincon-queue:/.test(media.CurrentURI || "");

  const uri = pos.TrackURI ?? null;
  const silenceBridge = isDjSilenceTrack(uri, meta?.Title);
  const djClip = isDjVoiceUri(uri) && !silenceBridge;
  // Silence pad stays under the DJ persona (name + icon); guests shouldn't see
  // a blank/"silence" track flash between the announce and the first song.
  // Resolve the companion TTS URI so the tagline matches Up Next.
  let companionUri = null;
  if (silenceBridge && playingFromQueue) {
    try {
      const queue = await coordinator.GetQueue();
      const items = Array.isArray(queue.Result) ? queue.Result : [];
      const trackNum = Number(pos.Track) || 0;
      companionUri = findCompanionDjTtsUri(items, trackNum - 1);
    } catch {
      /* best-effort — fall back to last remembered tagline */
    }
  }
  const djPersona =
    djClip || silenceBridge
      ? djVoiceDisplay(uri, {
          silence: silenceBridge,
          remember: true,
          companionUri,
        })
      : null;

  let title;
  let artist;
  let album;
  let albumArt;
  if (djClip || silenceBridge) {
    title = djPersona.title;
    artist = djPersona.artist;
    album = djPersona.album;
    albumArt = djPersona.albumArt;
  } else {
    title = hasTrack
      ? meta.Title ?? null
      : uri
        ? String(uri).split("/").pop() || null
        : null;
    artist = hasTrack ? meta.Artist ?? null : null;
    album = hasTrack ? meta.Album ?? null : null;
    albumArt = hasTrack ? albumArtUrl(meta.AlbumArtUri, coordinator.Host) : null;
  }

  // Record what actually started playing (not only what Random auto-added), so
  // guest requests and Sonos-app picks enter song memory too. Only while the
  // local queue is the source — radio/SiriusXM shouldn't pollute the DJ memory.
  // Skip DJ TTS / silence-bridge clips so filenames don't enter song memory.
  if (playingFromQueue && uri && !djClip && !silenceBridge) {
    const id = spotifyTrackId(uri);
    if (id && id !== lastHeardTrackId) {
      lastHeardTrackId = id;
      // Prefer the queue-origin tag when PartyQueue added it; Sonos-app / radio
      // plays stay untagged.
      const source = originOf(id) || null;
      const mood = source === "mood" ? moodOf(id) : null;
      recordPlayed([
        { id, artist: artist || "", name: title || "", source, mood },
      ]);
    }
  }

  // Sonos reports RelTime / TrackDuration as H:MM:SS (sometimes with decimals).
  const positionSec = parseSonosTime(pos.RelTime);
  const durationSec = parseSonosTime(pos.TrackDuration);

  // Warm lyrics for the current track in the shared server cache (overlay-ready).
  if (hasTrack && !djClip && !silenceBridge && title && artist) {
    scheduleLyricsWarm(
      {
        title,
        artist,
        album: album || "",
        duration: durationSec,
        uri,
      },
      "current"
    );
  }

  return {
    isPlaying: state === "PLAYING",
    queuePlaying: state === "PLAYING" && playingFromQueue,
    queueTrack: Number(pos.Track) || 0,
    state,
    muted: !!groupMute.CurrentMute,
    shuffle: /SHUFFLE/.test(settings.PlayMode || ""),
    title,
    artist,
    album,
    uri,
    albumArt,
    positionSec,
    positionObservedAt,
    durationSec,
    djVoice: djClip || silenceBridge,
    djSilence: silenceBridge,
    room: coordinator.Name,
    // Origin badge for the Now Playing pill (same tags as the queue list).
    ...(() => {
      if (djClip || silenceBridge || !uri) {
        return {
          origin: null,
          searched: false,
          discovered: false,
          requestedBy: null,
          requestedByUser: null,
          dedication: null,
        };
      }
      const id = spotifyTrackId(uri);
      const ometa = id ? originSnapshot().get(id) : null;
      const source = ometa?.source ?? null;
      const badge =
        source === "searched" ? ometa?.requestedBy || null : null;
      const user =
        source === "searched"
          ? ometa?.requestedByUser || ometa?.requestedBy || null
          : null;
      return {
        origin: source, // searched | discovered | mood | filler | null
        searched: source === "searched",
        discovered: source === "discovered",
        moodPick: source === "mood",
        // Decade the track was added under, so badges survive decade swaps.
        mood: source === "mood" ? ometa?.mood || null : null,
        requestedBy: badge,
        requestedByUser: user,
        dedication: source === "searched" ? ometa?.dedication || null : null,
      };
    })(),
  };
}

/** Parse Sonos AVTransport time strings ("0:03:45", "00:03:45.123") to seconds. */
function parseSonosTime(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (!s || s === "NOT_IMPLEMENTED") return null;
  const parts = s.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const sec = Number(parts[parts.length - 1]);
  const min = Number(parts[parts.length - 2]);
  const hr = parts.length === 3 ? Number(parts[0]) : 0;
  if (![hr, min, sec].every((n) => Number.isFinite(n))) return null;
  return hr * 3600 + min * 60 + sec;
}

async function getQueueListRaw() {
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);

  const [queue, pos, media] = await Promise.all([
    coordinator.GetQueue(),
    coordinator.AVTransportService.GetPositionInfo().catch(() => ({ Track: 0 })),
    coordinator.AVTransportService.GetMediaInfo({ InstanceID: 0 }).catch(() => ({
      CurrentURI: "",
    })),
  ]);

  const items = Array.isArray(queue.Result) ? queue.Result : [];

  // Mirror the Sonos app: only show songs still ahead in the queue. The current
  // song lives in the "Now Playing" card, so we drop everything up to and
  // including it. `pos.Track` is the 1-based index of the current track, so
  // slicing at that index leaves only the upcoming songs. We only trim when the
  // queue is the active source (x-rincon-queue:...); for SiriusXM/radio/stopped
  // nothing has played from the queue yet, so we show all of it.
  const playingFromQueue = /^x-rincon-queue:/.test(media.CurrentURI || "");
  const track = Number(pos.Track) || 0;
  const offset = playingFromQueue && track >= 1 ? track : 0;
  // Hide silence bridges from the guest-facing list (still in the Sonos queue
  // for volume handoff). Keep DJ TTS rows so people see the announce coming.
  const upcoming = [];
  for (let i = offset; i < items.length; i++) {
    const t = items[i];
    if (isDjSilenceTrack(t.TrackUri, t.Title)) continue;
    upcoming.push({ t, absoluteIndex: i + 1 });
  }

  // `position` is the absolute 1-based spot in the full Sonos queue (not the
  // displayed index), which queue editing (delete/reorder) needs. `searched` and
  // `discovered` flag how the song was added so the UI can badge them.
  const origin = originSnapshot();
  const tracks = upcoming.map(({ t, absoluteIndex }) => {
    const uri = t.TrackUri ?? null;
    const djClip = isDjVoiceUri(uri) && !isDjSilenceUri(uri);
    const djPersona = djClip ? djVoiceDisplay(uri) : null;
    const meta = origin.get(spotifyTrackId(uri));
    const source = meta?.source ?? null;
    return {
      position: absoluteIndex,
      itemId: t.ItemId ?? null,
      uri,
      title: djClip ? djPersona.title : t.Title ?? "Unknown",
      artist: djClip ? djPersona.artist : t.Artist ?? "",
      album: djClip ? djPersona.album : t.Album ?? "",
      // Surfaced for now-playing prefetch (next 1–2 covers). Queue UI stays text-only.
      albumArt: djClip
        ? djPersona.albumArt
        : albumArtUrl(t.AlbumArtUri, coordinator.Host),
      searched: source === "searched",
      discovered: source === "discovered",
      moodPick: source === "mood",
      // Decade the track was added under, so badges survive decade swaps.
      mood: source === "mood" ? meta?.mood || null : null,
      requestedBy: source === "searched" ? meta?.requestedBy || null : null,
      requestedByUser:
        source === "searched"
          ? meta?.requestedByUser || meta?.requestedBy || null
          : null,
      dedication: source === "searched" ? meta?.dedication || null : null,
      djVoice: djClip,
    };
  });

  // Warm lyrics for the next upcoming track (shared cache; phones pay nothing).
  const next = tracks.find((t) => !t.djVoice && t.title && t.artist);
  if (next) {
    scheduleLyricsWarm(
      {
        title: next.title,
        artist: next.artist,
        album: next.album || "",
        uri: next.uri || "",
      },
      "next"
    );
  }

  return tracks;
}

// Public, coalesced readers. Every client polling within the TTL window shares a
// single Sonos read (and concurrent callers share one in-flight request), so
// Sonos/network load stays flat regardless of how many guests have the app open.
export const getNowPlaying = makeCachedReader(
  getNowPlayingRaw,
  NOW_PLAYING_TTL_MS
);

// Bypass the shared snapshot (and in-flight coalescing). DJ Voice volume
// timing needs a true live URI; a stale guest poll must not delay boost or
// trigger an early restore.
export async function getNowPlayingFresh() {
  return getNowPlayingRaw();
}
export const getQueueList = makeCachedReader(getQueueListRaw, SNAPSHOT_TTL_MS);
export const listGroups = makeCachedReader(listGroupsRaw, SNAPSHOT_TTL_MS);
export const getQueueStatus = makeCachedReader(getQueueStatusRaw, SNAPSHOT_TTL_MS);

// Drop the cached now-playing/queue snapshots so the next poll re-reads Sonos.
// Every mutation below calls this so a guest's own add/remove/skip/clear is
// reflected on the very next refresh instead of lingering for up to the TTL.
const snapshotInvalidationListeners = new Set();

export function onSonosSnapshotsInvalidated(listener) {
  if (typeof listener !== "function") return () => {};
  snapshotInvalidationListeners.add(listener);
  return () => snapshotInvalidationListeners.delete(listener);
}

export function invalidateSonosSnapshots() {
  getNowPlaying.bust();
  getQueueList.bust();
  // Never-Ending reads getQueueStatus — must bust on Clear/mutations or a
  // stale "playing + upcoming≤1" snapshot can refill an empty queue.
  getQueueStatus.bust();
  listGroups.bust();
  for (const listener of [...snapshotInvalidationListeners]) {
    try {
      listener();
    } catch {
      /* invalidation must never fail a Sonos mutation */
    }
  }
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

// Lightweight queue status for the never-ending-queue monitor: just enough to
// decide whether to top up, without the metadata/album-art work getQueueList
// does. `upcoming` is how many songs remain AFTER the current one (mirrors the
// Sonos app / our queue list). We read TotalMatches so the count is right even
// for queues longer than one Browse page.
async function getQueueStatusRaw() {
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);

  const [transport, pos, media, queue] = await Promise.all([
    coordinator.AVTransportService.GetTransportInfo(),
    coordinator.AVTransportService.GetPositionInfo().catch(() => ({ Track: 0 })),
    coordinator.AVTransportService.GetMediaInfo({ InstanceID: 0 }).catch(() => ({
      CurrentURI: "",
    })),
    coordinator.GetQueue(),
  ]);

  const items = Array.isArray(queue.Result) ? queue.Result : [];
  const total = Number(queue.TotalMatches) || items.length;
  const isPlaying = transport.CurrentTransportState === "PLAYING";
  const playingFromQueue = /^x-rincon-queue:/.test(media.CurrentURI || "");
  const track = Number(pos.Track) || 0;
  const upcoming =
    playingFromQueue && track >= 1 ? Math.max(0, total - track) : total;

  return { isPlaying, playingFromQueue, total, track, upcoming };
}

/**
 * Live 1-based queue index of a searched track (for DJ shout placement).
 * Returns null when the song is no longer upcoming.
 */
export async function findUpcomingTrackPosition({ name = "", artist = "" } = {}) {
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);
  const [pos, media, queue] = await Promise.all([
    coordinator.AVTransportService.GetPositionInfo().catch(() => ({ Track: 0 })),
    coordinator.AVTransportService.GetMediaInfo({ InstanceID: 0 }).catch(() => ({
      CurrentURI: "",
    })),
    coordinator.GetQueue().catch(() => ({ Result: [] })),
  ]);
  const items = Array.isArray(queue.Result) ? queue.Result : [];
  const track = Number(pos.Track) || 0;
  const playingFromQueue = /^x-rincon-queue:/.test(media.CurrentURI || "");
  const start = playingFromQueue && track >= 1 ? track : 0; // 0-based upcoming start
  const want = songMatchKey(name, artist);
  if (!want) return null;
  for (let i = start; i < items.length; i++) {
    const it = items[i];
    if (songMatchKey(it.Title, it.Artist) === want) return i + 1;
  }
  return null;
}

/**
 * Live queue context for DJ volume handoff: current track index, next URI,
 * and seconds left on the current track. Used to boost *before* a queued DJ
 * clip starts and to pause briefly when a mid-set shout would race the playhead.
 */
export async function getAnnouncePlaybackContext() {
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);
  const [transport, pos, media, queue] = await Promise.all([
    coordinator.AVTransportService.GetTransportInfo().catch(() => ({
      CurrentTransportState: "",
    })),
    coordinator.AVTransportService.GetPositionInfo().catch(() => ({
      Track: 0,
      RelTime: "",
      TrackDuration: "",
      TrackURI: "",
    })),
    coordinator.AVTransportService.GetMediaInfo({ InstanceID: 0 }).catch(() => ({
      CurrentURI: "",
    })),
    coordinator.GetQueue().catch(() => ({ Result: [], TotalMatches: 0 })),
  ]);
  const items = Array.isArray(queue.Result) ? queue.Result : [];
  const track = Number(pos.Track) || 0;
  const playingFromQueue = /^x-rincon-queue:/.test(media.CurrentURI || "");
  const positionSec = parseSonosTime(pos.RelTime) || 0;
  const durationSec = parseSonosTime(pos.TrackDuration) || 0;
  const remainingSec =
    durationSec > 0 ? Math.max(0, durationSec - positionSec) : null;
  // Next absolute queue item (1-based track N → items[N]).
  const nextItem =
    playingFromQueue && track >= 1 && track < items.length
      ? items[track]
      : null;
  const nextUri = String(nextItem?.TrackUri || nextItem?.uri || "");
  return {
    state: String(transport.CurrentTransportState || ""),
    isPlaying: transport.CurrentTransportState === "PLAYING",
    playingFromQueue,
    track,
    total: Number(queue.TotalMatches) || items.length,
    currentUri: String(pos.TrackURI || ""),
    nextUri,
    remainingSec,
    positionSec,
    durationSec,
  };
}

export async function play(...args) {
  return withSonosTransportLane(() => playUnlocked(...args));
}

async function playUnlocked({ trackNumber } = {}) {
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);

  // Switch the coordinator to its own queue when another source is active
  // (SiriusXM, radio, line-in, etc.) so Play starts the PartyQueue instead of
  // resuming that source. When the queue is ALREADY the active source (e.g.
  // resuming after pause), skip the switch — re-setting the AVTransport URI
  // resets Sonos to queue track 1, which replayed an earlier song on resume.
  let onQueue = false;
  try {
    const media = await coordinator.AVTransportService.GetMediaInfo({
      InstanceID: 0,
    });
    onQueue = /^x-rincon-queue:/.test(media.CurrentURI || "");
  } catch {
    /* best-effort — fall back to switching below */
  }
  if (!onQueue) await coordinator.SwitchToQueue();
  const n = Number(trackNumber);
  if (Number.isFinite(n) && n >= 1) {
    try {
      await coordinator.SeekTrack(n);
      // Seek often leaves the transport paused/idle until a later Play.
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      console.error("[play] SeekTrack failed:", err.message);
    }
  }
  await coordinator.Play();
  await new Promise((r) => setTimeout(r, 200));
  try {
    const transport = await coordinator.AVTransportService.GetTransportInfo();
    const state = String(transport.CurrentTransportState || "");
    // Only retry when clearly idle. TRANSITIONING/PLAYING means the first Play
    // took — a second Play can restart the current track (e.g. DJ TTS twice).
    if (state === "STOPPED" || state === "PAUSED_PLAYBACK") {
      await coordinator.Play();
    }
  } catch {
    /* ignore — first Play is best-effort */
  }

  invalidateSonosSnapshots();
  return { room: coordinator.Name };
}

/** Resume the current queue item without SwitchToQueue/SeekTrack (keeps index). */
export async function resumeQueuePlayback(...args) {
  return withSonosTransportLane(() => resumeQueuePlaybackUnlocked(...args));
}

async function resumeQueuePlaybackUnlocked() {
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);
  await coordinator.Play();
  invalidateSonosSnapshots();
  return { room: coordinator.Name };
}

export async function pause(...args) {
  return withSonosTransportLane(() => pauseUnlocked(...args));
}

async function pauseUnlocked() {
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);
  await coordinator.Pause();
  invalidateSonosSnapshots();
  return { room: coordinator.Name };
}

// Transport: skip to the next track in the group's queue. Treats the skip as
// DJ feedback: the current song enters song memory and its artist is cooled
// down for a few upcoming auto-picks so Random doesn't lean on them again.
export async function next(...args) {
  return withSonosTransportLane(() => nextUnlocked(...args));
}

async function nextUnlocked() {
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);

  // Snapshot what's playing before we skip so we can remember it.
  let skipped = null;
  try {
    const pos = await coordinator.AVTransportService.GetPositionInfo();
    const meta = typeof pos.TrackMetaData === "object" ? pos.TrackMetaData : null;
    const uri = pos.TrackURI ?? null;
    const id = spotifyTrackId(uri);
    if (id) {
      skipped = {
        id,
        artist: meta?.Artist ?? "",
        name: meta?.Title ?? "",
      };
    }
  } catch {
    /* best-effort — still skip even if we can't read now-playing */
  }

  await coordinator.Next();

  if (skipped) {
    recordSkip(skipped);
  }

  invalidateSonosSnapshots();
  return { room: coordinator.Name, skipped: !!skipped };
}

// Transport: go back to the previous track in the group's queue.
export async function previous(...args) {
  return withSonosTransportLane(() => previousUnlocked(...args));
}

async function previousUnlocked() {
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);
  await coordinator.Previous();
  invalidateSonosSnapshots();
  return { room: coordinator.Name };
}

// Map a Sonos PlayMode to its shuffle-toggled counterpart, preserving the
// current repeat setting. Sonos PlayMode pairs shuffle/repeat into one enum.
function toggledShuffleMode(current) {
  switch (current) {
    case "NORMAL":
      return "SHUFFLE_NOREPEAT";
    case "REPEAT_ALL":
      return "SHUFFLE";
    case "REPEAT_ONE":
      return "SHUFFLE_REPEAT_ONE";
    case "SHUFFLE_NOREPEAT":
      return "NORMAL";
    case "SHUFFLE":
      return "REPEAT_ALL";
    case "SHUFFLE_REPEAT_ONE":
      return "REPEAT_ONE";
    default:
      return "SHUFFLE_NOREPEAT";
  }
}

// Transport control: toggle shuffle play order for the group's queue. This
// changes the order songs play in without reordering or destroying the queue,
// so it is reversible and safe to flip during a party.
export async function toggleShuffle(...args) {
  return withSonosTransportLane(() => toggleShuffleUnlocked(...args));
}

async function toggleShuffleUnlocked() {
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);

  const settings = await coordinator.AVTransportService.GetTransportSettings({
    InstanceID: 0,
  });
  const next = toggledShuffleMode(settings.PlayMode || "NORMAL");
  await coordinator.AVTransportService.SetPlayMode({
    InstanceID: 0,
    NewPlayMode: next,
  });

  invalidateSonosSnapshots();
  return { shuffle: /SHUFFLE/.test(next), playMode: next };
}

const VOLUME_STEP = 1;

function assertManualVolumeAvailable() {
  if (!isDjVolumeHandoffActive()) return;
  const error = new Error(
    "DJ volume handoff in progress — volume will return automatically."
  );
  error.statusCode = 423;
  throw error;
}

export async function toggleMute(...args) {
  return withSonosTransportLane(() => {
    assertManualVolumeAvailable();
    return toggleMuteUnlocked(...args);
  });
}

async function toggleMuteUnlocked() {
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);
  const current = await coordinator.GroupRenderingControlService.GetGroupMute({
    InstanceID: 0,
  });
  const desired = !current.CurrentMute;
  await coordinator.GroupRenderingControlService.SetGroupMute({
    InstanceID: 0,
    DesiredMute: desired,
  });
  invalidateSonosSnapshots();
  return { muted: desired };
}

// Pick the canonical "current" level for the group: the most common per-player
// volume (the mode). Ties are broken in favor of the coordinator's level. This
// is what makes an out-of-sync speaker snap to where the rest already are.
// Step the whole group by `delta` while keeping every player LOCKED to one
// shared absolute level. We read each player's own volume, take the HIGHEST as
// the reference, then SET every player to reference + delta. Using absolute
// per-player SetVolume avoids two Sonos quirks: group volume scales each
// speaker proportionally (so they drift apart), and SetRelativeGroupVolume
// silently ignores small positive steps.
const readPlayerVolume = (device) =>
  device.RenderingControlService.GetVolume({
    InstanceID: 0,
    Channel: "Master",
  }).then((r) => r.CurrentVolume);

const setPlayerVolume = (device, volume) =>
  device.RenderingControlService.SetVolume({
    InstanceID: 0,
    Channel: "Master",
    DesiredVolume: volume,
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How long to wait for speakers to finish ramping before re-checking, and how
// many correction passes to attempt. Sonos ramps volume over a few hundred ms
// and, within a group, setting one speaker can briefly tug the others (relative
// group-volume coupling). Re-asserting the absolute target after a short settle
// makes the whole group converge to one exact level.
const SETTLE_MS = 350;
const MAX_PASSES = 4;

// Set every member to one absolute target, then settle + verify in a short
// loop, re-asserting the target on any player that hasn't landed on it yet.
// This guarantees the whole group ends locked to the same exact level.
async function lockGroupVolume(members, target) {
  let toSet = members;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    await Promise.all(toSet.map((device) => setPlayerVolume(device, target)));
    await sleep(SETTLE_MS);

    const after = await Promise.all(
      members.map(async (device) => ({
        device,
        volume: await readPlayerVolume(device),
      }))
    );
    toSet = after.filter((r) => r.volume !== target).map((r) => r.device);
    if (toSet.length === 0) break;
  }
  return toSet.length === 0;
}

async function adjustGroupVolume(delta) {
  const m = await getManager();
  const { members } = await resolveGroup(m);

  // Read every player's CURRENT volume live, then sync the whole group to the
  // LOUDEST one before applying the step. Example: [12, 8, 8] with +1 -> all 13.
  const volumes = await Promise.all(
    members.map((device) => readPlayerVolume(device))
  );
  const reference = Math.max(...volumes);
  const target = Math.max(0, Math.min(100, reference + delta));

  const locked = await lockGroupVolume(members, target);
  return { volume: target, players: members.length, locked };
}

export async function volumeUp(step = VOLUME_STEP) {
  return withSonosTransportLane(() => {
    assertManualVolumeAvailable();
    return adjustGroupVolume(Math.abs(step));
  });
}

export async function volumeDown(step = VOLUME_STEP) {
  return withSonosTransportLane(() => {
    assertManualVolumeAvailable();
    return adjustGroupVolume(-Math.abs(step));
  });
}

// Absolute group volume helpers (0–100) for DJ Voice boost/restore.
// Reads stay unlocked so DJ watch / UI polls don't serialize behind queue writes.
export async function getGroupVolume() {
  const m = await getManager();
  const { members } = await resolveGroup(m);
  const volumes = await Promise.all(
    members.map((device) => readPlayerVolume(device))
  );
  return Math.max(0, ...volumes.map((v) => Number(v) || 0));
}

export async function setGroupVolume(level) {
  return withSonosTransportLane(() => setGroupVolumeUnlocked(level));
}

async function setGroupVolumeUnlocked(level) {
  const m = await getManager();
  const { members } = await resolveGroup(m);
  const target = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
  const locked = await lockGroupVolume(members, target);
  invalidateSonosSnapshots();
  return { volume: target, players: members.length, locked };
}

// Party button: pull every speaker into ONE group and set them all to a known
// volume. We anchor on the current target-room coordinator so whatever is
// playing keeps playing; every other room joins that group.
const GROUP_ALL_VOLUME = 15;

export async function groupAll(...args) {
  return withSonosWriteLock(() => {
    assertManualVolumeAvailable();
    return groupAllUnlocked(...args);
  });
}

async function groupAllUnlocked() {
  const m = await getManager();
  const anchor = await resolveCoordinator(m);

  // Join each other room to the anchor's group (sequential to avoid topology
  // races). Already-grouped rooms are effectively a no-op.
  for (const device of m.Devices) {
    if (device.Uuid === anchor.Uuid) continue;
    try {
      await device.JoinGroup(anchor.Name);
    } catch (err) {
      console.error(`[group-all] ${device.Name} join failed:`, err.message);
    }
  }

  // Let the topology change settle, then drop the cache so later resolves see
  // the new single group, and lock every player to the party volume.
  await sleep(SETTLE_MS);
  zoneCache = { at: 0, groups: null };

  const locked = await lockGroupVolume(m.Devices, GROUP_ALL_VOLUME);
  invalidateSonosSnapshots();
  return { players: m.Devices.length, volume: GROUP_ALL_VOLUME, locked };
}

function findDeviceByName(m, room) {
  const name = String(room || "").trim().toLowerCase();
  if (!name) return null;
  return m.Devices.find((d) => d.Name.toLowerCase() === name) || null;
}

// Join one speaker to the currently targeted group's coordinator.
export async function joinSpeakerToTarget(room) {
  const name = String(room || "").trim();
  if (!name) throw new Error("Missing room name.");

  const m = await getManager();
  const device = findDeviceByName(m, name);
  if (!device) {
    const available = m.Devices.map((d) => d.Name).join(", ");
    throw new Error(`Sonos room "${name}" not found. Available: ${available || "(none)"}`);
  }

  const anchor = await resolveCoordinator(m);
  if (device.Uuid === anchor.Uuid) {
    return { room: device.Name, coordinator: anchor.Name, alreadyInGroup: true };
  }

  await device.JoinGroup(anchor.Name);
  await sleep(SETTLE_MS);
  zoneCache = { at: 0, groups: null };
  invalidateSonosSnapshots();
  return { room: device.Name, coordinator: anchor.Name, joined: true };
}

// Leave the current group (become a standalone coordinator).
export async function leaveSpeakerGroup(room) {
  const name = String(room || "").trim();
  if (!name) throw new Error("Missing room name.");

  const m = await getManager();
  const device = findDeviceByName(m, name);
  if (!device) {
    const available = m.Devices.map((d) => d.Name).join(", ");
    throw new Error(`Sonos room "${name}" not found. Available: ${available || "(none)"}`);
  }

  // Already alone — nothing to do.
  const coord = device.Coordinator ?? device;
  const alone =
    m.Devices.filter((d) => (d.Coordinator ?? d).Uuid === coord.Uuid).length <= 1;
  if (alone) {
    return { room: device.Name, alreadyStandalone: true };
  }

  await device.AVTransportService.BecomeCoordinatorOfStandaloneGroup({
    InstanceID: 0,
  });
  await sleep(SETTLE_MS);
  zoneCache = { at: 0, groups: null };

  // If we just ungrouped the saved target, retarget this speaker (now standalone).
  const target = getSonosTargetRoom();
  if (target && target.toLowerCase() === device.Name.toLowerCase()) {
    setSonosTargetRoom(device.Name);
  }

  invalidateSonosSnapshots();
  return { room: device.Name, left: true };
}

// Split every multi-room group so each speaker stands alone.
export async function ungroupAll() {
  const m = await getManager();
  let changed = 0;

  // Snapshot membership first; BecomeCoordinator changes topology as we go.
  const groups = await getZoneGroups(m, { fresh: true });
  const multiMembers = [];
  for (const g of groups) {
    const members = g.members ?? [];
    if (members.length <= 1) continue;
    for (const mem of members) {
      const device = deviceForMember(m, mem);
      if (device) multiMembers.push(device);
    }
  }

  for (const device of multiMembers) {
    try {
      await device.AVTransportService.BecomeCoordinatorOfStandaloneGroup({
        InstanceID: 0,
      });
      changed += 1;
      await sleep(150);
    } catch (err) {
      console.error(`[ungroup-all] ${device.Name} leave failed:`, err.message);
    }
  }

  await sleep(SETTLE_MS);
  zoneCache = { at: 0, groups: null };
  invalidateSonosSnapshots();
  return { players: m.Devices.length, ungrouped: changed };
}

// Allow the album-art proxy to fetch only from known Sonos speakers (port 1400).
export async function isKnownSonosHost(host) {
  const m = await getManager();
  return m.Devices.some((d) => d.Host === host);
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
