/** Main search box, results list, add-to-queue, and dedication modal. */

import { attachModal } from "./modal.js";
import {
  sanitizeDedication,
  dedicationDisplayLabel,
  getDisplayName,
  getDisplayAlias,
} from "./guest.js";
import { escapeHtml } from "./format.js";
import { buildAddToastMessage } from "./add-toast.js";
import {
  trackIdFromUri,
  songMatchKey,
  buildQueuedPresence,
  queuedResultBadge,
} from "./search-track.js";

/**
 * @param {{
 *   searchInput?: HTMLInputElement|null,
 *   searchClear?: HTMLElement|null,
 *   resultsEl?: HTMLElement|null,
 *   statusEl?: HTMLElement|null,
 *   dedicationOverlay?: HTMLElement|null,
 *   dedicationInput?: HTMLInputElement|null,
 *   dedicationError?: HTMLElement|null,
 *   dedicationSaveBtn?: HTMLElement|null,
 *   dedicationCancelBtn?: HTMLElement|null,
 * }} els
 * @param {{
 *   fetch?: typeof fetch,
 *   showToast: (msg: string, isError?: boolean, durationMs?: number, opts?: object) => void,
 *   confirmModal: (message: string, confirmLabel?: string, cancelLabel?: string) => Promise<boolean>,
 *   ensureDisplayName: (opts?: object) => Promise<string>,
 *   guestIdentityPayload: () => object,
 *   getPartyLocks: () => { partyOver?: boolean, requestsPaused?: boolean },
 *   partyOverMessage: string,
 *   setAutofillToggle: (checked: boolean) => void,
 *   markClosingShown: (ts: number) => void,
 *   showPartyRecap: (recap: object) => void,
 *   refreshSonos: () => void,
 *   getCurrentView: () => string,
 *   loadStats: () => void,
 *   onFairnessRefresh?: () => void,
 * }} deps
 */
