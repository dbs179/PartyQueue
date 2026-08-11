// Let other HTTP / SSE work run between heavy sync stretches (e.g. Random plan
// scans over large playlist pools).

/** Resolves on the next event-loop turn (after I/O callbacks already queued). */
export function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}
