// Bounded ring of recent external failures for /api/ready.
// Throttled per scope so a Sonos outage does not fill the ring every poll.

const MAX_EVENTS = 30;
const DEFAULT_MIN_INTERVAL_MS = 15_000;

/** @type {{ at: number, scope: string, message: string }[]} */
const events = [];
/** @type {Map<string, number>} */
const lastNotedAt = new Map();
/** @type {Map<string, number>} */
const lastSuccessAt = new Map();

/**
 * @param {string} scope
 * @param {string} message
 * @param {{ minIntervalMs?: number, now?: number }} [opts]
 */
export function noteFailure(scope, message, opts = {}) {
  const name = String(scope || "app").slice(0, 40);
  const now = Number(opts.now) || Date.now();
  const minInterval = Number.isFinite(opts.minIntervalMs)
    ? opts.minIntervalMs
    : DEFAULT_MIN_INTERVAL_MS;
  const prev = lastNotedAt.get(name) || 0;
  if (prev && minInterval > 0 && now - prev < minInterval) return false;
  lastNotedAt.set(name, now);
  events.push({
    at: now,
    scope: name,
    message: String(message || "failed").slice(0, 180),
  });
  if (events.length > MAX_EVENTS) events.shift();
  return true;
}

/** @param {string} scope @param {number} [now] */
export function noteSuccess(scope, now = Date.now()) {
  const name = String(scope || "app").slice(0, 40);
  lastSuccessAt.set(name, Number(now) || Date.now());
}

/** @param {string} scope */
export function lastSuccessFor(scope) {
  return lastSuccessAt.get(String(scope || "")) || 0;
}

export function recentFailures() {
  return events.map((event) => ({ ...event }));
}

export function resetFailureLogForTests() {
  events.length = 0;
  lastNotedAt.clear();
  lastSuccessAt.clear();
}
