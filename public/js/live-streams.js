/** Demand-driven Now Playing / queue / party SSE openers + HTTP fallbacks. */

import {
  createStreamCursor,
  resetStreamCursor,
  advanceStreamCursor,
} from "./stream-cursor.js";

export const NOW_PLAYING_FALLBACK_MS = 15000;
/** HTTP fallback only (SSE down): slower while paused/idle. */
export const NOW_PLAYING_FALLBACK_PAUSED_MS = 45000;
export const NOW_PLAYING_FALLBACK_DELAY_MS = 5000;
export const QUEUE_FALLBACK_MS = 15000;
export const QUEUE_FALLBACK_DELAY_MS = 5000;
export const PARTY_FALLBACK_MS = 20000;
export const PARTY_FALLBACK_DELAY_MS = 5000;
/** Ignore stacked pageshow/focus/visibility resume events from one unlock. */
export const FOREGROUND_RESUME_DEBOUNCE_MS = 1200;
/** Skip a focus-only resume when SSE still delivered an event this recently. */
export const FOCUS_RESUME_FRESH_MS = 8000;
/** Visible-only safety net for a zombie EventSource that never errors. */
export const STALE_LIVE_MS = 45000;
export const STALE_LIVE_CHECK_MS = 30000;

/** Shown on Up Next / Party Display when the queue stream is stale. */
export const QUEUE_STALE_MESSAGE =
  "Queue reconnecting — showing the last known list.";
/** Shown on Now Playing / Party Display when the NP stream is stale. */
export const NOW_PLAYING_STALE_MESSAGE =
  "Sonos reconnecting — showing the last update.";

/** @param {object|null|undefined} snapshot */
export function nowPlayingLooksActive(snapshot) {
  const state = String(snapshot?.state || "");
  return (
    snapshot?.isPlaying === true ||
    state === "PLAYING" ||
    state === "TRANSITIONING"
  );
}

/**
 * @param {string} visibilityState
 * @param {string} currentView
 */
export function shouldPollView(visibilityState, currentView) {
  return (
    visibilityState === "visible" &&
    (currentView === "main" ||
      currentView === "display" ||
      currentView === "mix")
  );
}

/**
 * Mobile Safari often freezes EventSource without a `hidden` visibility
 * change. Resume from pageshow / focus / online, but debounce the burst
 * and skip a desktop focus hop while streams are still fresh.
 */
export function bindForegroundResume({
  onResume,
  onSleep,
  shouldResumeOnFocus,
  target = typeof document !== "undefined" ? document : null,
  win = typeof window !== "undefined" ? window : null,
  now = () => Date.now(),
  debounceMs = FOREGROUND_RESUME_DEBOUNCE_MS,
} = {}) {
  let lastResumeAt = 0;

  function resume() {
    const t = now();
    if (lastResumeAt && t - lastResumeAt < debounceMs) return false;
    lastResumeAt = t;
    onResume?.();
    return true;
  }

  function sleep() {
    onSleep?.();
  }

  function onVisibility() {
    if (target?.visibilityState === "hidden") sleep();
    else resume();
  }

  function onFocus() {
    if (shouldResumeOnFocus && !shouldResumeOnFocus()) return;
    resume();
  }

  target?.addEventListener("visibilitychange", onVisibility);
  win?.addEventListener("pageshow", resume);
  win?.addEventListener("pagehide", sleep);
  win?.addEventListener("focus", onFocus);
  win?.addEventListener("online", resume);

  return () => {
    target?.removeEventListener("visibilitychange", onVisibility);
    win?.removeEventListener("pageshow", resume);
    win?.removeEventListener("pagehide", sleep);
    win?.removeEventListener("focus", onFocus);
    win?.removeEventListener("online", resume);
  };
}

