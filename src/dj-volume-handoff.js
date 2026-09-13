import { createLogger } from "./logger.js";
import {
  isDjVolumeHandoffActive,
  isDjVolumeHandoffArmed,
  setDjVolumeHandoffActive,
  setDjVolumeHandoffArmed,
} from "./dj-volume-handoff-state.js";
import { isBakedAnnounceUri } from "./dj-announce-bake.js";

export { isDjVolumeHandoffActive, isDjVolumeHandoffArmed };

let activeHandoff = null;

/** Keep the leaf flags aligned with the live handoff. */
function syncHandoffActiveFlag() {
  setDjVolumeHandoffActive(!!activeHandoff?.isVolumeLocked());
  const phase = activeHandoff?.snapshot?.()?.phase;
  setDjVolumeHandoffArmed(
    !!activeHandoff && phase !== "complete" && phase !== "cancelled"
  );
}

/**
 * Slide this handoff's queue indices after tracks were removed from the front.
 * Trim always deletes from index 1, so everything left shifts down by `count`.
 */
export function shiftDjVolumeHandoffPositions(count) {
  const removed = Math.floor(Number(count) || 0);
  if (removed < 1 || !activeHandoff?.shiftPositions) return false;
  return activeHandoff.shiftPositions(removed);
}

const DEFAULT_POLL_MS = 150;
const DEFAULT_RAMP_STEPS = 4;
/**
 * Gap between unverified ramp steps. The ramp has to finish well inside the 3s
 * pre-silence pad: at 6 x 300ms it ran ~2.2s and left under PAD_ADVANCE_SLACK_MS,
 * so maybeJumpToTtsAfterRamp took the SeekTrack branch on every single announce
 * instead of letting the pad walk onto the clip. 4 x 200ms lands near 1.1s.
 */
const DEFAULT_RAMP_STEP_MS = 200;
/** Instant EHOSTUNREACH used to hammer a dying NIC every 150ms. Back off, then abort. */
export const HANDOFF_WATCH_MAX_FAILURES = 6;
export const HANDOFF_WATCH_FAILURE_STREAK_MS = 8_000;
export const HANDOFF_WATCH_BACKOFF_CAP_MS = 5_000;

export function handoffWatchSleepMs(
  consecutiveFailures,
  pollMs,
  capMs = HANDOFF_WATCH_BACKOFF_CAP_MS
) {
  const base = Math.max(0, Number(pollMs) || 0);
  if (consecutiveFailures <= 0) return base;
  return Math.min(base * 2 ** Math.min(consecutiveFailures, 5), capMs);
}
const RESTORE_RETRIES = 3;
const RESTORE_RETRY_MS = 250;
const PAD_RESUME_MS = 1200;
const PAD_RESUME_TRIES = 8;
const DEADLINE_SLACK_MS = 10_000;
/** If the ramp pad has this little left after SOAP, SeekTrack TTS instead of waiting. */
const PAD_ADVANCE_SLACK_MS = 1500;

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
  if (isBakedAnnounceUri(value)) return true;
  const fileToken = publicUrl
    ? String(publicUrl).split("/").pop() || ""
    : "";
  return (
    /tts_proxy|\/media\/tts\//i.test(value) ||
    (fileToken && value.includes(fileToken))
  );
}

