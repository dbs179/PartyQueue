import {
  MAX_HANDOFF_ARMED_MS,
  setDjVolumeHandoffActive,
  setDjVolumeHandoffArmed,
} from "./dj-volume-handoff-state.js";
import { handoffWatchSleepMs } from "./dj-volume-handoff.js";
import { noteGroupVolume, volumeGetPayload } from "./sonos-volume.js";
import {
  flushSpeakerVolumeEpoch,
  publishSpeakerVolume,
  resetSpeakerVolumeForTests,
  SPEAKER_VOLUME_CLEANUP_MS,
} from "./dj-speaker-volume.js";

// Volume control for a single-row baked announce.
//
// The room gets two targets, not a staircase. Opening silence publishes the
// announce level. Closing silence publishes the saved music level. Each
// speaker has its own writer, so a slow Office SetVolume cannot hold the
// next target back from the rest of the group.

let announceVolumeRunning = false;
let announceVolumeGeneration = 0;
let lastMusicBaseline = null;
/** Play/Skip just started the clip — poll at 150ms so the opening pad is seen. */
let announcePlaybackImminent = false;
/**
 * Commanded level for the volume indicator. Updated when a target is
 * published, not when a speaker answers. `epoch` keeps a finished announcement
 * from clearing a newer one.
 */
let announceDisplay = null;

export function markAnnouncePlaybackImminent() {
  announcePlaybackImminent = true;
}

/** True while RelTime volume is polling for a baked announce. */
export function isAnnounceVolumeRunning() {
  return announceVolumeRunning;
}

/** Music level the current (or last) volume session is restoring to. */
export function lastAnnounceMusicBaseline() {
  return lastMusicBaseline;
}

/**
 * Baseline for a new shout. Only inherit while another session is still
 * running — otherwise a finished night's first volume becomes every later
 * shout's floor, even after the host turned the room down.
 */
export function inheritAnnounceMusicBaseline({
  running = announceVolumeRunning,
  lastBaseline = lastMusicBaseline,
} = {}) {
  if (running && lastBaseline != null) return lastBaseline;
  return null;
}

/** Test helper — drop session bookkeeping between cases. */
export function resetAnnounceVolumeForTests() {
  announceVolumeRunning = false;
  announceVolumeGeneration = 0;
  lastMusicBaseline = null;
  announcePlaybackImminent = false;
  announceDisplay = null;
  resetSpeakerVolumeForTests();
}

/** Handoff-shaped display state while this announcement owns the indicator. */
export function getAnnounceVolumeDisplayState() {
  return announceDisplay;
}

/**
 * GET /api/volume. The baked announcement's commanded level wins over the
 * idle multi-row handoff snapshot. No Sonos read.
 */
export function announceVolumePayload(fallbackHandoff = null) {
  return volumeGetPayload(announceDisplay || fallbackHandoff);
}

/** Phases of a baked announce, by position within the clip. */
export const ANNOUNCE_PHASE = {
  ramp: "ramp",
  hold: "hold",
  restore: "restore",
  done: "done",
};

/**
 * Clip length the closing target should use.
 *
 * Prefer the shorter of the baked measurement and Sonos TrackDuration so an
 * inflated value cannot schedule the music level into the next song. Ignore a
 * tiny Sonos stub (HTTP streams often report a few seconds first).
 */
export function resolveAnnounceClipDuration(announceDurationSec, liveDurationSec) {
  const baked = Number(announceDurationSec);
  const live = Number(liveDurationSec);
  const bakedOk = Number.isFinite(baked) && baked > 0;
  const liveOk = Number.isFinite(live) && live > 0;
  if (bakedOk && liveOk) {
    const floor = Math.max(4, baked * 0.5);
    if (live < baked && live >= floor) return live;
    return baked;
  }
  if (bakedOk) return baked;
  if (liveOk) return live;
  return 0;
}

/**
 * The level the room should be heading toward at this playhead.
 *
 * Opening silence and speech both want the announce level. Closing silence
 * wants the music level immediately — there is no midpoint and no lerp.
 */