export function createSearchUi(els, deps) {
  const {
    searchInput,
    searchClear,
    resultsEl,
    statusEl,
    dedicationOverlay,
    dedicationInput,
    dedicationError,
    dedicationSaveBtn,
    dedicationCancelBtn,
  } = els || {};
  const fetchFn = deps.fetch || fetch;
  const showToast = deps.showToast;
  const confirmModal = deps.confirmModal;
  const ensureDisplayName = deps.ensureDisplayName;
  const guestIdentityPayload = deps.guestIdentityPayload;
  const getPartyLocks = deps.getPartyLocks || (() => ({}));
  const partyOverMessage = deps.partyOverMessage || "Requests are closed.";
  const setAutofillToggle = deps.setAutofillToggle || (() => {});
  const markClosingShown = deps.markClosingShown || (() => {});
  const showPartyRecap = deps.showPartyRecap || (() => {});
  const refreshSonos = deps.refreshSonos || (() => {});
  const getCurrentView = deps.getCurrentView || (() => "main");
  const loadStats = deps.loadStats || (() => {});
  const onFairnessRefresh = deps.onFairnessRefresh || (() => {});

  let debounceTimer = null;
  let currentQuery = "";
  let presence = {
    queuedIds: new Set(),
    searchedQueuedIds: new Set(),
    queuedKeys: new Set(),
    searchedQueuedKeys: new Set(),
    nowPlayingId: null,
    nowPlayingKey: "",
  };

  function getNowPlayingId() {
    return presence.nowPlayingId;
  }

  function setQueuedTracks(tracks) {
    const built = buildQueuedPresence(tracks);
    presence = {
      ...presence,
      queuedIds: built.queuedIds,
      searchedQueuedIds: built.searchedQueuedIds,
      queuedKeys: built.queuedKeys,
      searchedQueuedKeys: built.searchedQueuedKeys,
    };
    updateResultsQueuedState();
  }

  /**
   * @param {object|null|undefined} np
   * @param {{ includeId?: boolean }} [opts] when includeId is false (metadata
   *   gap / updating), keep the song key for dupe badges but clear the track id
   *   so reactions don't bind to a stale Spotify id.
   */
  function setNowPlaying(np, { includeId = true } = {}) {
    if (!np) {
      presence = { ...presence, nowPlayingId: null, nowPlayingKey: "" };
    } else {
      presence = {
        ...presence,
        nowPlayingId: includeId ? trackIdFromUri(np.uri) : null,
        nowPlayingKey: songMatchKey(np.title, np.artist),
      };
    }
    updateResultsQueuedState();
  }

  function updateResultsQueuedState() {
    if (!resultsEl) return;
    for (const li of resultsEl.children) {
      const id = li.dataset.id;
      const key = li.dataset.key || "";
      const badgeInfo = queuedResultBadge(id, key, presence);
      const queued = !!badgeInfo;
      li.classList.toggle("in-queue", queued);
      const badge = li.querySelector(".in-queue-badge");
      if (!badge) continue;
      badge.hidden = !queued;
      if (badgeInfo) {
        badge.textContent = badgeInfo.label;
        badge.classList.toggle("random", badgeInfo.isRandom);
      }
    }
  }

  async function runSearch(q) {
    currentQuery = q;
    if (statusEl) statusEl.textContent = "Searching...";
    resultsEl?.setAttribute("aria-busy", "true");
    try {
      const res = await fetchFn(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (q !== currentQuery) return;

      if (!res.ok) {
        if (resultsEl) resultsEl.innerHTML = "";
        if (statusEl) statusEl.textContent = data.error || "Search failed.";
        return;
      }
      renderResults(data.tracks || [], data.artists || [], q);
    } catch {
      if (q !== currentQuery) return;
      if (resultsEl) resultsEl.innerHTML = "";
      if (statusEl) statusEl.textContent = "Network error. Try again.";
    } finally {
      if (q === currentQuery) resultsEl?.removeAttribute("aria-busy");
    }
  }

  function pickSetRequestArtist(artists, query) {
    const list = Array.isArray(artists) ? artists : [];
    if (!list.length) return null;
    const needle = String(query || "").trim().toLowerCase();
    const exact = list.find((a) => a?.name?.toLowerCase() === needle);
    if (exact?.id) return exact;
    // Strong enough: top hit when the query looks like a name (not a song title
    // with " - " / " by "), and popularity is decent or name shares the query.
    const top = list[0];
    if (!top?.id || !top?.name) return null;
    if (/[-–—]| by /i.test(query)) return null;
    const name = top.name.toLowerCase();
    if (needle.length >= 2 && (name === needle || name.includes(needle) || needle.includes(name))) {
      return top;
    }
    return null;
  }

  function renderResults(tracks, artists, query) {
    if (!resultsEl) return;
    resultsEl.innerHTML = "";
    const setArtist = pickSetRequestArtist(artists, query);
    if (statusEl) {
      statusEl.textContent =
        tracks.length || setArtist ? "" : "No songs found.";
    }

    if (setArtist) {
      const li = document.createElement("li");
      li.className = "track set-request-row";
      li.dataset.artistId = setArtist.id;
      const art = setArtist.image
        ? `<img src="${escapeHtml(setArtist.image)}" alt="" loading="lazy" />`
        : `<div class="art-fallback"></div>`;
      li.innerHTML = `
      ${art}
      <div class="meta">
        <div class="title"><span class="set-request-kicker">Artist</span>${escapeHtml(setArtist.name)}</div>
        <div class="artist">Add 5 songs as a Set Request</div>
      </div>
      <button class="add-btn set-request-btn" type="button">Set Request</button>
    `;
      const btn = li.querySelector(".set-request-btn");
      btn.addEventListener("click", () => addSetRequest(setArtist, btn));
      resultsEl.appendChild(li);
    }

    for (const track of tracks) {
      const li = document.createElement("li");
      li.className = "track";
      li.dataset.id = trackIdFromUri(track.uri) || "";
      li.dataset.key = songMatchKey(track.name, track.artists);

      const art = track.image
        ? `<img src="${track.image}" alt="" loading="lazy" />`
        : `<div class="art-fallback"></div>`;

      li.innerHTML = `
      ${art}
      <div class="meta">
        <div class="title">${escapeHtml(track.name)}<span class="in-queue-badge" hidden>\u2713 In queue</span></div>
        <div class="artist">${escapeHtml(track.artists)}</div>
      </div>
      <button class="add-btn" type="button">Add</button>
    `;

      const btn = li.querySelector(".add-btn");
      btn.addEventListener("click", () => addToQueue(track, btn));
      resultsEl.appendChild(li);
    }

    updateResultsQueuedState();
  }

  async function addSetRequest(artist, btn) {
    const locks = getPartyLocks() || {};
    if (locks.partyOver) {
      showToast(partyOverMessage, true);
      return;
    }
    if (locks.requestsPaused) {
      showToast("Requests are paused right now.", true);
      return;
    }
    const displayName = await ensureDisplayName({ required: true });
    if (!displayName) {
      showToast("Enter your name before requesting a set.", true);
      return;
    }
    const ok = await confirmModal(
      `Add a Set Request of 5 songs by ${artist.name}?`,
      "Set Request",
      "Cancel"
    );
    if (!ok) return;

    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = "Adding…";
    try {
      const res = await fetchFn("/api/queue/set-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artistId: artist.id,
          artist: artist.name,
          ...guestIdentityPayload(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not add Set Request.");
      const n = Number(data.added) || 0;
      showToast(
        n
          ? `Set Request: ${n} song${n === 1 ? "" : "s"} by ${data.artist || artist.name}`
          : `Set Request added for ${data.artist || artist.name}`
      );
      btn.textContent = "Added";
      refreshSonos();
      onFairnessRefresh();
      if (getCurrentView() === "stats") loadStats();
    } catch (err) {
      showToast(err.message, true);
      onFairnessRefresh();
      btn.textContent = prev;
      btn.disabled = false;
      return;
    }
    setTimeout(() => {
      btn.textContent = prev;
      btn.disabled = false;
    }, 2000);
  }

  async function addToQueue(track, btn) {
    const locks = getPartyLocks() || {};
    if (locks.partyOver) {
      showToast(partyOverMessage, true);
      return;
    }
    if (locks.requestsPaused) {
      showToast("Requests are paused right now.", true);
      return;
    }
    const displayName = await ensureDisplayName({ required: true });
    if (!displayName) {
      showToast("Enter your name before adding songs.", true);
      return;
    }

    const id = trackIdFromUri(track.uri);
    const key = songMatchKey(track.name, track.artists);
    const exactMatch =
      !!id &&
      (presence.queuedIds.has(id) || id === presence.nowPlayingId);
    const versionMatch =
      !exactMatch &&
      !!key &&
      (presence.queuedKeys.has(key) || key === presence.nowPlayingKey);

    let force = false;
    if (versionMatch) {
      force = await confirmModal(
        `A version of "${track.name}" is already in the queue. Add this version too, or move the one that's already waiting up to the front?`,
        "Add this version",
        "Move existing up"
      );
    }

    btn.disabled = true;
    btn.textContent = "Adding...";
    try {
      const res = await fetchFn("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uri: track.uri,
          name: track.name,
          artist: track.artists,
          force,
          ...guestIdentityPayload(),
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Could not add song.");
      }

      btn.textContent = data.alreadyRequested
        ? "Already queued"
        : data.promoted
          ? "Moved up"
          : "Added";
      btn.classList.add("added");
      if (data.closingTime) {
        setAutofillToggle(false);
        markClosingShown(data.closingTimeAt || Date.now());
        showPartyRecap(data.partyRecap);
      } else {
        const msg = data.alreadyRequested
          ? `"${track.name}" is already in the requested queue.`
          : await buildAddToastMessage(track, data, { fetchImpl: fetchFn });
        showToast(
          msg,
          false,
          5500,
          data.alreadyRequested
            ? {}
            : {
                actionLabel: "Dedicate",
                onAction: () => openDedicationModal(track),
              }
        );
      }
      refreshSonos();
      onFairnessRefresh();
      if (getCurrentView() === "stats") loadStats();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Add";
      showToast(err.message, true);
      onFairnessRefresh();
    }
  }

  async function openDedicationModal(track) {
    if (!dedicationOverlay || !dedicationInput || !track) return;
    const displayName = await ensureDisplayName({ required: true });
    if (!displayName) return;
    if (dedicationError) {
      dedicationError.hidden = true;
      dedicationError.textContent = "";
    }
    dedicationInput.value = sanitizeDedication(track.dedication || "");

    let session = null;
    const cleanup = () => {
      dedicationSaveBtn?.removeEventListener("click", onSave);
      dedicationCancelBtn?.removeEventListener("click", onCancel);
      dedicationInput.removeEventListener("keydown", onKey);
      session?.close();
      session = null;
    };
    const onCancel = () => cleanup();
    const onKey = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onSave();
      }
    };
    const onSave = async () => {
      const note = sanitizeDedication(dedicationInput.value);
      if (!note) {
        if (dedicationError) {
          dedicationError.textContent =
            "Enter a name or short note, or tap Skip.";
          dedicationError.hidden = false;
        }
        return;
      }
      if (dedicationSaveBtn) dedicationSaveBtn.disabled = true;
      try {
        const res = await fetchFn("/api/queue/dedication", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uri: track.uri,
            name: track.name || track.title,
            artist: track.artists || track.artist,
            dedication: note,
            ...guestIdentityPayload(),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Could not save dedication.");
        cleanup();
        const by = getDisplayAlias() || getDisplayName();
        showToast(dedicationDisplayLabel(note, by) || "Dedication saved");
        refreshSonos();
      } catch (err) {
        if (dedicationError) {
          dedicationError.textContent = err.message || "Could not save.";
          dedicationError.hidden = false;
        }
      } finally {
        if (dedicationSaveBtn) dedicationSaveBtn.disabled = false;
      }
    };
    dedicationSaveBtn?.addEventListener("click", onSave);
    dedicationCancelBtn?.addEventListener("click", onCancel);
    dedicationInput.addEventListener("keydown", onKey);
    session = attachModal(dedicationOverlay, {
      initialFocus: dedicationInput,
      onEscape: onCancel,
      allowBackdrop: true,
      onBackdrop: onCancel,
    });
  }

  searchInput?.addEventListener("input", () => {
    const q = searchInput.value.trim();
    if (searchClear) searchClear.hidden = searchInput.value.length === 0;
    clearTimeout(debounceTimer);
    if (!q) {
      if (resultsEl) resultsEl.innerHTML = "";
      if (statusEl) statusEl.textContent = "";
      return;
    }
    debounceTimer = setTimeout(() => runSearch(q), 300);
  });

  searchClear?.addEventListener("click", () => {
    clearTimeout(debounceTimer);
    if (searchInput) searchInput.value = "";
    if (searchClear) searchClear.hidden = true;
    if (resultsEl) resultsEl.innerHTML = "";
    if (statusEl) statusEl.textContent = "";
    searchInput?.focus();
  });

  return {
    setQueuedTracks,
    setNowPlaying,
    getNowPlayingId,
    updateResultsQueuedState,
    openDedicationModal,
  };
}
