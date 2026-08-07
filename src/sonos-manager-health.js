// Single global gate for Sonos manager rediscovery.
//
// Goal: if Sonos has been unreachable for a long stretch WHILE clients are
// actively polling, drop the sticky manager once so the next getManager()
// rediscovers. Multiple offline players / multiple failing readers must not
// cascade into discovery storms — one clock, one cooldown, household-wide.

export const SONOS_OFFLINE_BEFORE_RESET_MS = 10 * 60_000;
export const SONOS_RESET_COOLDOWN_MS = 10 * 60_000;

let nowFn = Date.now;
/** @type {() => boolean} */
let demandChecker = () => false;
/** @type {(() => void) | null} */
let resetHandler = null;
/** @type {{ warn?: Function }} */
let logger = console;

let lastSuccessAt = 0;
/** First failure while demand was active; 0 = currently healthy / idle. */
let unhealthySince = 0;
let lastResetAt = 0;

/**
 * @param {{
 *   now?: () => number,
 *   demandChecker?: () => boolean,
 *   reset?: () => void,
 *   logger?: { warn?: Function },
 * }} [opts]
 */
export function configureSonosManagerHealth(opts = {}) {
  if (typeof opts.now === "function") nowFn = opts.now;
  if (typeof opts.demandChecker === "function") demandChecker = opts.demandChecker;
  if (typeof opts.reset === "function") resetHandler = opts.reset;
  if (opts.logger) logger = opts.logger;
}

/** Used by server.js once monitors exist (avoids import cycles with sonos.js). */
export function setSonosDemandChecker(fn) {
  demandChecker = typeof fn === "function" ? fn : () => false;
}

export function noteSonosReadSuccess() {
  lastSuccessAt = nowFn();
  unhealthySince = 0;
}

/**
 * Record a failed Sonos read. Only advances the offline clock when clients are
 * connected (demand). Returns whether a reset was performed.
 * @returns {{ reset: boolean, reason: string, offlineForMs?: number }}
 */
export function noteSonosReadFailure() {
  if (!demandChecker()) {
    return { reset: false, reason: "no-demand" };
  }

  const t = nowFn();
  if (!unhealthySince) unhealthySince = t;
  const offlineForMs = t - unhealthySince;

  if (offlineForMs < SONOS_OFFLINE_BEFORE_RESET_MS) {
    return { reset: false, reason: "waiting", offlineForMs };
  }

  if (lastResetAt && t - lastResetAt < SONOS_RESET_COOLDOWN_MS) {
    return { reset: false, reason: "cooldown", offlineForMs };
  }

  if (typeof resetHandler !== "function") {
    return { reset: false, reason: "no-reset-handler", offlineForMs };
  }

  lastResetAt = t;
  try {
    resetHandler();
  } catch (err) {
    logger.warn?.(
      "[sonos] manager auto-reset failed:",
      err?.message || err
    );
    return { reset: false, reason: "reset-threw", offlineForMs };
  }

  logger.warn?.(
    `[sonos] manager reset after ${Math.round(offlineForMs / 1000)}s of failed reads while clients were connected`
  );
  return { reset: true, reason: "reset", offlineForMs };
}

/** Clear the unhealthy clock (manual reset / host config change). */
export function clearSonosUnhealthy() {
  unhealthySince = 0;
}

/** Test / diagnostics helper. */
export function getSonosManagerHealth() {
  return {
    lastSuccessAt,
    unhealthySince,
    lastResetAt,
    offlineBeforeResetMs: SONOS_OFFLINE_BEFORE_RESET_MS,
    resetCooldownMs: SONOS_RESET_COOLDOWN_MS,
  };
}

/** Test helper — full state wipe. */
export function resetSonosManagerHealthStateForTests() {
  lastSuccessAt = 0;
  unhealthySince = 0;
  lastResetAt = 0;
  nowFn = Date.now;
  demandChecker = () => false;
  resetHandler = null;
  logger = console;
}
