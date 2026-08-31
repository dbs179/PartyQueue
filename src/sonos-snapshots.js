import {
  makeCachedReader,
  GROUPS_TTL_MS,
  NOW_PLAYING_TTL_MS,
  SNAPSHOT_TTL_MS,
} from "./sonos-cache.js";
import {
  getManager,
  resolveCoordinator,
  getZoneGroups,
  deviceForMember,
  setSonosSnapshotInvalidator,
} from "./sonos-core.js";
import {
  findCompanionDjTtsUri,
  isDjVoiceUri,
  isDjSilenceUri,
  isDjSilenceTrack,
  findUpcomingTrackPositionInItems,
  queueTrackGenreFields,
  queueTrackFromPlaylist,
  visibleUpcomingQueueItems,
  upcomingGenreHintFromQueueItems,
} from "./sonos-queue-policy.js";
import { spotifyTrackId } from "./sampler.js";
import { recordPlayed } from "./play-history.js";
import { memoryRequesterIdentityOf } from "./memory-requester.js";
import {
  getSonosTargetRoom,
  getSonosPlayerTypes,
  getDjPersona,
  DJ_VOICE_DEFAULTS,
  DJ_ICON_DEFAULT_URL,
  DJ_PERSONA_HOLY_ROLLER,
} from "./settings.js";
import {
  iconForSonosGroup,
  lookupSonosPlayerType,
  DEFAULT_SONOS_PLAYER_TYPE,
} from "./sonos-player-types.js";
import { taglineForClip } from "./dj-taglines.js";
import { scriptForClip, personaForClip } from "./dj-night-memory.js";
import {
  originOf,
  moodOf,
  originSnapshot,
  originMetaForOccurrence,
  clearConsumedDedication,
  advanceHeardTrack,
} from "./queue-origin.js";
import { warmLyrics } from "./lyrics.js";
import {
  noteSonosReadSuccess,
  noteSonosReadFailure,
} from "./sonos-manager-health.js";
import {
  isPlayerSkipped,
  markPlayerReachable,
  noteSpeakerFailure,
} from "./sonos-reachability.js";
import { envTimeoutMs, withTimeout } from "./with-timeout.js";

/** Per-coordinator budget for the group picker's playing-state scan. */
const GROUP_STATE_TIMEOUT_MS = envTimeoutMs(
  "PARTYQUEUE_GROUP_STATE_TIMEOUT_MS",
  2_000
);

export function groupLabel(group) {
  const members = group.members ?? [];
  if (members.length <= 1) return group.coordinator?.name ?? group.name ?? "Unknown";
  const names = members.map((m) => m.name).filter(Boolean);
  return names.length ? names.join(" + ") : (group.name ?? "Group");
}

