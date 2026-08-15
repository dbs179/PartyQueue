import { createLogger } from "./logger.js";
import {
  isDjVolumeHandoffActive,
  setDjVolumeHandoffActive,
} from "./dj-volume-handoff-state.js";

export { isDjVolumeHandoffActive };

let activeHandoff = null;

/** Keep the leaf flag aligned with prior `!!activeHandoff?.isVolumeLocked()`. */
function syncHandoffActiveFlag() {
  setDjVolumeHandoffActive(!!activeHandoff?.isVolumeLocked());
}

const DEFAULT_POLL_MS = 150;
const DEFAULT_RAMP_STEPS = 6;
const RESTORE_RETRIES = 3;
const RESTORE_RETRY_MS = 250;
const PAD_RESUME_MS = 1200;
const PAD_RESUME_TRIES = 8;
const DEADLINE_SLACK_MS = 10_000;

const clampVolume = (value) =>
  Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isRampSilenceUri(uri) {
  return /silence-ramp-\d+(?:\.\d+)?s\.mp3/i.test(String(uri || ""));
}

export function isRestoreSilenceUri(uri) {
  const value = String(uri || "");
  return (
    !isRampSilenceUri(value) &&
    /silence-\d+(?:\.\d+)?s\.mp3|dj-silence/i.test(value)
  );
}

export function isDjClipUri(uri, publicUrl) {
  const value = String(uri || "");
  if (isRampSilenceUri(value) || isRestoreSilenceUri(value)) return false;
  const fileToken = publicUrl
    ? String(publicUrl).split("/").pop() || ""
    : "";
  return (
    /tts_proxy|\/media\/tts\//i.test(value) ||
    (fileToken && value.includes(fileToken))
  );
}

function defaultLogger() {
  const log = createLogger("dj-volume");
  return {
    info(message, meta) {
      log.info(message, meta);
    },
    warn(message, meta) {
      log.warn(message, meta);
    },
    error(message, meta) {
      log.error(message, meta);
    },
  };
}

async function defaultAdapter() {
  const sonos = await import("./sonos.js");
  return {
    getNowPlaying: sonos.getNowPlayingFresh,
    getVolume: sonos.getGroupVolume,
    setVolume: sonos.setGroupVolume,
    pause: sonos.pause,
    resume: sonos.resumeQueuePlayback,
    playAt: (trackNumber) => sonos.play({ trackNumber }),
    // Raw Next — never host announce-aware Skip (that cancels this handoff).
    next: sonos.advanceQueueTrack,
  };
}

