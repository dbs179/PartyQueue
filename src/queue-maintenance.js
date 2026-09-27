// Queue maintenance: keep the Sonos queue lean by trimming already-played songs.
//
// Sonos never removes a track after it plays - it just advances a pointer, so
// played songs pile up in the queue all night. That buried newly added songs
// under the night's history. This is a single server-side, self-scheduling timer
// (the same gentle pattern as autofill) that periodically removes everything
// behind the current track while the queue is the active, playing source.
//
// It runs independently of the Never-Ending Queue toggle, and is the ONLY caller
// of trimPlayedTracks(), so removals never overlap or race the browsers.
//
// It also carries the pending-add true-up (see add-trueup.js). That belongs
// here rather than on its own timer: this loop already wakes between songs when
// the write lane is quiet, already backs off on error, and is already the one
// place queue-wide bookkeeping happens.

import { getQueueList, getQueueStatus, trimPlayedTracks } from "./sonos.js";
import { runAddTrueUp } from "./add-trueup.js";
import { expireFailedAdds, expirePlacedAdds } from "./pending-adds.js";

const PLAYING_MS = 45_000; // trim cadence while the queue is actively playing
const IDLE_MS = 60_000; // nothing to trim (stopped / external source)
const ERROR_MS = 60_000; // back off after a failed check
const START_DELAY_MS = 15_000; // wait after boot (let things settle)

let timer = null;
let stopping = false;
let activeTick = null;
let errorStreak = 0;

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
}

// Failed rows stay visible long enough for a guest to notice and retry, but
// not so long that they clutter the party display all night.
const FAILED_TTL_MS = 10 * 60_000;

// A placed row only exists to cover the seconds before Sonos shows the song.
// If the speaker still has not confirmed it after this long, the song has
// almost certainly played and been trimmed - stop drawing a shadow of it.
const PLACED_TTL_MS = 2 * 60_000;

async function trueUpPendingAdds() {
  try {
    // getQueueList() is only reached when something is actually waiting, so a
    // healthy party adds no extra Sonos reads here.
    const { confirmed } = await runAddTrueUp({ getQueueList });
    if (confirmed) {
      console.log(`[maintenance] true-up confirmed ${confirmed} pending add(s)`);
    }
    expireFailedAdds(FAILED_TTL_MS);
    expirePlacedAdds(PLACED_TTL_MS);
  } catch (err) {
    // Never let reconciliation break trimming - they are independent jobs.
    console.error("[maintenance] true-up failed:", err.message);
  }
}

async function tick() {
  let delay = IDLE_MS;
  try {
    const status = await getQueueStatus();
    if (status.playingFromQueue && status.isPlaying) {
      const { removed } = await trimPlayedTracks();
      if (removed) console.log(`[maintenance] trimmed ${removed} played song(s)`);
      delay = PLAYING_MS;
    } else {
      delay = IDLE_MS;
    }
    // Runs whether or not the queue is playing: a stopped speaker is exactly
    // when adds are most likely to be stuck waiting for confirmation.
    await trueUpPendingAdds();
    errorStreak = 0;
  } catch (err) {
    errorStreak += 1;
    delay = Math.min(ERROR_MS * 2 ** Math.min(errorStreak - 1, 2), 5 * 60_000);
    console.error("[maintenance] tick failed:", err.message);
  }
  schedule(delay);
}

// Start the maintenance loop. Safe to call once at startup.
export function initQueueMaintenance() {
  stopping = false;
  schedule(START_DELAY_MS);
}

/** Stop the self-scheduling loop during process shutdown. */
export function stopQueueMaintenance() {
  stopping = true;
  clearTimer();
  return activeTick ?? Promise.resolve();
}