// The group picker scans every group, so this runs against speakers that are
// not in the party. Skip anything inside its cool-off and cap the wait, or one
// wedged standalone room slows (and keeps getting hit by) every groups read.
async function isGroupPlaying(m, group) {
  const coordinator = deviceForMember(m, group.coordinator);
  if (!coordinator) return false;
  if (isPlayerSkipped(coordinator)) return false;
  try {
    const transport = await withTimeout(
      coordinator.AVTransportService.GetTransportInfo(),
      GROUP_STATE_TIMEOUT_MS,
      "Sonos group state timed out"
    );
    markPlayerReachable(coordinator);
    return transport.CurrentTransportState === "PLAYING";
  } catch (err) {
    noteSpeakerFailure(coordinator, err);
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
    // Always hit live topology for the group picker — snapshot TTL already
    // coalesces /api/groups; the zone cache must not serve pre-ungroup state.
    groups = await getZoneGroups(m, { fresh: true });
  } catch (err) {
    throw new Error(err.message || "Could not read Sonos groups.");
  }

  const playing = await Promise.all(groups.map((g) => isGroupPlaying(m, g)));
  const playerTypes = getSonosPlayerTypes();

  const out = groups.map((group, i) => {
    const members = (group.members ?? []).map((mem) => mem.name).filter(Boolean);
    const coordinator = group.coordinator?.name ?? members[0] ?? "";
    const row = {
      groupId: group.groupId,
      label: groupLabel(group),
      coordinator,
      members,
      memberCount: members.length,
      isPlaying: playing[i],
      isTarget: groupMatchesTarget(group, targetRoom),
      icon: iconForSonosGroup(
        { members, memberCount: members.length, coordinator },
        playerTypes
      ),
    };
    return row;
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
      playerType:
        lookupSonosPlayerType(playerTypes, name) || DEFAULT_SONOS_PLAYER_TYPE,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return {
    targetRoom: target?.coordinator || targetRoom || null,
    targetLabel: target?.label || null,
    groups: out,
    speakers,
    playerTypes,
  };
}

// DJ Voice clips are HTTP TTS URLs with empty/ugly Sonos metadata. The app
// presents them as the configured DJ name (title line) plus a fun tagline
// from the pack on the artist line (where "PartyQueue" used to sit). Silence
// pads (ramp/restore) must reuse the companion TTS clip's tagline — minting
// one from the silence URL made Now Playing disagree with Up Next.
let lastNowPlayingDjTagline = null;

function djVoiceDisplay(
  uri = null,
  { silence = false, remember = false, companionUri = null } = {}
) {
  const personaId =
    personaForClip(silence ? companionUri : uri) || DJ_PERSONA_HOLY_ROLLER;
  const persona = getDjPersona(personaId);
  const pack = persona.djTaglines;
  let tagline;
  if (silence) {
    // Never taglineForClip(silenceUri) — that burns a pack slot and drifts
    // from the Up Next TTS row during the lead-in pad. The companion clip's
    // tagline wins (stable per clip per night); the last remembered one is
    // only a fallback, otherwise the intro pad shows the PREVIOUS announce's
    // line while Up Next shows the new one.
    const companion = companionUri ? taglineForClip(companionUri, pack) : null;
    tagline = companion || lastNowPlayingDjTagline || "Live from the Booth";
    if (companion && remember) lastNowPlayingDjTagline = companion;
  } else {
    tagline = taglineForClip(uri, pack);
    if (remember) lastNowPlayingDjTagline = tagline;
  }
  return {
    title: persona.djName || DJ_VOICE_DEFAULTS.djName,
    artist: tagline,
    album: "DJ Voice",
    albumArt: persona.djIconUrl || DJ_ICON_DEFAULT_URL,
  };
}

function albumArtUrl(albumArtUri, host) {
  if (!albumArtUri) return null;
  const absolute = albumArtUri.startsWith("http")
    ? albumArtUri
    : `http://${host}:1400${albumArtUri}`;
  return `/api/albumart?u=${encodeURIComponent(absolute)}`;
}

// ---- Shared read snapshots (now-playing + queue) --------------------------
// Coalescing factory + TTLs live in sonos-cache.js; readers below use them.

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
  /** @type {ReturnType<typeof upcomingGenreHintFromQueueItems>} */
  let upcomingForGenre = null;
  if (silenceBridge && playingFromQueue) {
    try {
      const queue = await coordinator.GetQueue();
      const items = Array.isArray(queue.Result) ? queue.Result : [];
      const trackNum = Number(pos.Track) || 0;
      companionUri = findCompanionDjTtsUri(items, trackNum - 1);
      // Reuse this GetQueue for the genre header so enrichNowPlaying does not
      // trigger a second coalesced queue snapshot during silence pads.
      upcomingForGenre = upcomingGenreHintFromQueueItems(items, trackNum);
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
  const announceScript =
    djClip || silenceBridge
      ? scriptForClip(silenceBridge ? companionUri || uri : uri)
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

  // Record what actually started playing. Guest requests rely on this path
  // (and Skip) for song memory — they are not recorded at enqueue. Only while
  // the local queue is the source — radio/SiriusXM shouldn't pollute memory.
  // Skip DJ TTS / silence-bridge clips so filenames don't enter song memory.
  // Consume a searched origin when music advances to a *different* song (or
  // leaves the queue) — never when playback moves onto DJ announce pads, or
  // empty-queue Set Request shouts wipe Requested + Genre on the first track.
  {
    const id =
      playingFromQueue && uri && !djClip && !silenceBridge
        ? spotifyTrackId(uri)
        : null;
    const step = advanceHeardTrack(lastHeardTrackId, {
      playingFromQueue,
      uri,
      djClip,
      silenceBridge,
      trackId: id,
    });
    if (step.heardId) {
      const source = originOf(step.heardId) || null;
      const mood = source === "mood" ? moodOf(step.heardId) : null;
      const who =
        source === "searched" ? memoryRequesterIdentityOf(step.heardId) : null;
      recordPlayed([
        {
          id: step.heardId,
          artist: artist || "",
          name: title || "",
          source,
          mood,
          requestedBy: who?.requestedBy || null,
          alias: who?.alias || null,
        },
      ]);
    }
    if (step.clearId) clearConsumedDedication(step.clearId);
    lastHeardTrackId = step.lastHeardTrackId;
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
    ...(announceScript ? { announceScript } : {}),
    // Internal hint for enrichNowPlaying during silence (stripped before wire).
    ...(upcomingForGenre ? { upcomingForGenre } : {}),
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
      // Oldest live searched instance = the copy that's now playing.
      const ometa = id ? originMetaForOccurrence(id, 0) : null;
      const source = ometa?.source ?? (id ? originOf(id) : null);
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
        // Set lane used when this track was enqueued (survives lane rotation).
        genreLane:
          source === "filler" ||
          source === "discovered" ||
          source === "mood"
            ? ometa?.genreLane || null
            : null,
        reactionSet:
          source === "filler" &&
          (ometa?.reactionSet === "loved" ||
            ometa?.reactionSet === "hated" ||
            ometa?.reactionSet === "requested")
            ? ometa.reactionSet
            : null,
        requestedBy: badge,
        requestedByUser: user,
        dedication: source === "searched" ? ometa?.dedication || null : null,
      };
    })(),
  };
}

