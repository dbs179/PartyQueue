/** Playlist list + Random add UI. */

import { escapeHtml } from "./format.js";
import { DECADE_LABELS } from "./genre-presets.js";
import {
  loadPlaylistSelection,
  savePlaylistSelection,
  reconcilePlaylistSelection,
} from "./playlist-selection.js";

/** @param {number} n */
export function songCount(n) {
  return n === 1 ? "1 song" : `${n} songs`;
}

/**
 * @param {{
 *   playlistConnect?: HTMLElement|null,
 *   playlistBox?: HTMLElement|null,
 *   playlistsList?: HTMLElement|null,
 *   playlistsEmpty?: HTMLElement|null,
 *   toggleAllBtn?: HTMLElement|null,
 *   selectedCountEl?: HTMLElement|null,
 *   randomBar?: HTMLElement|null,
 *   controlsRandom?: HTMLElement|null,
 *   randomButtons?: HTMLElement[],
 *   connectSpotifyBtn?: HTMLElement|null,
 * }} els
 * @param {{
 *   hostFetch: typeof fetch,
 *   fetch?: typeof fetch,
 *   showToast: (msg: string, isError?: boolean, durationMs?: number) => void,
 *   confirmModal: (message: string, confirmLabel?: string) => Promise<boolean>,
 *   refreshSonos: () => void,
 *   syncToolbarMoodVisibility: () => void,
 *   updateMusicMixHubSummaries: () => void,
 *   syncAutoFillSelection: () => void,
 *   getGenreIds: () => string[],
 *   getMoodId: () => string|null,
 *   getGenreBucketCount: () => number,
 * }} deps
 */
