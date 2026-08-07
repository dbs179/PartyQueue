const DEFAULT_INTERVAL_MS = 1500;
const DEFAULT_ERROR_INTERVAL_MS = 3000;
const DEFAULT_CLOCK_SYNC_MS = 10_000;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

function reactionsSignature(reactions) {
  if (!reactions || typeof reactions !== "object") return "";
  return JSON.stringify(stableValue(reactions));
}

/**
 * Track / transport fingerprint only. Party-wide toggles live on /api/party
 * and must not force NP republish (or deep-clone) every settings poll.
 */
export function nowPlayingSignature(snapshot = null) {
  if (!snapshot || typeof snapshot !== "object") return "";
  return [
    snapshot.uri ?? "",
    snapshot.title ?? "",
    snapshot.artist ?? "",
    snapshot.album ?? "",
    snapshot.albumArt ?? "",
    snapshot.state ?? "",
    snapshot.isPlaying ? 1 : 0,
    snapshot.queuePlaying ? 1 : 0,
    snapshot.muted ? 1 : 0,
    snapshot.shuffle ? 1 : 0,
    snapshot.queueTrack ?? "",
    snapshot.room ?? "",
    snapshot.durationSec ?? "",
    snapshot.origin ?? "",
    snapshot.searched ? 1 : 0,
    snapshot.discovered ? 1 : 0,
    snapshot.moodPick ? 1 : 0,
    snapshot.mood ?? "",
    snapshot.genreLane ?? "",
    snapshot.requestedBy ?? "",
    snapshot.requestedByUser ?? "",
    snapshot.dedication ?? "",
    snapshot.djVoice ? 1 : 0,
    snapshot.djSilence ? 1 : 0,
    snapshot.mixGenreLane ?? "",
    snapshot.mixGenreLabel ?? "",
    snapshot.metadataPending ? 1 : 0,
    snapshot.updating ? 1 : 0,
    reactionsSignature(snapshot.reactions),
  ].join("\x1f");
}

export function nowPlayingClockDiscontinuous(previous, next) {
  if (!previous || !next) return false;
  const previousPosition = Number(previous.positionSec);
  const nextPosition = Number(next.positionSec);
  if (!Number.isFinite(previousPosition) || !Number.isFinite(nextPosition)) {
    return false;
  }

  const previousObservedAt = Number(previous.positionObservedAt);
  const nextObservedAt = Number(next.positionObservedAt);
  const hasObservationWindow =
    Number.isFinite(previousObservedAt) &&
    Number.isFinite(nextObservedAt) &&
    nextObservedAt >= previousObservedAt;
  const previousPlaybackKnown =
    typeof previous.isPlaying === "boolean" ||
    typeof previous.state === "string";
  const nextPlaybackKnown =
    typeof next.isPlaying === "boolean" || typeof next.state === "string";
  if (!previousPlaybackKnown || !nextPlaybackKnown) return false;
  const wasPlaying =
    previous.isPlaying === true || previous.state === "PLAYING";
  const isPlaying = next.isPlaying === true || next.state === "PLAYING";
  if (wasPlaying !== isPlaying) return false;
  // During playback, elapsed observation time is required to distinguish a
  // seek from ordinary forward progress. Legacy/test payloads may omit it.
  if (isPlaying && !hasObservationWindow) return false;

  const elapsedSec = hasObservationWindow
    ? (nextObservedAt - previousObservedAt) / 1000
    : 0;
  const expectedPosition = previousPosition + (isPlaying ? elapsedSec : 0);
  return Math.abs(nextPosition - expectedPosition) > (isPlaying ? 2.5 : 1.5);
}

