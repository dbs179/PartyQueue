/** Music Mix UI: genres, decade mood, Never-Ending toggle, mix labels. */

import { escapeHtml } from "./format.js";
import {
  DECADE_LABELS,
  sameIdSet,
  presetIdsFor as presetIdsForBuckets,
  moodLabelForIds,
  loadEraMood,
  saveEraMood as persistEraMood,
} from "./genre-presets.js";
import {
  resolveActiveEraMoodId,
  buildMixLabelTexts,
  resolveMixGenreLabelFromNowPlaying,
  mixSelectionPatchFromParty,
  formatMixHubMoodLine,
  formatSelectedOfTotal,
  paintMixLabels,
} from "./mix-labels.js";

/**
 * @param {{
 *   genreChips?: HTMLElement|null,
 *   genrePresets?: HTMLElement|null,
 *   poolSizeHint?: HTMLElement|null,
 *   taggingPill?: HTMLElement|null,
 *   genreToggleAll?: HTMLElement|null,
 *   decadeChips?: HTMLElement|null,
 *   npMoodLabel?: HTMLElement|null,
 *   npGenreLabel?: HTMLElement|null,
 *   displayMixPill?: HTMLElement|null,
 *   displayGenrePill?: HTMLElement|null,
 *   autofillToggle?: HTMLInputElement|null,
 *   musicMixHub?: HTMLElement|null,
 *   moodNeedSpotify?: HTMLElement|null,
 *   randomBar?: HTMLElement|null,
 * }} els
 * @param {{
 *   hostFetch: typeof fetch,
 *   showToast: (msg: string, isError?: boolean, durationMs?: number) => void,
 *   fetch?: typeof fetch,
 *   navigateMixPanel: (panel: string) => void,
 *   getPlaylistIds: () => string[],
 *   getPlaylistHubStats: () => { total: number, selected: number, hasSelection: boolean },
 *   setPlaylistIdsFromServer: (ids: string[]) => void,
 *   renderPlaylistsIfLoaded: () => void,
 *   syncDiscoverFromServer: (enabled: unknown) => void,
 *   syncRotationFromServer: (data: object) => void,
 *   syncContentTogglesFromServer: (data: object) => void,
 *   isRandomBarConnected?: () => boolean,
 * }} deps
 */