export function createPlaylistsUi(els, deps) {
  const {
    playlistConnect,
    playlistBox,
    playlistsList,
    playlistsEmpty,
    toggleAllBtn,
    selectedCountEl,
    randomBar,
    controlsRandom,
    connectSpotifyBtn,
  } = els || {};
  const randomButtons = Array.isArray(els?.randomButtons)
    ? els.randomButtons
    : [];

  const hostFetch = deps.hostFetch;
  const fetchFn = deps.fetch || fetch;
  const showToast = deps.showToast;
  const confirmModal = deps.confirmModal;
  const refreshSonos = deps.refreshSonos;
  const syncToolbarMoodVisibility = deps.syncToolbarMoodVisibility;
  const updateMusicMixHubSummaries = deps.updateMusicMixHubSummaries;
  const syncAutoFillSelection = deps.syncAutoFillSelection;
  const getGenreIds = deps.getGenreIds;
  const getMoodId = deps.getMoodId;
  const getGenreBucketCount = deps.getGenreBucketCount;

  // Which playlists are included in the "random" picker. Persisted in the browser.
  // `null` means "not chosen yet" -> defaults to all playlists on first render.
  let currentPlaylists = [];
  let selectedPlaylistIds = loadPlaylistSelection();

  function saveSelection() {
    savePlaylistSelection(selectedPlaylistIds);
  }

  async function loadPlaylists() {
    try {
      const res = await fetchFn("/api/playlists");
      const data = await res.json();
      const connected = !!data.connected;
      if (playlistConnect) playlistConnect.hidden = connected;
      if (playlistBox) playlistBox.hidden = !connected;
      if (randomBar) randomBar.hidden = !connected;
      if (controlsRandom) controlsRandom.hidden = !connected;
      syncToolbarMoodVisibility();
      if (!connected) {
        if (playlistsList) playlistsList.innerHTML = "";
        if (playlistsEmpty) playlistsEmpty.hidden = true;
        updateMusicMixHubSummaries();
        return;
      }
      renderPlaylists(data.playlists || []);
    } catch {
      /* leave previous state on transient errors */
    } finally {
      syncToolbarMoodVisibility();
      updateMusicMixHubSummaries();
    }
  }

  function renderPlaylists(playlists) {
    // Alphabetical order for a predictable dropdown.
    playlists = [...playlists].sort((a, b) =>
      (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })
    );
    currentPlaylists = playlists;
    selectedPlaylistIds = reconcilePlaylistSelection(
      playlists,
      selectedPlaylistIds
    );

    playlistsList.innerHTML = "";
    playlistsEmpty.hidden = playlists.length > 0;

    for (const pl of playlists) {
      const li = document.createElement("li");
      li.className = "track";
      const art = pl.image
        ? `<img src="${pl.image}" alt="" loading="lazy" />`
        : `<div class="art-fallback"></div>`;
      const checked = selectedPlaylistIds.has(pl.id) ? "checked" : "";
      li.innerHTML = `
      <input type="checkbox" class="pl-check" ${checked} aria-label="Include ${escapeHtml(pl.name)} in random" />
      ${art}
      <div class="meta">
        <div class="title">${escapeHtml(pl.name)}</div>
        <div class="artist">${songCount(pl.trackCount)}</div>
      </div>
      <button class="add-btn" type="button">Add</button>
    `;
      const check = li.querySelector(".pl-check");
      check.addEventListener("change", () => {
        if (check.checked) selectedPlaylistIds.add(pl.id);
        else selectedPlaylistIds.delete(pl.id);
        saveSelection();
        updateSelectionUi();
        syncAutoFillSelection();
      });
      const btn = li.querySelector(".add-btn");
      btn.addEventListener("click", () => addPlaylist(pl, btn));
      playlistsList.appendChild(li);
    }

    updateSelectionUi();
  }

  // Sync the "Check/Uncheck All" button label and the "x of y selected" count.
  function updateSelectionUi() {
    const ids = currentPlaylists.map((p) => p.id);
    const selected = ids.filter((id) => selectedPlaylistIds.has(id)).length;
    const allChecked = ids.length > 0 && selected === ids.length;
    if (toggleAllBtn) toggleAllBtn.textContent = allChecked ? "Uncheck All" : "Check All";
    if (selectedCountEl) {
      selectedCountEl.textContent = ids.length
        ? `${selected} of ${ids.length} selected`
        : "";
    }
    updateMusicMixHubSummaries();
  }

  toggleAllBtn?.addEventListener("click", () => {
    const ids = currentPlaylists.map((p) => p.id);
    const allChecked = ids.length > 0 && ids.every((id) => selectedPlaylistIds.has(id));
    selectedPlaylistIds = allChecked ? new Set() : new Set(ids);
    saveSelection();
    renderPlaylists(currentPlaylists);
    syncAutoFillSelection();
  });

  async function addPlaylist(pl, btn) {
    const ok = await confirmModal(
      `Add ${songCount(pl.trackCount)} to the queue?`,
      "Add"
    );
    if (!ok) return;

    btn.disabled = true;
    btn.textContent = "Adding...";
    try {
      const res = await hostFetch("/api/queue/playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uri: pl.uri }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not add playlist.");

      btn.textContent = "Added";
      btn.classList.add("added");
      showToast(`Added "${pl.name}" (${songCount(pl.trackCount)})`);
      refreshSonos();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Add";
      showToast(err.message, true);
    }
  }

  async function addRandom(btn) {
    const count = parseInt(btn.dataset.count, 10) || 50;
    const ids = selectedPlaylistIds ? [...selectedPlaylistIds] : null;
    if (ids && ids.length === 0) {
      showToast("Check at least one playlist for random.", true);
      return;
    }
    const genres = getGenreIds();
    if (getGenreBucketCount() > 0 && genres.length === 0) {
      showToast("Turn on at least one genre for random.", true);
      return;
    }

    const ok = await confirmModal(
      `Add ${count} random songs from your selected playlists?`,
      "Add"
    );
    if (!ok) return;

    randomButtons.forEach((b) => (b.disabled = true));
    const original = btn.innerHTML;
    btn.textContent = "Adding...";
    try {
      const payload = { count };
      if (ids) payload.playlistIds = ids;
      if (genres.length) payload.genres = genres;
      if (getMoodId()) payload.mood = getMoodId();
      const res = await fetchFn("/api/queue/random", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not add random songs.");

      const playlistAdded = Math.max(
        0,
        (data.added || 0) - (data.similarAdded || 0) - (data.moodAdded || 0)
      );
      let msg = `Added ${data.added} ${data.added === 1 ? "song" : "songs"}`;
      if (data.moodAdded) {
        const era = DECADE_LABELS[data.mood] || "era";
        msg += ` (${playlistAdded} from playlists + ${data.moodAdded} ${era} hits)`;
      } else if (data.similarAdded) {
        msg += ` (${playlistAdded} from playlists + ${data.similarAdded} from Discover)`;
      }
      if (data.added < data.requested) msg += " — pool ran short";
      if (data.relaxedMemory && data.memoryReuseCount) {
        msg += ` · reused ${data.memoryReuseCount} from memory`;
      } else if (data.relaxedArtist) {
        msg += " · relaxed artist limit";
      }
      if (data.started) msg += " — now playing";
      showToast(msg);
      refreshSonos();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      randomButtons.forEach((b) => (b.disabled = false));
      btn.innerHTML = original;
    }
  }

  randomButtons.forEach((btn) =>
    btn.addEventListener("click", () => addRandom(btn))
  );

  connectSpotifyBtn?.addEventListener("click", () => {
    window.open("/auth/login", "_blank", "noopener");
  });

  return {
    loadPlaylists,
    renderPlaylists,
    renderIfLoaded: () => {
      if (currentPlaylists.length) renderPlaylists(currentPlaylists);
    },
    getSelectedIds: () => (selectedPlaylistIds ? [...selectedPlaylistIds] : []),
    getHubStats: () => {
      const total = currentPlaylists.length;
      if (!total || selectedPlaylistIds == null) {
        return { total, selected: 0, hasSelection: false };
      }
      const ids = currentPlaylists.map((p) => p.id);
      const selected = ids.filter((id) => selectedPlaylistIds.has(id)).length;
      return { total, selected, hasSelection: true };
    },
    setSelectedIdsFromServer: (ids) => {
      selectedPlaylistIds = new Set(ids);
      saveSelection();
    },
    getCurrentPlaylists: () => currentPlaylists,
  };
}