export function createSnapshotMonitor({
  readSnapshot,
  signatureFor = nowPlayingSignature,
  monitorName = "Snapshot",
  intervalMs = DEFAULT_INTERVAL_MS,
  errorIntervalMs = DEFAULT_ERROR_INTERVAL_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  autoSchedule = true,
  failureThreshold = 2,
  maxSilenceMs = 0,
  forcePublishFor = null,
  onStatusChange = null,
  logger = console,
} = {}) {
  if (typeof readSnapshot !== "function") {
    throw new Error(`${monitorName} monitor requires readSnapshot.`);
  }
  if (typeof signatureFor !== "function") {
    throw new Error(`${monitorName} monitor requires signatureFor.`);
  }

  const subscribers = new Set();
  let timer = null;
  let activeTick = null;
  let latest = null;
  let latestSignature = "";
  let streamSequence = 0;
  let lastPublishedAt = null;
  const streamSession = `${now()}-${Math.random().toString(36).slice(2)}`;
  let stopped = false;
  let nudgePending = false;
  let consecutiveFailures = 0;
  let health = {
    status: "connecting",
    consecutiveFailures: 0,
    lastSuccessAt: 0,
    changedAt: now(),
  };

  function cancelTimer() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  }

  function schedule(delayMs) {
    if (!autoSchedule || stopped || !subscribers.size || timer || activeTick) {
      return;
    }
    timer = setTimer(() => {
      timer = null;
      void pollNow();
    }, Math.max(0, Number(delayMs) || 0));
    timer?.unref?.();
  }

  function notify(listener, snapshot) {
    try {
      listener(snapshot);
    } catch (err) {
      logger.warn?.(`[${monitorName}-stream] subscriber failed:`, err.message);
    }
  }

  function updateHealth(next) {
    const changed = health.status !== next.status;
    health = {
      ...health,
      ...next,
      changedAt: changed ? now() : health.changedAt,
    };
    if (changed && typeof onStatusChange === "function") {
      try {
        onStatusChange({ ...health });
      } catch (err) {
        logger.warn?.(
          `[${monitorName}-stream] status listener failed:`,
          err.message
        );
      }
    }
  }

  function publish(snapshot, { force = false } = {}) {
    const signature = signatureFor(snapshot);
    const sentAt = now();
    const observedAt = Number(snapshot?.positionObservedAt);
    const positionAgeSec =
      Number.isFinite(observedAt) && observedAt > 0 && observedAt <= sentAt
        ? (sentAt - observedAt) / 1000
        : undefined;
    const decorate = (sequence) => ({
      ...snapshot,
      ...(positionAgeSec == null ? {} : { positionAgeSec }),
      streamSession,
      streamSequence: sequence,
      streamSentAt: sentAt,
    });
    const clockSyncDue =
      maxSilenceMs > 0 &&
      lastPublishedAt != null &&
      sentAt - lastPublishedAt >= maxSilenceMs;
    let discontinuity = false;
    if (typeof forcePublishFor === "function" && latest) {
      try {
        discontinuity = !!forcePublishFor(latest, snapshot);
      } catch (err) {
        logger.warn?.(
          `[${monitorName}-stream] publish check failed:`,
          err.message
        );
      }
    }
    if (
      !force &&
      !clockSyncDue &&
      !discontinuity &&
      signature === latestSignature
    ) {
      // Position-only reads do not fan out to every connected browser, but keep
      // the retained snapshot fresh so a reconnect gets an accurate clock.
      latest = decorate(streamSequence);
      return false;
    }
    latestSignature = signature;
    latest = decorate(++streamSequence);
    lastPublishedAt = sentAt;
    for (const listener of [...subscribers]) {
      notify(listener, latest);
    }
    return true;
  }

  async function pollNow() {
    if (stopped || !subscribers.size) return null;
    if (activeTick) {
      nudgePending = true;
      return activeTick;
    }
    cancelTimer();
    let nextDelay = intervalMs;
    const tickPromise = Promise.resolve()
      .then(readSnapshot)
      .then((snapshot) => {
        const recovered = health.status === "disconnected";
        consecutiveFailures = 0;
        updateHealth({
          status: "connected",
          consecutiveFailures: 0,
          lastSuccessAt: now(),
        });
        if (!stopped && subscribers.size) publish(snapshot, { force: recovered });
        return snapshot;
      })
      .catch((err) => {
        nextDelay = errorIntervalMs;
        consecutiveFailures += 1;
        if (consecutiveFailures >= Math.max(1, failureThreshold)) {
          updateHealth({
            status: "disconnected",
            consecutiveFailures,
            lastFailureAt: now(),
            retryMs: errorIntervalMs,
          });
        }
        logger.warn?.("poll failed", { err: err.message });
        return null;
      })
      .finally(() => {
        if (activeTick === tickPromise) activeTick = null;
        if (!stopped && subscribers.size) {
          if (nudgePending) {
            nudgePending = false;
            schedule(0);
          } else {
            schedule(nextDelay);
          }
        }
      });
    activeTick = tickPromise;
    return tickPromise;
  }

  function subscribe(listener) {
    if (stopped) throw new Error(`${monitorName} monitor is stopped.`);
    if (typeof listener !== "function") {
      throw new Error(`${monitorName} subscriber must be a function.`);
    }
    subscribers.add(listener);
    if (latest) notify(listener, latest);
    else schedule(0);

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      subscribers.delete(listener);
      if (!subscribers.size) {
        cancelTimer();
        latest = null;
        latestSignature = "";
        lastPublishedAt = null;
        nudgePending = false;
      }
    };
  }

  function nudge() {
    if (stopped || !subscribers.size) return;
    if (activeTick) {
      nudgePending = true;
      return;
    }
    cancelTimer();
    if (autoSchedule) schedule(0);
    else void pollNow();
  }

  async function stop() {
    stopped = true;
    cancelTimer();
    subscribers.clear();
    latest = null;
    latestSignature = "";
    lastPublishedAt = null;
    nudgePending = false;
    await activeTick;
  }

  return {
    subscribe,
    nudge,
    pollNow,
    stop,
    get subscriberCount() {
      return subscribers.size;
    },
    get latest() {
      return latest;
    },
    get health() {
      return { ...health };
    },
  };
}

export function createNowPlayingMonitor(options = {}) {
  return createSnapshotMonitor({
    monitorName: "now-playing",
    maxSilenceMs: DEFAULT_CLOCK_SYNC_MS,
    forcePublishFor: nowPlayingClockDiscontinuous,
    ...options,
  });
}