/**
 * @param {{
 *   npCard?: HTMLElement|null,
 *   npConnectionStatus?: HTMLElement|null,
 *   displayConnectionStatus?: HTMLElement|null,
 *   queueSection?: HTMLElement|null,
 *   queueConnectionStatus?: HTMLElement|null,
 *   displayQueueSection?: HTMLElement|null,
 *   displayQueueStatus?: HTMLElement|null,
 * }} els
 * @param {{
 *   fetch?: typeof fetch,
 *   EventSource?: typeof EventSource,
 *   getVisibilityState?: () => string,
 *   getCurrentView: () => string,
 *   renderNowPlaying: (snapshot: object) => void,
 *   applyQueueTracks: (tracks: object[]) => void,
 *   applyPartySettings: (payload: object) => void,
 *   freezePlayhead: () => void,
 *   isQueueEditMode: () => boolean,
 *   setPendingStreamTracks: (tracks: object[]) => void,
 *   clearPendingStreamTracks: () => void,
 *   loadGroups: (force?: boolean) => void|Promise<void>,
 * }} deps
 */
export function createLiveStreams(els, deps) {
  const {
    npCard,
    npConnectionStatus,
    displayConnectionStatus,
    queueSection,
    queueConnectionStatus,
    displayQueueSection,
    displayQueueStatus,
  } = els || {};

  const fetchFn = deps.fetch || fetch;
  const EventSourceCtor =
    deps.EventSource ||
    (typeof EventSource !== "undefined" ? EventSource : null);
  const getVisibilityState =
    deps.getVisibilityState || (() => document.visibilityState);
  const liveFetch = (url) => fetchFn(url, { cache: "no-store" });
  const streamUrl = (path) => `${path}?resume=${Date.now()}`;
  const getCurrentView = deps.getCurrentView;
  const renderNowPlaying = deps.renderNowPlaying;
  const applyQueueTracks = deps.applyQueueTracks;
  const applyPartySettings = deps.applyPartySettings;
  const freezePlayhead = deps.freezePlayhead;
  const isQueueEditMode = deps.isQueueEditMode;
  const setPendingStreamTracks = deps.setPendingStreamTracks;
  const clearPendingStreamTracks = deps.clearPendingStreamTracks;
  const loadGroups = deps.loadGroups;

  let nowPlayingSource = null;
  let nowPlayingStreamConnected = false;
  let nowPlayingFallbackTimer = null;
  let nowPlayingFallbackDelayTimer = null;
  let nowPlayingFallbackGen = 0;
  let nowPlayingStreamCursor = createStreamCursor();
  let nowPlayingStreamVersion = 0;
  let nowPlayingHttpRequest = 0;
  /** Last known transport activity — drives HTTP fallback cadence. */
  let nowPlayingActive = true;

  let queueSource = null;
  let queueStreamConnected = false;
  let queueFallbackTimer = null;
  let queueFallbackDelayTimer = null;
  let queueStreamCursor = createStreamCursor();
  let queueStreamVersion = 0;
  let queueHttpRequest = 0;

  let partySource = null;
  let partyStreamConnected = false;
  let partyFallbackTimer = null;
  let partyFallbackDelayTimer = null;
  let partyStreamCursor = createStreamCursor();
  let partyStreamVersion = 0;
  let partyHttpRequest = 0;
  let lastLiveEventAt = 0;
  let staleWatchTimer = null;

  function noteLiveEvent() {
    lastLiveEventAt = Date.now();
  }

  function stopStaleWatch() {
    if (!staleWatchTimer) return;
    clearInterval(staleWatchTimer);
    staleWatchTimer = null;
  }

  function armStaleWatch() {
    if (staleWatchTimer || !shouldPoll()) return;
    staleWatchTimer = setInterval(() => {
      if (!shouldPoll()) {
        stopStaleWatch();
        return;
      }
      if (lastLiveEventAt && Date.now() - lastLiveEventAt > STALE_LIVE_MS) {
        syncPolling({ forceReconnect: true });
      }
    }, STALE_LIVE_CHECK_MS);
    staleWatchTimer.unref?.();
  }

  function shouldPoll() {
    return shouldPollView(getVisibilityState(), getCurrentView());
  }

  function stopNowPlayingFallback() {
    nowPlayingFallbackGen += 1;
    if (nowPlayingFallbackDelayTimer) {
      clearTimeout(nowPlayingFallbackDelayTimer);
      nowPlayingFallbackDelayTimer = null;
    }
    if (nowPlayingFallbackTimer) {
      clearTimeout(nowPlayingFallbackTimer);
      nowPlayingFallbackTimer = null;
    }
  }

  function nowPlayingFallbackIntervalMs() {
    return nowPlayingActive
      ? NOW_PLAYING_FALLBACK_MS
      : NOW_PLAYING_FALLBACK_PAUSED_MS;
  }

  function armNowPlayingFallbackTick(gen) {
    if (
      gen !== nowPlayingFallbackGen ||
      !shouldPoll() ||
      nowPlayingStreamConnected ||
      nowPlayingFallbackTimer
    ) {
      return;
    }
    nowPlayingFallbackTimer = setTimeout(() => {
      nowPlayingFallbackTimer = null;
      if (
        gen !== nowPlayingFallbackGen ||
        !shouldPoll() ||
        nowPlayingStreamConnected
      ) {
        return;
      }
      void loadNowPlaying().finally(() => {
        if (gen !== nowPlayingFallbackGen) return;
        armNowPlayingFallbackTick(gen);
      });
    }, nowPlayingFallbackIntervalMs());
  }

  function startNowPlayingFallback() {
    if (
      !shouldPoll() ||
      nowPlayingStreamConnected ||
      nowPlayingFallbackDelayTimer ||
      nowPlayingFallbackTimer
    ) {
      return;
    }
    const gen = nowPlayingFallbackGen;
    nowPlayingFallbackDelayTimer = setTimeout(() => {
      nowPlayingFallbackDelayTimer = null;
      if (
        gen !== nowPlayingFallbackGen ||
        !shouldPoll() ||
        nowPlayingStreamConnected
      ) {
        return;
      }
      void loadNowPlaying().finally(() => {
        if (gen !== nowPlayingFallbackGen) return;
        armNowPlayingFallbackTick(gen);
      });
    }, NOW_PLAYING_FALLBACK_DELAY_MS);
  }

  function noteNowPlayingActivity(snapshot) {
    nowPlayingActive = nowPlayingLooksActive(snapshot);
  }

  function applyNowPlayingStreamSnapshot(snapshot) {
    const next = advanceStreamCursor(nowPlayingStreamCursor, snapshot);
    if (!next.accept) return;
    nowPlayingStreamCursor = next.cursor;
    nowPlayingStreamVersion += 1;
    noteLiveEvent();
    noteNowPlayingActivity(snapshot);
    renderNowPlaying(snapshot);
  }

  function setNowPlayingConnectionStatus(status, message = "") {
    const disconnected = status === "disconnected";
    if (disconnected) freezePlayhead();
    npCard?.classList.toggle("is-stale", disconnected);
    if (npConnectionStatus) {
      npConnectionStatus.hidden = !disconnected;
      if (disconnected) {
        npConnectionStatus.textContent =
          message || NOW_PLAYING_STALE_MESSAGE;
      }
    }
    if (displayConnectionStatus) {
      displayConnectionStatus.hidden = !disconnected;
      if (disconnected) {
        displayConnectionStatus.textContent =
          message || NOW_PLAYING_STALE_MESSAGE;
      }
    }
  }

  function setQueueConnectionStatus(status, message = "") {
    const disconnected = status === "disconnected";
    queueSection?.classList.toggle("is-stale", disconnected);
    displayQueueSection?.classList.toggle("is-stale", disconnected);
    if (queueConnectionStatus) {
      queueConnectionStatus.hidden = !disconnected;
      if (disconnected) {
        queueConnectionStatus.textContent = message || QUEUE_STALE_MESSAGE;
      }
    }
    if (displayQueueStatus) {
      displayQueueStatus.hidden = !disconnected;
      if (disconnected) {
        displayQueueStatus.textContent = message || QUEUE_STALE_MESSAGE;
      }
    }
  }

  async function loadNowPlaying() {
    const requestId = ++nowPlayingHttpRequest;
    const streamVersionAtStart = nowPlayingStreamVersion;
    try {
      const res = await liveFetch("/api/nowplaying");
      if (!res.ok) return;
      const snapshot = await res.json();
      if (
        requestId !== nowPlayingHttpRequest ||
        nowPlayingStreamVersion !== streamVersionAtStart
      ) {
        return;
      }
      // SSE owns the paint while connected — a late HTTP response must not
      // overwrite a fresher stream snapshot after reconnect races.
      if (nowPlayingStreamConnected) return;
      const next = advanceStreamCursor(nowPlayingStreamCursor, snapshot);
      if (!next.accept) return;
      nowPlayingStreamCursor = next.cursor;
      nowPlayingStreamVersion += 1;
      noteLiveEvent();
      noteNowPlayingActivity(snapshot);
      renderNowPlaying(snapshot);
    } catch {
      /* retain the last good stream or fallback snapshot */
    }
  }

  function openNowPlayingStream() {
    if (nowPlayingSource || !shouldPoll()) return;
    void loadNowPlaying();
    if (typeof EventSourceCtor !== "function") {
      startNowPlayingFallback();
      return;
    }
    nowPlayingStreamCursor = resetStreamCursor();
    const source = new EventSourceCtor(streamUrl("/api/nowplaying/stream"));
    nowPlayingSource = source;
    source.onopen = () => {
      if (nowPlayingSource !== source) return;
      nowPlayingStreamConnected = true;
      stopNowPlayingFallback();
      setNowPlayingConnectionStatus("connected");
    };
    source.addEventListener("sonos-status", (event) => {
      if (nowPlayingSource !== source) return;
      try {
        const health = JSON.parse(event.data);
        setNowPlayingConnectionStatus(health?.status);
      } catch {
        /* ignore malformed status events */
      }
    });
    source.onmessage = (event) => {
      if (nowPlayingSource !== source) return;
      try {
        applyNowPlayingStreamSnapshot(JSON.parse(event.data));
      } catch {
        /* ignore malformed stream events and await the next snapshot */
      }
    };
    source.onerror = () => {
      if (nowPlayingSource !== source) return;
      nowPlayingStreamConnected = false;
      startNowPlayingFallback();
      setNowPlayingConnectionStatus("disconnected");
    };
  }

  function closeNowPlayingStream() {
    nowPlayingStreamConnected = false;
    stopNowPlayingFallback();
    if (nowPlayingSource) {
      nowPlayingSource.close();
      nowPlayingSource = null;
    }
  }

  function stopQueueFallback() {
    if (queueFallbackDelayTimer) {
      clearTimeout(queueFallbackDelayTimer);
      queueFallbackDelayTimer = null;
    }
    if (queueFallbackTimer) {
      clearInterval(queueFallbackTimer);
      queueFallbackTimer = null;
    }
  }

  function startQueueFallback() {
    if (
      !shouldPoll() ||
      queueStreamConnected ||
      queueFallbackDelayTimer ||
      queueFallbackTimer
    ) {
      return;
    }
    queueFallbackDelayTimer = setTimeout(() => {
      queueFallbackDelayTimer = null;
      if (!shouldPoll() || queueStreamConnected) return;
      void loadQueue();
      queueFallbackTimer = setInterval(loadQueue, QUEUE_FALLBACK_MS);
    }, QUEUE_FALLBACK_DELAY_MS);
  }

  function applyQueueStreamSnapshot(snapshot) {
    const next = advanceStreamCursor(queueStreamCursor, snapshot);
    if (!next.accept) return;
    queueStreamCursor = next.cursor;
    queueStreamVersion += 1;
    noteLiveEvent();
    const tracks = Array.isArray(snapshot?.tracks) ? snapshot.tracks : [];
    if (isQueueEditMode()) {
      setPendingStreamTracks(tracks);
      return;
    }
    clearPendingStreamTracks();
    applyQueueTracks(tracks);
  }

  async function loadQueue(force = false) {
    if (isQueueEditMode() && !force) return;
    const requestId = ++queueHttpRequest;
    const streamVersionAtStart = queueStreamVersion;
    try {
      const res = await liveFetch("/api/queue/list");
      if (!res.ok) return;
      const data = await res.json();
      if (
        requestId !== queueHttpRequest ||
        queueStreamVersion !== streamVersionAtStart
      ) {
        return;
      }
      if (queueStreamConnected) return;
      const next = advanceStreamCursor(queueStreamCursor, data);
      if (!next.accept) return;
      queueStreamCursor = next.cursor;
      queueStreamVersion += 1;
      noteLiveEvent();
      const tracks = Array.isArray(data.tracks) ? data.tracks : [];
      applyQueueTracks(tracks);
    } catch {
      /* leave previous queue on transient errors */
    }
  }

  function openQueueStream() {
    if (queueSource || !shouldPoll()) return;
    void loadQueue();
    if (typeof EventSourceCtor !== "function") {
      startQueueFallback();
      return;
    }
    queueStreamCursor = resetStreamCursor();
    const source = new EventSourceCtor(streamUrl("/api/queue/stream"));
    queueSource = source;
    source.onopen = () => {
      if (queueSource !== source) return;
      queueStreamConnected = true;
      stopQueueFallback();
      setQueueConnectionStatus("connected");
    };
    source.addEventListener("queue-status", (event) => {
      if (queueSource !== source) return;
      try {
        const health = JSON.parse(event.data);
        if (health?.status === "disconnected") {
          queueStreamConnected = false;
          startQueueFallback();
          setQueueConnectionStatus("disconnected");
        } else if (health?.status === "connected") {
          queueStreamConnected = true;
          stopQueueFallback();
          setQueueConnectionStatus("connected");
        } else if (health?.status === "connecting") {
          // Keep last paint; don't clear a reconnect banner mid-blip.
        }
      } catch {
        /* ignore malformed status events */
      }
    });
    source.onmessage = (event) => {
      if (queueSource !== source) return;
      try {
        applyQueueStreamSnapshot(JSON.parse(event.data));
      } catch {
        /* ignore malformed stream events and await the next snapshot */
      }
    };
    source.onerror = () => {
      if (queueSource !== source) return;
      queueStreamConnected = false;
      startQueueFallback();
      setQueueConnectionStatus("disconnected");
    };
  }

  function closeQueueStream() {
    queueStreamConnected = false;
    stopQueueFallback();
    if (queueSource) {
      queueSource.close();
      queueSource = null;
    }
    // Leave any stale banner until the next connected status / open — closing
    // the stream (hidden tab) must not pretend the last queue is fresh.
  }

  function stopPartyFallback() {
    if (partyFallbackDelayTimer) {
      clearTimeout(partyFallbackDelayTimer);
      partyFallbackDelayTimer = null;
    }
    if (partyFallbackTimer) {
      clearInterval(partyFallbackTimer);
      partyFallbackTimer = null;
    }
  }

  function startPartyFallback() {
    if (
      !shouldPoll() ||
      partyStreamConnected ||
      partyFallbackDelayTimer ||
      partyFallbackTimer
    ) {
      return;
    }
    partyFallbackDelayTimer = setTimeout(() => {
      partyFallbackDelayTimer = null;
      if (!shouldPoll() || partyStreamConnected) return;
      void loadPartySettings();
      partyFallbackTimer = setInterval(loadPartySettings, PARTY_FALLBACK_MS);
    }, PARTY_FALLBACK_DELAY_MS);
  }

  function applyPartyStreamSnapshot(snapshot) {
    const next = advanceStreamCursor(partyStreamCursor, snapshot);
    if (!next.accept) return;
    partyStreamCursor = next.cursor;
    partyStreamVersion += 1;
    noteLiveEvent();
    applyPartySettings(snapshot);
  }

  async function loadPartySettings() {
    const requestId = ++partyHttpRequest;
    const streamVersionAtStart = partyStreamVersion;
    try {
      const res = await liveFetch("/api/party");
      if (!res.ok) return;
      const snapshot = await res.json();
      if (
        requestId !== partyHttpRequest ||
        partyStreamVersion !== streamVersionAtStart
      ) {
        return;
      }
      // SSE owns the toggles while connected — a late HTTP response must not
      // flip Discover / Random Mood after a reconnect race.
      if (partyStreamConnected) return;
      const next = advanceStreamCursor(partyStreamCursor, snapshot);
      if (!next.accept) return;
      partyStreamCursor = next.cursor;
      partyStreamVersion += 1;
      noteLiveEvent();
      applyPartySettings(snapshot);
    } catch {
      /* leave toggles as-is on transient errors */
    }
  }

  function openPartyStream() {
    if (partySource || !shouldPoll()) return;
    void loadPartySettings();
    if (typeof EventSourceCtor !== "function") {
      startPartyFallback();
      return;
    }
    partyStreamCursor = resetStreamCursor();
    const source = new EventSourceCtor(streamUrl("/api/party/stream"));
    partySource = source;
    source.onopen = () => {
      if (partySource !== source) return;
      partyStreamConnected = true;
      stopPartyFallback();
    };
    source.addEventListener("party-status", (event) => {
      if (partySource !== source) return;
      try {
        const health = JSON.parse(event.data);
        if (health?.status === "disconnected") {
          partyStreamConnected = false;
          startPartyFallback();
        } else if (health?.status === "connected") {
          partyStreamConnected = true;
          stopPartyFallback();
        }
      } catch {
        /* ignore malformed status events */
      }
    });
    source.onmessage = (event) => {
      if (partySource !== source) return;
      try {
        applyPartyStreamSnapshot(JSON.parse(event.data));
      } catch {
        /* ignore malformed stream events */
      }
    };
    source.onerror = () => {
      if (partySource !== source) return;
      partyStreamConnected = false;
      startPartyFallback();
    };
  }

  function closePartyStream() {
    partyStreamConnected = false;
    stopPartyFallback();
    if (partySource) {
      partySource.close();
      partySource = null;
    }
  }

  function closeAllStreams() {
    closeNowPlayingStream();
    closeQueueStream();
    closePartyStream();
    stopStaleWatch();
  }

  function syncPolling({ forceReconnect = false } = {}) {
    if (!shouldPoll()) {
      closeAllStreams();
      return;
    }
    if (forceReconnect) closeAllStreams();
    if (getCurrentView() !== "display") void loadGroups();
    openNowPlayingStream();
    openQueueStream();
    openPartyStream();
    if (!lastLiveEventAt) noteLiveEvent();
    armStaleWatch();
  }

  function bindResume(hooks = {}) {
    return bindForegroundResume({
      onResume: () => {
        syncPolling({ forceReconnect: true });
        hooks.onResume?.();
      },
      onSleep: () => closeAllStreams(),
      shouldResumeOnFocus: () =>
        !nowPlayingSource ||
        !lastLiveEventAt ||
        Date.now() - lastLiveEventAt >= FOCUS_RESUME_FRESH_MS,
    });
  }

  function refreshSonos() {
    if (!queueStreamConnected) void loadQueue();
    if (getCurrentView() !== "display") void loadGroups();
  }

  function isQueueStreamConnected() {
    return queueStreamConnected;
  }

  return {
    syncPolling,
    bindResume,
    loadQueue,
    loadNowPlaying,
    loadPartySettings,
    refreshSonos,
    isQueueStreamConnected,
    openNowPlayingStream,
    closeNowPlayingStream,
    openQueueStream,
    closeQueueStream,
    openPartyStream,
    closePartyStream,
  };
}
