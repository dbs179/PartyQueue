/** Full-screen NP overlay lyrics + Party Display karaoke window + playhead clock. */

import {
  parseSyncedLyrics,
  serverPlaybackPosition,
  playbackIdentity,
} from "./now-playing-utils.js";
import { escapeHtml, formatTrackTime } from "./format.js";
import { prefersReducedMotion } from "./modal.js";

export const LYRICS_LEAD_SEC = 0.75;

/**
 * @param {{ t: number, text: string }[]} lines
 * @param {number} posSec
 * @param {number} [leadSec]
 */
export function activeSyncedLineIndex(lines, posSec, leadSec = LYRICS_LEAD_SEC) {
  let idx = -1;
  if (!Array.isArray(lines)) return idx;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= posSec + leadSec) idx = i;
    else break;
  }
  return idx;
}

/**
 * @param {{ degraded?: boolean }|null|undefined} data
 */
export function lyricsMissMessage(data) {
  if (data?.degraded) {
    return "No lyrics found — providers are having trouble";
  }
  return "No lyrics found";
}

/** Soft line breaks so DJ announce copy reads well on TV / overlay. */
export function formatDjAnnounceScript(script) {
  const text = String(script || "").trim();
  if (!text) return "";
  return text.replace(/([.!?])\s+/g, "$1\n\n");
}

export function playbackClockNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

/**
 * @param {{
 *   npOverlay?: HTMLElement|null,
 *   npOverlayClose?: HTMLElement|null,
 *   npFsArt?: HTMLImageElement|null,
 *   npFsTitle?: HTMLElement|null,
 *   npFsArtist?: HTMLElement|null,
 *   npFsAlbum?: HTMLElement|null,
 *   npFsProgress?: HTMLElement|null,
 *   npFsProgressFill?: HTMLElement|null,
 *   npFsProgressElapsed?: HTMLElement|null,
 *   npFsProgressDuration?: HTMLElement|null,
 *   npFsLyrics?: HTMLElement|null,
 *   displayLyrics?: HTMLElement|null,
 *   npProgress?: HTMLElement|null,
 *   npProgressFill?: HTMLElement|null,
 *   npProgressElapsed?: HTMLElement|null,
 *   npProgressDuration?: HTMLElement|null,
 *   displayProgress?: HTMLElement|null,
 *   displayProgressFill?: HTMLElement|null,
 *   displayProgressElapsed?: HTMLElement|null,
 *   displayProgressDuration?: HTMLElement|null,
 *   npCard?: HTMLElement|null,
 * }} els
 * @param {{
 *   fetch?: typeof fetch,
 *   getLastNowPlaying: () => object|null,
 *   getCurrentView: () => string,
 *   isModalOpen: () => boolean,
 *   bindArtwork: (img: HTMLImageElement|null, np: object|null) => void,
 * }} deps
 */