export function announceVolumeAt({
  positionSec,
  durationSec,
  rampSec,
  restoreSec,
  musicVolume,
  announceVolume,
}) {
  const music = clampVolume(musicVolume);
  const announce = clampVolume(announceVolume);
  const duration = Math.max(0, Number(durationSec) || 0);
  const ramp = Math.max(0, Number(rampSec) || 0);
  const restore = Math.max(0, Number(restoreSec) || 0);
  const pos = Math.max(0, Number(positionSec) || 0);

  if (!(duration > 0)) {
    return { phase: ANNOUNCE_PHASE.hold, volume: announce, progress: 1 };
  }
  if (pos >= duration) {
    return { phase: ANNOUNCE_PHASE.done, volume: music, progress: 1 };
  }
  const restoreStart = Math.max(0, duration - restore);
  if (restore > 0 && pos >= restoreStart) {
    return { phase: ANNOUNCE_PHASE.restore, volume: music, progress: 1 };
  }
  if (ramp > 0 && pos < ramp) {
    return { phase: ANNOUNCE_PHASE.ramp, volume: announce, progress: 1 };
  }
  return { phase: ANNOUNCE_PHASE.hold, volume: announce, progress: 1 };
}

/**
 * Lead and margin used to finish a staircase inside the pad. The two-point
 * driver publishes the endpoint at the start of each pad, so those knobs
 * no longer move the level.
 */
export function scheduleAnnounceVolume(ctx = {}) {
  return announceVolumeAt(ctx);
}

/** Kept so older imports still resolve. The staircase no longer uses them. */
export const ANNOUNCE_RAMP_MARGIN_SEC = 0.6;
export const ANNOUNCE_RESTORE_MARGIN_SEC = 0.6;
export const ANNOUNCE_APPLY_LEAD_CAP_SEC = 1;
/**
 * While Sonos reports PLAYING and the clip length is not known, trust
 * wall-clock elapsed only this far ahead of RelTime. A known duration replaces
 * this cap.
 */
export const ANNOUNCE_PLAYHEAD_AHEAD_CAP_SEC = 2.5;

function clampVolume(n) {
  return Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
}

function transportHeld(state) {
  const value = String(state || "");
  return value === "STOPPED" || value === "PAUSED_PLAYBACK" || value === "PAUSED";
}

