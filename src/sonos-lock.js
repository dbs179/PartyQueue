// Serialize Sonos write operations so concurrent guest adds / Random /
// Never-Ending / trim / DJ enqueue can't race and corrupt the queue.

let chain = Promise.resolve();

/**
 * Run `fn` after any prior locked work finishes. Failures don't break the chain.
 * @template T
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export function withSonosWriteLock(fn) {
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
}