export function createDjVolumeHandoff({
  publicUrl,
  approxDurationSec = 8,
  silenceSec = 3,
  ttsPosition = null,
  musicPosition = null,
  baselineOverride = null,
  holdPreSilence = false,
  calculateTarget,
  adapter = null,
  sleep = sleepDefault,
  now = Date.now,
  pollMs = DEFAULT_POLL_MS,
  rampSteps = DEFAULT_RAMP_STEPS,
  logger = defaultLogger(),
} = {}) {
  if (typeof calculateTarget !== "function") {
    throw new Error("DJ volume handoff requires calculateTarget.");
  }

  let phase = "pending";
  let baselineVolume = null;
  let announceVolume = null;
  let cancelled = false;
  let started = false;
  let volumeLocked = false;
  let deadlineAt = null;
  let task = null;
  let resolvedAdapter = adapter;
  let lastPadResumeAt = 0;
  let padResumeTries = 0;
  let sawDjPlaying = false;
  let advancedFromDj = false;
  let advancedFromRestore = false;
  let restoreHeldAt = null;
  let deadlineHandled = false;
  let ttsPublicUrl = publicUrl;
  let liveTtsPosition = ttsPosition;
  let liveMusicPosition = musicPosition;
  let preSilenceReleased = !holdPreSilence;
  let pausedByHold = false;
  const preservedBaseline =
    baselineOverride == null ? null : clampVolume(baselineOverride);

  const getAdapter = async () => {
    if (!resolvedAdapter) resolvedAdapter = await defaultAdapter();
    return resolvedAdapter;
  };

  const snapshot = () => ({
    phase,
    baselineVolume,
    announceVolume,
    cancelled,
    started,
    volumeLocked,
    deadlineAt,
    ttsPosition: liveTtsPosition,
    musicPosition: liveMusicPosition,
  });

  const setPhase = (next) => {
    if (phase === next) return;
    phase = next;
    logger.info(`phase ${next}`);
  };

  const captureBaseline = async () => {
    if (baselineVolume != null) return baselineVolume;
    const io = await getAdapter();
    baselineVolume =
      preservedBaseline == null
        ? clampVolume(await io.getVolume())
        : preservedBaseline;
    announceVolume = clampVolume(calculateTarget(baselineVolume));
    volumeLocked = true;
    syncHandoffActiveFlag();
    deadlineAt =
      now() +
      Math.max(3000, Math.round(Number(approxDurationSec || 8) * 1000)) +
      Math.round(Number(silenceSec || 3) * 2000) +
      DEADLINE_SLACK_MS;
    logger.info(
      `captured baseline ${baselineVolume}; announce target ${announceVolume}${
        preservedBaseline == null ? "" : " (preserved)"
      }`
    );
    return baselineVolume;
  };

  const setAndCheck = async (target) => {
    const io = await getAdapter();
    await io.setVolume(clampVolume(target));
    // Trust the live read. A false `locked: false` (SOAP string vs number)
    // must not abort restore while the room is already at the baseline.
    return clampVolume(await io.getVolume()) === clampVolume(target);
  };

  const ramp = async (from, to) => {
    const start = clampVolume(from);
    const end = clampVolume(to);
    const steps = Math.max(1, Math.floor(Number(rampSteps) || 1));
    let previous = start;
    for (let index = 1; index <= steps; index++) {
      if (cancelled) return false;
      const next = clampVolume(start + ((end - start) * index) / steps);
      if (next === previous && index < steps) continue;
      const io = await getAdapter();
      await io.setVolume(next);
      previous = next;
    }
    return true;
  };

  const restoreExact = async (reason = "restore") => {
    if (baselineVolume == null) {
      volumeLocked = false;
      syncHandoffActiveFlag();
      return true;
    }
    setPhase("restoring");
    for (let attempt = 1; attempt <= RESTORE_RETRIES; attempt++) {
      try {
        if (await setAndCheck(baselineVolume)) {
          volumeLocked = false;
          syncHandoffActiveFlag();
          setPhase("restored");
          logger.info(`restored exact baseline ${baselineVolume} (${reason})`);
          return true;
        }
      } catch (error) {
        logger.warn(
          `restore attempt ${attempt} failed (${reason}): ${error.message}`
        );
      }
      if (attempt < RESTORE_RETRIES) await sleep(RESTORE_RETRY_MS);
    }
    logger.error(`could not verify baseline ${baselineVolume} (${reason})`);
    return false;
  };

  const maybeResumePad = async (onPad, state) => {
    const idle = state === "STOPPED" || state === "PAUSED_PLAYBACK";
    if (
      !onPad ||
      !idle ||
      padResumeTries >= PAD_RESUME_TRIES ||
      (lastPadResumeAt > 0 && now() - lastPadResumeAt < PAD_RESUME_MS)
    ) {
      return;
    }
    lastPadResumeAt = now();
    padResumeTries += 1;
    try {
      const io = await getAdapter();
      await io.resume();
      logger.info(`resumed stopped announce pad (try ${padResumeTries})`);
    } catch (error) {
      logger.warn(`announce-pad resume failed: ${error.message}`);
    }
  };

  const holdRestorePad = async (state) => {
    if (state !== "PLAYING" && state !== "TRANSITIONING") return;
    try {
      const io = await getAdapter();
      await io.pause();
      logger.info("held post-silence while volume settles");
    } catch (error) {
      logger.warn(`could not hold post-silence: ${error.message}`);
    }
  };

  const liveIsAnnouncePad = (uri) => {
    const value = String(uri || "");
    return (
      isRampSilenceUri(value) ||
      isRestoreSilenceUri(value) ||
      isDjClipUri(value, ttsPublicUrl)
    );
  };

  const advanceAfterSilencePad = async (
    position,
    label,
    startedAt,
    { nextTransition = false } = {}
  ) => {
    const elapsed = Math.max(0, now() - startedAt);
    const remaining = Math.max(0, Math.round(silenceSec * 1000) - elapsed);
    if (remaining) await sleep(remaining);
    const io = await getAdapter();
    // If the restore pad already advanced to the first music track while we
    // were restoring volume, Next() would skip that song (e.g. the track the
    // DJ just named). Only advance while still on an announce pad.
    let liveUri = "";
    try {
      liveUri = String((await io.getNowPlaying())?.uri || "");
    } catch {
      /* treat as still on pad and fall through */
    }
    if (liveUri && !liveIsAnnouncePad(liveUri)) {
      try {
        await io.resume();
      } catch (error) {
        logger.warn(`music resume after ${label} failed: ${error.message}`);
      }
      logger.info(`already on music after ${label}; not advancing`);
      return;
    }
    // io.next must be a raw queue advance (see defaultAdapter) — never host
    // announce-aware Skip, which would cancel this handoff mid-restore.
    if (nextTransition && typeof io.next === "function") {
      await io.next();
      await io.resume();
      logger.info(`advanced from ${label} with Next after ${silenceSec}s`);
      return;
    }
    if (Number(position) >= 1 && typeof io.playAt === "function") {
      await io.playAt(Number(position));
      logger.info(`advanced from ${label} after ${silenceSec}s`);
      return;
    }
    try {
      await io.resume();
      logger.info(`resumed ${label} after volume settled`);
    } catch (error) {
      logger.warn(`could not resume ${label}: ${error.message}`);
    }
  };

  const run = async () => {
    setPhase("waiting-pre-silence");
    while (!cancelled) {
      try {
        const io = await getAdapter();
        const np = await io.getNowPlaying();
        const uri = String(np?.uri || "");
        const state = String(np?.state || "").toUpperCase();
        const onRamp = isRampSilenceUri(uri);
        const onDj = isDjClipUri(uri, ttsPublicUrl);
        const onRestore = isRestoreSilenceUri(uri);
        const onPad = onRamp || onDj || onRestore;
        let handledPad = false;

        if (onRamp && baselineVolume == null) {
          handledPad = true;
          // Silence is silent: ramp volume while the pad is current.
          // If the DJ clip is not queued yet, pause here so the 3s pad cannot
          // expire into the guest request (tease → pause → restart).
          await captureBaseline();
          setPhase("ramping-up");
          await ramp(baselineVolume, announceVolume);
          if (holdPreSilence && !preSilenceReleased) {
            try {
              await io.pause();
              pausedByHold = true;
            } catch (error) {
              logger.warn(`could not hold pre-silence: ${error.message}`);
            }
            setPhase("holding-pre-silence");
            logger.info("holding pre-silence until announce clip is queued");
          } else {
            setPhase("announcing");
            logger.info("volume ready on pre-silence; letting pad advance");
          }
        } else if (onRamp && phase === "holding-pre-silence") {
          handledPad = true;
          if (preSilenceReleased) {
            try {
              await io.resume();
              pausedByHold = false;
            } catch (error) {
              logger.warn(`pre-silence release failed: ${error.message}`);
            }
            setPhase("announcing");
            logger.info("announce queued; releasing pre-silence hold");
          }
        } else if (onDj) {
          if (baselineVolume == null) {
            handledPad = true;
            // Do NOT pause a live TTS HTTP stream here. Sonos often restarts
            // http:// clips from 0 on resume, which sounds like the DJ
            // announcing twice. Capture + ramp under the already-playing clip.
            await captureBaseline();
            setPhase("ramping-up-fallback");
            await ramp(baselineVolume, announceVolume);
          }
          if (state === "PLAYING" || state === "TRANSITIONING") {
            sawDjPlaying = true;
          }
          if (phase !== "restored") setPhase("announcing");
          if (
            sawDjPlaying &&
            !advancedFromDj &&
            (state === "STOPPED" || state === "PAUSED_PLAYBACK") &&
            Number(liveMusicPosition) >= 2 &&
            (typeof io.next === "function" || typeof io.playAt === "function")
          ) {
            handledPad = true;
            // Next from a STOPPED/PAUSED TTS clip often leaves the transport
            // idle on the restore pad — always Play after advancing or the
            // room stays paused after the DJ (Set Request / mid-set shouts).
            if (typeof io.next === "function") {
              await io.next();
              try {
                await io.resume();
              } catch (error) {
                logger.warn(
                  `resume after DJ advance failed: ${error.message}`
                );
              }
            } else {
              await io.playAt(Number(liveMusicPosition) - 1);
            }
            advancedFromDj = true;
            logger.info("advanced completed DJ clip to post-silence");
          }
        } else if (onRestore && baselineVolume != null) {
          handledPad = true;
          if (phase !== "restored") {
            restoreHeldAt = now();
            // Hold post-silence only (never pre-silence/TTS). Without this the
            // restore pad can finish during volume ramp-down, start the first
            // music track, then our Next() skips the song the DJ just named.
            await holdRestorePad(state);
            setPhase("ramping-down");
            // A previous restore pass may have partially lowered the group.
            // Always continue from the live level; restarting from the stored
            // announce target would raise it again before another retry.
            const currentVolume = clampVolume(await io.getVolume());
            await ramp(currentVolume, baselineVolume);
            const restored = await restoreExact("post-silence");
            if (!restored) {
              try {
                await io.pause();
              } catch {
                /* best effort: keep retrying while transport is held */
              }
              continue;
            }
          }
          if (!advancedFromRestore) {
            await advanceAfterSilencePad(
              liveMusicPosition,
              "post-silence",
              restoreHeldAt ?? now(),
              { nextTransition: true }
            );
            advancedFromRestore = true;
          }
        } else if (!onPad && baselineVolume != null) {
          if (phase !== "restored") {
            try {
              await io.pause();
            } catch {
              /* best effort */
            }
            const restored = await restoreExact("music boundary");
            if (!restored) {
              await sleep(RESTORE_RETRY_MS);
              continue;
            }
            try {
              await io.resume();
            } catch (error) {
              logger.warn(`music resume failed: ${error.message}`);
            }
          }
          setPhase("complete");
          return snapshot();
        }

        if (
          baselineVolume != null &&
          volumeLocked &&
          !deadlineHandled &&
          phase !== "holding-pre-silence" &&
          deadlineAt != null &&
          now() >= deadlineAt
        ) {
          deadlineHandled = true;
          handledPad = true;
          try {
            await io.pause();
          } catch {
            /* best effort */
          }
          const restored = await restoreExact("absolute deadline");
          if (restored && typeof io.playAt === "function") {
            // Re-read transport: the pad may have advanced while we paused for
            // the volume restore. Seeking an already-playing TTS clip restarts
            // it from 0 (double announce).
            let liveUri = uri;
            try {
              liveUri = String((await io.getNowPlaying())?.uri || uri);
            } catch {
              /* keep the poll's uri */
            }
            const liveOnRamp = isRampSilenceUri(liveUri);
            const liveOnDj = isDjClipUri(liveUri, ttsPublicUrl);
            const liveOnRestore = isRestoreSilenceUri(liveUri);
            if (liveOnRamp && Number(liveTtsPosition) >= 1) {
              await io.playAt(Number(liveTtsPosition));
            } else if (liveOnDj && Number(liveMusicPosition) >= 2) {
              // Past the lead-in — skip forward. Never SeekTrack the TTS URI
              // itself (that restarts the http clip from 0).
              advancedFromDj = true;
              if (typeof io.next === "function") {
                await io.next();
                try {
                  await io.resume();
                } catch {
                  /* best effort */
                }
              } else {
                await io.playAt(Number(liveMusicPosition) - 1);
              }
            } else if (liveOnRestore && Number(liveMusicPosition) >= 1) {
              await io.playAt(Number(liveMusicPosition));
            } else if (!liveOnRamp && !liveOnDj && !liveOnRestore) {
              await io.resume();
            }
          } else if (restored && !onPad) {
            try {
              await io.resume();
            } catch {
              /* best effort */
            }
          }
        }

        // A DJ clip that has played and is now idle is complete. Never send
        // Play to it again: if advancing failed, retry Next on the next poll.
        if (
          onPad &&
          !handledPad &&
          phase !== "holding-pre-silence" &&
          !(onDj && sawDjPlaying)
        ) {
          await maybeResumePad(true, state);
        }
      } catch (error) {
        logger.error(`watch failed: ${error.message}`);
      }
      if (cancelled) break;
      await sleep(pollMs);
    }
    return snapshot();
  };

  return {
    start() {
      if (!started) {
        started = true;
        task = run();
      }
      return task;
    },
    async cancelAndRestore(reason = "superseded") {
      cancelled = true;
      if (task) await task.catch(() => {});
      const restored = await restoreExact(reason);
      // Baseline first, then let the room go: a shout that died while we were
      // holding on the silence must never leave the party paused.
      if (pausedByHold) {
        pausedByHold = false;
        try {
          const io = await getAdapter();
          await io.resume();
          logger.info(`resumed playback after cancelled pre-silence hold (${reason})`);
        } catch (error) {
          logger.error(`could not resume after hold (${reason}): ${error.message}`);
        }
      }
      setPhase("cancelled");
      return restored;
    },
    get heldPlayback() {
      return pausedByHold;
    },
    isVolumeLocked() {
      return volumeLocked;
    },
    setTtsUrl(url) {
      ttsPublicUrl = url || ttsPublicUrl;
    },
    setPositions({ ttsPosition: nextTts, musicPosition: nextMusic } = {}) {
      if (nextTts != null) liveTtsPosition = nextTts;
      if (nextMusic != null) liveMusicPosition = nextMusic;
    },
    releasePreSilenceHold() {
      preSilenceReleased = true;
    },
    snapshot,
    restoreExact,
    get done() {
      return task;
    },
  };
}

