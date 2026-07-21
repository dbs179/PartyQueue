/** Track Sonos queue-index / metadata lag without blanking the UI early. */

export const TRANSITION_TIMEOUT_MS = 2500;
export const TRANSITION_CONFIRM_MS = 1200;

export function sameTrackMetadata(a, b) {
  return (
    String(a?.uri || "") === String(b?.uri || "") &&
    String(a?.title || "") === String(b?.title || "") &&
    String(a?.artist || "") === String(b?.artist || "") &&
    String(a?.album || "") === String(b?.album || "") &&
    String(a?.albumArt || "") === String(b?.albumArt || "")
  );
}

export function trackMediaFields(snapshot) {
  return {
    queueTrack: Number(snapshot?.queueTrack) || 0,
    uri: snapshot?.uri ?? null,
    title: snapshot?.title ?? null,
    artist: snapshot?.artist ?? null,
    album: snapshot?.album ?? null,
    albumArt: snapshot?.albumArt ?? null,
  };
}

/**
 * Pure-ish transition tracker.
 * - `nudge(from)` records an expected skip/previous without marking pending.
 * - `resolve(previous, snapshot)` sets metadataPending only when the queue index
 *   advanced while media fields are still the previous track (true Sonos lag).
 * - Pending / expected transitions hard-clear after timeoutMs.
 */
export function createNowPlayingTransitionTracker({
  now = Date.now,
  timeoutMs = TRANSITION_TIMEOUT_MS,
} = {}) {
  let expectedFrom = null;
  let pendingStale = null;
  let lastClearReason = null;

  function clearAll(reason) {
    expectedFrom = null;
    pendingStale = null;
    lastClearReason = reason;
  }

  function pendingAgeMs(at = now()) {
    const startedAt = pendingStale?.startedAt ?? expectedFrom?.startedAt;
    if (!startedAt) return 0;
    return Math.max(0, at - startedAt);
  }

  function nudge(previousSnapshot = null) {
    const at = now();
    lastClearReason = null;
    if (previousSnapshot) {
      expectedFrom = { ...trackMediaFields(previousSnapshot), startedAt: at };
    } else {
      expectedFrom = {
        queueTrack: 0,
        uri: null,
        title: null,
        artist: null,
        album: null,
        albumArt: null,
        startedAt: at,
      };
    }
    // Never mark pending until Sonos actually advances the index with stale meta.
    pendingStale = null;
  }

  function resolve(previousPublished, snapshot) {
    const at = now();
    if (!snapshot) {
      return { metadataPending: false };
    }

    if (pendingAgeMs(at) > timeoutMs) {
      clearAll("timeout");
      return { ...snapshot, metadataPending: false };
    }

    const prev = previousPublished || null;
    const queueChanged =
      Number(prev?.queueTrack) > 0 &&
      Number(snapshot?.queueTrack) > 0 &&
      Number(prev.queueTrack) !== Number(snapshot.queueTrack);

    if (queueChanged && sameTrackMetadata(prev, snapshot)) {
      pendingStale = {
        ...trackMediaFields(snapshot),
        startedAt: expectedFrom?.startedAt || at,
      };
    } else if (
      expectedFrom &&
      Number(expectedFrom.queueTrack) > 0 &&
      Number(snapshot.queueTrack) > 0 &&
      Number(snapshot.queueTrack) !== Number(expectedFrom.queueTrack) &&
      sameTrackMetadata(expectedFrom, snapshot)
    ) {
      // Host skip: index moved, but DIDL still describes the pre-skip track.
      pendingStale = {
        ...trackMediaFields(snapshot),
        startedAt: expectedFrom.startedAt,
      };
    }

    const metadataPending =
      !!pendingStale &&
      Number(pendingStale.queueTrack) === Number(snapshot.queueTrack) &&
      sameTrackMetadata(pendingStale, snapshot);

    if (pendingStale && !metadataPending) {
      clearAll("metadata-changed");
      return { ...snapshot, metadataPending: false };
    }

    if (expectedFrom && !metadataPending) {
      const stillOnFrom =
        Number(snapshot.queueTrack) === Number(expectedFrom.queueTrack) &&
        sameTrackMetadata(expectedFrom, snapshot);
      if (!stillOnFrom) {
        // Advanced with new metadata, or otherwise left the pre-skip identity.
        expectedFrom = null;
        lastClearReason = lastClearReason || "converged";
      }
    }

    return { ...snapshot, metadataPending };
  }

  function diagnostics() {
    return {
      expectedFrom: expectedFrom
        ? {
            queueTrack: expectedFrom.queueTrack,
            uri: expectedFrom.uri,
            startedAt: expectedFrom.startedAt,
          }
        : null,
      pendingStale: pendingStale
        ? {
            queueTrack: pendingStale.queueTrack,
            uri: pendingStale.uri,
            startedAt: pendingStale.startedAt,
          }
        : null,
      pendingAgeMs: pendingAgeMs(),
      lastClearReason,
    };
  }

  function reset() {
    clearAll(null);
  }

  return { nudge, resolve, diagnostics, reset, pendingAgeMs };
}