export function createMusicMixUi(els, deps) {
  const {
    genreChips,
    genrePresets,
    poolSizeHint,
    taggingPill,
    genreToggleAll,
    decadeChips,
    npMoodLabel,
    npGenreLabel,
    displayMixPill,
    displayGenrePill,
    autofillToggle,
    musicMixHub,
    moodNeedSpotify,
    randomBar,
  } = els || {};

  const hostFetch = deps.hostFetch;
  const fetchFn = deps.fetch || fetch;
  const showToast = deps.showToast;
  const navigateMixPanel = deps.navigateMixPanel;
  const getPlaylistIds = deps.getPlaylistIds;
  const getPlaylistHubStats = deps.getPlaylistHubStats;
  const setPlaylistIdsFromServer = deps.setPlaylistIdsFromServer;
  const renderPlaylistsIfLoaded = deps.renderPlaylistsIfLoaded;
  const syncDiscoverFromServer = deps.syncDiscoverFromServer;
  const syncRotationFromServer = deps.syncRotationFromServer;
  const syncContentTogglesFromServer = deps.syncContentTogglesFromServer;

  const toolbarMoodBtn =
    typeof document !== "undefined"
      ? document.getElementById("toolbar-mood")
      : null;

  // ---- Genre filters ----
  // Toggle which broad genres feed Random / Never-Ending. Selection persists in
  // the browser AND on the server so every phone shares one host pool.
  // `null` = not chosen yet -> all on.
  const GENRE_KEY = "pq.genres";
  let genreBuckets = [];
  let genreCountsCache = {};
  let genreDataEnabled = true;
  let genreSelection = loadGenreSelection();
  let poolSizeTimer = null;

  // Mix-label state (declared before the decade block below runs its initial
  // sync, which paints the label). Server-broadcast mix wins; undefined = not
  // seen yet, so local state fills in until the first Now Playing payload.
  let serverMix = {
    genres: undefined,
    mood: undefined,
    genreLabel: undefined,
    genreLane: undefined,
  };

  npMoodLabel?.addEventListener("click", () => navigateMixPanel("mood-presets"));
  npGenreLabel?.addEventListener("click", () => navigateMixPanel("genres"));

  // ---- Era mood (Decades) ----
  // One decade at a time (or none = off). Playlist picks stay in the era and
  // shortfalls fill with era hits from outside the library. Persists locally +
  // on the server so Random and Never-Ending share it across phones.
  let eraMood = loadEraMood();

  function saveEraMood() {
    persistEraMood(eraMood);
  }
  function currentMoodId() {
    return eraMood;
  }
  function syncDecadeChips() {
    if (!decadeChips) return;
    for (const btn of decadeChips.querySelectorAll("[data-mood]")) {
      const on = btn.dataset.mood === eraMood;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    updateMusicMixHubSummaries();
  }
  if (decadeChips) {
    decadeChips.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-mood]");
      if (!btn) return;
      eraMood = eraMood === btn.dataset.mood ? null : btn.dataset.mood;
      saveEraMood();
      syncDecadeChips();
      syncPickerSelection();
      refreshPoolSizeHint();
    });
    syncDecadeChips();
  }

  // ---- Mix label ("MOOD: PARTY - 80'S") over Now Playing + on Party Display ----
  /** Active decade mood id preferring the server-broadcast mix. */
  function activeEraMoodId() {
    return resolveActiveEraMoodId(serverMix.mood, eraMood);
  }

  function updateMixLabels() {
    paintMixLabels(
      { npMoodLabel, npGenreLabel, displayMixPill, displayGenrePill },
      buildMixLabelTexts(serverMix, {
        localGenres: currentGenreIds(),
        localMood: eraMood,
        allBucketIds: genreBuckets.map((b) => b.id),
      })
    );
  }

  /** Vibe mix selection (genres + era mood) — owned by /api/party. */
  function updateMixSelectionFromServer(party) {
    const patch = mixSelectionPatchFromParty(party);
    if (!patch) return;
    if ("genres" in patch) serverMix.genres = patch.genres;
    if ("mood" in patch) serverMix.mood = patch.mood;
    updateMixLabels();
    applyServerMixToPickers();
  }

  /** Per-track Genre header — owned by Now Playing. */
  function updateMixGenreHeaderFromServer(np) {
    const label = resolveMixGenreLabelFromNowPlaying(np);
    if (label === undefined) return;
    serverMix.genreLabel = label;
    serverMix.genreLane =
      typeof np?.mixGenreLane === "string" && np.mixGenreLane
        ? np.mixGenreLane
        : null;
    updateMixLabels();
  }

  // When the server changes the mix underneath us (Random Mood / Random Decade
  // rotating between sets), follow along: repaint the decade chips, genre chips
  // + preset highlight, and local storage. Guarded by the recent-touch window
  // so a host mid-tap isn't fought by an in-flight poll.
  let mixTouchedAt = 0;
  function applyServerMixToPickers() {
    if (Date.now() - mixTouchedAt < 3000) return;
    if (serverMix.mood !== undefined) {
      const m =
        serverMix.mood && DECADE_LABELS[serverMix.mood] ? serverMix.mood : null;
      if (m !== eraMood) {
        eraMood = m;
        saveEraMood();
        syncDecadeChips();
      }
    }
    if (serverMix.genres !== undefined && genreBuckets.length) {
      const want = Array.isArray(serverMix.genres)
        ? serverMix.genres
        : genreBuckets.map((b) => b.id);
      if (!sameIdSet(currentGenreIds(), want)) {
        genreSelection = new Set(want);
        saveGenreSelection();
        renderGenres();
      }
    }
  }

  function loadGenreSelection() {
    try {
      const raw = localStorage.getItem(GENRE_KEY);
      return raw == null ? null : new Set(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  function saveGenreSelection() {
    try {
      localStorage.setItem(GENRE_KEY, JSON.stringify([...genreSelection]));
    } catch {
      /* ignore storage errors */
    }
  }

  // The enabled genre ids to send the server (always explicit, so toggling all
  // back on is honored by the Never-Ending state too).
  function currentGenreIds() {
    const all = genreBuckets.map((b) => b.id);
    if (genreSelection === null) return all;
    return all.filter((id) => genreSelection.has(id));
  }

  function getGenreBucketCount() {
    return genreBuckets.length;
  }

  function applyGenresFromSettings(genres) {
    if (!Array.isArray(genres)) return;
    genreSelection = new Set(genres);
    saveGenreSelection();
    if (genreBuckets.length) {
      renderGenres();
      refreshPoolSizeHint();
    }
  }

  function renderGenreTagGuide(guide, rules) {
    const list = document.getElementById("genre-map-list");
    const intro = document.getElementById("genre-map-intro");
    if (!list) return;
    const rows = Array.isArray(guide) ? guide : [];
    const top = Number(rules?.topTags) || 2;
    const min = Number(rules?.minTagCount) || 10;
    if (intro) {
      intro.textContent =
        `How Last.fm artist tags map into PartyQueue genres. Only each artist's top ${top} tags (count ≥ ${min}) are used.`;
    }
    list.innerHTML = rows
      .map(
        (row) => `<li class="genre-map-row">
        <span class="genre-map-label">${escapeHtml(row.label || row.id || "")}</span>
        <p class="genre-map-tags">${escapeHtml(row.tags || "")}</p>
      </li>`
      )
      .join("");
  }

  function renderMoodGenreGuide(guide) {
    const list = document.getElementById("mood-map-list");
    if (!list) return;
    const rows = Array.isArray(guide) ? guide : [];
    list.innerHTML = rows
      .map(
        (row) => `<li class="genre-map-row">
        <span class="genre-map-label">${escapeHtml(row.label || row.id || "")}</span>
        <p class="genre-map-tags">${escapeHtml(row.genres || "")}</p>
      </li>`
      )
      .join("");
  }

  async function loadGenres() {
    try {
      const ids = currentSelectionIds();
      const qs = ids.length
        ? `?playlistIds=${encodeURIComponent(ids.join(","))}`
        : "";
      const res = await fetchFn(`/api/genres${qs}`);
      if (!res.ok) return;
      const data = await res.json();
      genreBuckets = data.buckets || [];
      genreCountsCache = data.counts || {};
      genreDataEnabled = !!data.enabled;
      renderGenreTagGuide(data.tagGuide, data.tagRules);
      renderMoodGenreGuide(data.moodGuide);
      renderGenres();
      refreshPoolSizeHint();
    } catch {
      /* leave previous genre UI on transient errors */
    }
  }

  function renderGenres() {
    // First run (or stored ids that no longer exist): default to all on.
    if (genreSelection === null) {
      genreSelection = new Set(genreBuckets.map((b) => b.id));
    } else {
      genreSelection = new Set(
        [...genreSelection].filter((id) => genreBuckets.some((b) => b.id === id))
      );
    }

    if (genreChips) {
      genreChips.innerHTML = "";
      for (const b of genreBuckets) {
        const on = genreSelection.has(b.id);
        const count = genreCountsCache[b.id] ?? 0;
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "genre-chip" + (on ? " on" : "");
        chip.setAttribute("aria-pressed", on ? "true" : "false");
        chip.title = on
          ? `Include ${b.label} (${count} tracks)`
          : `Exclude ${b.label} (${count} tracks)`;
        chip.innerHTML = `<span class="genre-name">${escapeHtml(b.label)}</span><span class="genre-cnt">${count}</span>`;
        chip.addEventListener("click", () => {
          if (genreSelection.has(b.id)) genreSelection.delete(b.id);
          else genreSelection.add(b.id);
          saveGenreSelection();
          renderGenres();
          syncPickerSelection();
          refreshPoolSizeHint();
        });
        genreChips.appendChild(chip);
      }
    }

    const all = genreBuckets.map((b) => b.id);
    const allOn = all.length && all.every((id) => genreSelection.has(id));
    if (genreToggleAll) genreToggleAll.textContent = allOn ? "Uncheck All" : "Check All";
    syncGenrePresetHighlight();

    if (taggingPill) {
      taggingPill.textContent = genreDataEnabled ? "Tagging: On" : "Tagging: Off";
      taggingPill.classList.toggle("status-connected", genreDataEnabled);
      taggingPill.classList.toggle("status-disconnected", !genreDataEnabled);
      taggingPill.classList.remove("status-unknown");
      taggingPill.title = genreDataEnabled
        ? "Genre tagging is active (Last.fm key detected)."
        : "Genre tagging is off \u2014 add a LASTFM_API_KEY to tag songs by genre.";
    }
  }

  function presetIdsFor(name) {
    return presetIdsForBuckets(
      name,
      genreBuckets.map((b) => b.id)
    );
  }

  function syncGenrePresetHighlight() {
    if (genrePresets) {
      const current = currentGenreIds();
      for (const btn of genrePresets.querySelectorAll("[data-preset]")) {
        const ids = presetIdsFor(btn.dataset.preset);
        const on = ids.length > 0 && sameIdSet(current, ids);
        btn.classList.toggle("on", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      }
    }
    updateMusicMixHubSummaries();
  }

  /** Active mood preset label, or "Custom" when genres don't match a preset. */
  function currentMoodLabel() {
    return moodLabelForIds(
      currentGenreIds(),
      genreBuckets.map((b) => b.id)
    );
  }

  function updateMusicMixHubSummaries() {
    const moodEl = document.getElementById("mix-stat-mood");
    const genresEl = document.getElementById("mix-stat-genres");
    const playlistsEl = document.getElementById("mix-stat-playlists");

    if (moodEl) {
      const era = eraMood ? DECADE_LABELS[eraMood] : null;
      moodEl.textContent = formatMixHubMoodLine(currentMoodLabel(), era);
    }

    if (genresEl) {
      const total = genreBuckets.length;
      genresEl.textContent = formatSelectedOfTotal(
        currentGenreIds().length,
        total
      );
    }

    if (playlistsEl) {
      const { total, selected, hasSelection } = getPlaylistHubStats();
      if (!total || !hasSelection) {
        playlistsEl.textContent = "—";
      } else {
        playlistsEl.textContent = formatSelectedOfTotal(selected, total);
      }
    }

    updateMixLabels();
  }

  function applyGenrePreset(name) {
    const ids = presetIdsFor(name);
    if (!ids.length) return;
    genreSelection = new Set(ids);
    saveGenreSelection();
    renderGenres();
    syncPickerSelection();
    refreshPoolSizeHint();
  }

  if (genrePresets) {
    genrePresets.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-preset]");
      if (!btn) return;
      applyGenrePreset(btn.dataset.preset);
    });
  }

  function refreshPoolSizeHint() {
    if (!poolSizeHint) return;
    clearTimeout(poolSizeTimer);
    poolSizeTimer = setTimeout(async () => {
      try {
        const res = await fetchFn("/api/pool-size", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            playlistIds: currentSelectionIds(),
            genres: currentGenreIds(),
            mood: currentMoodId(),
          }),
        });
        if (!res.ok) return;
        const data = await res.json();
        // Keep genre chip numbers scoped to the same playlist selection.
        if (data.counts && typeof data.counts === "object") {
          genreCountsCache = data.counts;
          updateGenreChipCounts();
        }
        const n = data.tracks ?? 0;
        if (n <= 0) {
          poolSizeHint.hidden = false;
          poolSizeHint.classList.add("warn");
          poolSizeHint.textContent =
            "No eligible tracks with the current playlists + genres.";
          return;
        }
        const formatted = n.toLocaleString();
        poolSizeHint.hidden = false;
        poolSizeHint.classList.toggle("warn", !!data.warn);
        poolSizeHint.textContent = data.warn
          ? `~${formatted} eligible tracks \u2014 repeats more likely (widen genres or playlists).`
          : `~${formatted} eligible tracks after filters.`;
      } catch {
        /* leave previous hint on transient errors */
      }
    }, 250);
  }

  // Update the number on each genre chip without rebuilding the whole row
  // (avoids flicker / focus loss when playlist selection changes).
  function updateGenreChipCounts() {
    if (!genreChips) return;
    const chips = genreChips.querySelectorAll(".genre-chip");
    for (let i = 0; i < chips.length && i < genreBuckets.length; i++) {
      const b = genreBuckets[i];
      const count = genreCountsCache[b.id] ?? 0;
      const cnt = chips[i].querySelector(".genre-cnt");
      if (cnt) cnt.textContent = String(count);
      const on = chips[i].classList.contains("on");
      chips[i].title = on
        ? `Include ${b.label} (${count} tracks)`
        : `Exclude ${b.label} (${count} tracks)`;
    }
  }

  genreToggleAll?.addEventListener("click", () => {
    const all = genreBuckets.map((b) => b.id);
    const allOn = all.length && all.every((id) => genreSelection.has(id));
    genreSelection = allOn ? new Set() : new Set(all);
    saveGenreSelection();
    renderGenres();
    syncPickerSelection();
    refreshPoolSizeHint();
  });

  // The list of playlist IDs the random/never-ending picker should draw from.
  function currentSelectionIds() {
    return getPlaylistIds() || [];
  }

  // Set the toggle's checked state and remember when, so an in-flight Now Playing
  // poll can't briefly flip it back right after a manual change (see syncAutoFill).
  let autofillTouchedAt = 0;
  function setAutofillToggle(checked) {
    autofillToggle.checked = checked;
    autofillTouchedAt = Date.now();
  }

  // Keep the toggle in sync with the server state broadcast in the Now Playing
  // poll, so every guest sees it flip (e.g. when "Closing Time" turns it off).
  // Skipped briefly after a local change to avoid a flip-flop with a stale poll.
  function syncAutoFillFromServer(enabled) {
    if (typeof enabled !== "boolean") return;
    if (Date.now() - autofillTouchedAt < 3000) return;
    if (autofillToggle.checked !== enabled) autofillToggle.checked = enabled;
  }

  // Reflect the server-side never-ending-queue state in the toggle on load, and
  // prefer the server's saved playlist/genre selection so every phone matches.
  async function loadAutoFill() {
    try {
      const res = await fetchFn("/api/autofill");
      const data = await res.json();
      autofillToggle.checked = !!data.enabled;
      let playlistsChanged = false;
      if (Array.isArray(data.playlistIds) && data.playlistIds.length) {
        setPlaylistIdsFromServer(data.playlistIds);
        playlistsChanged = true;
      }
      if (Array.isArray(data.genres) && data.genres.length) {
        genreSelection = new Set(data.genres);
        saveGenreSelection();
        if (genreBuckets.length) renderGenres();
      }
      // Discover + rotation + content toggles ride along on this public endpoint
      // (settings are host-gated).
      syncDiscoverFromServer(data.discoverEnabled);
      syncRotationFromServer(data);
      syncContentTogglesFromServer(data);
      // Era mood: the server is the source of truth (null = off) so every
      // phone shows the same decade.
      if ("mood" in data) {
        eraMood = typeof data.mood === "string" && DECADE_LABELS[data.mood] ? data.mood : null;
        saveEraMood();
        syncDecadeChips();
      }
      // Re-render checkboxes if playlists already painted with a stale local set.
      if (playlistsChanged) {
        renderPlaylistsIfLoaded();
      }
      refreshPoolSizeHint();
    } catch {
      /* leave the toggle as-is on transient errors */
    }
  }

  async function setAutoFill(enabled) {
    const res = await hostFetch("/api/autofill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled,
        playlistIds: currentSelectionIds(),
        genres: currentGenreIds(),
        mood: currentMoodId(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not update Never-Ending Queue.");
    return data;
  }

  autofillToggle?.addEventListener("change", async () => {
    const enabled = autofillToggle.checked;
    if (enabled && currentSelectionIds().length === 0) {
      autofillToggle.checked = false;
      showToast("Check at least one playlist for random.", true);
      return;
    }
    if (enabled && genreBuckets.length && currentGenreIds().length === 0) {
      autofillToggle.checked = false;
      showToast("Turn on at least one genre for random.", true);
      return;
    }
    autofillToggle.disabled = true;
    autofillTouchedAt = Date.now();
    try {
      await setAutoFill(enabled);
      showToast(
        enabled ? "Never-Ending Queue on" : "Never-Ending Queue off"
      );
    } catch (err) {
      autofillToggle.checked = !enabled; // revert on failure
      showToast(err.message, true);
    } finally {
      autofillToggle.disabled = false;
    }
  });

  // Always push playlist + genre selection to the server so Random and
  // Never-Ending share one host pool across phones (fire-and-forget).
  function syncPickerSelection() {
    // Optimistic: show the new mix immediately; the server broadcast follows.
    mixTouchedAt = Date.now();
    serverMix = { genres: currentGenreIds(), mood: currentMoodId() };
    updateMixLabels();
    hostFetch("/api/selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playlistIds: currentSelectionIds(),
        genres: currentGenreIds(),
        mood: currentMoodId(),
      }),
    }).catch(() => {});
    // When Never-Ending is on, also refresh its live monitor state.
    if (autofillToggle && autofillToggle.checked) setAutoFill(true).catch(() => {});
  }

  // Back-compat alias used by playlist checkbox handlers.
  function syncAutoFillSelection() {
    syncPickerSelection();
    refreshPoolSizeHint();
  }

  /** Vibe toolbar button stays visible; only the Mood/Genres/Playlists hub is Spotify-gated. */
  function syncToolbarMoodVisibility() {
    let connected;
    if (typeof deps.isRandomBarConnected === "function") {
      connected = deps.isRandomBarConnected();
    } else {
      if (!randomBar) return;
      connected = !randomBar.hidden;
    }
    if (toolbarMoodBtn) toolbarMoodBtn.hidden = false;
    if (musicMixHub) musicMixHub.hidden = !connected;
    if (moodNeedSpotify) moodNeedSpotify.hidden = connected;
  }

  return {
    syncToolbarMoodVisibility,
    activeEraMoodId,
    currentGenreIds,
    currentMoodId,
    getGenreBucketCount,
    syncAutoFillFromServer,
    updateMixSelectionFromServer,
    updateMixGenreHeaderFromServer,
    applyGenresFromSettings,
    loadGenres,
    loadAutoFill,
    setAutofillToggle,
    updateMusicMixHubSummaries,
    refreshPoolSizeHint,
    syncPickerSelection,
    syncAutoFillSelection,
  };
}
