/** Demand-driven Now Playing / queue / party SSE openers + HTTP fallbacks. */

import {
  createStreamCursor,
  resetStreamCursor,
  advanceStreamCursor,
} from "./stream-cursor.js";

export const NOW_PLAYING_FALLBACK_MS = 15000;
export const NOW_PLAYING_FALLBACK_DELAY_MS = 5000;
export const QUEUE_FALLBACK_MS = 15000;
export const QUEUE_FALLBACK_DELAY_MS = 5000;
export const PARTY_FALLBACK_MS = 20000;
export const PARTY_FALLBACK_DELAY_MS = 5000;

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
 * @param {{
 *   npCard?: HTMLElement|null,
 *   npConnectionStatus?: HTMLElement|null,
 *   displayConnectionStatus?: HTMLElement|null,
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
  const { npCard, npConnectionStatus, displayConnectionStatus } = els || {};

  const fetchFn = deps.fetch || fetch;
  const EventSourceCtor =
    deps.EventSource ||
    (typeof EventSource !== "undefined" ? EventSource : null);
  const getVisibilityState =
    deps.getVisibilityState || (() => document.visibilityState);
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
  let nowPlayingStreamCursor = createStreamCursor();
  let nowPlayingStreamVersion = 0;
  let nowPlayingHttpRequest = 0;

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

  function shouldPoll() {
    return shouldPollView(getVisibilityState(), getCurrentView());
  }

  function stopNowPlayingFallback() {
    if (nowPlayingFallbackDelayTimer) {
      clearTimeout(nowPlayingFallbackDelayTimer);
      nowPlayingFallbackDelayTimer = null;
    }
    if (nowPlayingFallbackTimer) {
      clearInterval(nowPlayingFallbackTimer);
      nowPlayingFallbackTimer = null;
    }
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
    nowPlayingFallbackDelayTimer = setTimeout(() => {
      nowPlayingFallbackDelayTimer = null;
      if (!shouldPoll() || nowPlayingStreamConnected) return;
      void loadNowPlaying();
      nowPlayingFallbackTimer = setInterval(
        loadNowPlaying,
        NOW_PLAYING_FALLBACK_MS
      );
    }, NOW_PLAYING_FALLBACK_DELAY_MS);
  }

  function applyNowPlayingStreamSnapshot(snapshot) {
    const next = advanceStreamCursor(nowPlayingStreamCursor, snapshot);
    if (!next.accept) return;
    nowPlayingStreamCursor = next.cursor;
    nowPlayingStreamVersion += 1;
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
          message || "Sonos reconnecting — showing the last update.";
      }
    }
    if (displayConnectionStatus) {
      displayConnectionStatus.hidden = !disconnected;
      if (disconnected) {
        displayConnectionStatus.textContent =
          message || "Sonos reconnecting — showing the last update.";
      }
    }
  }

  async function loadNowPlaying() {
    const requestId = ++nowPlayingHttpRequest;
    const streamVersionAtStart = nowPlayingStreamVersion;
    try {
      const res = await fetchFn("/api/nowplaying");
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
    const source = new EventSourceCtor("/api/nowplaying/stream");
    nowPlayingSource = source;
    source.onopen = () => {
      if (nowPlayingSource !== source) return;
      nowPlayingStreamConnected = true;
      stopNowPlayingFallback();
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
      const res = await fetchFn("/api/queue/list");
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
      const tracks = Array.isArray(data.tracks) ? data.tracks : [];
      applyQueueTracks(tracks);
    } catch {
      /* leave previous queue on transient errors */
    }
  }

  function openQueueStream() {
    if (queueSource || !shouldPoll()) return;
    if (typeof EventSourceCtor !== "function") {
      void loadQueue();
      startQueueFallback();
      return;
    }
    queueStreamCursor = resetStreamCursor();
    const source = new EventSourceCtor("/api/queue/stream");
    queueSource = source;
    source.onopen = () => {
      if (queueSource !== source) return;
      queueStreamConnected = true;
      stopQueueFallback();
    };
    source.addEventListener("queue-status", (event) => {
      if (queueSource !== source) return;
      try {
        const health = JSON.parse(event.data);
        if (health?.status === "disconnected") {
          queueStreamConnected = false;
          startQueueFallback();
        } else if (health?.status === "connected") {
          queueStreamConnected = true;
          stopQueueFallback();
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
    };
  }

  function closeQueueStream() {
    queueStreamConnected = false;
    stopQueueFallback();
    if (queueSource) {
      queueSource.close();
      queueSource = null;
    }
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
    applyPartySettings(snapshot);
  }

  async function loadPartySettings() {
    try {
      const res = await fetchFn("/api/party");
      if (!res.ok) return;
      applyPartySettings(await res.json());
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
    const source = new EventSourceCtor("/api/party/stream");
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

  function syncPolling() {
    if (shouldPoll()) {
      void loadQueue();
      if (getCurrentView() !== "display") void loadGroups();
      openNowPlayingStream();
      openQueueStream();
      openPartyStream();
    } else {
      closeNowPlayingStream();
      closeQueueStream();
      closePartyStream();
    }
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