/** Parse Sonos AVTransport time strings ("0:03:45", "00:03:45.123") to seconds. */
export function parseSonosTime(value) {
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
  const upcoming = visibleUpcomingQueueItems(items, offset);

  // `position` is the absolute 1-based spot in the full Sonos queue (not the
  // displayed index), which queue editing (delete/reorder) needs. `searched` and
  // `discovered` flag how the song was added so the UI can badge them.
  // Multiple searched copies of the same Spotify id each get their own
  // occurrence meta (Maria / Dave / Owen dedications).
  const playingId =
    playingFromQueue && track >= 1
      ? spotifyTrackId(items[track - 1]?.TrackUri)
      : null;
  const occurrenceCursor = new Map();
  if (playingId) occurrenceCursor.set(playingId, 1); // 0 = now playing
  const rollup = originSnapshot();
  const tracks = upcoming.map(({ t, absoluteIndex }) => {
    const uri = t.TrackUri ?? null;
    const djClip = isDjVoiceUri(uri) && !isDjSilenceUri(uri);
    const djPersona = djClip ? djVoiceDisplay(uri) : null;
    const id = spotifyTrackId(uri);
    const occ = occurrenceCursor.get(id) || 0;
    occurrenceCursor.set(id, occ + 1);
    const meta = id
      ? originMetaForOccurrence(id, occ) || rollup.get(id)
      : null;
    const source = meta?.source ?? (id ? originOf(id) : null);
    const artist = djClip ? djPersona.artist : t.Artist ?? "";
    const genre = queueTrackGenreFields(artist, meta, { djClip });
    return {
      position: absoluteIndex,
      itemId: t.ItemId ?? null,
      uri,
      title: djClip ? djPersona.title : t.Title ?? "Unknown",
      artist,
      album: djClip ? djPersona.album : t.Album ?? "",
      // Surfaced for now-playing prefetch (next 1–2 covers). Queue UI stays text-only.
      albumArt: djClip
        ? djPersona.albumArt
        : albumArtUrl(t.AlbumArtUri, coordinator.Host),
      origin: source || null,
      searched: source === "searched",
      setRequest: source === "searched" ? !!meta?.setRequest : false,
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
      fromPlaylist: !djClip && queueTrackFromPlaylist(id, meta),
      reactionSet:
        source === "filler" &&
        (meta?.reactionSet === "loved" ||
          meta?.reactionSet === "hated" ||
          meta?.reactionSet === "requested")
          ? meta.reactionSet
          : null,
      genreLane: genre.genreLane,
      genreLabel: genre.genreLabel,
      genreLanes: genre.genreLanes,
      genreLabels: genre.genreLabels,
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
  try {
    const value = await getNowPlayingRaw();
    noteSonosReadSuccess();
    return value;
  } catch (err) {
    noteSonosReadFailure();
    throw err;
  }
}

/**
 * Minimal live transport read: only the fields the DJ volume handoff watch loop
 * inspects (uri / state / positionSec). The full now-playing snapshot is five
 * SOAP calls plus an entire GetQueue while a silence pad is current — far too
 * much to run against the party coordinator at the handoff's poll rate.
 */
export async function getTransportTick() {
  try {
    const m = await getManager();
    const coordinator = await resolveCoordinator(m);
    const [pos, transport] = await Promise.all([
      coordinator.AVTransportService.GetPositionInfo(),
      coordinator.AVTransportService.GetTransportInfo(),
    ]);
    noteSonosReadSuccess();
    return {
      uri: pos.TrackURI ?? null,
      state: transport.CurrentTransportState,
      positionSec: parseSonosTime(pos.RelTime),
    };
  } catch (err) {
    noteSonosReadFailure();
    throw err;
  }
}
export const getQueueList = makeCachedReader(getQueueListRaw, SNAPSHOT_TTL_MS);
export const listGroups = makeCachedReader(listGroupsRaw, GROUPS_TTL_MS);
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

/**
 * Live 1-based queue index of a searched track (for DJ shout placement).
 * Returns null when the song is no longer upcoming.
 */
export async function findUpcomingTrackPosition({
  name = "",
  artist = "",
  uri = null,
  expected = null,
} = {}) {
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
  return findUpcomingTrackPositionInItems(items, {
    name,
    artist,
    uri,
    expected,
    currentTrack: track,
    playingFromQueue,
  });
}

/** Used by transport.next when a skip clears the heard-track dedupe. */
export function clearLastHeardIf(id) {
  if (lastHeardTrackId === id) lastHeardTrackId = null;
}

setSonosSnapshotInvalidator(() => invalidateSonosSnapshots());
