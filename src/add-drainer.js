// Places guest adds on Sonos off the HTTP request path.
//
// POST /api/queue records the add in pending-adds.js and answers the phone
// immediately. This loop does the slow part - coordinator resolution, the
// live queue read, AddURIToQueue, and the DJ shout - where nobody is waiting
// on it. A wedged speaker now delays the music, not the app.
//
// Same self-scheduling shape as autofill.js and queue-maintenance.js: one
// timer, no overlap, backs off on failure. It is nudged when a guest adds so a
// healthy party still places songs within a second or so.
//
// Retries here are deliberately not aggressive. An add that times out may well
// have landed anyway, so the true-up in queue-maintenance.js checks the live
// queue and retires the entry before this loop gets another go at it. That is
// what keeps "at least once" from turning into "twice".

import {
  addTrackToQueue,
  play,
  ensureShoutLeadBuffer,
  getQueueList,
} from "./sonos.js";
import { queueWorkWasPreempted } from "./queue-preempt.js";
import {
  shouldShoutOnSearch,
  announceRequestShout,
  queueRequestShout,
  releaseReservedFirstShout,
} from "./dj-shout.js";
import { recordRequest } from "./request-log.js";
import { ensureGuestProfile } from "./guest-profiles.js";
import {
  claimPending,
  listPlaceable,
  markPlaced,
  markFailed,
  recordAttemptError,
  releasePlacing,
} from "./pending-adds.js";

const START_DELAY_MS = 5_000; // let the speaker layer settle after boot
const IDLE_MS = 15_000; // safety poll; adds normally arrive via nudge
const BUSY_MS = 250; // brief breath between back-to-back placements

// Per-entry retry backoff. Gentle on purpose: a struggling speaker should not
// be hammered, and the true-up may retire the entry before we try again.
const RETRY_BASE_MS = 3_000;
const RETRY_MAX_MS = 60_000;

// After this many failed attempts the guest is told the truth instead of
// watching a song that is never going to play.
const MAX_ATTEMPTS = 5;

let timer = null;
let stopping = false;
let activeTick = null;

// Speaker/DJ seam: production uses the real modules, tests inject fakes.
let overrides = {};

function deps() {
  return {
    addTrackToQueue,
    play,
    getQueueList,
    ensureShoutLeadBuffer,
    recordRequest,
    ensureGuestProfile,
    shouldShoutOnSearch,
    announceRequestShout,
    queueRequestShout,
    releaseReservedFirstShout,
    ...overrides,
  };
}

/** Inject fakes for tests. Call with {} to restore the real speaker layer. */
export function configureAddDrainer(next = {}) {
  overrides = next || {};
}

function retryDelayMs(attempts) {
  const n = Math.max(0, attempts - 1);
  return Math.min(RETRY_BASE_MS * 2 ** n, RETRY_MAX_MS);
}

/** Entries whose backoff has elapsed, oldest tap first. */
function dueEntries(now) {
  return listPlaceable().filter(
    (e) => e.attempts === 0 || now - e.updatedAt >= retryDelayMs(e.attempts)
  );
}

function clearTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function schedule(ms) {
  clearTimer();
  if (stopping) return;
  timer = setTimeout(() => {
    timer = null;
    const running = tick();
    activeTick = running;
    void running.finally(() => {
      if (activeTick === running) activeTick = null;
    });
  }, ms);
  timer.unref?.();
}

/**
 * Fire the DJ shout for a placed request. Never awaited by a guest, so a slow
 * or broken TTS path can only delay the announce, not the add.
 */
async function runRequestShout(entry, result, d) {
  const { requestedByUser: user, name, artist, dedication, uri, trackId } = entry;
  const pos = Number(result.absoluteQueuePosition ?? result.queuePosition);

  if (!Number.isFinite(pos) || pos < 1) {
    d.releaseReservedFirstShout(user);
    return;
  }

  // Only Play-from-DJ when we actually held idle. Empty queue + already
  // playing must not Pause / Seek the current song.
  const startPlayback = !!result.deferredStart && !result.alreadyPlaying;

  if (startPlayback) {
    // Await empty/idle shouts so we can fall back to playing the song if
    // TTS/HA fails - otherwise the queue stays STOPPED forever.
    try {
      const voice = await d.announceRequestShout({
        name,
        artist,
        requestedBy: user,
        dedication,
        uri,
        trackId,
        kind: "songRequest",
        queuePosition: pos,
        startPlayback: true,
        preemptGeneration: entry.preemptGeneration,
      });
      if (
        !voice?.ok &&
        !voice?.skipped &&
        !queueWorkWasPreempted(entry.preemptGeneration)
      ) {
        await d.play();
      }
    } catch (err) {
      console.error("[add-drainer] request shout:", err.message);
      if (!queueWorkWasPreempted(entry.preemptGeneration)) {
        try {
          await d.play();
        } catch (playErr) {
          console.error("[add-drainer] shout fallback play:", playErr.message);
        }
      }
    }
    return;
  }

  // Mid-set: never Pause. Nothing is holding an HTTP response open now, so the
  // announce never needs to be awaited for placement accuracy - the lead-buffer
  // logic re-glues the shout to its request by URI.
  try {
    await d.queueRequestShout(
      {
        name,
        artist,
        requestedBy: user,
        dedication,
        uri,
        trackId,
        kind: "songRequest",
        queuePosition: pos,
        startPlayback: false,
        preemptGeneration: entry.preemptGeneration,
      },
      { awaitInsert: false }
    );
  } catch (err) {
    console.error("[add-drainer] request shout:", err.message);
  }
}

