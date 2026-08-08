// Never-Ending refill DJ intro suppression.
// Pure helpers stay free of Sonos/settings imports; live queue lookup is injected.

/** Safety TTL so unmatched/renamed tracks cannot mute refill intros forever. */
export function refillAnnounceGuardTtlMs(setSize) {
  const n = Math.max(0, Math.floor(Number(setSize) || 0));
  return Math.max(20 * 60_000, n * 4 * 60_000);
}

/**
 * Pure: whether a prior refill announce should block a new intro.
 * `anyHighlightQueued` is resolved by the caller (live Sonos lookup).
 */
export function shouldSuppressRefillAnnounce({
  guard = null,
  anyHighlightQueued = false,
  now = Date.now(),
} = {}) {
  if (!guard) return false;
  const createdAt = Number(guard.createdAt) || 0;
  if (now - createdAt >= refillAnnounceGuardTtlMs(guard.setSize)) return false;
  const highlights = Array.isArray(guard.highlights) ? guard.highlights : [];
  if (!highlights.length) {
    // No track anchors — keep silent top-ups for the TTL window only.
    return true;
  }
  return !!anyHighlightQueued;
}

/** Snapshot stored after a refill announce lands in the Sonos queue. */
export function buildRefillAnnounceGuard(summary, createdAt = Date.now()) {
  const highlights = (Array.isArray(summary?.highlights) ? summary.highlights : [])
    .filter((h) => h && (h.name || h.artist))
    .map((h) => ({
      name: String(h.name || ""),
      artist: String(h.artist || ""),
    }));
  const setSize = Math.max(
    0,
    Math.floor(Number(summary?.added ?? summary?.count ?? highlights.length) || 0)
  );
  return { highlights, setSize, createdAt: Number(createdAt) || Date.now() };
}

// After a successful Never-Ending refill intro, suppress the next intro until
// that announced batch is no longer current/upcoming (silent top-ups still run).
let refillAnnounceGuard = null;

export function clearRefillAnnounceGuard() {
  refillAnnounceGuard = null;
}

export function getRefillAnnounceGuard() {
  return refillAnnounceGuard;
}

export function installRefillAnnounceGuard(summary, createdAt = Date.now()) {
  refillAnnounceGuard = buildRefillAnnounceGuard(summary, createdAt);
  return refillAnnounceGuard;
}

/** Test helper — install or clear the in-memory refill announce guard. */
export function setRefillAnnounceGuardForTests(guard = null) {
  refillAnnounceGuard = guard;
}

/**
 * True when the prior refill-announce batch is still in the queue (or the
 * guard TTL has not elapsed for a highlight-less guard). Cleared when expired
 * or when no guarded highlights remain.
 *
 * @param {{
 *   findUpcoming?: (track: { name?: string, artist?: string }) => Promise<number|null>,
 *   now?: number,
 * }} [opts]
 */
export async function isRefillAnnounceSuppressed({
  findUpcoming = null,
  now = Date.now(),
} = {}) {
  const guard = refillAnnounceGuard;
  if (!guard) return false;

  const highlights = Array.isArray(guard.highlights) ? guard.highlights : [];
  let anyHighlightQueued = false;

  if (highlights.length) {
    let finder = findUpcoming;
    if (!finder) {
      try {
        const sonosMod = await import("./sonos.js");
        finder = (track) => sonosMod.findUpcomingTrackPosition(track);
      } catch {
        // If we cannot inspect the queue, keep suppressing until TTL.
        anyHighlightQueued = true;
        finder = null;
      }
    }
    if (finder) {
      for (const h of highlights) {
        try {
          const pos = await finder({ name: h.name, artist: h.artist });
          if (Number(pos) >= 1) {
            anyHighlightQueued = true;
            break;
          }
        } catch {
          /* best-effort lookup per highlight */
        }
      }
    }
  }

  const suppress = shouldSuppressRefillAnnounce({
    guard,
    anyHighlightQueued,
    now,
  });
  if (!suppress) {
    refillAnnounceGuard = null;
  }
  return suppress;
}
