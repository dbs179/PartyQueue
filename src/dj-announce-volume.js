import {
  MAX_HANDOFF_ARMED_MS,
  setDjVolumeHandoffActive,
  setDjVolumeHandoffArmed,
} from "./dj-volume-handoff-state.js";

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
 * Drive group volume for one baked announce, then put it back.
 *
 * Returns when the clip is no longer on the playhead for any reason — it
 * finished, a guest skipped it, the host cleared the queue, or the speaker
 * dropped it. Every one of those exits restores the music volume, because the
 * only unrecoverable outcome here is leaving the party boosted or muted.
 *
 * `io` is injected so this is testable without Sonos:
 *   read()              -> { uri, positionSec }  one transport read per poll
 *   setVolume(n, exact) -> void   exact writes read back; ramp steps do not
 *   getVolume()         -> number  used only when the baseline was unknown
 *   sleep(ms)           -> Promise
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
  const now = io.now ?? Date.now;

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

  const setVolume = async (volume, exact = false) => {
    if (volume === lastSet) return;
    try {
      await io.setVolume(volume, exact);
      lastSet = volume;
    } catch (err) {
      logger.warn?.(`[dj-volume] setVolume ${volume} failed: ${err?.message || err}`);
    }
  };

  const generation = ++announceVolumeGeneration;
  announceVolumeRunning = true;
  setDjVolumeHandoffArmed(true);
  const rememberBaseline = (level) => {
    if (generation === announceVolumeGeneration && level != null) {
      lastMusicBaseline = level;
    }
  };
  rememberBaseline(musicVolume);
  try {
    while (now() - started < maxMs) {
      if (generation !== announceVolumeGeneration) {
        reason = "superseded";
        break;
      }
      let uri;
      let positionSec;
      let queueTrack;
      try {
        ({ uri, positionSec, queueTrack } = (await io.read()) ?? {});
      } catch (err) {
        logger.warn?.(`[dj-volume] transport read failed: ${err?.message || err}`);
        await io.sleep(pollMs);
        continue;
      }
      if (matches(uri)) {
        if (!sawClip) {
          try {
            opts.onClipStart?.({ uri, positionSec, queueTrack });
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
        rememberBaseline(musicVolume);
        const at = announceVolumeAt({
          positionSec,
          durationSec: announce.durationSec,
          rampSec: announce.rampSec,
          restoreSec: announce.restoreSec,
          musicVolume,
          announceVolume,
        });
        // The two levels that must land exactly are the announce level (the DJ
        // is about to speak over it) and the music level at the end. Mid-ramp
        // steps are transient, so they skip the read-back.
        await setVolume(at.volume, at.phase !== ANNOUNCE_PHASE.ramp);
        if (at.phase === ANNOUNCE_PHASE.done) break;
      } else if (sawClip) {
        // Gone from the playhead after we had it: finished or skipped. Either
        // way the announce is over.
        reason = "left-playhead";
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
    if (!superseded && sawClip && musicVolume != null) {
      try {
        await io.setVolume(clampVolume(musicVolume), true);
      } catch (err) {
        logger.error?.(
          `[dj-volume] could not restore music volume: ${err?.message || err}`
        );
      }
    }
    if (superseded) reason = "superseded";
  }
  return { reason, sawClip };
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