export function createLyricsUi(els, deps) {
  const {
    npOverlay,
    npOverlayClose,
    npFsArt,
    npFsTitle,
    npFsArtist,
    npFsAlbum,
    npFsProgress,
    npFsProgressFill,
    npFsProgressElapsed,
    npFsProgressDuration,
    npFsLyrics,
    displayLyrics,
    npProgress,
    npProgressFill,
    npProgressElapsed,
    npProgressDuration,
    displayProgress,
    displayProgressFill,
    displayProgressElapsed,
    displayProgressDuration,
    npCard,
  } = els || {};

  const fetchFn = deps.fetch || fetch;
  const getLastNowPlaying = deps.getLastNowPlaying;
  const getCurrentView = deps.getCurrentView;
  const isModalOpen = deps.isModalOpen;
  const bindArtwork = deps.bindArtwork;

  let overlayOpen = false;
  let lyricsKey = "";
  let lyricsFetchId = 0;
  /** @type {{ t: number, text: string }[]|null} */
  let syncedLines = null;
  let positionBase = 0;
  let positionAt = 0;
  let isPlayingOverlay = false;
  let progressClockKey = "";
  /** @type {ReturnType<typeof setTimeout>|null} */
  let lyricTick = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let lyricsRetryTimer = null;
  let overlayHistoryPushed = false;

  function lyricsTrackKey(np) {
    return playbackIdentity(np);
  }

  function isOpen() {
    return overlayOpen;
  }

  function lyricsActive() {
    return overlayOpen || getCurrentView() === "display";
  }

  function lyricsContainers() {
    return [npFsLyrics, displayLyrics].filter(Boolean);
  }

  function setDisplayLyricsVisible(on, { dj = false } = {}) {
    if (!displayLyrics) return;
    displayLyrics.hidden = !on;
    displayLyrics.classList?.toggle?.("is-dj", !!(on && dj));
    if (!on) {
      displayLyrics.replaceChildren();
      displayLyrics.innerHTML = "";
    }
  }

  function lyricsContainerHasPaint(el) {
    return !!el?.querySelector(
      ".np-fs-lyrics-synced, .np-fs-lyrics-plain, .np-fs-lyrics-status"
    );
  }

  function mirrorLyricsContainers() {
    const containers = lyricsContainers();
    const source = containers.find((el) => lyricsContainerHasPaint(el));
    if (!source) return;
    for (const el of containers) {
      if (el === source || lyricsContainerHasPaint(el)) continue;
      if (el === displayLyrics) continue;
      el.innerHTML = source.innerHTML;
    }
  }

  function paintDisplayLyricWindow(activeIdx) {
    if (!displayLyrics || !syncedLines) return;
    displayLyrics.hidden = false;
    const ul = document.createElement("ul");
    ul.className = "np-fs-lyrics-synced party-display-lyrics-window";
    // 5-line karaoke window: two before, active, two after.
    const slots = [
      { i: activeIdx - 2, cls: "is-past" },
      { i: activeIdx - 1, cls: "is-past" },
      { i: activeIdx, cls: "is-active" },
      { i: activeIdx + 1, cls: "is-next" },
      { i: activeIdx + 2, cls: "is-next" },
    ];
    for (const slot of slots) {
      const li = document.createElement("li");
      li.className = "np-fs-line";
      const line =
        slot.i >= 0 && slot.i < syncedLines.length
          ? syncedLines[slot.i]
          : null;
      if (line) {
        li.textContent = line.text;
        if (slot.cls === "is-active") li.classList.add("is-active");
        else if (slot.cls === "is-past") li.classList.add("is-past");
        else li.classList.add("is-next");
      } else {
        li.classList.add("is-empty");
        li.innerHTML = "&nbsp;";
      }
      ul.appendChild(li);
    }
    displayLyrics.replaceChildren(ul);
  }

  function setNpFsLyricsStatus(msg, { showOnDisplay = false } = {}) {
    syncedLines = null;
    if (npFsLyrics) {
      npFsLyrics.innerHTML = `<p class="np-fs-lyrics-status">${escapeHtml(msg)}</p>`;
    }
    if (showOnDisplay && displayLyrics) {
      setDisplayLyricsVisible(true, { dj: true });
      displayLyrics.innerHTML = `<p class="np-fs-lyrics-status">${escapeHtml(msg)}</p>`;
    } else {
      setDisplayLyricsVisible(false);
    }
  }

  function renderPlainLyrics(text, { showOnDisplay = false } = {}) {
    syncedLines = null;
    if (npFsLyrics) {
      const pre = document.createElement("pre");
      pre.className = "np-fs-lyrics-plain";
      pre.textContent = text;
      npFsLyrics.innerHTML = "";
      npFsLyrics.appendChild(pre);
    }
    if (showOnDisplay && displayLyrics) {
      setDisplayLyricsVisible(true, { dj: true });
      displayLyrics.innerHTML = `<pre class="np-fs-lyrics-plain">${escapeHtml(text)}</pre>`;
    } else {
      setDisplayLyricsVisible(false);
    }
  }

  function renderSyncedLyrics(lines) {
    syncedLines = lines;
    setDisplayLyricsVisible(true);
    if (npFsLyrics) {
      const ul = document.createElement("ul");
      ul.className = "np-fs-lyrics-synced";
      for (const line of lines) {
        const li = document.createElement("li");
        li.className = "np-fs-line";
        li.textContent = line.text;
        ul.appendChild(li);
      }
      npFsLyrics.replaceChildren(ul);
    }
    updateSyncedHighlight(true);
  }

  function renderLyricsAttribution(data) {
    if (!data || !npFsLyrics) return;
    const isPlain = data.syncKind === "plain" || !data.syncedLyrics;
    const attribution = data.provider === "unison" ? data.attribution : null;
    if (!isPlain && !attribution) return;

    const note = document.createElement("p");
    note.className = "np-fs-lyrics-attribution";
    if (isPlain) note.append("Plain lyrics");
    if (attribution?.url) {
      if (isPlain) note.append(" · ");
      const link = document.createElement("a");
      link.href = attribution.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = attribution.text || "Lyrics from Unison";
      note.appendChild(link);
    } else if (attribution?.text) {
      if (isPlain) note.append(" · ");
      note.append(attribution.text);
    }
    npFsLyrics.prepend(note);
  }

  function estimatedPositionSec() {
    let pos = positionBase;
    if (isPlayingOverlay && positionAt) {
      pos += (playbackClockNow() - positionAt) / 1000;
    }
    return pos;
  }

  function paintTrackProgress(container, fill, elapsed, total, position, duration) {
    if (!container || !fill || !elapsed || !total) return;
    const available = Number.isFinite(duration) && duration > 0;
    container.hidden = !available;
    if (!available) return;
    const current = Math.max(0, Math.min(duration, position));
    const percent = Math.max(0, Math.min(100, (current / duration) * 100));
    fill.style.transform = `scaleX(${percent / 100})`;
    elapsed.textContent = formatTrackTime(current);
    total.textContent = formatTrackTime(duration);
    const bar = container.querySelector('[role="progressbar"]');
    bar?.setAttribute("aria-valuenow", String(Math.round(percent)));
    bar?.setAttribute(
      "aria-valuetext",
      `${formatTrackTime(current)} of ${formatTrackTime(duration)}`
    );
  }

  function updateTrackProgress() {
    const np = getLastNowPlaying();
    const isAnnouncement = !!np?.djVoice || !!np?.djSilence;
    const duration = isAnnouncement ? Number.NaN : Number(np?.durationSec);
    const position = estimatedPositionSec();
    paintTrackProgress(
      npProgress,
      npProgressFill,
      npProgressElapsed,
      npProgressDuration,
      position,
      duration
    );
    paintTrackProgress(
      npFsProgress,
      npFsProgressFill,
      npFsProgressElapsed,
      npFsProgressDuration,
      position,
      duration
    );
    paintTrackProgress(
      displayProgress,
      displayProgressFill,
      displayProgressElapsed,
      displayProgressDuration,
      position,
      duration
    );
  }

  function applyPlaybackClock(np) {
    const key = lyricsTrackKey(np);
    const force = key !== progressClockKey;
    progressClockKey = key;

    const clockNow = playbackClockNow();
    const playing = !!(np && np.isPlaying && !np.djVoice);
    const serverPos = serverPlaybackPosition(np);
    const hasServer = serverPos != null;

    if (force || !positionAt) {
      positionBase = hasServer ? serverPos : 0;
      positionAt = clockNow;
      isPlayingOverlay = playing;
      return;
    }

    const estimated = estimatedPositionSec();

    if (!hasServer) {
      if (playing !== isPlayingOverlay && !playing) {
        positionBase = estimated;
        positionAt = clockNow;
      }
      isPlayingOverlay = playing;
      return;
    }

    const drift = Math.abs(serverPos - estimated);
    const playChanged = playing !== isPlayingOverlay;
    const staleReplay = playing && !playChanged && serverPos + 0.75 < estimated;
    if (playChanged || !playing) {
      positionBase = hasServer ? serverPos : estimated;
      positionAt = clockNow;
    } else if (!staleReplay && drift > 1.5) {
      positionBase = serverPos;
      positionAt = clockNow;
    }
    isPlayingOverlay = playing;
  }

  function freezePlayhead() {
    if (!isPlayingOverlay) return;
    positionBase = estimatedPositionSec();
    positionAt = playbackClockNow();
    isPlayingOverlay = false;
    updateTrackProgress();
  }

  function shouldScrollLyricsRoot(root) {
    if (root === npFsLyrics) return overlayOpen;
    if (root === displayLyrics) return getCurrentView() === "display";
    return false;
  }

  function updateSyncedHighlight(forceScroll) {
    if (!syncedLines) return;
    const pos = estimatedPositionSec();
    const idx = activeSyncedLineIndex(syncedLines, pos);
    if (getCurrentView() === "display") paintDisplayLyricWindow(idx);
    if (!npFsLyrics) return;
    const ul = npFsLyrics.querySelector(".np-fs-lyrics-synced");
    if (!ul) return;
    const kids = ul.children;
    let activeEl = null;
    let becameActive = false;
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      const wasActive = el.classList.contains("is-active");
      el.classList.toggle("is-active", i === idx);
      el.classList.toggle("is-past", i < idx);
      if (i === idx) {
        activeEl = el;
        if (!wasActive) becameActive = true;
      }
    }
    if (
      activeEl &&
      (becameActive || forceScroll) &&
      shouldScrollLyricsRoot(npFsLyrics)
    ) {
      activeEl.scrollIntoView({
        block: "center",
        behavior: forceScroll ? "auto" : "smooth",
      });
    }
  }

  function stopLyricTicker() {
    if (lyricTick) {
      clearTimeout(lyricTick);
      lyricTick = null;
    }
  }

  function startLyricTicker() {
    stopLyricTicker();
    if (!lyricsActive() || !syncedLines) return;
    let lastIdx = -1;
    const tick = () => {
      if (!lyricsActive() || !syncedLines) return;
      const pos = estimatedPositionSec();
      const idx = activeSyncedLineIndex(syncedLines, pos);
      if (idx !== lastIdx) {
        lastIdx = idx;
        updateSyncedHighlight(false);
      }
      lyricTick = setTimeout(tick, 250);
    };
    updateSyncedHighlight(true);
    lyricTick = setTimeout(tick, 250);
  }

  function clearLyricsRetry() {
    if (lyricsRetryTimer) {
      clearTimeout(lyricsRetryTimer);
      lyricsRetryTimer = null;
    }
  }

  function fillNpOverlayMeta(np) {
    if (!npFsTitle) return;
    const hasTrack = np && (np.title || np.artist);
    npFsTitle.textContent = hasTrack ? np.title || "" : "";
    if (npFsArtist) npFsArtist.textContent = hasTrack ? np.artist || "" : "";
    if (npFsAlbum) npFsAlbum.textContent = hasTrack ? np.album || "" : "";
    bindArtwork(npFsArt, np);
  }

  async function loadOverlayLyrics(np, { retryCount = 0 } = {}) {
    clearLyricsRetry();
    const fetchId = ++lyricsFetchId;
    if (np?.djVoice) {
      const script = formatDjAnnounceScript(np.announceScript);
      if (script) {
        renderPlainLyrics(script, { showOnDisplay: true });
        return;
      }
      setNpFsLyricsStatus(
        np.djSilence ? "DJ coming up…" : "DJ Voice — waiting for script",
        { showOnDisplay: true }
      );
      return;
    }
    if (!np || !(np.title && np.artist)) {
      setNpFsLyricsStatus("No lyrics for this track");
      return;
    }
    // Drop previous karaoke immediately. Otherwise Party Display keeps the
    // last track's synced lines (and ticker) until a slow miss returns.
    if (retryCount === 0) {
      stopLyricTicker();
      setNpFsLyricsStatus("Loading lyrics…");
    }
    const params = new URLSearchParams({
      title: np.title,
      artist: np.artist,
    });
    if (np.album) params.set("album", np.album);
    if (np.uri) params.set("uri", np.uri);
    if (
      np.durationSec != null &&
      Number.isFinite(np.durationSec) &&
      np.durationSec > 0
    ) {
      params.set("duration", String(Math.round(np.durationSec)));
    }
    try {
      const res = await fetchFn(`/api/lyrics?${params}`);
      const data = await res.json();
      if (fetchId !== lyricsFetchId) return;
      if (!res.ok) {
        const error = new Error(data.error || "Could not load lyrics.");
        error.status = res.status;
        error.retryAfterSec = Number(data.retryAfterSec);
        throw error;
      }
      if (data.instrumental) {
        setNpFsLyricsStatus("Instrumental");
        return;
      }
      if (!data.found) {
        setNpFsLyricsStatus(lyricsMissMessage(data));
        return;
      }
      const synced = parseSyncedLyrics(data.syncedLyrics);
      if (synced) {
        renderSyncedLyrics(synced);
        renderLyricsAttribution(data);
        startLyricTicker();
      } else if (data.plainLyrics) {
        renderPlainLyrics(data.plainLyrics);
        renderLyricsAttribution(data);
      } else {
        setNpFsLyricsStatus(lyricsMissMessage(data));
      }
    } catch (err) {
      if (fetchId !== lyricsFetchId) return;
      if (err.status === 503 && retryCount < 2 && lyricsActive()) {
        const retryAfterSec = Number.isFinite(err.retryAfterSec)
          ? Math.max(1, Math.min(30, err.retryAfterSec))
          : 10;
        setNpFsLyricsStatus(
          `Lyrics service is busy — retrying in ${retryAfterSec}s…`
        );
        lyricsRetryTimer = setTimeout(() => {
          lyricsRetryTimer = null;
          const last = getLastNowPlaying();
          if (lyricsActive() && lyricsTrackKey(last) === lyricsKey) {
            loadOverlayLyrics(last, { retryCount: retryCount + 1 });
          }
        }, retryAfterSec * 1000);
        return;
      }
      setNpFsLyricsStatus(err.message || "Could not load lyrics");
    }
  }

  function sync(np) {
    if (!lyricsActive()) return;
    const key = lyricsTrackKey(np);
    const trackChanged = key !== lyricsKey;
    if (overlayOpen) fillNpOverlayMeta(np);
    if (trackChanged) {
      lyricsKey = key;
      clearLyricsRetry();
      stopLyricTicker();
      // Clear paint before the async fetch so the prior track cannot linger.
      setNpFsLyricsStatus("Loading lyrics…");
      loadOverlayLyrics(np);
      return;
    }
    // announceScript can land a tick after the pad starts (or after silence
    // resolves its companion TTS URI) — promote status → plain text.
    if (
      np?.djVoice &&
      String(np.announceScript || "").trim() &&
      !lyricsContainers().some((el) => el.querySelector(".np-fs-lyrics-plain"))
    ) {
      loadOverlayLyrics(np);
      return;
    }
    mirrorLyricsContainers();
    if (syncedLines) startLyricTicker();
  }

  function open() {
    const np = getLastNowPlaying();
    if (!np || !(np.title || np.artist) || !npOverlay) return;
    overlayOpen = true;
    npOverlay.hidden = false;
    document.body.classList.add("np-overlay-open");
    lyricsKey = lyricsTrackKey(np);
    fillNpOverlayMeta(np);
    updateTrackProgress();
    loadOverlayLyrics(np);
    try {
      history.pushState({ npOverlay: true }, "");
      overlayHistoryPushed = true;
    } catch {
      overlayHistoryPushed = false;
    }
    npOverlayClose?.focus();
  }

  function close({ fromPopstate = false } = {}) {
    if (!overlayOpen) return;
    overlayOpen = false;
    if (!lyricsActive()) {
      clearLyricsRetry();
      stopLyricTicker();
      lyricsFetchId += 1;
    }
    if (npOverlay) npOverlay.hidden = true;
    document.body.classList.remove("np-overlay-open");
    if (!fromPopstate && overlayHistoryPushed && history.state?.npOverlay) {
      overlayHistoryPushed = false;
      history.back();
    } else {
      overlayHistoryPushed = false;
    }
  }

  function onViewChange({ target, previous }) {
    if (target === "display") {
      sync(getLastNowPlaying());
    } else if (previous === "display" && !overlayOpen) {
      clearLyricsRetry();
      stopLyricTicker();
      lyricsFetchId += 1;
    }
  }

  function clearDisplay() {
    if (displayLyrics) displayLyrics.innerHTML = "";
  }

  if (npCard) {
    npCard.addEventListener("click", () => {
      if (npCard.classList.contains("is-empty")) return;
      open();
    });
    npCard.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (npCard.classList.contains("is-empty")) return;
      e.preventDefault();
      open();
    });
  }

  npOverlayClose?.addEventListener("click", () => close());
  npOverlay?.addEventListener("click", (e) => {
    if (e.target === npOverlay) close();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlayOpen && !isModalOpen()) {
      e.preventDefault();
      close();
    }
  });

  window.addEventListener("popstate", () => {
    if (overlayOpen) close({ fromPopstate: true });
  });

  window.setInterval(
    updateTrackProgress,
    prefersReducedMotion() ? 1000 : 250
  );

  return {
    sync,
    open,
    close,
    isOpen,
    applyPlaybackClock,
    updateTrackProgress,
    estimatedPositionSec,
    freezePlayhead,
    onViewChange,
    clearDisplay,
  };
}
