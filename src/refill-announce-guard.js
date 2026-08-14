// Never-Ending refill DJ intro suppression.
// Pure helpers stay free of Sonos/settings imports; live queue lookup is injected.
//
// Same genreLane + mood early top-ups stay silent while the prior announced
// batch is still queued. A new set flavor (lane, mood, reaction, same-artist,
// or a fresh rotate event) always allows an intro. A rotate flag on the prior
// guard does not force a second intro on the next same-set top-up.

/** Safety TTL so unmatched/renamed tracks cannot mute refill intros forever. */
export function refillAnnounceGuardTtlMs(setSize) {
  const n = Math.max(0, Math.floor(Number(setSize) || 0));
  return Math.max(20 * 60_000, n * 4 * 60_000);
}

function cleanFlavorPart(value) {
  const s = String(value || "").trim();
  return s || "";
}

/**
 * True when the next batch is a different set flavor than the guard.
 * Empty vs empty on both lane and mood is not a change (same unknown set).
 * Empty vs a concrete lane/mood counts as a change so the first labeled set
 * after an unlabeled guard still announces.
 *
 * @param {object|null|undefined} guard
 * @param {string|null|undefined} nextGenreLane
 * @param {string|null|undefined} nextMood
 */
export function refillSetFlavorChanged(
  guard,
  nextGenreLane = null,
  nextMood = null,
  nextReactionSet = null,
  nextSameArtist = null,
  nextRotation = null
) {
  if (!guard) return false;
  const gRs = cleanFlavorPart(guard.reactionSet);
  const nRs = cleanFlavorPart(nextReactionSet);
  if (gRs !== nRs) return true;
  const gSa = cleanFlavorPart(guard.sameArtist);
  const nSa = cleanFlavorPart(nextSameArtist);
  if (gSa !== nSa) return true;
  const gRot = cleanFlavorPart(guard.rotation);
  const nRot = cleanFlavorPart(nextRotation);
  // Rotation is a one-shot event on the batch that just rotated. A later
  // same-lane top-up with no rotation flag is still that set — do not treat
  // "had a rotate → no rotate" as a new flavor. A *new* rotate always is.
  if (nRot && gRot !== nRot) return true;
  const gLane = cleanFlavorPart(guard.genreLane);
  const gMood = cleanFlavorPart(guard.mood);
  const nLane = cleanFlavorPart(nextGenreLane);
  const nMood = cleanFlavorPart(nextMood);
  if (
    !gLane &&
    !gMood &&
    !nLane &&
    !nMood &&
    !gRs &&
    !nRs &&
    !gSa &&
    !nSa &&
    !gRot &&
    !nRot
  ) {
    return false;
  }
  return gLane !== nLane || gMood !== nMood;
}

/**
 * Pure: whether a prior refill announce should block a new intro.
 * `anyHighlightQueued` is resolved by the caller (live Sonos lookup).
 */
export function shouldSuppressRefillAnnounce({
  guard = null,
  anyHighlightQueued = false,
  now = Date.now(),
  nextGenreLane = null,
  nextMood = null,
  nextReactionSet = null,
  nextSameArtist = null,
  nextRotation = null,
} = {}) {
  if (!guard) return false;
  if (
    refillSetFlavorChanged(
      guard,
      nextGenreLane,
      nextMood,
      nextReactionSet,
      nextSameArtist,
      nextRotation
    )
  )
    return false;
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
  const genreLane = cleanFlavorPart(summary?.genreLane) || null;
  const mood = cleanFlavorPart(summary?.mood) || null;
  const reactionSet =
    cleanFlavorPart(summary?.reactionSet?.kind || summary?.reactionSet) || null;
  const sameArtist =
    cleanFlavorPart(
      summary?.sameArtistBatch?.artist ||
        summary?.sameArtistBatch?.key ||
        summary?.sameArtist
    ) || null;
  const rotation = [
    cleanFlavorPart(summary?.rotation?.decade),
    cleanFlavorPart(summary?.rotation?.mood),
  ]
    .filter(Boolean)
    .join("+") || null;
  return {
    highlights,
    setSize,
    createdAt: Number(createdAt) || Date.now(),
    genreLane,
    mood,
    reactionSet,
    sameArtist,
    rotation,
  };
}

// After a successful Never-Ending refill intro, suppress the next intro until
// that announced batch is no longer current/upcoming — unless the next batch
// is a new set flavor (lane/mood). Silent same-set top-ups still run.
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
 * guard TTL has not elapsed for a highlight-less guard), and the next batch
 * is the same set flavor. Cleared when expired, when no guarded highlights
 * remain, or when the next batch is a new lane/mood.
 *
 * @param {{
 *   findUpcoming?: (track: { name?: string, artist?: string }) => Promise<number|null>,
 *   now?: number,
   *   nextSummary?: { genreLane?: string|null, mood?: string|null, reactionSet?: { kind?: string }|string|null, sameArtistBatch?: { artist?: string, key?: string }|null }|null,
 *   nextGenreLane?: string|null,
 *   nextMood?: string|null,
 * }} [opts]
 */
export async function isRefillAnnounceSuppressed({
  findUpcoming = null,
  now = Date.now(),
  nextSummary = null,
  nextGenreLane = null,
  nextMood = null,
} = {}) {
  const guard = refillAnnounceGuard;
  if (!guard) return false;

  const lane =
    nextGenreLane != null
      ? nextGenreLane
      : nextSummary?.genreLane != null
        ? nextSummary.genreLane
        : null;
  const mood =
    nextMood != null
      ? nextMood
      : nextSummary?.mood != null
        ? nextSummary.mood
        : null;
  const reactionSet =
    nextSummary?.reactionSet?.kind != null
      ? nextSummary.reactionSet.kind
      : nextSummary?.reactionSet != null
        ? nextSummary.reactionSet
        : null;
  const sameArtist =
    nextSummary?.sameArtistBatch?.artist ||
    nextSummary?.sameArtistBatch?.key ||
    nextSummary?.sameArtist ||
    null;
  const rotation = [
    nextSummary?.rotation?.decade,
    nextSummary?.rotation?.mood,
  ]
    .filter(Boolean)
    .join("+") || null;

  // New set flavor — allow without Sonos highlight lookups.
  if (
    refillSetFlavorChanged(guard, lane, mood, reactionSet, sameArtist, rotation)
  ) {
    refillAnnounceGuard = null;
    return false;
  }

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
    nextGenreLane: lane,
    nextMood: mood,
  });
  if (!suppress) {
    refillAnnounceGuard = null;
  }
  return suppress;
}
