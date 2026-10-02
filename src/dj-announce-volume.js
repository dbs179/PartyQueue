import {
  MAX_HANDOFF_ARMED_MS,
  setDjVolumeHandoffActive,
  setDjVolumeHandoffArmed,
} from "./dj-volume-handoff-state.js";
import { handoffWatchSleepMs } from "./dj-volume-handoff.js";

// Volume control for a single-row baked announce.
//
// The old handoff had to chase the playhead across a ramp pad, one or two TTS
// rows and a restore pad, which is why it issued SeekTrack, Pause, Play and
// Next. Every one of those is a transport command that Sonos can refuse, and a
// refusal left the room stranded.
//
// With the pads baked into the clip there is nothing to chase. The whole
// behaviour is a function of how far into the one row we are, so this module
// issues exactly one kind of command: SetVolume.

let announceVolumeRunning = false;
let announceVolumeGeneration = 0;
let lastMusicBaseline = null;

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
}

/** Phases of a baked announce, by position within the clip. */
export const ANNOUNCE_PHASE = {
  ramp: "ramp",
  hold: "hold",
  restore: "restore",
  done: "done",
};

/**
 * Clip length the restore ramp should use.
 *
 * Prefer the shorter of the baked measurement and Sonos TrackDuration so an
 * inflated value cannot schedule restore into the next song. Ignore a tiny
 * Sonos stub (HTTP streams often report a few seconds first) so we do not
 * dump volume during the DJ's first words.
 *
 * @param {number} announceDurationSec
 * @param {number} liveDurationSec
 * @returns {number}
 */
export function resolveAnnounceClipDuration(
  announceDurationSec,
  liveDurationSec
) {
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
 * Where we are inside a baked announce, and what the group volume should be.
 *
 * Ramps are linear across the silent pads, so the level is already correct by
 * the time the DJ speaks and already back to the music level before the next
 * song starts. Both pads are silent, so neither ramp is audible.
 *
 * @param {{
 *   positionSec: number,
 *   durationSec: number,
 *   rampSec: number,
 *   restoreSec: number,
 *   musicVolume: number,
 *   announceVolume: number,
 * }} ctx
 * @returns {{ phase: string, volume: number, progress: number }}
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

  if (duration <= 0) return { phase: ANNOUNCE_PHASE.hold, volume: announce, progress: 0 };
  if (pos >= duration) {
    return { phase: ANNOUNCE_PHASE.done, volume: music, progress: 1 };
  }

  // A clip too short to hold both pads still has to end at the music level, so
  // the restore ramp wins the overlap rather than leaving the room boosted.
  const restoreStart = Math.max(0, duration - restore);

  if (pos >= restoreStart && restore > 0) {
    const t = clamp01((pos - restoreStart) / restore);
    return {
      phase: ANNOUNCE_PHASE.restore,
      volume: lerpVolume(announce, music, t),
      progress: t,
    };
  }
  if (pos < ramp && ramp > 0) {
    const t = clamp01(pos / ramp);
    return {
      phase: ANNOUNCE_PHASE.ramp,
      volume: lerpVolume(music, announce, t),
      progress: t,
    };
  }
  return { phase: ANNOUNCE_PHASE.hold, volume: announce, progress: 1 };
}

function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

function clampVolume(n) {
  return Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
}

function lerpVolume(from, to, t) {
  return clampVolume(from + (to - from) * clamp01(t));
}

/**
 * Finish the opening ramp this long before speech, and the restore this long
 * before the clip ends. The curve used to land on the boundary itself, so the
 * SetVolume that was still in flight spilled into the DJ or the next song.
 */
export const ANNOUNCE_RAMP_MARGIN_SEC = 0.6;
export const ANNOUNCE_RESTORE_MARGIN_SEC = 0.6;
/** Don't aim more than this far ahead of the playhead to absorb one slow write. */
export const ANNOUNCE_APPLY_LEAD_CAP_SEC = 1;
/**
 * While Sonos reports PLAYING, trust wall-clock elapsed up to this far ahead of
 * a lagging RelTime. A stuck 0:00:00 used to keep the ramp in the opening pad
 * after the DJ was already talking. Capped so a frozen position cannot run the
 * whole shout on a timer.
 */
export const ANNOUNCE_PLAYHEAD_AHEAD_CAP_SEC = 2.5;

