// "Never-Ending Queue" monitor.
//
// When enabled, a single server-side loop watches the group's queue and tops it
// up with random songs before it runs dry. Running this server-side (rather than
// in the browser) means it works with no tab open and can't double-fire from
// multiple phones.
//
// Load is kept gentle on purpose: there is exactly one self-scheduling timer
// (never overlapping), each tick does one lean status read, and the interval
// adapts to how many songs are left, so we only check often as the queue nears
// empty and back off to once a minute when there's plenty queued.

import {
  getQueueStatus,
  addRandomFromPlaylists,
  clearQueue,
} from "./sonos.js";
import {
  loadSettings,
  saveSettings,
  getDiscoverySettings,
  getContentSettings,
  getRandomnessSettings,
  NEVER_ENDING_DEFAULT,
} from "./settings.js";
import {
  scheduleRefillAnnounce,
  checkPendingAnnounce,
} from "./dj-voice.js";

// Top up when this many (or fewer) songs remain AFTER the current one. Keeping
// it at 1 means we refill while a song is still queued, so playback never gaps.
const REFILL_THRESHOLD = 1;

// Adaptive check intervals (ms), chosen to minimize network/Sonos chatter.
// Most songs run ~3 min, so a deep queue barely needs watching: ~10 songs is
// over half an hour of music. We only tighten the cadence as the queue nears
// empty, and at 2 songs left we check every 30s so we reliably catch the
// next-to-last song starting and refill before playback can run dry.
const VERY_FAR_MS = 30 * 60_000; // 6+ songs left -> every 30 min
const FAR_MS = 20 * 60_000; // 5 songs left -> every 20 min
const MID_MS = 5 * 60_000; // 3-4 songs left -> every 5 min
const NEAR_MS = 30_000; // 2 left -> every 30s
// Hosts who mash Next can drain the last 1–2 songs faster than NEAR_MS;
// check often once we're on the final upcoming track.
const CRITICAL_MS = 5_000; // 0–1 left -> every 5s
const IDLE_MS = 60_000; // queue not the active source / not playing
const AFTER_FILL_MS = 8_000; // brief cool-down after a refill
const ERROR_MS = 30_000; // back off after a failed check
const START_DELAY_MS = 10_000; // wait after boot (pool may still be warming)
const NUDGE_MS = 1_000; // skip/next asked us to re-check soon

// Safety clamp: the bands above can be longer than the music actually left in a
// smallish queue (e.g. 6 songs is ~18 min but the band is 30 min), which would
// let a fresh/low queue drain to silence before the next scan. So we also cap
// the wait at roughly half the estimated remaining playtime. Deep queues keep
// their long, low-load intervals; only the 5-9 song range gets tightened.
const SONG_MS = 3 * 60_000; // assumed average song length
const SAFETY = 0.5; // re-check by ~the halfway point of the music left

let enabled = false;
let playlistIds = null;
let genres = null;
let timer = null;
let filling = false;
let stopping = false;
let activeTick = null;
let queueClearPauseCount = 0;

function clearTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function schedule(ms) {
  clearTimer();
  if (!enabled || stopping || queueClearPauseCount > 0) return;
  timer = setTimeout(() => {
    timer = null;
    const running = tick();
    activeTick = running;
    void running.finally(() => {
      if (activeTick === running) activeTick = null;
    });
  }, ms);
}

// The configured interval for a given number of upcoming songs.
function bandDelay(u) {
  if (u <= 1) return CRITICAL_MS; // last song / empty-upcoming — keep up with skips
  if (u <= 2) return NEAR_MS; // 30s
  if (u <= 4) return MID_MS; // 5 min
  if (u === 5) return FAR_MS; // 20 min
  return VERY_FAR_MS; // 6+ -> 30 min
}

/**
 * Pure: whether Never-Ending should top up now.
 * Only while music is actively playing from the queue and running low.
 * Never seeds an empty queue (fresh boot / Clear) — Sonos can still report
 * playingFromQueue after Clear with total=0, which used to revive the night.
 * Guests start with a request or Random; Never-Ending keeps it going mid-set.
 */
export function shouldAutofillRefill(
  status,
  threshold = REFILL_THRESHOLD
) {
  if (!status?.playingFromQueue || !status?.isPlaying) return false;
  const total = Number(status?.total) || 0;
  if (total <= 0) return false;
  const upcoming = Number(status?.upcoming);
  return Number.isFinite(upcoming) && upcoming <= threshold;
}

/**
 * Pure: adaptive poll delay. Near-empty STOPPED queues use CRITICAL_MS so we
 * recover quickly; deep idle queues stay on IDLE_MS. Exported for tests.
 */
export function autofillNextDelayMs(status, threshold = REFILL_THRESHOLD) {
  const upcoming = Number(status?.upcoming);
  const u = Number.isFinite(upcoming) ? upcoming : 0;
  const total = Number(status?.total) || 0;
  const nearEmpty = u <= threshold || total === 0;

  if (status?.playingFromQueue && status?.isPlaying) {
    const cap = Math.max(NEAR_MS, u * SONG_MS * SAFETY);
    return Math.min(bandDelay(u), cap);
  }
  // STOPPED / paused / not on queue: poll slowly unless near-empty.
  return nearEmpty ? CRITICAL_MS : IDLE_MS;
}

