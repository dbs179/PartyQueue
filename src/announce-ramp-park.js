// In-memory freeze while a next-up shout is parked on the volume-ramp
// silence. Autofill / trim / pad-supersede must not split that block.
// Guest adds still go through findInsertPosition (after the glued request).
//
// The park is a hard freeze on Never-Ending, so it can never be allowed to
// leak: a crashed script/TTS call would otherwise stop the night. Every park
// carries a deadline, and callers register listeners that re-arm their timers
// as soon as it clears.

import crypto from "node:crypto";

/** A shout that cannot build its clip within this window has already failed. */
export const MAX_ANNOUNCE_PARK_MS = 45_000;

let parkCount = 0;
let parkedRampUrl = null;
let parkedRequestUri = null;
let parkedAt = 0;
let expireTimer = null;
let expireHandler = null;
const endListeners = new Set();

/** Unique per-announce suffix so two ramps are never the same queue URI. */
export function announceRampToken() {
  return crypto.randomBytes(4).toString("hex");
}

function clearExpireTimer() {
  if (expireTimer) {
    clearTimeout(expireTimer);
    expireTimer = null;
  }
}

function notifyEnded() {
  for (const listener of [...endListeners]) {
    try {
      listener();
    } catch (err) {
      console.warn("[announce-park] end listener failed:", err?.message || err);
    }
  }
}

/**
 * Freeze autofill/trim around a parked ramp.
 * @param {{
 *   rampUrl?: string|null,
 *   requestUri?: string|null,
 *   timeoutMs?: number,
 *   onExpire?: (() => unknown)|null,
 * }} [opts]
 * @returns {() => void} the matching release
 */
export function beginAnnounceRampPark({
  rampUrl = null,
  requestUri = null,
  timeoutMs = MAX_ANNOUNCE_PARK_MS,
  onExpire = null,
} = {}) {
  parkCount += 1;
  parkedAt = Date.now();
  if (rampUrl) parkedRampUrl = String(rampUrl);
  if (requestUri) parkedRequestUri = String(requestUri);
  if (onExpire) expireHandler = onExpire;

  clearExpireTimer();
  const ms = Math.max(1000, Number(timeoutMs) || MAX_ANNOUNCE_PARK_MS);
  expireTimer = setTimeout(() => {
    expireTimer = null;
    if (parkCount === 0) return;
    console.warn(
      `[announce-park] park exceeded ${ms}ms — releasing so Never-Ending resumes`
    );
    const handler = expireHandler;
    forceEndAnnounceRampPark();
    if (handler) {
      Promise.resolve()
        .then(handler)
        .catch((err) =>
          console.warn("[announce-park] expiry cleanup failed:", err?.message || err)
        );
    }
  }, ms);
  if (typeof expireTimer.unref === "function") expireTimer.unref();

  return endAnnounceRampPark;
}

export function endAnnounceRampPark() {
  if (parkCount === 0) return;
  parkCount -= 1;
  if (parkCount > 0) return;
  parkedRampUrl = null;
  parkedRequestUri = null;
  parkedAt = 0;
  expireHandler = null;
  clearExpireTimer();
  notifyEnded();
}

/** Drop the freeze regardless of depth (watchdog, Clear Queue). */
export function forceEndAnnounceRampPark() {
  if (parkCount === 0) return false;
  parkCount = 0;
  parkedRampUrl = null;
  parkedRequestUri = null;
  parkedAt = 0;
  expireHandler = null;
  clearExpireTimer();
  notifyEnded();
  return true;
}

export function isAnnounceRampParkActive() {
  if (parkCount === 0) return false;
  // Self-heal if a timer was never able to run (suspended host, fake timers).
  if (parkedAt && Date.now() - parkedAt > MAX_ANNOUNCE_PARK_MS) {
    forceEndAnnounceRampPark();
    return false;
  }
  return true;
}

export function getAnnounceRampPark() {
  return {
    active: parkCount > 0,
    rampUrl: parkedRampUrl,
    requestUri: parkedRequestUri,
    parkedAt,
  };
}

/**
 * Attach the recovery run if this park times out. Set once the volume handoff
 * exists, which is after the ramp (and therefore the freeze) is already in.
 */
export function setAnnounceRampParkExpiry(handler) {
  if (parkCount > 0 && typeof handler === "function") expireHandler = handler;
}

/** Re-arm timers (autofill) the moment the freeze lifts. */
export function onAnnounceRampParkEnd(listener) {
  if (typeof listener !== "function") return () => {};
  endListeners.add(listener);
  return () => endListeners.delete(listener);
}

export function resetAnnounceRampParkForTests() {
  parkCount = 0;
  parkedRampUrl = null;
  parkedRequestUri = null;
  parkedAt = 0;
  expireHandler = null;
  clearExpireTimer();
  endListeners.clear();
}
