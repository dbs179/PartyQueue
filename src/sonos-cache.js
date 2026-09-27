// Short-lived coalescing readers for Sonos SOAP snapshots.
// Health notes live here so every cached read feeds the manager auto-reset gate.

import {
  noteSonosReadSuccess,
  noteSonosReadFailure,
} from "./sonos-manager-health.js";

export const NOW_PLAYING_TTL_MS = 1000;
export const SNAPSHOT_TTL_MS = 3000;
// The group picker is the only reader that scans the whole household, so it
// gets a longer window than now-playing/queue. Every topology mutation still
// busts it, and the DJ Booth forces a read on open, so the picker stays right —
// this only stops a guest's song add from re-scanning every room in the house.
export const GROUPS_TTL_MS = 10_000;

export function makeCachedReader(fn, ttlMs) {
  let cache = { at: 0, value: null };
  // Survives bust(): the last thing Sonos actually told us, kept so readers can
  // degrade to stale data instead of to an error. See peek().
  let lastGood = { at: 0, value: null };
  let inFlight = null;
  let generation = 0;
  const read = async () => {
    if (cache.value && Date.now() - cache.at < ttlMs) return cache.value;
    if (inFlight) return inFlight; // collapse concurrent callers into one read
    const readGeneration = generation;
    const request = (async () => {
      try {
        const value = await fn();
        noteSonosReadSuccess();
        lastGood = { at: Date.now(), value };
        // A mutation may have invalidated snapshots while this request was in
        // flight. Return its result to the original caller, but never let that
        // stale result repopulate the shared cache.
        if (readGeneration === generation) {
          cache = { at: Date.now(), value };
        }
        return value;
      } catch (err) {
        // One global health gate — NP + queue + groups all share this; many
        // offline players cannot cascade rediscovery.
        noteSonosReadFailure();
        throw err;
      } finally {
        // Do not let an older invalidated request clear a newer in-flight read.
        if (inFlight === request) inFlight = null;
      }
    })();
    inFlight = request;
    return request;
  };
  read.bust = () => {
    generation += 1;
    cache = { at: 0, value: null };
    // New callers must start a post-mutation read instead of joining an older
    // request. The original caller may still finish, guarded by generation.
    inFlight = null;
  };
  // Non-blocking look at the last value we got, however old. Callers that must
  // stay responsive when Sonos is unreachable (guest adds, the queue display)
  // use this instead of awaiting a read that may never return. `fresh` tells
  // them whether it is still inside the normal TTL.
  read.peek = () => {
    if (!lastGood.value) return null;
    const ageMs = Date.now() - lastGood.at;
    const fresh = !!cache.value && Date.now() - cache.at < ttlMs;
    return { value: lastGood.value, at: lastGood.at, ageMs, fresh };
  };
  // Plant a value the next poll can return immediately (DJ announce after Play)
  // so a 10s+ SOAP that started on the previous song cannot keep winning.
  read.seed = (value) => {
    generation += 1;
    cache = { at: Date.now(), value };
    lastGood = { at: Date.now(), value };
    inFlight = null;
  };
  return read;
}