/** True when this TTS URI is the lead (Holy Roller) clip, not a banter punch. */
export function isLeadDjClipUri(uri, publicUrl) {
  if (!isDjClipUri(uri, publicUrl)) return false;
  const fileToken = publicUrl
    ? String(publicUrl).split("/").pop() || ""
    : "";
  if (!fileToken) return true;
  return String(uri || "").includes(fileToken);
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
    // Transport tick only (uri/state/positionSec) — the full now-playing
    // snapshot pulls the whole queue during silence pads, which this loop
    // would hammer the coordinator with several times a second.
    getNowPlaying: sonos.getTransportTick,
    getVolume: sonos.getGroupVolume,
    setVolume: sonos.setGroupVolume,
    // Intermediate ramp steps don't need read-back verification; only the
    // endpoints (announce target, restored baseline) must land exactly.
    setVolumeFast: sonos.setGroupVolumeFast,
    // Raw Pause — never host Pause (that cancels this handoff, then leaves
    // the first music track paused after the DJ). Same rule as next.
    pause: sonos.pausePlayback,
    resume: sonos.resumeQueuePlayback,
    playAt: (trackNumber) => sonos.play({ trackNumber }),
    // Raw Next — never host announce-aware Skip (that cancels this handoff).
    next: sonos.advanceQueueTrack,
    // Fresh queue read, only ever called right before a seek (never per poll).
    // Maintenance trims played songs off the front between arming this handoff
    // and the ramp reaching the playhead, so the indices we were handed at
    // insert time are wrong by however many songs were reaped in between.
    locateAnnounce: async (clipUrl) => {
      const [core, policy] = await Promise.all([
        import("./sonos-core.js"),
        import("./skip-announce-policy.js"),
      ]);
      const m = await core.getManager();
      const coordinator = await core.resolveCoordinator(m);
      const [queue, pos, media] = await Promise.all([
        coordinator.GetQueue(),
        coordinator.AVTransportService.GetPositionInfo().catch(() => ({
          Track: 0,
        })),
        coordinator.AVTransportService.GetMediaInfo({ InstanceID: 0 }).catch(
          () => ({ CurrentURI: "" })
        ),
      ]);
      return policy.locateAnnounceBlockByClipUrl(
        Array.isArray(queue.Result) ? queue.Result : [],
        clipUrl,
        {
          currentTrack: Number(pos.Track) || 0,
          playingFromQueue: /^x-rincon-queue:/.test(media.CurrentURI || ""),
        }
      );
    },
  };
}

