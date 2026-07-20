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

import { getQueueStatus, trimPlayedTracks } from "./sonos.js";

const PLAYING_MS = 45_000; // trim cadence while the queue is actively playing
const IDLE_MS = 60_000; // nothing to trim (stopped / external source)
const ERROR_MS = 60_000; // back off after a failed check
const START_DELAY_MS = 15_000; // wait after boot (let things settle)

let timer = null;
let stopping = false;
let activeTick = null;

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
  } catch (err) {
    console.error("[maintenance] tick failed:", err.message);
    delay = ERROR_MS;
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