function isLaterAnnounce(previous, next) {
  const prevTts = Number(previous?.ttsPosition);
  const nextTts = Number(next?.ttsPosition);
  if (!Number.isFinite(prevTts) || !Number.isFinite(nextTts)) return false;
  return nextTts > prevTts;
}

function createDeferredHandoff() {
  return {
    deferred: true,
    start: async () => ({
      phase: "deferred",
      cancelled: false,
      started: false,
      volumeLocked: false,
      deadlineAt: null,
      ttsPosition: null,
      musicPosition: null,
      baselineVolume: null,
      announceVolume: null,
    }),
    cancelAndRestore: async () => true,
    isVolumeLocked: () => false,
    snapshot: () => ({
      phase: "deferred",
      baselineVolume: null,
      announceVolume: null,
      cancelled: false,
      started: false,
      volumeLocked: false,
      deadlineAt: null,
      ttsPosition: null,
      musicPosition: null,
      deferred: true,
    }),
    restoreExact: async () => true,
    get done() {
      return Promise.resolve();
    },
  };
}

export async function beginDjVolumeHandoff(options = {}) {
  let preservedBaseline = null;
  if (activeHandoff) {
    const previous = activeHandoff.snapshot();
    const previousPhase = previous.phase;
    if (previousPhase !== "complete" && previousPhase !== "cancelled") {
      // A later request shout must not cancel the earlier handoff. Cancelling
      // left the first ramp in queue with no TTS session — empty DJ, then a
      // jump to the later song. Rearm when the active handoff completes.
      if (!options.takeOver && isLaterAnnounce(previous, options)) {
        console.info(
          `[dj-volume] keeping active handoff tts@${previous.ttsPosition}; ` +
            `later shout tts@${options.ttsPosition} will rearm`
        );
        return createDeferredHandoff();
      }
      const restored = await activeHandoff.cancelAndRestore("superseded announce");
      if (!restored && previous.baselineVolume != null) {
        // Never let a failed restore ratchet the next announce upward by
        // capturing the still-elevated live volume as its new baseline.
        preservedBaseline = previous.baselineVolume;
      }
    }
  }
  const handoff = createDjVolumeHandoff({
    ...options,
    baselineOverride: options.baselineOverride ?? preservedBaseline,
  });
  const start = handoff.start.bind(handoff);
  handoff.start = () => {
    const running = start();
    void running.then(
      async (snap) => {
        if (activeHandoff === handoff) {
          activeHandoff = null;
          syncHandoffActiveFlag();
        }
        if (options.rearmOnComplete && snap?.phase === "complete") {
          try {
            const voice = await import("./dj-voice.js");
            await voice.rearmOrphanedDjVolumeHandoff();
          } catch (err) {
            console.warn(
              "[dj-volume] rearm after handoff failed:",
              err?.message || err
            );
          }
        }
      },
      () => {
        if (activeHandoff === handoff) {
          activeHandoff = null;
          syncHandoffActiveFlag();
        }
      }
    );
    return running;
  };
  activeHandoff = handoff;
  syncHandoffActiveFlag();
  return handoff;
}

export async function cancelActiveDjVolumeHandoff(reason = "queue preempted") {
  const handoff = activeHandoff;
  if (!handoff) return false;
  await handoff.cancelAndRestore(reason);
  if (activeHandoff === handoff) {
    activeHandoff = null;
    syncHandoffActiveFlag();
  }
  return true;
}

export function getDjVolumeHandoffState() {
  return activeHandoff?.snapshot() ?? {
    phase: "idle",
    baselineVolume: null,
    announceVolume: null,
    cancelled: false,
    started: false,
    volumeLocked: false,
    deadlineAt: null,
  };
}
