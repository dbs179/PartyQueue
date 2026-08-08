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

import { AsyncLocalStorage } from "node:async_hooks";

function makeLane({ reentrant = false } = {}) {
  let chain = Promise.resolve();
  const als = reentrant ? new AsyncLocalStorage() : null;
  return (fn) => {
    if (als?.getStore()) {
      return Promise.resolve().then(() => fn());
    }
    const run = chain.then(
      () => (als ? als.run({}, () => fn()) : fn()),
      () => (als ? als.run({}, () => fn()) : fn())
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
 * Run `fn` after any prior queue-mutation work finishes.
 * @template T
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export const withSonosWriteLock = makeLane();

/**
 * Run `fn` after any prior transport command finishes, independent of the
 * queue-mutation lane above.
 * @template T
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export const withSonosTransportLane = makeLane({ reentrant: true });
