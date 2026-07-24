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

function makeLane() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(
      () => fn(),
      () => fn()
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
export const withSonosTransportLane = makeLane();