/**
 * Volume for the level that will land when SetVolume returns, not the level
 * for the position we just read.
 *
 * Opening: aim `leadSec` ahead and compress the curve so it reaches the
 * announce level `rampMarginSec` before speech. Closing: same idea, so the
 * music level lands `restoreMarginSec` before the clip ends. The hold in
 * between is not pulled early — a lead must not duck the last words.
 *
 * With lead 0 and both margins 0 this matches {@link announceVolumeAt}.
 */
export function scheduleAnnounceVolume({
  positionSec,
  durationSec,
  rampSec,
  restoreSec,
  musicVolume,
  announceVolume,
  leadSec = 0,
  rampMarginSec = ANNOUNCE_RAMP_MARGIN_SEC,
  restoreMarginSec = ANNOUNCE_RESTORE_MARGIN_SEC,
  applyLeadCapSec = ANNOUNCE_APPLY_LEAD_CAP_SEC,
}) {
  const base = {
    positionSec,
    durationSec,
    rampSec,
    restoreSec,
    musicVolume,
    announceVolume,
  };
  const duration = Math.max(0, Number(durationSec) || 0);
  const ramp = Math.max(0, Number(rampSec) || 0);
  const restore = Math.max(0, Number(restoreSec) || 0);
  const pos = Math.max(0, Number(positionSec) || 0);
  const leadCap = Math.max(0, Number(applyLeadCapSec) || 0);
  const lead = Math.max(0, Math.min(leadCap, Number(leadSec) || 0));
  const rampMargin = Math.max(0, Math.min(ramp * 0.5, Number(rampMarginSec) || 0));
  const restoreMargin = Math.max(
    0,
    Math.min(restore * 0.5, Number(restoreMarginSec) || 0)
  );
  if (duration <= 0) return announceVolumeAt(base);
  if (pos >= duration) return announceVolumeAt({ ...base, positionSec: duration });

  const speechStart = ramp;
  const speechEnd = Math.max(ramp, duration - restore);

  if (pos < speechStart && ramp > 0) {
    const window = Math.max(0.05, ramp - rampMargin);
    const aimed = Math.min(speechStart, pos + lead);
    if (aimed >= window) {
      // Already inside the margin: be at the announce level while it is still silent.
      return announceVolumeAt({ ...base, positionSec: ramp });
    }
    return announceVolumeAt({ ...base, positionSec: aimed, rampSec: window });
  }

  if (pos >= speechEnd && restore > 0) {
    const window = Math.max(0.05, restore - restoreMargin);
    const virtualEnd = speechEnd + window;
    const aimed = Math.min(duration, pos + lead);
    return announceVolumeAt({
      ...base,
      positionSec: Math.min(virtualEnd, aimed),
      durationSec: virtualEnd,
      restoreSec: window,
    });
  }

  return announceVolumeAt(base);
}

function transportHeld(state) {
  const value = String(state || "");
  return value === "STOPPED" || value === "PAUSED_PLAYBACK" || value === "PAUSED";
}

/**
 * Playhead used to choose a volume. PLAYING samples advance on the wall clock
 * when RelTime lags; anything else uses the reported position so a pause cannot
 * ramp the room and scripted tests stay on the positions they pass in.
 */
export function estimateAnnouncePlayhead(sample, nowMs, origin) {
  const reported = Math.max(0, Number(sample?.positionSec) || 0);
  if (sample?.state !== "PLAYING") {
    return { positionSec: reported, originAt: origin?.originAt ?? null };
  }
  const at = Number.isFinite(Number(sample?.observedAt))
    ? Number(sample.observedAt)
    : nowMs;
  let originAt = origin?.originAt;
  if (originAt == null) originAt = at - reported * 1000;
  else {
    const implied = at - reported * 1000;
    // RelTime jumped forward (seek, or it caught up). Rebase so we follow it.
    if (implied < originAt) originAt = implied;
  }
  const elapsed = Math.max(0, (at - originAt) / 1000);
  const capped = Math.min(Math.max(reported, elapsed), reported + ANNOUNCE_PLAYHEAD_AHEAD_CAP_SEC);
  return { positionSec: capped, originAt };
}

