// Serialize Sonos write operations so concurrent guest adds / Random /
// Never-Ending / trim / DJ enqueue can't race and corrupt the queue.
//
// Two independent lanes:
// - withSonosWriteLock: queue-content and topology mutations (adds, removes,
//   reorder, clear, group changes). These compute insert positions from queue
//   snapshots and MUST NOT interleave with each other.
// - withSonosTransportLane: transport-level commands (play/pause/next/volume/
//   shuffle/mute). They never touch queue contents, so they must not wait
//   behind a long Never-Ending refill — pause has to work mid-fill.
//
// Transport lane is reentrant: Skip→cancel handoff→setVolume must not
// deadlock waiting on the same lane that Skip already holds.
//
// Each lane call also has a wall-clock deadline so a hung SOAP request cannot
// pin the lane forever (guest Adds / Random / Clear would otherwise freeze).

import { AsyncLocalStorage } from "node:async_hooks";
import { envTimeoutMs, withTimeout } from "./with-timeout.js";

/** Default budget for queue mutations (multi-add Random / announce blocks). */
export const SONOS_WRITE_TIMEOUT_MS = envTimeoutMs(
  "PARTYQUEUE_SONOS_WRITE_TIMEOUT_MS",
  30_000
);

/** Default budget for play/pause/next/volume. */
export const SONOS_TRANSPORT_TIMEOUT_MS = envTimeoutMs(
  "PARTYQUEUE_SONOS_TRANSPORT_TIMEOUT_MS",
  12_000
);

let writeTimeoutMs = SONOS_WRITE_TIMEOUT_MS;
let transportTimeoutMs = SONOS_TRANSPORT_TIMEOUT_MS;
/** @type {null | (() => void | Promise<void>)} */
let onLaneTimeoutHook = null;
let lastLaneResetAt = 0;
export const LANE_RESET_DEBOUNCE_MS = 30_000;

/** @param {{ writeMs?: number, transportMs?: number }} [opts] */
export function setSonosLaneTimeoutsForTests(opts = {}) {
  if (opts.writeMs != null) writeTimeoutMs = Number(opts.writeMs);
  if (opts.transportMs != null) transportTimeoutMs = Number(opts.transportMs);
}

/** @param {null | (() => void | Promise<void>)} hook */
export function setSonosLaneTimeoutHookForTests(hook) {
  onLaneTimeoutHook = hook;
}

export function resetSonosLaneTimeoutsForTests() {
  writeTimeoutMs = SONOS_WRITE_TIMEOUT_MS;
  transportTimeoutMs = SONOS_TRANSPORT_TIMEOUT_MS;
  onLaneTimeoutHook = null;
  lastLaneResetAt = 0;
}

function isTimeoutError(err) {
  return /timed out/i.test(String(err?.message || err || ""));
}

/** Drop stale Sonos sockets after a hung lane op (lazy to avoid import cycles). */
async function resetManagerAfterTimeout() {
  const t = Date.now();
  if (lastLaneResetAt && t - lastLaneResetAt < LANE_RESET_DEBOUNCE_MS) {
    return;
  }
  lastLaneResetAt = t;
  if (onLaneTimeoutHook) {
    try {
      await onLaneTimeoutHook();
    } catch {
      /* best-effort */
    }
    return;
  }
  try {
    const { resetSonosManager } = await import("./sonos-core.js");
    resetSonosManager();
  } catch {
    /* best-effort */
  }
}

/**
 * @param {{ reentrant?: boolean, timeoutMs: () => number, label: string }} opts
 */
function makeLane({ reentrant = false, timeoutMs, label }) {
  let chain = Promise.resolve();
  const als = reentrant ? new AsyncLocalStorage() : null;
  return (fn) => {
    if (als?.getStore()) {
      // Nested transport work shares the outer deadline.
      return Promise.resolve().then(() => fn());
    }
    const run = chain.then(
      () => runTimed(fn, als, timeoutMs(), label),
      () => runTimed(fn, als, timeoutMs(), label)
    );
    // Keep the chain alive even if this call rejects.
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

/**
 * @template T
 * @param {() => Promise<T>|T} fn
 * @param {AsyncLocalStorage<object>|null} als
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
async function runTimed(fn, als, ms, label) {
  const exec = () => (als ? als.run({}, () => fn()) : fn());
  try {
    return await withTimeout(Promise.resolve().then(exec), ms, label);
  } catch (err) {
    if (isTimeoutError(err)) {
      // Don't await — unlock the lane immediately for the next caller.
      void resetManagerAfterTimeout();
    }
    throw err;
  }
}

/**
 * Run `fn` after any prior queue-mutation work finishes.
 * @template T
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export const withSonosWriteLock = makeLane({
  timeoutMs: () => writeTimeoutMs,
  label: "Sonos queue operation timed out",
});

/**
 * Run `fn` after any prior transport command finishes, independent of the
 * queue-mutation lane above.
 * @template T
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export const withSonosTransportLane = makeLane({
  reentrant: true,
  timeoutMs: () => transportTimeoutMs,
  label: "Sonos transport operation timed out",
});
