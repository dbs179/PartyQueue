const DEFAULT_INTERVAL_MS = 1500;
const DEFAULT_ERROR_INTERVAL_MS = 3000;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

export function nowPlayingSignature(snapshot = null) {
  if (!snapshot || typeof snapshot !== "object") return "";
  const {
    positionSec: _positionSec,
    positionObservedAt: _positionObservedAt,
    streamSession: _streamSession,
    streamSequence: _streamSequence,
    streamSentAt: _streamSentAt,
    ...meaningful
  } = snapshot;
  return JSON.stringify(stableValue(meaningful));
}

export function createNowPlayingMonitor({
  readSnapshot,
  intervalMs = DEFAULT_INTERVAL_MS,
  errorIntervalMs = DEFAULT_ERROR_INTERVAL_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  autoSchedule = true,
  failureThreshold = 2,
  onStatusChange = null,
  logger = console,
} = {}) {
  if (typeof readSnapshot !== "function") {
    throw new Error("Now Playing monitor requires readSnapshot.");
  }

  const subscribers = new Set();
  let timer = null;
  let activeTick = null;
  let latest = null;
  let latestSignature = "";
  let streamSequence = 0;
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
      logger.warn?.("[now-playing-stream] subscriber failed:", err.message);
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
        logger.warn?.("[now-playing-stream] status listener failed:", err.message);
      }
    }
  }

  function publish(snapshot, { force = false } = {}) {
    const signature = nowPlayingSignature(snapshot);
    if (!force && signature === latestSignature) {
      // Position-only reads do not fan out to every connected browser, but keep
      // the retained snapshot fresh so a reconnect gets an accurate clock.
      latest = {
        ...latest,
        ...snapshot,
        streamSession,
        streamSequence,
        streamSentAt: now(),
      };
      return false;
    }
    latestSignature = signature;
    latest = {
      ...snapshot,
      streamSession,
      streamSequence: ++streamSequence,
      streamSentAt: now(),
    };
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
        logger.warn?.("[now-playing-stream] poll failed:", err.message);
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
    if (stopped) throw new Error("Now Playing monitor is stopped.");
    if (typeof listener !== "function") {
      throw new Error("Now Playing subscriber must be a function.");
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