/**
 * Drive group volume for one baked announce, then put it back.
 *
 * Returns when the clip is no longer on the playhead for any reason — it
 * finished, a guest skipped it, the host cleared the queue, or the speaker
 * dropped it. Every one of those exits restores the music volume, because the
 * only unrecoverable outcome here is leaving the party boosted or muted.
 *
 * `io` is injected so this is testable without Sonos:
 *   read()              -> { uri, positionSec, durationSec?, state?, observedAt? }
 *   setVolume(n, exact) -> void   exact writes read back; ramp steps do not
 *   getVolume()         -> number  used only when the baseline was unknown
 *   sleep(ms)           -> Promise
 *   mono()              -> number  optional clock for apply-time measurement
 *
 * `read` deliberately returns both fields together: asking for the URI and the
 * position separately costs two SOAP round trips per poll, several times a
 * second, against the same coordinator that is trying to play audio.
 *
 * @param {{
 *   clipUrl: string,
 *   durationSec: number,
 *   rampSec: number,
 *   restoreSec: number,
 *   musicVolume: number,
 *   announceVolume: number,
 * }} announce
 * @param {object} io
 * @param {{ pollMs?: number, graceMs?: number, maxMs?: number, logger?: object }} [opts]
 */
export async function runAnnounceVolume(announce, io, opts = {}) {
  const pollMs = opts.pollMs ?? 150;
  const waitMs = opts.waitMs ?? pollMs;
  const graceMs = opts.graceMs ?? 4000;
  const maxMs = opts.maxMs ?? MAX_HANDOFF_ARMED_MS;
  const logger = opts.logger ?? console;
  // Tests omit a logger; production passes one. console.debug would print on
  // every shout during the suite because Node shows debug by default.
  const debug = opts.logger?.debug?.bind(opts.logger) ?? (() => {});
  const now = io.now ?? Date.now;
  const clock = typeof io.mono === "function" ? io.mono : Date.now;
  const rampMarginSec = opts.rampMarginSec ?? ANNOUNCE_RAMP_MARGIN_SEC;
  const restoreMarginSec = opts.restoreMarginSec ?? ANNOUNCE_RESTORE_MARGIN_SEC;
  const applyLeadCapSec = opts.applyLeadCapSec ?? ANNOUNCE_APPLY_LEAD_CAP_SEC;

  const matches = (uri) => uriMatchesClip(uri, announce.clipUrl);
  const started = now();
  let sawClip = false;
  let lastSet = null;
  let reason = "complete";
  let musicVolume =
    announce.musicVolume == null
      ? null
      : clampVolume(announce.musicVolume);
  let announceVolume =
    announce.announceVolume == null
      ? null
      : clampVolume(announce.announceVolume);

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

  const generation = ++announceVolumeGeneration;
  announceVolumeRunning = true;
  setDjVolumeHandoffArmed(true);
  const owns = () => generation === announceVolumeGeneration;
  let applyLeadSec = 0;
  let playOrigin = { originAt: null };
  let lastPlayheadSec = 0;
  let activeDurationSec = Math.max(0, Number(announce.durationSec) || 0);
  let warnedOpening = false;
  let warnedRestore = false;
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

  const noteTimeline = (at, appliedAt) => {
    if (!timeline.rampUpStartAt && at.phase === ANNOUNCE_PHASE.ramp) {
      timeline.rampUpStartAt = appliedAt;
      debug("[dj-volume] ramp-up started");
    }
    if (
      !timeline.rampUpDoneAt &&
      at.volume === announceVolume &&
      (at.phase === ANNOUNCE_PHASE.hold || at.phase === ANNOUNCE_PHASE.done)
    ) {
      timeline.rampUpDoneAt = appliedAt;
      debug("[dj-volume] ramp-up complete");
    }
    if (!timeline.rampDownStartAt && at.phase === ANNOUNCE_PHASE.restore) {
      timeline.rampDownStartAt = appliedAt;
      debug("[dj-volume] ramp-down started");
    }
    if (!timeline.rampDownDoneAt && at.phase === ANNOUNCE_PHASE.done) {
      timeline.rampDownDoneAt = appliedAt;
      timeline.announceEndAt = appliedAt;
      debug("[dj-volume] ramp-down complete");
    }
  };

  const setVolume = async (volume, exact, samplePos, scheduled, force = false) => {
    if (!owns()) return;
    if (!force && volume === lastSet) return;
    const t0 = clock();
    try {
      await io.setVolume(volume, exact);
    } catch (err) {
      logger.warn?.(`[dj-volume] setVolume ${volume} failed: ${err?.message || err}`);
      const elapsedSec = Math.max(0, (clock() - t0) / 1000);
      if (elapsedSec >= 0.02) {
        applyLeadSec = Math.min(applyLeadCapSec, elapsedSec);
      }
      return;
    }
    const elapsedSec = Math.max(0, (clock() - t0) / 1000);
    if (elapsedSec >= 0.02) {
      applyLeadSec = Math.min(applyLeadCapSec, elapsedSec);
    }
    // The write already left. A newer shout owns whatever it sets next.
    if (!owns()) return;
    lastSet = volume;
    const appliedAt = clock();
    if (scheduled) noteTimeline(scheduled, appliedAt);
    if (
      samplePos != null &&
      announceVolume != null &&
      scheduled?.phase === ANNOUNCE_PHASE.ramp
    ) {
      const landed = samplePos + elapsedSec;
      const ramp = Math.max(0, Number(announce.rampSec) || 0);
      if (!warnedOpening && ramp > 0 && landed >= ramp && volume < announceVolume) {
        warnedOpening = true;
        logger.warn?.(
          `[dj-volume] opening ramp landed ${Math.round((landed - ramp) * 1000)}ms after speech started`
        );
      }
    }
  };
  const rememberBaseline = (level) => {
    if (generation === announceVolumeGeneration && level != null) {
      lastMusicBaseline = level;
    }
  };
  rememberBaseline(musicVolume);
  let consecutiveReadFailures = 0;
  try {
    while (now() - started < maxMs) {
      if (generation !== announceVolumeGeneration) {
        reason = "superseded";
        break;
      }
      let sample;
      try {
        sample = (await io.read()) ?? {};
        consecutiveReadFailures = 0;
      } catch (err) {
        consecutiveReadFailures += 1;
        // Office dropped ~8% of these ticks all soak long. Sleeping the active
        // 150ms poll here used to hammer the speaker harder on failure than on
        // success. Back off from the wait interval instead, and stop reprinting
        // every timeout — the first of a streak and each 8th after that is enough.
        if (consecutiveReadFailures === 1 || consecutiveReadFailures % 8 === 0) {
          logger.warn?.(
            `[dj-volume] transport read failed (${consecutiveReadFailures} in a row): ${err?.message || err}`
          );
        }
        await io.sleep(
          handoffWatchSleepMs(
            consecutiveReadFailures,
            sawClip ? pollMs : waitMs
          )
        );
        continue;
      }
      const uri = sample.uri;
      const reportedPos = Number(sample.positionSec) || 0;
      const queueTrack = sample.queueTrack;
      const durationSec = sample.durationSec;
      if (matches(uri)) {
        // Play returned is not the first audio frame. A paused or stopped
        // row at 0:00 still has the clip URI; ramping then would finish
        // before the opening silence exists.
        if (transportHeld(sample.state) && reportedPos < 0.05) {
          await io.sleep(pollMs);
          continue;
        }
        const tracked = estimateAnnouncePlayhead(sample, clock(), playOrigin);
        playOrigin = { originAt: tracked.originAt };
        const positionSec = tracked.positionSec;
        lastPlayheadSec = positionSec;
        if (!sawClip) {
          const startedAt = clock() - positionSec * 1000;
          timeline.playbackStartAt = startedAt;
          const rampMs = Math.max(0, Number(announce.rampSec) || 0) * 1000;
          const restoreMs = Math.max(0, Number(announce.restoreSec) || 0) * 1000;
          const durMs = Math.max(0, Number(announce.durationSec) || 0) * 1000;
          timeline.expectedSpeechStartAt = startedAt + rampMs;
          timeline.expectedSpeechEndAt = startedAt + Math.max(0, durMs - restoreMs);
          timeline.expectedAnnounceEndAt = startedAt + durMs;
          debug(
            `[dj-volume] playback started (position ${positionSec.toFixed(2)}s)`
          );
          try {
            opts.onClipStart?.({ uri, positionSec: reportedPos, queueTrack });
          } catch (err) {
            logger.warn?.(
              `[dj-volume] onClipStart failed: ${err?.message || err}`
            );
          }
        }
        sawClip = true;
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
        const clipDuration = resolveAnnounceClipDuration(
          announce.durationSec,
          durationSec
        );
        activeDurationSec = clipDuration;
        if (timeline.playbackStartAt != null) {
          const restoreMs = Math.max(0, Number(announce.restoreSec) || 0) * 1000;
          timeline.expectedSpeechEndAt =
            timeline.playbackStartAt + Math.max(0, clipDuration * 1000 - restoreMs);
          timeline.expectedAnnounceEndAt = timeline.playbackStartAt + clipDuration * 1000;
        }
        const at = scheduleAnnounceVolume({
          positionSec,
          durationSec: clipDuration,
          rampSec: announce.rampSec,
          restoreSec: announce.restoreSec,
          musicVolume,
          announceVolume,
          leadSec: applyLeadSec,
          rampMarginSec,
          restoreMarginSec,
          applyLeadCapSec,
        });
        // Read-back only at the two landings: announce level (speech) and
        // music level (restore done). Mid-ramp and mid-restore steps are
        // transient — the exact path's settle loop is what used to push the
        // closing ramp into the next song.
        const exact =
          at.phase === ANNOUNCE_PHASE.hold || at.phase === ANNOUNCE_PHASE.done;
        await setVolume(at.volume, exact, positionSec, at);
        if (at.phase === ANNOUNCE_PHASE.done) break;
      } else if (sawClip) {
        // Gone from the playhead after we had it: finished or skipped. Either
        // way the announce is over. This is the safety exit, not the clock
        // the restore ramp waits on — that ramp already ran inside the tail.
        reason = "left-playhead";
        timeline.nextTrackAt = clock();
        if (!timeline.announceEndAt) timeline.announceEndAt = timeline.nextTrackAt;
        const restoreSec = Math.max(0, Number(announce.restoreSec) || 0);
        const tailStart = Math.max(0, activeDurationSec - restoreSec);
        // A skip during speech is not a late ramp. Warn only when we were
        // already in the closing silence (or past it) and the music level
        // had not landed yet — that is the next song starting hot.
        if (
          !warnedRestore &&
          musicVolume != null &&
          lastSet != null &&
          lastSet !== musicVolume &&
          lastPlayheadSec >= tailStart - 0.25
        ) {
          warnedRestore = true;
          logger.warn?.(
            `[dj-volume] restore unfinished as the next track started (volume ${lastSet}, music ${musicVolume})`
          );
        }
        break;
      } else if (now() - started > graceMs) {
        // Never arrived. The clip was pulled before it played, so there is
        // nothing to duck for and nothing to restore.
        reason = "never-started";
        break;
      }
      await io.sleep(sawClip ? pollMs : waitMs);
    }
    if (now() - started >= maxMs) reason = "timeout";
  } finally {
    const superseded = generation !== announceVolumeGeneration;
    if (!superseded) {
      announceVolumeRunning = false;
      setDjVolumeHandoffActive(false);
      if (sawClip) setDjVolumeHandoffArmed(false);
    }
    // A newer announce owns the room — restoring here would fight its ramp.
    // One bounded write, and only if this generation still owns the room at
    // the moment of the call. No timer is left behind.
    if (!superseded && sawClip && musicVolume != null && owns()) {
      try {
        await setVolume(
          clampVolume(musicVolume),
          true,
          null,
          {
            phase: ANNOUNCE_PHASE.done,
            volume: clampVolume(musicVolume),
          },
          true
        );
      } catch (err) {
        logger.error?.(
          `[dj-volume] could not restore music volume: ${err?.message || err}`
        );
      }
    }
    if (superseded) reason = "superseded";
    debug("[dj-volume] announce timeline", { reason, ...timeline });
  }
  return { reason, sawClip, timeline };
}

/**
 * Match a queue URI against the baked clip URL. Sonos rewrites the URL it was
 * handed (proxy prefixes, query strings), so compare on the file name.
 * @param {string|null|undefined} uri
 * @param {string} clipUrl
 */
export function uriMatchesClip(uri, clipUrl) {
  const value = String(uri || "");
  const want = String(clipUrl || "");
  if (!value || !want) return false;
  if (value === want) return true;
  const fileName = (want.split("/").pop() || "").split("?")[0];
  return !!fileName && value.includes(fileName);
}