async function tick() {
  if (!enabled || queueClearPauseCount > 0) return;
  try {
    const status = await getQueueStatus();

    // Fire a scheduled set-boundary announce when playback crosses into the
    // next Never-Ending set (after the previous set's last song).
    try {
      await checkPendingAnnounce(status);
    } catch (err) {
      console.error("[autofill] dj-voice check failed:", err.message);
    }

    const shouldRefill = shouldAutofillRefill(status);

    if (shouldRefill && !filling) {
      filling = true;
      try {
        // Honor the host's current discovery + content + refill size settings.
        const { discoverEnabled, similarCount } = getDiscoverySettings();
        const { filterExplicit } = getContentSettings();
        const { endlessQueueCount } = getRandomnessSettings();
        // Current track is the last song of the active set; announce after it.
        const boundaryTrack = status.track;
        const res = await addRandomFromPlaylists(
          endlessQueueCount,
          playlistIds,
          genres,
          {
            similarCount: discoverEnabled ? similarCount : 0,
            filterExplicit,
          }
        );
        // addRandomFromPlaylists auto-starts when transport is STOPPED/idle
        // (respects deliberate pause via autoStartDecision).
        console.log(
          `[autofill] topped up: added ${res.added} song(s)` +
            (res.started ? " + started" : "") +
            (res.similarAdded
              ? ` (${res.added - res.similarAdded} playlists + ${res.similarAdded} discoveries)`
              : "") +
            (res.relaxedMemory
              ? ` [relaxed memory: ${res.memoryReuseCount}]`
              : res.relaxedArtist
                ? " [relaxed artist cap]"
                : "")
        );
        if (res.added > 0) {
          await scheduleRefillAnnounce(res, {
            boundaryTrack,
            upcoming: status.upcoming,
          });
        }
      } catch (err) {
        console.error("[autofill] refill failed:", err.message);
      } finally {
        filling = false;
      }
      schedule(AFTER_FILL_MS);
      return;
    }

    schedule(autofillNextDelayMs(status));
  } catch (err) {
    console.error("[autofill] check failed:", err.message);
    schedule(ERROR_MS);
  }
}

export function getAutoFillState() {
  return { enabled, playlistIds, genres };
}

/** Re-check soon after a skip/drain so Never-Ending can't lag behind Next. */
export function nudgeAutoFill() {
  if (!enabled || filling || stopping || queueClearPauseCount > 0) return false;
  schedule(NUDGE_MS);
  return true;
}

/**
 * Clear the Sonos queue without allowing an already-approved Never-Ending
 * refill to land afterward. Stop new ticks, let the current one finish, then
 * clear last so any songs it added are removed. Monitoring resumes afterward
 * and the normal total=0 guard keeps the empty queue quiet.
 *
 * `options` exists for deterministic race tests; production callers omit it.
 * @param {{
 *   pendingTick?: Promise<unknown>|null,
 *   clear?: () => Promise<unknown>,
 * }} [options]
 */
export async function clearQueueWithoutAutoRefill(options = {}) {
  queueClearPauseCount += 1;
  clearTimer();
  try {
    const pendingTick =
      Object.hasOwn(options, "pendingTick") ? options.pendingTick : activeTick;
    if (pendingTick) await pendingTick;
    // A finishing tick may have attempted to schedule its next check.
    clearTimer();
    const clear = options.clear || clearQueue;
    return await clear();
  } finally {
    queueClearPauseCount = Math.max(0, queueClearPauseCount - 1);
    if (queueClearPauseCount === 0 && enabled && !stopping) {
      schedule(CRITICAL_MS);
    }
  }
}

/** Stop the monitor without changing the persisted Never-Ending setting. */
export function stopAutoFillMonitor() {
  stopping = true;
  clearTimer();
  return activeTick ?? Promise.resolve();
}

// Timestamp of the last time "Closing Time" was added (last call). Broadcast in
// the Now Playing poll so every client can announce it once.
let closingTimeAt = 0;
let lastPartyRecap = null;
export function markClosingTime(recap = null) {
  closingTimeAt = Date.now();
  lastPartyRecap = recap && typeof recap === "object" ? recap : null;
}
export function getClosingTimeAt() {
  return closingTimeAt;
}
/** Tonight's party recap from the latest Closing Time add (or null). */
export function getLastPartyRecap() {
  return lastPartyRecap;
}

// Enable/disable the monitor and persist the choice. `ids` is the set of
// playlists to draw from (null/omitted = all) and `genreIds` the enabled genre
// buckets; each is only updated when an array is given, so a plain on/off
// doesn't wipe a saved selection.
export function setAutoFill(on, ids, genreIds) {
  enabled = !!on;
  if (Array.isArray(ids)) {
    playlistIds = ids.length ? ids : null;
  }
  if (Array.isArray(genreIds)) {
    genres = genreIds.length ? genreIds : null;
  }
  // Merge over the existing file so toggling the monitor doesn't wipe the host's
  // other saved settings (song memory, discovery, explicit filter, etc.).
  saveSettings({ ...loadSettings(), neverEnding: enabled, playlistIds, genres });

  clearTimer();
  if (enabled) {
    schedule(2_000); // first check shortly after enabling
  }
  return getAutoFillState();
}

// Persist playlist + genre selection for Random / Never-Ending without changing
// the monitor on/off state. Keeps every phone and the server on the same pool.
export function savePickerSelection(ids, genreIds) {
  if (Array.isArray(ids)) {
    playlistIds = ids.length ? ids : null;
  }
  if (Array.isArray(genreIds)) {
    genres = genreIds.length ? genreIds : null;
  }
  saveSettings({ ...loadSettings(), playlistIds, genres });
  return { playlistIds, genres };
}

// Restore the saved state at startup and resume monitoring if it was on.
export function initAutoFill() {
  stopping = false;
  const s = loadSettings();
  enabled =
    typeof s.neverEnding === "boolean" ? s.neverEnding : NEVER_ENDING_DEFAULT;
  playlistIds = Array.isArray(s.playlistIds) ? s.playlistIds : null;
  genres = Array.isArray(s.genres) ? s.genres : null;
  if (enabled) schedule(START_DELAY_MS);
}