function knownClipDuration(durationSec) {
  const duration = Number(durationSec);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function boundPlayhead(position, reported, durationSec) {
  const duration = knownClipDuration(durationSec);
  const ahead = Math.max(0, Math.max(reported, position));
  if (!duration) {
    return Math.min(ahead, Math.max(0, reported) + ANNOUNCE_PLAYHEAD_AHEAD_CAP_SEC);
  }
  return Math.min(ahead, duration);
}

/**
 * Playhead used to choose a volume.
 *
 * PLAYING with a known clip length follows wall-clock elapsed up to that
 * length, even when RelTime stays at 0. Without a length, elapsed may lead
 * RelTime by at most {@link ANNOUNCE_PLAYHEAD_AHEAD_CAP_SEC}.
 *
 * Leaving PLAYING freezes the estimate. Paused or stopped time is not added
 * back in when playback resumes.
 */
export function estimateAnnouncePlayhead(sample, nowMs, origin, durationSec = 0) {
  const reported = Math.max(0, Number(sample?.positionSec) || 0);
  const duration = knownClipDuration(durationSec);
  if (sample?.state !== "PLAYING") {
    let frozen = reported;
    if (origin?.playing === true && Number.isFinite(origin.positionSec)) {
      frozen = Math.max(origin.positionSec, reported);
    } else if (origin?.playing === false && origin.frozenSec != null) {
      frozen = Math.max(origin.frozenSec, reported);
    }
    const positionSec = boundPlayhead(frozen, frozen, duration);
    return { positionSec, originAt: null, playing: false, frozenSec: positionSec };
  }
  const at = Number.isFinite(Number(sample?.observedAt))
    ? Number(sample.observedAt)
    : nowMs;
  const resumed = origin?.playing === false;
  let originAt = resumed ? null : origin?.originAt;
  if (originAt == null) {
    const start =
      resumed && origin?.frozenSec != null
        ? Math.max(origin.frozenSec, reported)
        : reported;
    originAt = at - start * 1000;
  } else {
    const implied = at - reported * 1000;
    if (implied < originAt) originAt = implied;
  }
  const elapsed = Math.max(0, (at - originAt) / 1000);
  const positionSec = boundPlayhead(elapsed, reported, duration);
  return { positionSec, originAt, playing: true, frozenSec: null };
}

function speakersFrom(io) {
  if (Array.isArray(io?.speakers)) return io.speakers;
  if (typeof io?.setVolume !== "function") return [];
  return [
    {
      Name: io.speakerName || "group",
      setVolume: (level) => io.setVolume(level),
      getVolume:
        typeof io.getVolume === "function" ? () => io.getVolume() : undefined,
    },
  ];
}

/**
 * Watch one baked announce and publish its two volume endpoints.
 *
 * `io.read` is never held behind a speaker write. `io.speakers` is the set
 * captured when the announcement started; a timeout inside a write does not
 * remove a speaker from that set.
 */
export async function runAnnounceVolume(announce, io, opts = {}) {
  const pollMs = opts.pollMs ?? 150;
  const waitMs = opts.waitMs ?? pollMs;
  const graceMs = opts.graceMs ?? 4000;
  const maxMs = opts.maxMs ?? MAX_HANDOFF_ARMED_MS;
  const logger = opts.logger ?? console;
  const debug = opts.logger?.debug?.bind(opts.logger) ?? (() => {});
  const now = io.now ?? Date.now;
  const clock = typeof io.mono === "function" ? io.mono : now;
  const speakers = speakersFrom(io);

  const matches = (uri) => uriMatchesClip(uri, announce.clipUrl);
  const started = now();
  let sawClip = false;
  let reason = "complete";
  let musicVolume =
    announce.musicVolume == null ? null : clampVolume(announce.musicVolume);
  let announceVolume =
    announce.announceVolume == null ? null : clampVolume(announce.announceVolume);
  let published = null;
  let playOrigin = { originAt: null };
  let activeDurationSec = Math.max(0, Number(announce.durationSec) || 0);
  let warnedOpening = false;
  let consecutiveReadFailures = 0;
  const timeline = {
    generatedDurationSec: Number(announce.durationSec) || 0,
    openingSilenceSec: Number(announce.rampSec) || 0,
    closingSilenceSec: Number(announce.restoreSec) || 0,
    playbackStartAt: null,
    rampUpStartAt: null,
    rampUpDoneAt: null,
    expectedSpeechStartAt: null,
    expectedSpeechEndAt: null,
    expectedAnnounceEndAt: null,
    rampDownStartAt: null,
    rampDownDoneAt: null,
    announceEndAt: null,
    nextTrackAt: null,
  };

  const generation = ++announceVolumeGeneration;
  announceVolumeRunning = true;
  setDjVolumeHandoffArmed(true);
  const owns = () => generation === announceVolumeGeneration;

  const ensureLevels = async () => {
    if (musicVolume != null && announceVolume != null) return true;
    if (typeof io.getVolume !== "function") return false;
    try {
      const live = clampVolume(await io.getVolume());
      musicVolume = live;
      announceVolume = announce.calculateTarget
        ? clampVolume(announce.calculateTarget(live))
        : live;
      return true;
    } catch {
      return false;
    }
  };

  const rememberBaseline = (level) => {
    if (owns() && level != null) lastMusicBaseline = level;
  };
  rememberBaseline(musicVolume);

  const publish = (level) => {
    if (!owns() || level == null) return;
    const next = clampVolume(level);
    if (published === next) return;
    published = next;
    noteGroupVolume(next);
    announceDisplay = {
      epoch: generation,
      phase:
        musicVolume != null && next === musicVolume
          ? "ramping-down"
          : "ramping-up",
      volumeLocked: true,
      currentVolume: next,
    };
    const appliedAt = clock();
    if (announceVolume != null && next === announceVolume) {
      if (!timeline.rampUpStartAt) timeline.rampUpStartAt = appliedAt;
      if (!timeline.rampUpDoneAt) {
        timeline.rampUpDoneAt = appliedAt;
        debug("[dj-volume] announce target published");
      }
    }
    if (musicVolume != null && next === musicVolume) {
      if (!timeline.rampDownStartAt) timeline.rampDownStartAt = appliedAt;
      if (!timeline.rampDownDoneAt) {
        timeline.rampDownDoneAt = appliedAt;
        timeline.announceEndAt = appliedAt;
        debug("[dj-volume] music target published");
      }
    }
    for (const speaker of speakers) publishSpeakerVolume(speaker, next, generation);
  };

  const watchSleep = () =>
    sawClip || announcePlaybackImminent ? pollMs : waitMs;

  try {
    while (now() - started < maxMs) {
      if (!owns()) {
        reason = "superseded";
        break;
      }
      let sample;
      try {
        sample = (await io.read()) ?? {};
        consecutiveReadFailures = 0;
      } catch (err) {
        consecutiveReadFailures += 1;
        debug(
          `[dj-volume] transport read failed (${consecutiveReadFailures} in a row): ${err?.message || err}`
        );
        await io.sleep(
          announcePlaybackImminent && !sawClip
            ? pollMs
            : handoffWatchSleepMs(consecutiveReadFailures, watchSleep())
        );
        continue;
      }

      const uri = sample.uri;
      const reportedPos = Number(sample.positionSec) || 0;
      if (matches(uri)) {
        if (!sawClip && transportHeld(sample.state) && reportedPos < 0.05) {
          await io.sleep(pollMs);
          continue;
        }
        const clipDuration = resolveAnnounceClipDuration(
          announce.durationSec,
          sample.durationSec
        );
        const explicitState = sample.state != null;
        const tracked = explicitState
          ? estimateAnnouncePlayhead(sample, clock(), playOrigin, clipDuration)
          : {
              positionSec: reportedPos,
              originAt: null,
              playing: true,
              frozenSec: null,
            };
        if (explicitState) playOrigin = tracked;
        const positionSec = tracked.positionSec;
        if (!sawClip) {
          const startedAt = clock() - positionSec * 1000;
          timeline.playbackStartAt = startedAt;
          const rampMs = Math.max(0, Number(announce.rampSec) || 0) * 1000;
          const restoreMs = Math.max(0, Number(announce.restoreSec) || 0) * 1000;
          const durMs = Math.max(0, Number(clipDuration) || 0) * 1000;
          timeline.expectedSpeechStartAt = startedAt + rampMs;
          timeline.expectedSpeechEndAt = startedAt + Math.max(0, durMs - restoreMs);
          timeline.expectedAnnounceEndAt = startedAt + durMs;
          debug(
            `[dj-volume] playback started (position ${positionSec.toFixed(2)}s)`
          );
          const opening = Math.max(0, Number(announce.rampSec) || 0);
          if (!warnedOpening && opening > 0 && positionSec >= opening) {
            warnedOpening = true;
            logger.warn?.(
              `[dj-volume] opening silence missed; first playhead ${positionSec.toFixed(2)}s is already in speech`
            );
          }
          try {
            opts.onClipStart?.({
              uri,
              positionSec: reportedPos,
              queueTrack: sample.queueTrack,
            });
          } catch (err) {
            logger.warn?.(
              `[dj-volume] onClipStart failed: ${err?.message || err}`
            );
          }
        }
        sawClip = true;
        announcePlaybackImminent = false;
        setDjVolumeHandoffActive(true);
        if (!(await ensureLevels())) {
          await io.sleep(pollMs);
          continue;
        }
        if (!owns()) {
          reason = "superseded";
          break;
        }
        rememberBaseline(musicVolume);
        activeDurationSec = clipDuration;
        const endpoint = announceVolumeAt({
          positionSec,
          durationSec: clipDuration,
          rampSec: announce.rampSec,
          restoreSec: announce.restoreSec,
          musicVolume,
          announceVolume,
        });
        publish(endpoint.volume);
        if (
          endpoint.phase === ANNOUNCE_PHASE.done ||
          endpoint.phase === ANNOUNCE_PHASE.restore
        ) {
          break;
        }
      } else if (sawClip) {
        reason = "left-playhead";
        timeline.nextTrackAt = clock();
        if (!timeline.announceEndAt) timeline.announceEndAt = timeline.nextTrackAt;
        break;
      } else if (now() - started > graceMs) {
        reason = "never-started";
        break;
      }
      await io.sleep(watchSleep());
    }
    if (owns() && now() - started >= maxMs && reason === "complete" && !sawClip) {
      reason = "timeout";
    }
  } finally {
    const superseded = !owns();
    if (superseded) reason = "superseded";
    try {
      if (!superseded && sawClip && musicVolume != null) {
        publish(musicVolume);
        await flushSpeakerVolumeEpoch(generation, {
          budgetMs: SPEAKER_VOLUME_CLEANUP_MS,
          now,
          sleep: (ms) => io.sleep(ms),
        });
      }
    } catch (err) {
      logger.error?.(
        `[dj-volume] could not finish speaker volume: ${err?.message || err}`
      );
    } finally {
      if (announceDisplay?.epoch === generation) announceDisplay = null;
      if (owns()) {
        announceVolumeRunning = false;
        announcePlaybackImminent = false;
        setDjVolumeHandoffActive(false);
        if (sawClip) setDjVolumeHandoffArmed(false);
      }
    }
    debug("[dj-volume] announce timeline", { reason, activeDurationSec, ...timeline });
  }
  return { reason, sawClip, timeline };
}

/**
 * Match a queue URI against the baked clip URL. Sonos rewrites the URL it was
 * handed (proxy prefixes, query strings), so compare on the file name.
 */
export function uriMatchesClip(uri, clipUrl) {
  const value = String(uri || "");
  const want = String(clipUrl || "");
  if (!value || !want) return false;
  if (value === want) return true;
  const fileName = (want.split("/").pop() || "").split("?")[0];
  return !!fileName && value.includes(fileName);
}