/**
 * Place one claimed entry on Sonos.
 * @returns {Promise<{ ok: true, result: object } | { ok: false, error: string }>}
 */
async function placeEntry(entry) {
  const d = deps();

  const added = await d.addTrackToQueue(entry.uri, {
    name: entry.name,
    artist: entry.artist,
    force: entry.force,
    requestedBy: entry.requestedBy,
    requestedByUser: entry.requestedByUser,
    dedication: entry.dedication,
  });

  // Only a newly-added or promoted slot consumes Party Stats, matching the
  // synchronous path. Fairness quota was already taken at acknowledgement.
  if (entry.trackId && added.requestCreated !== false) {
    try {
      d.recordRequest({
        id: entry.trackId,
        name: entry.name,
        artist: entry.artist,
        requestedBy: entry.requestedByUser,
        alias:
          entry.alias && entry.alias !== entry.requestedByUser ? entry.alias : null,
        dedication: entry.dedication,
      });
    } catch (err) {
      console.error("[add-drainer] record request:", err.message);
    }
  }

  try {
    if (d.ensureGuestProfile(entry.requestedByUser)) {
      console.log(`[queue] new guest profile created: ${entry.requestedByUser}`);
    }
  } catch (err) {
    console.error("[add-drainer] guest profile create:", err.message);
  }

  if (
    added.requestCreated !== false &&
    d.shouldShoutOnSearch({
      force: !!added.queueWasEmpty,
      requestedBy: entry.requestedByUser,
    })
  ) {
    await runRequestShout(entry, added, d);
  } else if (
    added.requestCreated !== false &&
    added.deferredStart &&
    !added.started &&
    !queueWorkWasPreempted(entry.preemptGeneration)
  ) {
    // Shout was deferred-start but didn't fire (DJ not ready, etc.) - play song.
    try {
      await d.play();
    } catch (err) {
      console.error("[add-drainer] deferred start failed:", err.message);
    }
  }

  return { ok: true, result: added };
}

/**
 * Process the oldest due entry, if any.
 * @param {{ now?: number }} [opts] `now` lets tests step past retry backoff.
 * @returns {Promise<"idle"|"placed"|"failed"|"retry">}
 */
export async function drainOnce({ now = Date.now() } = {}) {
  // Emptying the queue is the only thing that discards pending adds, and it is
  // handled at that choke point (clearQueueWithoutAutoRefill). Do NOT infer it
  // from the preempt generation: the End-of-Night ritual bumps that too, and it
  // clears filler precisely so real guest requests play out the night.
  const due = dueEntries(now);
  if (!due.length) return "idle";

  const entry = claimPending(due[0].id);
  if (!entry) return "idle";

  try {
    await placeEntry(entry);
    markPlaced(entry.id);
    console.log(
      `[add-drainer] placed "${entry.name}" for ${entry.requestedByUser}` +
        (entry.attempts > 1 ? ` (attempt ${entry.attempts})` : "")
    );
    return "placed";
  } catch (err) {
    const message = err?.message || "Could not add to the Sonos queue.";
    if (entry.attempts >= MAX_ATTEMPTS) {
      markFailed(entry.id, message);
      console.error(
        `[add-drainer] giving up on "${entry.name}" after ${entry.attempts} attempts: ${message}`
      );
      return "failed";
    }
    recordAttemptError(entry.id, message);
    console.error(
      `[add-drainer] attempt ${entry.attempts} for "${entry.name}" failed: ${message}`
    );
    return "retry";
  } finally {
    releasePlacing(entry.id);
  }
}

async function tick() {
  let delay = IDLE_MS;
  try {
    const outcome = await drainOnce();
    // Keep going while there is work; a burst of taps should land quickly.
    delay = outcome === "idle" ? IDLE_MS : BUSY_MS;
  } catch (err) {
    console.error("[add-drainer] tick failed:", err.message);
    delay = IDLE_MS;
  }
  schedule(delay);
}

/** Wake the loop now - called when a guest add lands in the outbox. */
export function nudgeAddDrainer() {
  if (stopping || activeTick) return;
  schedule(0);
}

/** Start the drain loop. Safe to call once at startup. */
export function initAddDrainer() {
  stopping = false;
  schedule(START_DELAY_MS);
}

/** Stop the self-scheduling loop during process shutdown. */
export function stopAddDrainer() {
  stopping = true;
  clearTimer();
  return activeTick ?? Promise.resolve();
}
