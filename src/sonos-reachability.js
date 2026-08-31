// Classify Sonos SOAP / TCP failures that mean a player is gone or wedged, and
// remember which speakers to leave alone for a while.
//
// The skip map is shared household-wide on purpose. A speaker that just refused
// a volume write is the same speaker the topology probe, the group scan, and
// Group All are about to hit; without one memory between them, a dying player
// gets retried from four directions until it drops off the network.

export function isSonosUnreachableError(err) {
  const code = String(err?.code || "");
  const msg = String(err?.message || err || "");
  return (
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EHOSTDOWN" ||
    /EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTDOWN|timed out/i.test(
      msg
    )
  );
}

export const SKIP_UNREACHABLE_MS = 60_000;
let skipUnreachableMs = SKIP_UNREACHABLE_MS;
/** @type {Map<string, number>} player key -> skip-until epoch ms */
const unreachableUntil = new Map();

/** Stable identity for a managed SonosDevice (host first — it survives renames). */
export function playerKey(device) {
  return String(device?.Host || device?.Uuid || device?.Name || "");
}

export function isPlayerSkipped(device, now = Date.now()) {
  const key = playerKey(device);
  if (!key) return false;
  const until = unreachableUntil.get(key);
  if (!until) return false;
  if (now >= until) {
    unreachableUntil.delete(key);
    return false;
  }
  return true;
}

export function markPlayerUnreachable(device, now = Date.now()) {
  const key = playerKey(device);
  if (!key) return;
  const already = unreachableUntil.has(key);
  unreachableUntil.set(key, now + skipUnreachableMs);
  if (!already) {
    console.warn(
      `[sonos] skipping unreachable player ${key} for ${Math.round(skipUnreachableMs / 1000)}s`
    );
  }
}

export function markPlayerReachable(device) {
  const key = playerKey(device);
  if (key) unreachableUntil.delete(key);
}

/**
 * Mark a speaker unreachable only when the failure actually looks like the box
 * is gone or wedged. A UPnP fault (wrong coordinator, bad position) means the
 * speaker answered us, so it must not earn a skip.
 * @returns {boolean} whether the player was marked
 */
export function noteSpeakerFailure(device, err, now = Date.now()) {
  if (!isSonosUnreachableError(err)) return false;
  markPlayerUnreachable(device, now);
  return true;
}

/** Drop players currently in their cool-off window. */
export function liveMembers(members, now = Date.now()) {
  return (members || []).filter((device) => !isPlayerSkipped(device, now));
}

export function setSkipUnreachableMsForTests(ms) {
  if (ms != null) skipUnreachableMs = Number(ms);
}

export function resetSpeakerReachabilityForTests() {
  skipUnreachableMs = SKIP_UNREACHABLE_MS;
  unreachableUntil.clear();
}

/** Test / diagnostics helper. */
export function reachabilityInfoForTests() {
  return { skipUnreachableMs, skipped: [...unreachableUntil.keys()] };
}