export function createDjVolumeHandoff({
  publicUrl,
  approxDurationSec = 8,
  silenceSec = 3,
  ttsPosition = null,
  tts2Position = null,
  musicPosition = null,
  baselineOverride = null,
  holdPreSilence = false,
  calculateTarget,
  adapter = null,
  sleep = sleepDefault,
  now = Date.now,
  pollMs = DEFAULT_POLL_MS,
  rampSteps = DEFAULT_RAMP_STEPS,
  rampStepMs = DEFAULT_RAMP_STEP_MS,
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
  let sawLeadPlaying = false;
  /** URI of the last DJ clip we already Next()'d off, so a second banter clip can still advance. */
  let lastAdvancedDjUri = null;
  let djPlayUri = "";
  let djPlayAccumMs = 0;
  let djPlayLastTick = null;
  let advancedFromRestore = false;
  let restoreHeldAt = null;
  let deadlineHandled = false;
  let djRecoverTries = 0;
  let ttsPublicUrl = publicUrl;
  let liveTtsPosition = ttsPosition;
  let liveTts2Position = tts2Position;
  let liveMusicPosition = musicPosition;
  /** Last live lookup of this announce block, used to bound every seek. */
  let locatedBlock = null;
  let preSilenceReleased = !holdPreSilence;
  let pausedByHold = false;
  let preSilenceStartedAt = null;
  let currentVolume = null;
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
    tts2Position: liveTts2Position,
    musicPosition: liveMusicPosition,
    currentVolume,
  });

  const setPhase = (next) => {
    if (phase === next) return;
    phase = next;
    logger.info(`phase ${next}`);
    syncHandoffActiveFlag();
  };

  /**
   * Re-read where this announce actually sits before seeking to it.
   *
   * The positions we were armed with are absolute Sonos indices from the moment
   * the block was enqueued, but maintenance trims played songs off the front of
   * the queue while we wait for the ramp to reach the playhead — one trim, and
   * every index is one too high. Returns false when the seek must not happen at
   * all (the clip is gone from the queue).
   */
  const syncPositions = async (io, reason) => {
    if (typeof io.locateAnnounce !== "function") return true;
    let found = null;
    try {
      found = await io.locateAnnounce(ttsPublicUrl);
    } catch (error) {
      logger.warn(`announce lookup failed (${reason}): ${error.message}`);
      return locatedBlock != null;
    }
    if (!found) {
      locatedBlock = null;
      logger.warn(`announce clip is no longer queued (${reason}); not seeking`);
      return false;
    }
    if (found.ttsPosition !== liveTtsPosition) {
      logger.info(
        `announce moved since it was queued (${reason}): ` +
          `tts@${liveTtsPosition} → tts@${found.ttsPosition}`
      );
    }
    locatedBlock = found;
    liveTtsPosition = found.ttsPosition;
    liveTts2Position = found.tts2Position;
    if (found.musicPosition != null) liveMusicPosition = found.musicPosition;
    return true;
  };

  /**
   * SeekTrack, bounded to this announce block and the song it introduces.
   * A wrong index used to drop the playhead several songs ahead; everything it
   * skipped then sat behind the playhead, where trim reaped it as "already
   * played". A missed announce is recoverable, a deleted request is not.
   */
  const seekWithinBlock = async (io, position, reason) => {
    const target = Math.floor(Number(position) || 0);
    if (target < 1 || typeof io.playAt !== "function") return false;
    if (!locatedBlock) {
      // No bounds means the lookup failed or was never run. Seeking on the
      // indices we were armed with is the original bug, so refuse outright
      // whenever the adapter could have told us where the block really is.
      if (typeof io.locateAnnounce === "function") {
        logger.warn(`refusing ${reason} seek to #${target}: block unresolved`);
        return false;
      }
      await io.playAt(target);
      return true;
    }
    const limit = locatedBlock.musicPosition ?? locatedBlock.blockEnd;
    if (target < locatedBlock.blockStart || target > limit) {
      logger.warn(
        `refusing ${reason} seek to #${target}: outside announce block ` +
          `#${locatedBlock.blockStart}-#${limit}`
      );
      return false;
    }
    await io.playAt(target);
    return true;
  };

  const captureBaseline = async () => {
    if (baselineVolume != null) return baselineVolume;
    const io = await getAdapter();
    baselineVolume =
      preservedBaseline == null
        ? clampVolume(await io.getVolume())
        : preservedBaseline;
    announceVolume = clampVolume(calculateTarget(baselineVolume));
    currentVolume = baselineVolume;
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
    const want = clampVolume(target);
    await io.setVolume(want);
    currentVolume = want;
    // Trust the live read. A false `locked: false` (SOAP string vs number)
    // must not abort restore while the room is already at the baseline.
    return clampVolume(await io.getVolume()) === want;
  };

  const ramp = async (from, to) => {
    const start = clampVolume(from);
    const end = clampVolume(to);
    const steps = Math.max(1, Math.floor(Number(rampSteps) || 1));
    let previous = start;
    currentVolume = start;
    for (let index = 1; index <= steps; index++) {
      if (cancelled) return false;
      const next = clampVolume(start + ((end - start) * index) / steps);
      if (next === previous && index < steps) continue;
      const io = await getAdapter();
      // Verify only the endpoint. Read-back plus settle on every step costs two
      // SOAP calls per speaker for a level we overwrite ~300ms later; the
      // explicit gap keeps the ramp the same length it always was.
      if (index === steps || typeof io.setVolumeFast !== "function") {
        await io.setVolume(next);
      } else {
        await io.setVolumeFast(next);
        await sleep(Math.max(0, Number(rampStepMs) || 0));
      }
      currentVolume = next;
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
      pausedByHold = true;
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

  /** Sonos often skips the HTTP TTS clip when the 3s ramp expires during SOAP. */
  const DJ_RECOVER_MAX = 2;
  const recoverSkippedDjClip = async (io, reason) => {
    if (sawLeadPlaying || djRecoverTries >= DJ_RECOVER_MAX) return false;
    if (Number(liveTtsPosition) < 1 || typeof io.playAt !== "function") {
      return false;
    }
    try {
      const live = await io.getNowPlaying();
      const liveUri = String(live?.uri || "");
      const liveState = String(live?.state || "").toUpperCase();
      if (
        isLeadDjClipUri(liveUri, ttsPublicUrl) &&
        (liveState === "PLAYING" || liveState === "TRANSITIONING")
      ) {
        if (liveState === "PLAYING") {
          sawDjPlaying = true;
          sawLeadPlaying = true;
        }
        logger.info(`${reason}; already on lead DJ clip — not seeking`);
        return false;
      }
    } catch {
      /* jump if we cannot tell */
    }
    djRecoverTries += 1;
    if (!(await syncPositions(io, reason))) return false;
    logger.warn(`${reason}; jumping to TTS (try ${djRecoverTries})`);
    if (!(await seekWithinBlock(io, liveTtsPosition, "DJ recovery"))) {
      return false;
    }
    try {
      await io.resume();
    } catch (error) {
      logger.warn(`resume after DJ recovery failed: ${error.message}`);
    }
    return true;
  };

  const maybeJumpToTtsAfterRamp = async (io) => {
    if (Number(liveTtsPosition) < 1 || typeof io.playAt !== "function") {
      logger.info("volume ready on pre-silence; letting pad advance");
      return;
    }
    const padMs = Math.max(0, Math.round(Number(silenceSec || 3) * 1000));
    const elapsed =
      preSilenceStartedAt == null
        ? 0
        : Math.max(0, now() - preSilenceStartedAt);
    const remainingMs = padMs - elapsed;
    if (remainingMs >= PAD_ADVANCE_SLACK_MS) {
      logger.info("volume ready on pre-silence; letting pad advance");
      return;
    }
    // Re-read: the volume SOAP ramp often outlasts the 3s pad, so Sonos has
    // already moved onto the TTS clip. SeekTrack on a live http:// clip
    // restarts it from 0 (double intro).
    let liveUri = "";
    let liveState = "";
    try {
      const live = await io.getNowPlaying();
      liveUri = String(live?.uri || "");
      liveState = String(live?.state || "").toUpperCase();
    } catch {
      /* jump if we cannot tell */
    }
    const liveOnDj = isDjClipUri(liveUri, ttsPublicUrl);
    const livePlaying =
      liveState === "PLAYING" || liveState === "TRANSITIONING";
    if (liveOnDj && livePlaying) {
      logger.info("pre-silence elapsed; already on DJ clip — not seeking");
      if (liveState === "PLAYING") sawDjPlaying = true;
      if (isLeadDjClipUri(liveUri, ttsPublicUrl)) sawLeadPlaying = true;
      return;
    }
    if (!(await syncPositions(io, "pre-silence elapsed"))) return;
    // Still holding the ramp, and the clip is the very next row: Sonos will
    // walk onto it on its own. Seeking here only risks landing somewhere else
    // — recoverSkippedDjClip picks up the rare drop after the fact.
    if (isRampSilenceUri(liveUri) && locatedBlock?.rampPosition != null) {
      logger.info("pre-silence elapsed; DJ clip is next — letting pad advance");
      return;
    }
    logger.warn(
      `pre-silence nearly elapsed (${Math.max(0, remainingMs)}ms left); jumping to TTS`
    );
    if (!(await seekWithinBlock(io, liveTtsPosition, "pre-silence"))) return;
    try {
      await io.resume();
    } catch (error) {
      logger.warn(`resume after pre-silence jump failed: ${error.message}`);
    }
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
        pausedByHold = false;
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
      pausedByHold = false;
      logger.info(`advanced from ${label} with Next after ${silenceSec}s`);
      return;
    }
    // Only ever seek to a freshly resolved row. Falling back to the position we
    // were armed with is what jumped the playhead over unplayed requests.
    if (
      Number(position) >= 1 &&
      typeof io.playAt === "function" &&
      (await syncPositions(io, label))
    ) {
      if (await seekWithinBlock(io, liveMusicPosition, label)) {
        pausedByHold = false;
        logger.info(`advanced from ${label} after ${silenceSec}s`);
        return;
      }
    }
    try {
      await io.resume();
      pausedByHold = false;
      logger.info(`resumed ${label} after volume settled`);
    } catch (error) {
      logger.warn(`could not resume ${label}: ${error.message}`);
    }
  };

  const run = async () => {
    setPhase("waiting-pre-silence");
    let consecutiveWatchFailures = 0;
    let watchFailureSince = 0;
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
          preSilenceStartedAt = now();
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
            await maybeJumpToTtsAfterRamp(io);
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
          const onLead = isLeadDjClipUri(uri, ttsPublicUrl);
          if (
            Number(liveTts2Position) >= 1 &&
            !onLead &&
            !sawLeadPlaying &&
            (await recoverSkippedDjClip(
              io,
              "companion clip before lead DJ played"
            ))
          ) {
            continue;
          }
          if (baselineVolume == null) {
            handledPad = true;
            // Do NOT pause a live TTS HTTP stream here. Sonos often restarts
            // http:// clips from 0 on resume, which sounds like the DJ
            // announcing twice. Capture + ramp under the already-playing clip.
            await captureBaseline();
            setPhase("ramping-up-fallback");
            await ramp(baselineVolume, announceVolume);
          }
          if (uri !== djPlayUri) {
            djPlayUri = uri;
            djPlayAccumMs = 0;
            djPlayLastTick = null;
          }
          if (state === "PLAYING") {
            sawDjPlaying = true;
            if (onLead) sawLeadPlaying = true;
            if (djPlayLastTick != null) {
              djPlayAccumMs += Math.max(0, now() - djPlayLastTick);
            }
            djPlayLastTick = now();
          } else if (djPlayLastTick != null) {
            djPlayAccumMs += Math.max(0, now() - djPlayLastTick);
            djPlayLastTick = null;
          }
          if (phase !== "restored") setPhase("announcing");
          const playedSec = Number(np?.positionSec);
          const relDone = Number.isFinite(playedSec) && playedSec >= 4;
          const wallDone = djPlayAccumMs >= 2_000;
          const frozenClock = djPlayAccumMs === 0;
          const heardEnough = wallDone || (frozenClock && relDone);
          if (
            sawDjPlaying &&
            heardEnough &&
            (state === "STOPPED" || state === "PAUSED_PLAYBACK") &&
            Number(liveMusicPosition) >= 2 &&
            (typeof io.next === "function" || typeof io.playAt === "function")
          ) {
            // Re-read: Sonos may already have moved to the punch clip or restore.
            let liveUri = uri;
            let liveState = state;
            try {
              const live = await io.getNowPlaying();
              liveUri = String(live?.uri || uri);
              liveState = String(live?.state || state).toUpperCase();
            } catch {
              /* keep the poll */
            }
            const stillOnDj =
              isDjClipUri(liveUri, ttsPublicUrl) &&
              (liveState === "STOPPED" || liveState === "PAUSED_PLAYBACK");
            if (stillOnDj && liveUri !== lastAdvancedDjUri) {
              handledPad = true;
              // Next from a STOPPED/PAUSED TTS clip often leaves the transport
              // idle on the next pad — always Play after advancing or the
              // room stays paused after the DJ (Set Request / mid-set shouts).
              // Banter queues a second TTS after the lead; Next once per clip
              // so Sister Static still plays instead of jumping to restore.
              if (typeof io.next === "function") {
                try {
                  await io.next();
                  lastAdvancedDjUri = liveUri;
                  try {
                    await io.resume();
                  } catch (error) {
                    logger.warn(
                      `resume after DJ advance failed: ${error.message}`
                    );
                  }
                } catch (error) {
                  logger.warn(`DJ advance failed: ${error.message}`);
                }
              } else if (await syncPositions(io, "completed DJ clip")) {
                await seekWithinBlock(
                  io,
                  Number(liveMusicPosition) - 1,
                  "DJ advance"
                );
                lastAdvancedDjUri = liveUri;
              }
              logger.info("advanced completed DJ clip to next announce pad");
            }
          }
        } else if (onRestore && baselineVolume != null) {
          if (
            !sawLeadPlaying &&
            (await recoverSkippedDjClip(
              io,
              "restore pad before DJ clip played"
            ))
          ) {
            continue;
          }
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
          if (
            !sawLeadPlaying &&
            (await recoverSkippedDjClip(
              io,
              "music started before DJ clip played"
            ))
          ) {
            continue;
          }
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
          const djStillPlaying =
            onDj && (state === "PLAYING" || state === "TRANSITIONING");
          // Never Pause a live intro to "catch up" — that is what skipped
          // DJ lines when the duration estimate ran out early.
          if (!djStillPlaying) {
            try {
              await io.pause();
            } catch {
              /* best effort */
            }
          }
          const restored = await restoreExact("absolute deadline");
          if (restored && typeof io.playAt === "function") {
            // Re-read transport: the pad may have advanced while we paused for
            // the volume restore. Seeking an already-playing TTS clip restarts
            // it from 0 (double announce).
            let liveUri = uri;
            let liveState = state;
            try {
              const live = await io.getNowPlaying();
              liveUri = String(live?.uri || uri);
              liveState = String(live?.state || state).toUpperCase();
            } catch {
              /* keep the poll's uri */
            }
            const liveOnRamp = isRampSilenceUri(liveUri);
            const liveOnDj = isDjClipUri(liveUri, ttsPublicUrl);
            const liveOnRestore = isRestoreSilenceUri(liveUri);
            const liveDjPlaying =
              djStillPlaying ||
              (liveOnDj &&
                (liveState === "PLAYING" || liveState === "TRANSITIONING"));
            // Deadline seeks run minutes after the block was queued; re-resolve
            // before using any of these indices.
            const synced = await syncPositions(io, "absolute deadline");
            if (liveOnRamp && synced && Number(liveTtsPosition) >= 1) {
              await seekWithinBlock(io, liveTtsPosition, "deadline");
            } else if (liveDjPlaying) {
              logger.warn(
                "deadline reached while DJ intro still playing; not skipping"
              );
              try {
                await io.resume();
              } catch {
                /* already playing */
              }
            } else if (
              liveOnDj &&
              liveUri !== lastAdvancedDjUri &&
              synced &&
              Number(liveMusicPosition) >= 2
            ) {
              // Idle/finished clip — skip forward one slot (punch TTS or restore).
              // Never SeekTrack the TTS URI itself (that restarts the http clip).
              lastAdvancedDjUri = liveUri;
              if (typeof io.next === "function") {
                await io.next();
                try {
                  await io.resume();
                } catch {
                  /* best effort */
                }
              } else {
                await seekWithinBlock(
                  io,
                  Number(liveMusicPosition) - 1,
                  "deadline"
                );
              }
            } else if (
              liveOnRestore &&
              synced &&
              Number(liveMusicPosition) >= 1
            ) {
              await seekWithinBlock(io, liveMusicPosition, "deadline");
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
        consecutiveWatchFailures = 0;
        watchFailureSince = 0;
      } catch (error) {
        consecutiveWatchFailures += 1;
        if (!watchFailureSince) watchFailureSince = now();
        logger.error(`watch failed: ${error.message}`);
        const streakMs = now() - watchFailureSince;
        if (
          consecutiveWatchFailures >= HANDOFF_WATCH_MAX_FAILURES ||
          streakMs >= HANDOFF_WATCH_FAILURE_STREAK_MS
        ) {
          logger.error(
            `aborting volume handoff after ${consecutiveWatchFailures} failed polls (${streakMs}ms)`
          );
          cancelled = true;
          try {
            await restoreExact("sonos unreachable");
          } catch {
            /* best-effort — the speaker may already be gone */
          }
          setPhase("cancelled");
          break;
        }
      }
      if (cancelled) break;
      await sleep(handoffWatchSleepMs(consecutiveWatchFailures, pollMs));
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
    setPositions({
      ttsPosition: nextTts,
      tts2Position: nextTts2,
      musicPosition: nextMusic,
    } = {}) {
      if (nextTts != null) liveTtsPosition = nextTts;
      if (nextTts2 != null) liveTts2Position = nextTts2;
      if (nextMusic != null) liveMusicPosition = nextMusic;
      locatedBlock = null;
    },
    /** Follow a front-of-queue removal (trim) so the stored indices stay live. */
    shiftPositions(count) {
      const removed = Math.floor(Number(count) || 0);
      if (removed < 1) return false;
      const slide = (value) =>
        Number(value) >= 1 ? Math.max(1, Number(value) - removed) : value;
      liveTtsPosition = slide(liveTtsPosition);
      liveTts2Position =
        liveTts2Position == null ? liveTts2Position : slide(liveTts2Position);
      liveMusicPosition = slide(liveMusicPosition);
      locatedBlock = null;
      logger.info(
        `queue trimmed ${removed}; announce now tts@${liveTtsPosition} music@${liveMusicPosition}`
      );
      return true;
    },
    releasePreSilenceHold() {
      preSilenceReleased = true;
    },
    /** Re-resolve against the live queue, then hand back a current snapshot. */
    async refreshPositions(reason = "refresh") {
      try {
        await syncPositions(await getAdapter(), reason);
      } catch (error) {
        logger.warn(`position refresh failed (${reason}): ${error.message}`);
      }
      return snapshot();
    },
    snapshot,
    restoreExact,
    get done() {
      return task;
    },
  };
}

/**
 * Does the incoming announce sit further down the queue than the active one?
 * Both sides must be measured against the same queue: `next` is fresh from the
 * insert that just ran, so `previous` has to be re-resolved first or a trim in
 * between makes the earlier shout look later and cancels the wrong handoff.
 */
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
      currentVolume: null,
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
      currentVolume: null,
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
    let previous = activeHandoff.snapshot();
    const previousPhase = previous.phase;
    if (previousPhase !== "complete" && previousPhase !== "cancelled") {
      previous =
        (await activeHandoff.refreshPositions?.("supersede check")) ?? previous;
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
  if (handoff) {
    await handoff.cancelAndRestore(reason);
    if (activeHandoff === handoff) {
      activeHandoff = null;
      syncHandoffActiveFlag();
    }
  }
  // Host Pause must not drop bake armed/active — the clip is still current.
  // Clear / skip-past-announce / preempt do, so trim can run again.
  const why = String(reason || "");
  if (/clear|skip announce|queue preempted|queue cleared/i.test(why)) {
    setDjVolumeHandoffActive(false);
    setDjVolumeHandoffArmed(false);
  }
  return !!handoff;
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
    currentVolume: null,
  };
}
