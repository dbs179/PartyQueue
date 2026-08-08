import { withSonosTransportLane } from "./sonos-lock.js";
import { getManager, resolveCoordinator } from "./sonos-core.js";
import {
  invalidateSonosSnapshots,
  parseSonosTime,
  clearLastHeardIf,
} from "./sonos-snapshots.js";
import { assertManualVolumeAvailable } from "./sonos-volume.js";
import { spotifyTrackId } from "./sampler.js";
import { recordSkip } from "./play-history.js";
import { originOf, moodOf, clearConsumedDedication } from "./queue-origin.js";
import {
  cancelActiveDjVolumeHandoff,
  isDjVolumeHandoffActive,
} from "./dj-volume-handoff.js";
import { isAnnounceQueuePad } from "./sonos-queue-policy.js";
import {
  SEEK_END_LEAD_SEC,
  decideSkipAnnounceAction,
  findNextMusicTrackNumber,
  formatSonosRelTime,
} from "./skip-announce-policy.js";

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
//
// Announce-aware policy (see skip-announce-policy.js):
// - Music with next = announce pad → seek near end (natural handoff into DJ).
// - Already on announce pads / volume-locked handoff → jump to next music.
//
// Pass `{ announceAware: false }` (or use advanceQueueTrack) for internal
// handoff advances — announce-aware Skip must never run from inside the
// volume handoff (it would cancel itself and leave the room paused).
export async function next(...args) {
  return withSonosTransportLane(() => nextUnlocked(...args));
}

/** Raw Sonos Next() for DJ volume handoff pad advances (no announce policy). */
export async function advanceQueueTrack() {
  return withSonosTransportLane(() =>
    nextUnlocked({ announceAware: false })
  );
}

function rememberSkippedTrack(skipped) {
  if (!skipped?.id) return;
  const source = originOf(skipped.id) || null;
  recordSkip({
    ...skipped,
    source,
    mood: source === "mood" ? moodOf(skipped.id) : null,
  });
  clearConsumedDedication(skipped.id);
  clearLastHeardIf(skipped.id);
}

async function nextUnlocked(opts = {}) {
  const announceAware = opts?.announceAware !== false;
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);

  if (!announceAware) {
    await coordinator.Next();
    invalidateSonosSnapshots();
    return { room: coordinator.Name, skipped: false, raw: true };
  }

  let skipped = null;
  let decision = { action: "normalNext" };
  let queueItems = [];
  let track = 0;
  let playingFromQueue = false;
  let currentIsAnnouncePad = false;

  try {
    const [pos, media, queue] = await Promise.all([
      coordinator.AVTransportService.GetPositionInfo(),
      coordinator.AVTransportService.GetMediaInfo({ InstanceID: 0 }).catch(
        () => ({ CurrentURI: "" })
      ),
      coordinator.GetQueue().catch(() => ({ Result: [] })),
    ]);
    const meta = typeof pos.TrackMetaData === "object" ? pos.TrackMetaData : null;
    const uri = pos.TrackURI ?? null;
    const title = meta?.Title ?? "";
    const id = spotifyTrackId(uri);
    if (id) {
      skipped = {
        id,
        artist: meta?.Artist ?? "",
        name: title,
      };
    }
    currentIsAnnouncePad = isAnnounceQueuePad(uri, title);

    queueItems = Array.isArray(queue.Result) ? queue.Result : [];
    track = Number(pos.Track) || 0;
    playingFromQueue = /^x-rincon-queue:/.test(media.CurrentURI || "");
    const nextItem =
      playingFromQueue && track >= 1 && track < queueItems.length
        ? queueItems[track]
        : null;
    decision = decideSkipAnnounceAction({
      currentUri: uri,
      currentTitle: title,
      nextUri: nextItem?.TrackUri ?? nextItem?.uri ?? "",
      nextTitle: nextItem?.Title ?? nextItem?.title ?? "",
      durationSec: parseSonosTime(pos.TrackDuration),
      positionSec: parseSonosTime(pos.RelTime),
      volumeLocked: isDjVolumeHandoffActive(),
    });
  } catch (err) {
    console.error("[next] announce context failed:", err.message);
    decision = { action: "normalNext" };
  }

  if (decision.action === "seekNearEnd") {
    try {
      if (!decision.alreadyNearEnd) {
        await coordinator.SeekPosition(
          formatSonosRelTime(decision.targetSec)
        );
      }
      // Keep transport rolling into the handoff pads.
      try {
        const transport =
          await coordinator.AVTransportService.GetTransportInfo();
        const state = String(transport.CurrentTransportState || "");
        if (state === "STOPPED" || state === "PAUSED_PLAYBACK") {
          await coordinator.Play();
        }
      } catch {
        /* best-effort */
      }
      rememberSkippedTrack(skipped);
      invalidateSonosSnapshots();
      console.info(
        `[next] seek-near-end into announce (lead=${SEEK_END_LEAD_SEC}s` +
          `${decision.alreadyNearEnd ? ", already-near-end" : ""})`
      );
      return {
        room: coordinator.Name,
        skipped: !!skipped,
        seekNearEnd: true,
        alreadyNearEnd: !!decision.alreadyNearEnd,
      };
    } catch (err) {
      console.error(
        "[next] seek-near-end failed; jumping announce:",
        err.message
      );
      decision = { action: "jumpAnnounce" };
    }
  }

  if (decision.action === "jumpAnnounce") {
    try {
      await cancelActiveDjVolumeHandoff("host skip announce");
      const musicTrack = playingFromQueue
        ? findNextMusicTrackNumber(queueItems, track)
        : null;
      if (musicTrack != null) {
        await playUnlocked({ trackNumber: musicTrack });
      } else {
        // No music ahead — leave the pad/handoff cancelled at baseline.
        try {
          await coordinator.Play();
        } catch {
          /* ignore */
        }
      }
      // Pads / DJ clips are not song skips for DJ memory. Jumping *from*
      // music (e.g. missing duration before an announce) still counts.
      if (skipped && !currentIsAnnouncePad) {
        rememberSkippedTrack(skipped);
      }
      invalidateSonosSnapshots();
      return {
        room: coordinator.Name,
        skipped: !!(skipped && !currentIsAnnouncePad),
        abortedAnnounce: true,
        jumpedToTrack: musicTrack,
      };
    } catch (err) {
      console.error("[next] jump announce failed:", err.message);
      // Fall through to raw Next only as last resort.
    }
  }

  await coordinator.Next();

  rememberSkippedTrack(skipped);

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
