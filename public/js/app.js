import {
  attachModal,
  isModalOpen,
  prefersReducedMotion,
} from "./modal.js";
import {
  sanitizeDisplayName,
  sanitizeDedication,
  dedicationDisplayLabel,
  getDisplayName,
  getDisplayAlias,
  setDisplayName,
  setDisplayAlias,
  guestBadgeName as guestBadgeNameFrom,
  guestIdentityPayload as guestIdentityPayloadFrom,
} from "./guest.js";
import {
  mediaIdentity,
  playbackIdentity,
  parseSyncedLyrics,
  queueTrackAsNowPlaying,
  resolveNowPlayingDisplay,
  serverPlaybackPosition,
} from "./now-playing-utils.js";
import {
  formatDuration,
  formatTimeAgo,
  formatSuggestionWhen,
  escapeHtml,
} from "./format.js";
import {
  DECADE_LABELS,
  sameIdSet,
  presetIdsFor as presetIdsForBuckets,
  presetNameForIds as presetNameForIdList,
  moodLabelForIds,
  trackEraDisplayLabel,
  loadEraMood,
  saveEraMood as persistEraMood,
} from "./genre-presets.js";
import {
  loadPlaylistSelection,
  savePlaylistSelection,
  reconcilePlaylistSelection,
} from "./playlist-selection.js";

const searchInput = document.getElementById("search");
const searchClear = document.getElementById("search-clear");
const resultsEl = document.getElementById("results");
const statusEl = document.getElementById("status");
const toastEl = document.getElementById("toast");
const clearBtn = document.getElementById("clearQueue");
const modalOverlay = document.getElementById("modal-overlay");
const modalMessage = document.getElementById("modal-message");
const modalCancel = document.getElementById("modal-cancel");
const modalConfirm = document.getElementById("modal-confirm");

const nameOverlay = document.getElementById("name-overlay");
const nameTitle = document.getElementById("name-title");
const nameInput = document.getElementById("name-input");
const aliasInput = document.getElementById("alias-input");
const nameUserHint = document.getElementById("name-user-hint");
const nameError = document.getElementById("name-error");
const nameSaveBtn = document.getElementById("name-save");
const nameCancelBtn = document.getElementById("name-cancel");
const guestNameBtn = document.getElementById("guest-name");

const dedicationOverlay = document.getElementById("dedication-overlay");
const dedicationInput = document.getElementById("dedication-input");
const dedicationError = document.getElementById("dedication-error");
const dedicationSaveBtn = document.getElementById("dedication-save");
const dedicationCancelBtn = document.getElementById("dedication-cancel");

/** Badge / “Searched by” label: alias if set, else User. */
function guestBadgeName() {
  return guestBadgeNameFrom(sessionDisplayName, sessionDisplayAlias);
}

/** Payload fields for queue / suggestion APIs. */
function guestIdentityPayload() {
  return guestIdentityPayloadFrom(sessionDisplayName, sessionDisplayAlias);
}

/** @type {string} */
let sessionDisplayName = getDisplayName();
/** @type {string} */
let sessionDisplayAlias = getDisplayAlias();
/** @type {Promise<string>|null} */
let nameGatePromise = null;

function syncGuestNameLabel() {
  if (!guestNameBtn) return;
  const label = guestBadgeName();
  if (sessionDisplayName) {
    guestNameBtn.textContent = `Adding as ${label}`;
    guestNameBtn.setAttribute(
      "aria-label",
      `Adding as ${label} — tap to change your name or alias`
    );
  } else {
    guestNameBtn.textContent = "Set your name";
    guestNameBtn.setAttribute(
      "aria-label",
      "Set your name to request songs"
    );
  }
}

/**
 * Show the User + alias modal when User is missing, or when `edit` is true.
 * Resolves with the stable User name (required for adds).
 * @param {{ edit?: boolean, required?: boolean }} [opts]
 *   required=true (Add): cancel hidden — must enter a name to continue.
 *   edit / soft prompt: cancel allowed (browse without a name).
 */
function ensureDisplayName({ edit = false, required = false } = {}) {
  if (!edit && !required && sessionDisplayName) {
    return Promise.resolve(sessionDisplayName);
  }
  if (!edit && required && sessionDisplayName) {
    return Promise.resolve(sessionDisplayName);
  }
  if (nameGatePromise) return nameGatePromise;
  if (!nameOverlay || !nameInput || !nameSaveBtn) {
    return Promise.resolve(sessionDisplayName || "");
  }

  nameGatePromise = new Promise((resolve) => {
    const editing = !!edit && !!sessionDisplayName;
    const mustName = !!required && !sessionDisplayName;
    nameError.hidden = true;
    nameInput.value = editing || sessionDisplayName ? sessionDisplayName : "";
    if (aliasInput) {
      aliasInput.value = editing || sessionDisplayAlias ? sessionDisplayAlias : "";
    }
    if (nameUserHint) nameUserHint.hidden = !editing;
    if (nameTitle) {
      nameTitle.textContent = editing
        ? "Change your name?"
        : "Who’s requesting?";
    }
    // Cancel OK unless this is a required first-Add gate.
    if (nameCancelBtn) nameCancelBtn.hidden = mustName;

    let session = null;
    const finish = (value) => {
      session?.close();
      session = null;
      cleanup();
      resolve(value);
    };
    const cleanup = () => {
      nameSaveBtn.removeEventListener("click", onSave);
      nameInput.removeEventListener("keydown", onKey);
      if (aliasInput) aliasInput.removeEventListener("keydown", onKey);
      if (nameCancelBtn) nameCancelBtn.removeEventListener("click", onCancel);
    };
    const onSave = () => {
      const cleaned = sanitizeDisplayName(nameInput.value);
      if (!cleaned) {
        nameError.textContent = "Please enter your real name.";
        nameError.hidden = false;
        nameInput.focus();
        return;
      }
      const alias = sanitizeDisplayName(aliasInput?.value || "");
      setDisplayName(cleaned);
      setDisplayAlias(alias);
      sessionDisplayName = cleaned;
      sessionDisplayAlias = alias;
      syncGuestNameLabel();
      finish(cleaned);
    };
    const onCancel = () => {
      if (mustName) return;
      finish(sessionDisplayName || "");
    };
    const onKey = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onSave();
      }
    };
    nameSaveBtn.addEventListener("click", onSave);
    nameInput.addEventListener("keydown", onKey);
    if (aliasInput) aliasInput.addEventListener("keydown", onKey);
    if (nameCancelBtn) nameCancelBtn.addEventListener("click", onCancel);
    session = attachModal(nameOverlay, {
      initialFocus: nameInput,
      onEscape: mustName ? null : onCancel,
      allowBackdrop: !mustName,
      onBackdrop: onCancel,
    });
  }).finally(() => {
    nameGatePromise = null;
  });

  return nameGatePromise;
}

syncGuestNameLabel();
if (guestNameBtn) {
  guestNameBtn.addEventListener("click", () =>
    ensureDisplayName({ edit: true }).then(syncGuestNameLabel)
  );
}
// Lazy name gate: no modal on first open — prompt only on Add (or heading tap).

const npCard = document.getElementById("np-card") || document.querySelector(".np-card");
const npArt = document.getElementById("np-art");
const npTitle = document.getElementById("np-title");
const npArtist = document.getElementById("np-artist");
const npAlbum = document.getElementById("np-album");
const npProgress = document.getElementById("np-progress");
const npProgressFill = document.getElementById("np-progress-fill");
const npProgressElapsed = document.getElementById("np-progress-elapsed");
const npProgressDuration = document.getElementById("np-progress-duration");
const npEmpty = document.getElementById("np-empty");
const npConnectionStatus = document.getElementById("np-connection-status");
const npState = document.getElementById("np-state");
const npOrigin = document.getElementById("np-origin");
const npPills = document.getElementById("np-pills");
const npToggle = document.getElementById("np-toggle");
const npOverlay = document.getElementById("np-overlay");
const npOverlayClose = document.getElementById("np-overlay-close");
const npFsArt = document.getElementById("np-fs-art");
const npFsTitle = document.getElementById("np-fs-title");
const npFsArtist = document.getElementById("np-fs-artist");
const npFsAlbum = document.getElementById("np-fs-album");
const npFsProgress = document.getElementById("np-fs-progress");
const npFsProgressFill = document.getElementById("np-fs-progress-fill");
const npFsProgressElapsed = document.getElementById("np-fs-progress-elapsed");
const npFsProgressDuration = document.getElementById("np-fs-progress-duration");
const npFsLyrics = document.getElementById("np-fs-lyrics");
const displayLyrics = document.getElementById("display-lyrics");
const shuffleBtn = document.getElementById("shuffle-btn");
const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");
const muteBtn = document.getElementById("mute-btn");
const volDownBtn = document.getElementById("vol-down-btn");
const volUpBtn = document.getElementById("vol-up-btn");
const volDown10Btn = document.getElementById("vol-down-10-btn");
const volUp10Btn = document.getElementById("vol-up-10-btn");
const groupAllBtn = document.getElementById("group-all-btn");
const queueList = document.getElementById("queue");
const queueCount = document.getElementById("queue-count");
const queueEmpty = document.getElementById("queue-empty");
const queueSection = document.getElementById("queue-section");
const queueToggle = document.getElementById("queue-toggle");
const queueEditToggle = document.getElementById("queue-edit-toggle");
const queueEditHint = document.getElementById("queue-edit-hint");

// Edit lives inside the collapsible header row; it's hidden both while the
// queue is empty and while host-only controls lock guests out.
let queueEditLockedForGuests = false;
let queueHasTracks = false;
function syncQueueEditButton() {
  if (queueEditToggle)
    queueEditToggle.hidden = queueEditLockedForGuests || !queueHasTracks;
}

const randomBar = document.getElementById("random-bar");
const controlsRandom = document.getElementById("controls-random");
const randomButtons = [...document.querySelectorAll(".random-btn")];
const autofillToggle = document.getElementById("autofill-toggle");

const playlistConnect = document.getElementById("playlist-connect");
const connectSpotifyBtn = document.getElementById("connect-spotify");
const playlistBox = document.getElementById("playlist-box");
const playlistsList = document.getElementById("playlists");
const playlistsEmpty = document.getElementById("playlists-empty");
const toggleAllBtn = document.getElementById("toggle-all-playlists");
const selectedCountEl = document.getElementById("selected-count");
const cacheRefreshBtn = document.getElementById("cache-refresh-btn");
const cacheStatus = document.getElementById("cache-status");
const cacheWarmed = document.getElementById("cache-warmed");
const spotifyStatus = document.getElementById("spotify-status");

// Which playlists are included in the "random" picker. Persisted in the browser.
// `null` means "not chosen yet" -> defaults to all playlists on first render.
let currentPlaylists = [];
let selectedPlaylistIds = loadPlaylistSelection();

function saveSelection() {
  savePlaylistSelection(selectedPlaylistIds);
}

// Collapse/expand the "Up next" list (the header + count stay visible).
// Expanded by default; remembers the last choice in localStorage.
const QUEUE_COLLAPSE_KEY = "pq.queueCollapsed";
function applyQueueCollapsed(collapsed) {
  queueSection.classList.toggle("collapsed", collapsed);
  queueToggle.setAttribute("aria-expanded", String(!collapsed));
}
{
  const stored = localStorage.getItem(QUEUE_COLLAPSE_KEY);
  applyQueueCollapsed(stored == null ? false : stored === "1");
}
queueToggle.addEventListener("click", (e) => {
  // The Edit button sits inside this header; don't collapse when it's used.
  if (e.target instanceof Element && e.target.closest("#queue-edit-toggle"))
    return;
  const collapsed = !queueSection.classList.contains("collapsed");
  localStorage.setItem(QUEUE_COLLAPSE_KEY, collapsed ? "1" : "0");
  applyQueueCollapsed(collapsed);
});
queueToggle.addEventListener("keydown", (e) => {
  if (e.target !== queueToggle) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    queueToggle.click();
  }
});

// Collapse/expand main-page panels (Controls, Suggestion Box, …).
// Each panel remembers its own state; missing keys use defaultCollapsed.
function wirePanelCollapse(
  sectionId,
  toggleId,
  storageKey,
  { onExpand = null, defaultCollapsed = true } = {}
) {
  const section = document.getElementById(sectionId);
  const toggle = document.getElementById(toggleId);
  if (!section || !toggle) return;
  function apply(collapsed) {
    section.classList.toggle("collapsed", collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
  }
  const stored = localStorage.getItem(storageKey);
  apply(stored == null ? defaultCollapsed : stored === "1");
  toggle.addEventListener("click", () => {
    const collapsed = !section.classList.contains("collapsed");
    localStorage.setItem(storageKey, collapsed ? "1" : "0");
    apply(collapsed);
    if (!collapsed && typeof onExpand === "function") onExpand();
  });
  toggle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle.click();
    }
  });
}

wirePanelCollapse("controls-section", "controls-toggle", "pq.controlsCollapsed", {
  onExpand: () => loadGroups(true),
});
wirePanelCollapse("suggestion-section", "suggestion-toggle", "pq.suggestionCollapsed", {
  defaultCollapsed: true,
});
wirePanelCollapse("toolbar-section", "toolbar-toggle", "pq.toolbarCollapsed", {
  defaultCollapsed: true,
});
wirePanelCollapse("genre-map-section", "genre-map-toggle", "pq.genreMapCollapsed", {
  defaultCollapsed: true,
});
wirePanelCollapse("mood-map-section", "mood-map-toggle", "pq.moodMapCollapsed", {
  defaultCollapsed: true,
});

const toolbarSonosBtn = document.getElementById("toolbar-sonos");
const toolbarMoodBtn = document.getElementById("toolbar-mood");
const toolbarBoothBtn = document.getElementById("toolbar-booth");
const toolbarStatsBtn = document.getElementById("toolbar-stats");
const toolbarJoinBtn = document.getElementById("toolbar-join");
const toolbarDisplayBtn = document.getElementById("toolbar-display");
const moodNeedSpotify = document.getElementById("mood-need-spotify");
const musicMixHub = document.getElementById("music-mix-hub");

/** Vibe toolbar button stays visible; only the Mood/Genres/Playlists hub is Spotify-gated. */
function syncToolbarMoodVisibility() {
  if (!randomBar) return;
  const connected = !randomBar.hidden;
  if (toolbarMoodBtn) toolbarMoodBtn.hidden = false;
  if (musicMixHub) musicMixHub.hidden = !connected;
  if (moodNeedSpotify) moodNeedSpotify.hidden = connected;
}

if (toolbarSonosBtn) {
  toolbarSonosBtn.addEventListener("click", () => navigate("sonos"));
}
if (toolbarMoodBtn) {
  toolbarMoodBtn.addEventListener("click", () => navigate("mix"));
}
if (toolbarBoothBtn) {
  toolbarBoothBtn.addEventListener("click", () => navigate("booth"));
}
if (toolbarStatsBtn) {
  toolbarStatsBtn.addEventListener("click", () => navigate("stats"));
}
if (toolbarJoinBtn) {
  toolbarJoinBtn.addEventListener("click", () => navigate("join"));
}
if (toolbarDisplayBtn) {
  toolbarDisplayBtn.addEventListener("click", () => navigate("display"));
}
syncToolbarMoodVisibility();

// ---- Sonos group picker + Edit groups ----
// Normal mode: pick which group's queue PartyQueue controls.
// Edit mode: join / leave speakers against the current target coordinator.
const groupChips = document.getElementById("group-chips");
const groupEmpty = document.getElementById("group-empty");
const groupIntro = document.getElementById("group-intro");
const groupPicker = document.getElementById("group-picker");
const groupEdit = document.getElementById("group-edit");
const groupEditAnchor = document.getElementById("group-edit-anchor");
const groupMembers = document.getElementById("group-members");
const groupAvailable = document.getElementById("group-available");
const groupEditEmpty = document.getElementById("group-edit-empty");
const groupEditToggle = document.getElementById("group-edit-toggle");
const groupUngroupAllBtn = document.getElementById("group-ungroup-all");
let groupsCache = [];
let speakersCache = [];
let groupsTargetLabel = null;
let groupsLoading = false;
let lastGroupsAt = 0;
let groupEditMode = false;
const GROUPS_MS = 5000;

async function loadGroups(force = false) {
  if (groupsLoading) return;
  if (!force && Date.now() - lastGroupsAt < GROUPS_MS) return;
  groupsLoading = true;
  try {
    const res = await fetch("/api/groups");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not load groups.");
    groupsCache = data.groups || [];
    speakersCache = data.speakers?.length
      ? data.speakers
      : speakersFromGroups(groupsCache);
    groupsTargetLabel =
      data.targetLabel ||
      groupsCache.find((g) => g.isTarget)?.label ||
      groupsCache[0]?.label ||
      null;
    lastGroupsAt = Date.now();
    renderGroups();
  } catch (err) {
    // Keep previous chips, but tell the host something went wrong.
    if (force || !groupsCache.length) {
      showToast(err.message || "Could not load Sonos groups.", true);
    }
  } finally {
    groupsLoading = false;
  }
}

/** Build speaker chips from group membership when the API omits speakers[]. */
function speakersFromGroups(groups) {
  const target = groups.find((g) => g.isTarget) || groups[0] || null;
  const targetMembers = new Set(
    (target?.members || []).map((n) => String(n).toLowerCase())
  );
  const coord = String(target?.coordinator || "").toLowerCase();
  const names = new Set();
  for (const g of groups) {
    for (const n of g.members || []) if (n) names.add(n);
  }
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const key = name.toLowerCase();
      return {
        name,
        inTargetGroup: targetMembers.has(key),
        isTargetCoordinator: key === coord,
      };
    });
}

function setGroupEditMode(on) {
  groupEditMode = !!on;
  if (groupPicker) groupPicker.hidden = groupEditMode;
  if (groupEdit) groupEdit.hidden = !groupEditMode;
  if (groupUngroupAllBtn) groupUngroupAllBtn.hidden = !groupEditMode;
  if (groupEditToggle) {
    groupEditToggle.setAttribute("aria-pressed", String(groupEditMode));
    groupEditToggle.textContent = groupEditMode ? "Done" : "Edit groups";
  }
  if (groupIntro) {
    groupIntro.textContent = groupEditMode
      ? "Edit mode: tap a speaker under Available to join, or tap one under In this group to leave."
      : "Songs go to this group's queue. Pick a group below, or Edit groups to join / leave speakers.";
  }
  renderGroups();
}

function renderGroups() {
  if (groupEditMode) {
    renderGroupEdit();
    return;
  }
  if (!groupChips) return;
  groupChips.innerHTML = "";
  if (groupEmpty) groupEmpty.hidden = groupsCache.length > 0;

  for (const g of groupsCache) {
    const on = g.isTarget;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "genre-chip group-chip" + (on ? " on" : "");
    chip.setAttribute("role", "radio");
    chip.setAttribute("aria-checked", on ? "true" : "false");
    chip.title =
      g.members?.length > 1 ? g.members.join(", ") : g.label;
    const count =
      g.memberCount > 1 ? `<span class="genre-cnt">${g.memberCount}</span>` : "";
    const playing = g.isPlaying ? '<span class="group-playing" aria-hidden="true">&#9654;</span>' : "";
    chip.innerHTML = `${playing}<span class="genre-name">${escapeHtml(g.label)}</span>${count}`;
    if (!on) chip.addEventListener("click", () => pickGroup(g.coordinator));
    groupChips.appendChild(chip);
  }
}

function renderGroupEdit() {
  if (!groupMembers || !groupAvailable) return;
  groupMembers.innerHTML = "";
  groupAvailable.innerHTML = "";

  const members = speakersCache.filter((s) => s.inTargetGroup);
  const available = speakersCache.filter((s) => !s.inTargetGroup);

  if (groupEditAnchor) {
    groupEditAnchor.textContent = groupsTargetLabel
      ? `Target group: ${groupsTargetLabel}`
      : "Target group: (none selected)";
  }

  for (const s of members) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className =
      "genre-chip group-chip on" + (s.isTargetCoordinator ? " group-chip-coord" : "");
    chip.title = s.isTargetCoordinator
      ? `${s.name} (coordinator) — tap to leave group`
      : `Remove ${s.name} from this group`;
    chip.innerHTML = `<span class="genre-name">${escapeHtml(s.name)}</span>${
      s.isTargetCoordinator ? '<span class="genre-cnt">lead</span>' : ""
    }`;
    chip.addEventListener("click", () => leaveSpeaker(s.name));
    groupMembers.appendChild(chip);
  }

  for (const s of available) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "genre-chip group-chip";
    chip.title = `Join ${s.name} to the target group`;
    chip.innerHTML = `<span class="genre-name">${escapeHtml(s.name)}</span><span class="genre-cnt">+</span>`;
    chip.addEventListener("click", () => joinSpeaker(s.name));
    groupAvailable.appendChild(chip);
  }

  if (groupEditEmpty) {
    const empty = speakersCache.length === 0;
    groupEditEmpty.hidden = !empty;
    if (empty) {
      groupEditEmpty.textContent =
        groupsCache.length === 0
          ? "No Sonos speakers found. Check that speakers are online, then tap Done and try again."
          : "Couldn't load speakers. Tap Done, hard-refresh the page, then try Edit groups again.";
    }
  }
}

async function pickGroup(room) {
  try {
    const res = await hostFetch("/api/groups/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not select group.");
    lastGroupsAt = 0;
    await loadGroups(true);
    refreshSonos();
    showToast(`Targeting ${data.label}`);
  } catch (err) {
    showToast(err.message, true);
  }
}

async function joinSpeaker(room) {
  try {
    const res = await hostFetch("/api/groups/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not join speaker.");
    lastGroupsAt = 0;
    await loadGroups(true);
    refreshSonos();
    if (data.alreadyInGroup) showToast(`${room} is already in the group`);
    else showToast(`Joined ${room}`);
  } catch (err) {
    showToast(err.message, true);
  }
}

async function leaveSpeaker(room) {
  try {
    const res = await hostFetch("/api/groups/leave", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not ungroup speaker.");
    lastGroupsAt = 0;
    await loadGroups(true);
    refreshSonos();
    if (data.alreadyStandalone) showToast(`${room} is already alone`);
    else showToast(`Ungrouped ${room}`);
  } catch (err) {
    showToast(err.message, true);
  }
}

if (groupEditToggle) {
  groupEditToggle.addEventListener("click", () => {
    setGroupEditMode(!groupEditMode);
    if (groupEditMode) loadGroups(true);
  });
}

if (groupUngroupAllBtn) {
  groupUngroupAllBtn.addEventListener("click", async () => {
    groupUngroupAllBtn.disabled = true;
    try {
      const res = await hostFetch("/api/groups/ungroup-all", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not ungroup speakers.");
      lastGroupsAt = 0;
      await loadGroups(true);
      refreshSonos();
      showToast(
        data.ungrouped
          ? `Ungrouped ${data.ungrouped} speaker${data.ungrouped === 1 ? "" : "s"}`
          : "All speakers were already alone"
      );
    } catch (err) {
      showToast(err.message, true);
    } finally {
      groupUngroupAllBtn.disabled = false;
    }
  });
}

// Randomness settings (song memory + per-artist budget), persisted server-side.
const songMemoryInput = document.getElementById("set-song-memory");
const artistWindowInput = document.getElementById("set-artist-window");
const artistCapInput = document.getElementById("set-artist-cap");
const strictFillInput = document.getElementById("set-strict-fill");
const settingsSaveBtn = document.getElementById("settings-save");
const settingsResetBtn = document.getElementById("settings-reset");
const settingsClearHistoryBtn = document.getElementById("settings-clear-history");
const settingsClearStatsBtn = document.getElementById("settings-clear-stats");
const settingsClearDjMemoryBtn = document.getElementById("settings-clear-dj-memory");
const settingsClearSuggestionsBtn = document.getElementById("settings-clear-suggestions");
const settingsClearReactionsBtn = document.getElementById("settings-clear-reactions");
const settingsClearKaraokeBtn = document.getElementById("settings-clear-karaoke");
const discoverEnabledInput = document.getElementById("set-discover-enabled");
const randomMoodToggle = document.getElementById("random-mood-toggle");
const randomDecadeToggle = document.getElementById("random-decade-toggle");
const similarCountInput = document.getElementById("set-similar-count");
const endlessCountInput = document.getElementById("set-endless-count");
const requestFairnessEnabledInput = document.getElementById(
  "set-request-fairness-enabled"
);
const requestFairnessThresholdInput = document.getElementById(
  "set-request-fairness-threshold"
);
const requestFairnessUpcomingInput = document.getElementById(
  "set-request-fairness-upcoming"
);
const requestFairnessRollingMaxInput = document.getElementById(
  "set-request-fairness-rolling-max"
);
const requestFairnessWindowInput = document.getElementById(
  "set-request-fairness-window"
);
const requestFairnessHostBypassInput = document.getElementById(
  "set-request-fairness-host-bypass"
);
const randomMoodEveryInput = document.getElementById("set-random-mood-every");
const randomDecadeEveryInput = document.getElementById(
  "set-random-decade-every"
);
const rotationMoodPool = document.getElementById("rotation-mood-pool");
const rotationDecadePool = document.getElementById("rotation-decade-pool");
const autofillHint = document.getElementById("autofill-hint");
const filterExplicitInput = document.getElementById("filter-explicit-toggle");
const requestsPausedInput = document.getElementById("requests-paused-toggle");
const partyOverInput = document.getElementById("party-over-toggle");
const hostControlsInput = document.getElementById("host-controls-toggle");
const kidsLockInput = document.getElementById("kids-lock-toggle");
const requestsPausedBanner = document.getElementById("requests-paused-banner");
const displayPartyOverPill = document.getElementById("display-party-over");
const npReactions = document.getElementById("np-reactions");
let requestsPaused = false;
let partyOver = false;
let hostControlsOnly = false;
const NP_REACTION_KINDS = [
  "up",
  "down",
  "heart",
  "fire",
  "laugh",
  "vomit",
  "party",
  "mic",
];
const NP_MOOD_REACTION_KINDS = NP_REACTION_KINDS.filter((k) => k !== "mic");
const REACT_GUEST_KEY = "pq.reactGuestId";
let npReactionCounts = Object.fromEntries(NP_REACTION_KINDS.map((k) => [k, 0]));
let npMyMood = null;
let npMyMic = false;
let npReactBusy = false;
let npReactionsSyncedFor = null;

function getReactGuestId() {
  try {
    let id = localStorage.getItem(REACT_GUEST_KEY) || "";
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID().replace(/-/g, "")
          : `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(REACT_GUEST_KEY, id);
    }
    return id;
  } catch {
    return `g${Date.now().toString(36)}`;
  }
}
const djVoiceToggle = document.getElementById("dj-voice-toggle");
const djNameInput = document.getElementById("set-dj-name");
const djIntroPercentInput = document.getElementById("set-dj-intro-percent");
const djMaxWordsInput = document.getElementById("set-dj-max-words");
const djVolumeLowInput = document.getElementById("set-dj-vol-low");
const djVolumeMidInput = document.getElementById("set-dj-vol-mid");
const djVolumeHighInput = document.getElementById("set-dj-vol-high");
const djSilenceInput = document.getElementById("set-dj-silence");
const djTtsProviderInput = document.getElementById("set-dj-tts-provider");
const djTtsVoiceInput = document.getElementById("set-dj-tts-voice");
const djTtsVoiceElevenlabsInput = document.getElementById(
  "set-dj-tts-voice-elevenlabs"
);
const djTtsVoiceOpenaiRow = document.getElementById("dj-tts-voice-openai-row");
const djTtsVoiceElevenlabsRow = document.getElementById(
  "dj-tts-voice-elevenlabs-row"
);
const djTtsSpeedInput = document.getElementById("set-dj-tts-speed");
const djIntensityInput = document.getElementById("set-dj-intensity");
const djCatchphraseInput = document.getElementById("set-dj-catchphrase");
const djBanListInput = document.getElementById("set-dj-ban-list");
const djPersonaNotesInput = document.getElementById("set-dj-persona-notes");
const djAlwaysInstructionsInput = document.getElementById(
  "set-dj-always-instructions"
);
const djNeverInstructionsInput = document.getElementById(
  "set-dj-never-instructions"
);
const djPronunciationsInput = document.getElementById("set-dj-pronunciations");
const djAdvancedSaveBtn = document.getElementById("dj-advanced-save");
const djAdvancedResetBtn = document.getElementById("dj-advanced-reset");
const djAdvancedPreviewRefreshBtn = document.getElementById(
  "dj-advanced-preview-refresh"
);
const djEffectivePromptInput = document.getElementById("dj-effective-prompt");
const djShoutEnabledInput = document.getElementById("set-dj-shout-enabled");
const djShoutModeInput = document.getElementById("set-dj-shout-mode");
const djShoutPercentInput = document.getElementById("set-dj-shout-percent");
const djShoutEveryInput = document.getElementById("set-dj-shout-every");
const djPartyRecapEnabledInput = document.getElementById("set-dj-party-recap-enabled");
const endOfNightLabelEl = document.getElementById("end-of-night-label");
const endOfNightSearchInput = document.getElementById("end-of-night-search");
const endOfNightResultsEl = document.getElementById("end-of-night-results");
const endOfNightResetBtn = document.getElementById("end-of-night-reset");
const recapHintEl = document.getElementById("recap-hint");

/** @type {{ uri: string|null, name: string, artist: string }} */
let endOfNightTrack = {
  uri: null,
  name: "Closing Time",
  artist: "Semisonic",
};
let endOfNightSearchTimer = 0;
const djShoutPercentRow = document.getElementById("dj-shout-percent-row");
const djShoutEveryRow = document.getElementById("dj-shout-every-row");
const guestHubGrid = document.getElementById("guest-hub-grid");
const guestListEl = document.getElementById("guest-list");
const guestNameInput = document.getElementById("guest-name-input");
const guestNotesInput = document.getElementById("guest-notes-input");
const guestSaveBtn = document.getElementById("guest-save");
const guestBdayMonth = document.getElementById("guest-bday-month");
const guestBdayDay = document.getElementById("guest-bday-day");
const guestBdayRole = document.getElementById("guest-bday-role");
const guestBdaySaveBtn = document.getElementById("guest-bday-save");
const guestBdayForgetBtn = document.getElementById("guest-bday-forget");
const guestRemoveBtn = document.getElementById("guest-remove");
const guestRenameBtn = document.getElementById("guest-rename");
const settingsUserEditTitle = document.getElementById("settings-user-edit-title");
/** @type {Array<{name?: string, notes?: string[], birthday?: string|null, birthdayRole?: string}>} */
let cachedGuests = [];
/** Name of guest currently open in the edit view, or null for Add user. */
let editingGuestName = null;
const djVoiceTestBtn = document.getElementById("dj-voice-test");
const djVoiceTestElevenlabsBtn = document.getElementById(
  "dj-voice-test-elevenlabs"
);
const djVoicePreviewPlayer = document.getElementById("dj-voice-preview-player");
const djVoiceSaveBtns = document.querySelectorAll(".dj-voice-save-btn");
const djVoiceResetBtns = document.querySelectorAll(".dj-voice-reset-btn");
const djIconUploadBtn = document.getElementById("dj-icon-upload-btn");
const djIconFileInput = document.getElementById("dj-icon-file");
const djIconGallery = document.getElementById("dj-icon-gallery");
/** @type {string|null} active uploaded icon filename, or null for default */
let activeDjIconName = null;
const eventNameInput = document.getElementById("set-event-name");
const subtitleInput = document.getElementById("set-subtitle");
const showVersionInput = document.getElementById("set-show-version");
const showQueueGenreInput = document.getElementById("set-show-queue-genre");
const headerEventName = document.getElementById("event-name");
const headerSubtitle = document.getElementById("subtitle");
const headerVersion = document.getElementById("app-version");
const heroImg = document.getElementById("hero");
const MAX_DJ_ICON_BYTES = 2 * 1024 * 1024;
let settingsDefaults = {
  songMemory: 500,
  artistWindow: 30,
  artistCap: 1,
  strictFill: true,
};
/** Guest-visible: Up Next genre + From Playlists pills (DJ Booth Look). */
let showQueueGenre = false;
try {
  const bootBrand = window.__PQ_BRAND__;
  if (bootBrand && typeof bootBrand.showQueueGenre === "boolean") {
    showQueueGenre = !!bootBrand.showQueueGenre;
  } else {
    const cached = JSON.parse(
      localStorage.getItem("pq.branding") || "{}"
    );
    if (typeof cached.showQueueGenre === "boolean") {
      showQueueGenre = cached.showQueueGenre;
    }
  }
} catch {
  /* ignore */
}
if (showQueueGenreInput) showQueueGenreInput.checked = showQueueGenre;

const BRANDING_STORAGE_KEY = "pq.branding";

function persistBrandingCache(partial = {}) {
  try {
    let prev = {};
    try {
      prev = JSON.parse(localStorage.getItem(BRANDING_STORAGE_KEY) || "{}") || {};
    } catch {
      prev = {};
    }
    const next = {
      eventName:
        partial.eventName != null ? partial.eventName : prev.eventName || "",
      subtitle:
        partial.subtitle != null ? partial.subtitle : prev.subtitle || "",
      heroBanner:
        partial.heroBanner !== undefined
          ? partial.heroBanner || null
          : prev.heroBanner || null,
      version: partial.version != null ? partial.version : prev.version || "",
      showVersion:
        partial.showVersion != null
          ? !!partial.showVersion
          : !!prev.showVersion,
      showQueueGenre:
        partial.showQueueGenre != null
          ? !!partial.showQueueGenre
          : !!prev.showQueueGenre,
    };
    localStorage.setItem(BRANDING_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / private mode */
  }
}

function syncShowQueueGenre(enabled, { rerender = true } = {}) {
  if (typeof enabled !== "boolean") return;
  if (showQueueGenre === enabled) {
    if (showQueueGenreInput) showQueueGenreInput.checked = enabled;
    return;
  }
  showQueueGenre = enabled;
  if (showQueueGenreInput) showQueueGenreInput.checked = enabled;
  persistBrandingCache({ showQueueGenre: enabled });
  if (rerender && Array.isArray(lastQueueTracks)) {
    renderQueue(lastQueueTracks);
  }
}

// Point the header image at the active banner (null = built-in default).
// Inline boot script already set /banner from saved branding — skip reassign
// on the initial settings load so the image isn't fetched twice.
function applyHero(name, { force = false } = {}) {
  if (!heroImg) return;
  const key = name || "default";
  persistBrandingCache({ heroBanner: name || null });
  if (!force && heroImg.dataset.bannerKey === key) {
    heroImg.setAttribute("data-ready", "1");
    return;
  }
  heroImg.dataset.bannerKey = key;
  heroImg.src = `/banner?b=${encodeURIComponent(key)}`;
  heroImg.setAttribute("data-ready", "1");
}

// Apply the event name/tagline to the page header (and the browser tab title).
function applyBranding(eventName, subtitle) {
  if (eventName != null && headerEventName) {
    if (headerEventName.textContent !== eventName) {
      headerEventName.textContent = eventName;
    }
    const displayName = document.getElementById("display-event-name");
    if (displayName && displayName.textContent !== eventName) {
      displayName.textContent = eventName;
    }
    if (document.title !== eventName) document.title = eventName;
  }
  if (subtitle != null && headerSubtitle) {
    if (headerSubtitle.textContent !== subtitle) {
      headerSubtitle.textContent = subtitle;
    }
    headerSubtitle.hidden = subtitle.trim() === "";
    headerSubtitle.setAttribute("data-ready", "1");
  }
  document.getElementById("header-title")?.setAttribute("data-ready", "1");
  if (eventName != null || subtitle != null) {
    persistBrandingCache({
      eventName: eventName != null ? eventName : undefined,
      subtitle: subtitle != null ? subtitle : undefined,
    });
  }
}

function fillSettings(s) {
  if (s.songMemory != null) songMemoryInput.value = s.songMemory;
  if (s.artistWindow != null) artistWindowInput.value = s.artistWindow;
  if (s.artistCap != null) artistCapInput.value = s.artistCap;
  if (s.strictFill != null) strictFillInput.checked = !!s.strictFill;
  if (s.discoverEnabled != null) discoverEnabledInput.checked = !!s.discoverEnabled;
  if (s.randomMoodEnabled != null && randomMoodToggle) {
    randomMoodToggle.checked = !!s.randomMoodEnabled;
  }
  if (s.randomDecadeEnabled != null && randomDecadeToggle) {
    randomDecadeToggle.checked = !!s.randomDecadeEnabled;
  }
  if (s.randomMoodEverySets != null && randomMoodEveryInput) {
    randomMoodEveryInput.value = s.randomMoodEverySets;
  }
  if (s.randomDecadeEverySets != null && randomDecadeEveryInput) {
    randomDecadeEveryInput.value = s.randomDecadeEverySets;
  }
  if (Array.isArray(s.randomMoodPool)) {
    paintRotationPool(rotationMoodPool, "data-pool-preset", s.randomMoodPool);
  }
  if (Array.isArray(s.randomDecadePool)) {
    paintRotationPool(rotationDecadePool, "data-pool-decade", s.randomDecadePool);
  }
  if (s.similarCount != null) similarCountInput.value = s.similarCount;
  if (s.requestFairnessEnabled != null && requestFairnessEnabledInput) {
    requestFairnessEnabledInput.checked = !!s.requestFairnessEnabled;
  }
  if (
    s.requestFairnessUpcomingThreshold != null &&
    requestFairnessThresholdInput
  ) {
    requestFairnessThresholdInput.value = s.requestFairnessUpcomingThreshold;
  }
  if (s.requestFairnessUpcomingCap != null && requestFairnessUpcomingInput) {
    requestFairnessUpcomingInput.value = s.requestFairnessUpcomingCap;
  }
  if (s.requestFairnessRollingMax != null && requestFairnessRollingMaxInput) {
    requestFairnessRollingMaxInput.value = s.requestFairnessRollingMax;
  }
  if (s.requestFairnessWindowMinutes != null && requestFairnessWindowInput) {
    requestFairnessWindowInput.value = s.requestFairnessWindowMinutes;
  }
  if (s.requestFairnessHostBypass != null && requestFairnessHostBypassInput) {
    requestFairnessHostBypassInput.checked = !!s.requestFairnessHostBypass;
  }
  if (s.endlessQueueCount != null && endlessCountInput) {
    endlessCountInput.value = s.endlessQueueCount;
    if (autofillHint) {
      autofillHint.textContent = `Auto-adds ${s.endlessQueueCount} songs when the queue runs low`;
    }
  }
  if (s.filterExplicit != null) filterExplicitInput.checked = !!s.filterExplicit;
  if (s.requestsPaused != null && requestsPausedInput) {
    requestsPausedInput.checked = !!s.requestsPaused;
    setRequestsPausedUi(!!s.requestsPaused);
  }
  if (s.partyOver != null) setPartyOverUi(!!s.partyOver);
  if (s.hostControlsOnly != null && hostControlsInput) {
    hostControlsOnly = !!s.hostControlsOnly;
    hostControlsInput.checked = hostControlsOnly;
    syncHostControlsVisibility();
  }
  if (s.kidsLock != null && kidsLockInput) {
    kidsLockInput.checked = !!s.kidsLock;
  }
  if (Array.isArray(s.genres)) {
    genreSelection = new Set(s.genres);
    saveGenreSelection();
    if (genreBuckets.length) {
      renderGenres();
      refreshPoolSizeHint();
    }
  }
  if (s.djVoiceEnabled != null && djVoiceToggle) {
    djVoiceToggle.checked = !!s.djVoiceEnabled;
  }
  if (s.djName != null && djNameInput) djNameInput.value = s.djName;
  if (s.djNameIntroPercent != null && djIntroPercentInput) {
    djIntroPercentInput.value = s.djNameIntroPercent;
  }
  if (s.djAnnounceMaxWords != null && djMaxWordsInput) {
    djMaxWordsInput.value = s.djAnnounceMaxWords;
  }
  if (s.djVolumeBumpLowPct != null && djVolumeLowInput) {
    djVolumeLowInput.value = s.djVolumeBumpLowPct;
  }
  if (s.djVolumeBumpMidPct != null && djVolumeMidInput) {
    djVolumeMidInput.value = s.djVolumeBumpMidPct;
  }
  if (s.djVolumeBumpHighPct != null && djVolumeHighInput) {
    djVolumeHighInput.value = s.djVolumeBumpHighPct;
  }
  if (s.djHandoffSilenceSec != null && djSilenceInput) {
    djSilenceInput.value = String(s.djHandoffSilenceSec);
  }
  if (s.djTtsProvider != null && djTtsProviderInput) {
    djTtsProviderInput.value = String(s.djTtsProvider);
  }
  if (s.djTtsVoiceOpenAi != null && djTtsVoiceInput) {
    djTtsVoiceInput.value = String(s.djTtsVoiceOpenAi);
  } else if (s.djTtsVoice != null && djTtsVoiceInput && s.djTtsProvider === "openai_ha") {
    djTtsVoiceInput.value = String(s.djTtsVoice);
  }
  if (s.djTtsVoiceElevenlabs != null && djTtsVoiceElevenlabsInput) {
    djTtsVoiceElevenlabsInput.value = String(s.djTtsVoiceElevenlabs);
  } else if (
    s.djTtsVoice != null &&
    djTtsVoiceElevenlabsInput &&
    s.djTtsProvider === "elevenlabs_ha"
  ) {
    djTtsVoiceElevenlabsInput.value = String(s.djTtsVoice);
  }
  syncDjTtsProviderUi();
  if (s.djTtsSpeed != null && djTtsSpeedInput) {
    djTtsSpeedInput.value = String(s.djTtsSpeed);
  }
  if (s.djCharacterIntensity != null && djIntensityInput) {
    djIntensityInput.value = String(s.djCharacterIntensity);
  }
  if (s.djCatchphrase != null && djCatchphraseInput) {
    djCatchphraseInput.value = String(s.djCatchphrase);
  }
  if (s.djBanList != null && djBanListInput) {
    djBanListInput.value = String(s.djBanList);
  }
  if (s.djPersonaNotes != null && djPersonaNotesInput) {
    djPersonaNotesInput.value = String(s.djPersonaNotes);
  }
  if (s.djAlwaysInstructions != null && djAlwaysInstructionsInput) {
    djAlwaysInstructionsInput.value = String(s.djAlwaysInstructions);
  }
  if (s.djNeverInstructions != null && djNeverInstructionsInput) {
    djNeverInstructionsInput.value = String(s.djNeverInstructions);
  }
  if (s.djPronunciations != null && djPronunciationsInput) {
    djPronunciationsInput.value = String(s.djPronunciations);
  }
  if (s.djShoutEnabled != null && djShoutEnabledInput) {
    djShoutEnabledInput.checked = !!s.djShoutEnabled;
  }
  if (s.djShoutMode != null && djShoutModeInput) {
    djShoutModeInput.value = String(s.djShoutMode);
  }
  if (s.djShoutPercent != null && djShoutPercentInput) {
    djShoutPercentInput.value = s.djShoutPercent;
  }
  if (s.djShoutEveryN != null && djShoutEveryInput) {
    djShoutEveryInput.value = s.djShoutEveryN;
  }
  syncDjShoutModeUi();
  if (s.djPartyRecapEnabled != null && djPartyRecapEnabledInput) {
    djPartyRecapEnabledInput.checked = !!s.djPartyRecapEnabled;
  }
  if (
    s.endOfNightTrackUri !== undefined ||
    s.endOfNightTrackName !== undefined ||
    s.endOfNightTrackArtist !== undefined
  ) {
    endOfNightTrack = {
      uri: s.endOfNightTrackUri || null,
      name: s.endOfNightTrackName || "Closing Time",
      artist: s.endOfNightTrackArtist || (s.endOfNightTrackUri ? "" : "Semisonic"),
    };
    if (!endOfNightTrack.uri) {
      endOfNightTrack = { uri: null, name: "Closing Time", artist: "Semisonic" };
    }
    paintEndOfNightLabel();
  }
  if (s.eventName != null) eventNameInput.value = s.eventName;
  if (s.subtitle != null) subtitleInput.value = s.subtitle;
  if (s.showVersion != null) {
    showVersionInput.checked = !!s.showVersion;
    if (headerVersion) headerVersion.hidden = !s.showVersion;
    persistBrandingCache({ showVersion: !!s.showVersion });
  }
  if (s.showQueueGenre != null) {
    syncShowQueueGenre(!!s.showQueueGenre, { rerender: true });
  }
  if (s.heroBanner !== undefined) applyHero(s.heroBanner);
  applyBranding(s.eventName, s.subtitle);
  if (s.defaults) settingsDefaults = s.defaults;
  if (Object.prototype.hasOwnProperty.call(s, "djIcon")) {
    activeDjIconName = s.djIcon || null;
  }
  updateDjHubSummaries();
}

function formatDjIconLabel(name) {
  if (!name) return "Default";
  const base = String(name)
    .replace(/\.[^.]+$/, "")
    .replace(/^dj-icon-(?:\d+-)?/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  const label = base || String(name);
  return label.length > 28 ? `${label.slice(0, 27)}…` : label;
}

function updateDjHubSummaries() {
  // The Sonos media URL card lives on this hub now.
  void refreshBoothMediaUrl();
  const bannerEl = document.getElementById("dj-stat-banner");
  const nameEl = document.getElementById("dj-stat-name");
  const voiceEl = document.getElementById("dj-stat-voice");
  const advancedEl = document.getElementById("dj-stat-advanced");
  const volumeEl = document.getElementById("dj-stat-volume");
  const shoutsEl = document.getElementById("dj-stat-shouts");

  if (bannerEl) bannerEl.textContent = formatDjIconLabel(activeDjIconName);

  if (nameEl) {
    const name = (djNameInput?.value || "").trim() || "Party DJ";
    nameEl.textContent = name;
  }

  if (voiceEl) {
    const intensity = String(djIntensityInput?.value || "classic");
    const intensityLabel =
      intensity.charAt(0).toUpperCase() + intensity.slice(1);
    const provider =
      (djTtsProviderInput?.value || "elevenlabs_ha") === "openai_ha"
        ? "OpenAI"
        : "ElevenLabs";
    const speed = Number(djTtsSpeedInput?.value ?? 1);
    const speedLabel = Number.isFinite(speed) ? `${speed}×` : "1×";
    voiceEl.textContent = `${intensityLabel} · ${provider} · ${speedLabel}`;
  }

  if (advancedEl) {
    const customSections = [
      djPersonaNotesInput?.value,
      djAlwaysInstructionsInput?.value,
      djNeverInstructionsInput?.value,
    ].filter((value) => String(value || "").trim()).length;
    const pronunciationCount = String(djPronunciationsInput?.value || "")
      .split(/\r?\n/)
      .filter((line) => /(?:=>|=)/.test(line)).length;
    advancedEl.textContent =
      customSections || pronunciationCount
        ? `${customSections} guidance · ${pronunciationCount} pronunciations`
        : "Core locked";
  }

  if (volumeEl) {
    const low = djVolumeLowInput?.value ?? "—";
    const mid = djVolumeMidInput?.value ?? "—";
    const high = djVolumeHighInput?.value ?? "—";
    const silence = djSilenceInput?.value ?? "—";
    volumeEl.textContent = `${low}/${mid}/${high}% · ${silence}s`;
  }

  if (shoutsEl) {
    const mode = djShoutModeInput?.value || "every";
    if (mode === "every") {
      const n = djShoutEveryInput?.value || "5";
      shoutsEl.textContent = `Every ${n}`;
    } else {
      const pct = djShoutPercentInput?.value ?? "25";
      shoutsEl.textContent = `${pct}% of the time`;
    }
  }

  const lastCallEl = document.getElementById("dj-stat-lastcall");
  if (lastCallEl) {
    const title = (endOfNightTrack.name || "Closing Time").trim();
    lastCallEl.textContent = title.length > 22 ? `${title.slice(0, 20)}…` : title;
  }
}

function paintEndOfNightLabel() {
  const name = (endOfNightTrack.name || "Closing Time").trim();
  const artist = (endOfNightTrack.artist || "").trim();
  const label = artist ? `${name} — ${artist}` : name;
  if (endOfNightLabelEl) {
    endOfNightLabelEl.textContent = endOfNightTrack.uri
      ? label
      : `${label} (default)`;
  }
  updateDjHubSummaries();
}

async function loadSettings() {
  try {
    const res = await hostFetch("/api/settings");
    if (!res.ok) return;
    fillSettings(await res.json());
  } catch {
    /* leave inputs blank on transient errors */
  }
}

async function saveSettings(values, { toastMessage = null } = {}) {
  if (settingsSaveBtn) settingsSaveBtn.disabled = true;
  if (settingsResetBtn) settingsResetBtn.disabled = true;
  try {
    const res = await hostFetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not save settings.");
    fillSettings(data); // reflect the clamped/effective values
    if (toastMessage) showToast(toastMessage);
    return true;
  } catch (err) {
    showToast(err.message, true);
    return false;
  } finally {
    if (settingsSaveBtn) settingsSaveBtn.disabled = false;
    if (settingsResetBtn) settingsResetBtn.disabled = false;
  }
}

function currentSettingsPayload() {
  return {
    songMemory: Number(songMemoryInput.value),
    artistWindow: Number(artistWindowInput.value),
    artistCap: Number(artistCapInput.value),
    strictFill: strictFillInput.checked,
    discoverEnabled: discoverEnabledInput.checked,
    similarCount: Number(similarCountInput.value),
    endlessQueueCount: Number(endlessCountInput?.value),
    requestFairnessEnabled: !!requestFairnessEnabledInput?.checked,
    requestFairnessUpcomingThreshold: Number(
      requestFairnessThresholdInput?.value
    ),
    requestFairnessUpcomingCap: Number(requestFairnessUpcomingInput?.value),
    requestFairnessRollingMax: Number(requestFairnessRollingMaxInput?.value),
    requestFairnessWindowMinutes: Number(requestFairnessWindowInput?.value),
    requestFairnessHostBypass: !!requestFairnessHostBypassInput?.checked,
    randomMoodEverySets: Number(randomMoodEveryInput?.value),
    randomDecadeEverySets: Number(randomDecadeEveryInput?.value),
  };
}

settingsSaveBtn?.addEventListener("click", () => {
  saveSettings(currentSettingsPayload(), { toastMessage: "Saved" });
});

// Discover state is broadcast in the Now Playing payload (settings need host
// auth, and sessions reset on deploy — without this the toggle looked off).
// Same stale-poll guard as the Never-Ending toggle.
let discoverTouchedAt = 0;
function syncDiscoverFromServer(enabled) {
  if (typeof enabled !== "boolean" || !discoverEnabledInput) return;
  if (Date.now() - discoverTouchedAt < 3000) return;
  if (discoverEnabledInput.checked !== enabled) {
    discoverEnabledInput.checked = enabled;
  }
}

// Filter explicit / Kids lock also live on Vibe and used to stay on HTML
// defaults until a host save hydrated fillSettings.
let contentToggleTouchedAt = 0;
function syncContentTogglesFromServer(payload) {
  if (!payload || Date.now() - contentToggleTouchedAt < 3000) return;
  if (typeof payload.filterExplicit === "boolean" && filterExplicitInput) {
    if (filterExplicitInput.checked !== payload.filterExplicit) {
      filterExplicitInput.checked = payload.filterExplicit;
    }
  }
  if (typeof payload.kidsLock === "boolean" && kidsLockInput) {
    if (kidsLockInput.checked !== payload.kidsLock) {
      kidsLockInput.checked = payload.kidsLock;
    }
  }
}

// Persist the discovery toggle immediately so it works without hitting Save.
// Targeted payload: this toggle lives in Vibe, where the other settings
// inputs may never have been filled (e.g. right after a deploy logs the host
// out) — a full-form save would clamp those blanks into real values.
discoverEnabledInput.addEventListener("change", () => {
  discoverTouchedAt = Date.now();
  saveSettings({ discoverEnabled: discoverEnabledInput.checked });
});

// Random Mood / Random Decade: rotate the mix between Never-Ending sets.
// Same broadcast-sync + targeted-save pattern as Discover.
let rotationTouchedAt = 0;
function syncRotationFromServer(payload) {
  if (!payload || Date.now() - rotationTouchedAt < 3000) return;
  if (typeof payload.randomMoodEnabled === "boolean" && randomMoodToggle) {
    randomMoodToggle.checked = payload.randomMoodEnabled;
  }
  if (typeof payload.randomDecadeEnabled === "boolean" && randomDecadeToggle) {
    randomDecadeToggle.checked = payload.randomDecadeEnabled;
  }
}
randomMoodToggle?.addEventListener("change", () => {
  rotationTouchedAt = Date.now();
  saveSettings(
    { randomMoodEnabled: randomMoodToggle.checked },
    {
      toastMessage: randomMoodToggle.checked
        ? "Random Mood on — mood rotates between sets"
        : "Random Mood off",
    }
  );
});
randomDecadeToggle?.addEventListener("change", () => {
  rotationTouchedAt = Date.now();
  saveSettings(
    { randomDecadeEnabled: randomDecadeToggle.checked },
    {
      toastMessage: randomDecadeToggle.checked
        ? "Random Decade on — decade rotates between sets"
        : "Random Decade off",
    }
  );
});

// Rotation pool chips (Booth > Queue): what Random Mood / Random Decade may
// pick from. Chips save on tap; the server echoes the effective pools back
// through fillSettings, which repaints via paintRotationPool.
function paintRotationPool(container, attr, ids) {
  if (!container) return;
  const set = new Set(Array.isArray(ids) ? ids : []);
  for (const btn of container.querySelectorAll(`[${attr}]`)) {
    const on = set.has(btn.getAttribute(attr));
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
}
function wireRotationPool(container, attr, settingsKey) {
  if (!container) return;
  container.addEventListener("click", (e) => {
    const btn = e.target.closest(`[${attr}]`);
    if (!btn) return;
    const on = !btn.classList.contains("on");
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    const ids = [...container.querySelectorAll(`[${attr}].on`)].map((b) =>
      b.getAttribute(attr)
    );
    saveSettings({ [settingsKey]: ids });
  });
}
wireRotationPool(rotationMoodPool, "data-pool-preset", "randomMoodPool");
wireRotationPool(rotationDecadePool, "data-pool-decade", "randomDecadePool");

// Strict fill also saves immediately — it's a safety switch like Discover.
// Targeted payload: the toggle sits on the Booth page, so don't send the whole
// Queue form (it may not be loaded when host sessions reset on deploy).
strictFillInput.addEventListener("change", () => {
  saveSettings({ strictFill: strictFillInput.checked });
});

// Host bypass lives on the Booth page now, away from the Queue panel's Save
// button, so it saves on flip like the other Booth switches.
requestFairnessHostBypassInput?.addEventListener("change", () => {
  saveSettings({
    requestFairnessHostBypass: !!requestFairnessHostBypassInput.checked,
  });
});

requestFairnessEnabledInput?.addEventListener("change", () => {
  saveSettings(
    { requestFairnessEnabled: !!requestFairnessEnabledInput.checked },
    {
      toastMessage: requestFairnessEnabledInput.checked
        ? "Request fairness enabled"
        : "Request fairness disabled",
    }
  );
});

// The explicit filter is an independent switch (like Never-Ending Queue): it
// saves on its own and isn't touched by the Song Selection Save / Defaults.
filterExplicitInput.addEventListener("change", () => {
  contentToggleTouchedAt = Date.now();
  saveSettings({ filterExplicit: filterExplicitInput.checked });
});

requestsPausedInput?.addEventListener("change", () => {
  const on = !!requestsPausedInput.checked;
  setRequestsPausedUi(on);
  saveSettings({ requestsPaused: on }, {
    toastMessage: on ? "Requests paused" : "Requests open again",
  });
});

partyOverInput?.addEventListener("change", () => {
  const on = !!partyOverInput.checked;
  partyOverTouchedAt = Date.now();
  setPartyOverUi(on);
  saveSettings({ partyOver: on }, {
    toastMessage: on
      ? "The party is over — requests locked"
      : "Party's back on — requests open",
  });
});

hostControlsInput?.addEventListener("change", () => {
  const on = !!hostControlsInput.checked;
  if (on && !settingsPinRequired) {
    hostControlsInput.checked = false;
    showToast("Set a host PIN before enabling host-only controls.", true);
    return;
  }
  hostControlsOnly = on;
  syncHostControlsVisibility();
  saveSettings(
    { hostControlsOnly: on },
    { toastMessage: on ? "Controls limited to the host" : "Party controls open" }
  );
});

kidsLockInput?.addEventListener("change", async () => {
  const on = !!kidsLockInput.checked;
  contentToggleTouchedAt = Date.now();
  kidsLockInput.disabled = true;
  try {
    await saveSettings(
      { kidsLock: on },
      { toastMessage: on ? "Kids lock on" : "Kids lock off" }
    );
  } finally {
    kidsLockInput.disabled = false;
  }
});

const GUEST_BANNER_PAUSED =
  "Requests are paused — ask the host when you can add songs again.";
const GUEST_BANNER_PARTY_OVER =
  "The party is over — you have to go home now.";

// One banner serves both locks; Party's Over (the hard end-of-night state)
// wins over a plain request pause when both are set.
function updateGuestLockBanner() {
  if (!requestsPausedBanner) return;
  requestsPausedBanner.hidden = !(partyOver || requestsPaused);
  requestsPausedBanner.textContent = partyOver
    ? GUEST_BANNER_PARTY_OVER
    : GUEST_BANNER_PAUSED;
  requestsPausedBanner.classList.toggle("party-over", partyOver);
}

function setRequestsPausedUi(on) {
  requestsPaused = !!on;
  updateGuestLockBanner();
}

// Remember when the host touched the booth toggle so an in-flight Now Playing
// poll can't briefly flip it back (same pattern as the autofill toggle).
let partyOverTouchedAt = 0;
function setPartyOverUi(on) {
  partyOver = !!on;
  if (partyOverInput) partyOverInput.checked = partyOver;
  if (displayPartyOverPill) displayPartyOverPill.hidden = !partyOver;
  updateGuestLockBanner();
}

// DJ Voice: announce each new set via Home Assistant (needs HA credentials).
if (djVoiceToggle) {
  djVoiceToggle.addEventListener("change", () => {
    saveSettings({ djVoiceEnabled: djVoiceToggle.checked });
  });
}

function syncDjTtsProviderUi() {
  const provider = djTtsProviderInput?.value || "elevenlabs_ha";
  const eleven = provider === "elevenlabs_ha";
  if (djTtsVoiceOpenaiRow) djTtsVoiceOpenaiRow.hidden = eleven;
  if (djTtsVoiceElevenlabsRow) djTtsVoiceElevenlabsRow.hidden = !eleven;
}

function syncDjShoutModeUi() {
  const every = (djShoutModeInput?.value || "every") === "every";
  if (djShoutPercentRow) djShoutPercentRow.hidden = every;
  if (djShoutEveryRow) djShoutEveryRow.hidden = !every;
}

function currentDjVoicePayload() {
  const provider = djTtsProviderInput?.value || "elevenlabs_ha";
  return {
    djName: djNameInput?.value ?? "",
    djNameIntroPercent: Number(djIntroPercentInput?.value),
    djAnnounceMaxWords: Number(djMaxWordsInput?.value),
    djVolumeBumpLowPct: Number(djVolumeLowInput?.value),
    djVolumeBumpMidPct: Number(djVolumeMidInput?.value),
    djVolumeBumpHighPct: Number(djVolumeHighInput?.value),
    djHandoffSilenceSec: Number(djSilenceInput?.value),
    djTtsProvider: provider,
    djTtsVoiceOpenAi: djTtsVoiceInput?.value ?? "onyx",
    djTtsVoiceElevenlabs: djTtsVoiceElevenlabsInput?.value?.trim() || "",
    djTtsVoice:
      provider === "openai_ha"
        ? djTtsVoiceInput?.value ?? "onyx"
        : djTtsVoiceElevenlabsInput?.value?.trim() || "",
    djTtsSpeed: Number(djTtsSpeedInput?.value ?? 1),
    djCharacterIntensity: djIntensityInput?.value ?? "classic",
    djCatchphrase: djCatchphraseInput?.value ?? "",
    djBanList: djBanListInput?.value ?? "",
    djPersonaNotes: djPersonaNotesInput?.value ?? "",
    djAlwaysInstructions: djAlwaysInstructionsInput?.value ?? "",
    djNeverInstructions: djNeverInstructionsInput?.value ?? "",
    djPronunciations: djPronunciationsInput?.value ?? "",
    djShoutEnabled: !!djShoutEnabledInput?.checked,
    djShoutMode: djShoutModeInput?.value || "every",
    djShoutPercent: Number(djShoutPercentInput?.value),
    djShoutEveryN: Number(djShoutEveryInput?.value),
  };
}

async function runDjVoicePreview(btn) {
  const provider = djTtsProviderInput?.value || "elevenlabs_ha";
  const voice =
    provider === "openai_ha"
      ? djTtsVoiceInput?.value || "onyx"
      : djTtsVoiceElevenlabsInput?.value?.trim() || "";
  const speed = Number(djTtsSpeedInput?.value || 1);
  if (btn) btn.disabled = true;
  const prevLabel = btn?.textContent;
  if (btn) btn.textContent = "…";
  showToast("Generating sample…", false, 8000);
  try {
    const res = await hostFetch("/api/dj-voice/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice, speed, provider }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not preview voice.");
    if (!data.url) throw new Error("Preview returned no audio URL.");

    if (djVoicePreviewPlayer) {
      djVoicePreviewPlayer.hidden = false;
      djVoicePreviewPlayer.src = data.url;
      djVoicePreviewPlayer.load();
      try {
        await djVoicePreviewPlayer.play();
        showToast(
          `Playing ${data.provider || provider} · ${data.voice || voice} @ ${data.speed ?? speed}×`
        );
      } catch {
        showToast("Sample ready — press play on the player below.", false, 5000);
      }
    } else {
      const audio = new Audio(data.url);
      await audio.play();
      showToast(`Playing ${data.voice || voice} @ ${data.speed ?? speed}×`);
    }
  } catch (err) {
    showToast(err.message || "Voice test failed.", true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = prevLabel;
    }
  }
}

if (djTtsProviderInput) {
  djTtsProviderInput.addEventListener("change", syncDjTtsProviderUi);
}

djVoiceSaveBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    saveSettings(currentDjVoicePayload(), { toastMessage: "Saved" });
  });
});

async function loadDjEffectivePrompt() {
  if (!djEffectivePromptInput) return;
  const btn = djAdvancedPreviewRefreshBtn;
  if (btn) btn.disabled = true;
  djEffectivePromptInput.value = "Loading effective prompt…";
  try {
    const res = await hostFetch("/api/dj-voice/prompt-preview", {
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not load prompt preview.");
    djEffectivePromptInput.value = data.prompt || "(No prompt returned.)";
  } catch (err) {
    djEffectivePromptInput.value = "";
    showToast(err.message || "Could not load prompt preview.", true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

if (djAdvancedSaveBtn) {
  djAdvancedSaveBtn.addEventListener("click", async () => {
    djAdvancedSaveBtn.disabled = true;
    try {
      const saved = await saveSettings(currentDjVoicePayload(), {
        toastMessage: "Advanced DJ saved",
      });
      if (saved) await loadDjEffectivePrompt();
    } finally {
      djAdvancedSaveBtn.disabled = false;
    }
  });
}

djAdvancedPreviewRefreshBtn?.addEventListener("click", () => {
  void loadDjEffectivePrompt();
});

djAdvancedResetBtn?.addEventListener("click", async () => {
  const d = settingsDefaults || {};
  const values = {
    djPersonaNotes: d.djPersonaNotes ?? "",
    djAlwaysInstructions: d.djAlwaysInstructions ?? "",
    djNeverInstructions: d.djNeverInstructions ?? "",
    djPronunciations: d.djPronunciations ?? "",
  };
  fillSettings(values);
  const saved = await saveSettings(values, {
    toastMessage: "Advanced DJ set to defaults",
  });
  if (saved) await loadDjEffectivePrompt();
});

if (djVoiceTestBtn) {
  djVoiceTestBtn.addEventListener("click", () => runDjVoicePreview(djVoiceTestBtn));
}
if (djVoiceTestElevenlabsBtn) {
  djVoiceTestElevenlabsBtn.addEventListener("click", () =>
    runDjVoicePreview(djVoiceTestElevenlabsBtn)
  );
}

async function resetDjVoiceDefaults() {
  const d = settingsDefaults || {};
  fillSettings({
    djName: d.djName ?? "Party DJ",
    djNameIntroPercent: d.djNameIntroPercent ?? 25,
    djAnnounceMaxWords: d.djAnnounceMaxWords ?? 55,
    djVolumeBumpLowPct: d.djVolumeBumpLowPct ?? 20,
    djVolumeBumpMidPct: d.djVolumeBumpMidPct ?? 8,
    djVolumeBumpHighPct: d.djVolumeBumpHighPct ?? 4,
    djHandoffSilenceSec: d.djHandoffSilenceSec ?? 3,
    djTtsProvider: d.djTtsProvider ?? "elevenlabs_ha",
    djTtsVoiceOpenAi: d.djTtsVoiceOpenAi ?? "onyx",
    djTtsVoiceElevenlabs: d.djTtsVoiceElevenlabs ?? "",
    djTtsSpeed: d.djTtsSpeed ?? 1,
    djCharacterIntensity: d.djCharacterIntensity ?? "extra",
    djCatchphrase: d.djCatchphrase ?? "",
    djBanList: d.djBanList ?? "",
    djPersonaNotes: d.djPersonaNotes ?? "",
    djAlwaysInstructions: d.djAlwaysInstructions ?? "",
    djNeverInstructions: d.djNeverInstructions ?? "",
    djPronunciations: d.djPronunciations ?? "",
    djShoutEnabled: d.djShoutEnabled ?? true,
    djShoutMode: d.djShoutMode ?? "every",
    djShoutPercent: d.djShoutPercent ?? 25,
    djShoutEveryN: d.djShoutEveryN ?? 5,
    djPartyRecapEnabled: d.djPartyRecapEnabled ?? true,
    endOfNightTrackUri: null,
    endOfNightTrackName: null,
    endOfNightTrackArtist: null,
  });
  endOfNightTrack = { uri: null, name: "Closing Time", artist: "Semisonic" };
  paintEndOfNightLabel();
  if (djPartyRecapEnabledInput) {
    djPartyRecapEnabledInput.checked = d.djPartyRecapEnabled ?? true;
  }
  try {
    await selectDjIcon(null);
  } catch {
    /* icon select is best-effort; text defaults still save */
  }
  saveSettings(
    {
      djName: d.djName ?? "Party DJ",
      djNameIntroPercent: d.djNameIntroPercent ?? 25,
      djAnnounceMaxWords: d.djAnnounceMaxWords ?? 55,
      djVolumeBumpLowPct: d.djVolumeBumpLowPct ?? 20,
      djVolumeBumpMidPct: d.djVolumeBumpMidPct ?? 8,
      djVolumeBumpHighPct: d.djVolumeBumpHighPct ?? 4,
      djHandoffSilenceSec: d.djHandoffSilenceSec ?? 3,
      djTtsProvider: d.djTtsProvider ?? "elevenlabs_ha",
      djTtsVoiceOpenAi: d.djTtsVoiceOpenAi ?? "onyx",
      djTtsVoiceElevenlabs: d.djTtsVoiceElevenlabs ?? "",
      djTtsSpeed: d.djTtsSpeed ?? 1,
      djCharacterIntensity: d.djCharacterIntensity ?? "extra",
      djCatchphrase: d.djCatchphrase ?? "",
      djBanList: d.djBanList ?? "",
      djPersonaNotes: d.djPersonaNotes ?? "",
      djAlwaysInstructions: d.djAlwaysInstructions ?? "",
      djNeverInstructions: d.djNeverInstructions ?? "",
      djPronunciations: d.djPronunciations ?? "",
      djShoutEnabled: d.djShoutEnabled ?? true,
      djShoutMode: d.djShoutMode ?? "every",
      djShoutPercent: d.djShoutPercent ?? 25,
      djShoutEveryN: d.djShoutEveryN ?? 5,
      djPartyRecapEnabled: d.djPartyRecapEnabled ?? true,
      endOfNightTrackUri: null,
      endOfNightTrackName: null,
      endOfNightTrackArtist: null,
      djIcon: null,
    },
    { toastMessage: "Set to Default" }
  );
}

djVoiceResetBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    void resetDjVoiceDefaults();
  });
});

if (djShoutModeInput) {
  djShoutModeInput.addEventListener("change", syncDjShoutModeUi);
}
if (djShoutEnabledInput) {
  djShoutEnabledInput.addEventListener("change", () => {
    saveSettings({ djShoutEnabled: !!djShoutEnabledInput.checked });
  });
}

if (djPartyRecapEnabledInput) {
  djPartyRecapEnabledInput.addEventListener("change", () => {
    saveSettings({ djPartyRecapEnabled: !!djPartyRecapEnabledInput.checked });
  });
}

async function searchEndOfNightTracks(q) {
  if (!endOfNightResultsEl) return;
  const query = String(q || "").trim();
  if (query.length < 2) {
    endOfNightResultsEl.hidden = true;
    endOfNightResultsEl.innerHTML = "";
    return;
  }
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Search failed.");
    const tracks = Array.isArray(data.tracks) ? data.tracks.slice(0, 8) : [];
    if (!tracks.length) {
      endOfNightResultsEl.hidden = false;
      endOfNightResultsEl.innerHTML =
        '<p class="setting-hint">No tracks found.</p>';
      return;
    }
    endOfNightResultsEl.hidden = false;
    endOfNightResultsEl.innerHTML = "";
    for (const t of tracks) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "end-of-night-result";
      btn.innerHTML = `<span class="end-of-night-result-meta"><span class="end-of-night-result-title"></span><span class="end-of-night-result-artist"></span></span><span>Use</span>`;
      btn.querySelector(".end-of-night-result-title").textContent = t.name || "Track";
      btn.querySelector(".end-of-night-result-artist").textContent = t.artist || "";
      btn.addEventListener("click", () => {
        void pickEndOfNightTrack(t);
      });
      endOfNightResultsEl.appendChild(btn);
    }
  } catch (err) {
    endOfNightResultsEl.hidden = false;
    endOfNightResultsEl.innerHTML = `<p class="setting-hint">${escapeHtml(err.message || "Search failed.")}</p>`;
  }
}

async function pickEndOfNightTrack(t) {
  const uri = t?.uri || null;
  if (!uri) {
    showToast("That track has no Spotify URI.", true);
    return;
  }
  try {
    await saveSettings(
      {
        endOfNightTrackUri: uri,
        endOfNightTrackName: t.name || "",
        endOfNightTrackArtist: t.artist || "",
      },
      { toastMessage: "End of night song saved" }
    );
    endOfNightTrack = {
      uri,
      name: t.name || "Last call song",
      artist: t.artist || "",
    };
    paintEndOfNightLabel();
    if (endOfNightSearchInput) endOfNightSearchInput.value = "";
    if (endOfNightResultsEl) {
      endOfNightResultsEl.hidden = true;
      endOfNightResultsEl.innerHTML = "";
    }
  } catch (err) {
    showToast(err.message || "Could not save song.", true);
  }
}

if (endOfNightSearchInput) {
  endOfNightSearchInput.addEventListener("input", () => {
    clearTimeout(endOfNightSearchTimer);
    endOfNightSearchTimer = setTimeout(() => {
      void searchEndOfNightTracks(endOfNightSearchInput.value);
    }, 280);
  });
}

if (endOfNightResetBtn) {
  endOfNightResetBtn.addEventListener("click", async () => {
    try {
      await saveSettings(
        {
          endOfNightTrackUri: null,
          endOfNightTrackName: null,
          endOfNightTrackArtist: null,
        },
        { toastMessage: "Reset to Closing Time" }
      );
      endOfNightTrack = {
        uri: null,
        name: "Closing Time",
        artist: "Semisonic",
      };
      paintEndOfNightLabel();
      if (endOfNightSearchInput) endOfNightSearchInput.value = "";
      if (endOfNightResultsEl) {
        endOfNightResultsEl.hidden = true;
        endOfNightResultsEl.innerHTML = "";
      }
    } catch (err) {
      showToast(err.message || "Could not reset.", true);
    }
  });
}

function fillGuestBirthdayForm(g) {
  if (guestNameInput) guestNameInput.value = g?.name || "";
  if (guestNotesInput) guestNotesInput.value = "";
  const bday = String(g?.birthday || "");
  const [mm, dd] = bday.split("-");
  if (guestBdayMonth) guestBdayMonth.value = mm ? String(Number(mm)) : "";
  if (guestBdayDay) guestBdayDay.value = dd ? String(Number(dd)) : "";
  if (guestBdayRole) guestBdayRole.value = g?.birthdayRole || "star";
}

function formatGuestBirthday(g) {
  if (!g?.birthday) return "";
  const [mm, dd] = String(g.birthday).split("-").map(Number);
  if (!mm || !dd) return "";
  const months = [
    "",
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const roleId = String(g.birthdayRole || "star").trim().toLowerCase() || "star";
  return `${months[mm] || mm} ${dd} · birthday ${roleId}`;
}

function guestNoteCount(g) {
  const notes = Array.isArray(g?.notes) ? g.notes : g?.notes ? [g.notes] : [];
  return notes.length;
}

function guestHubStat(g) {
  const n = guestNoteCount(g);
  const notesLabel = n === 1 ? "1 note" : `${n} notes`;
  const bday = formatGuestBirthday(g);
  return bday ? `${notesLabel} · ${bday}` : `${notesLabel} · No birthday`;
}

function guestHubDesc(g) {
  const notes = Array.isArray(g?.notes) ? g.notes : g?.notes ? [g.notes] : [];
  const first = String(notes[0] || "").trim();
  if (!first) return "Tap to add notes or a birthday";
  return first.length > 72 ? `${first.slice(0, 71)}…` : first;
}

function setGuests(guests) {
  cachedGuests = Array.isArray(guests) ? guests : [];
  renderGuestHub(cachedGuests);
  refreshGuestEditNotes();
}

function openGuestEditor(guest) {
  editingGuestName = guest?.name || null;
  fillGuestBirthdayForm(guest || {});
  if (settingsUserEditTitle) {
    settingsUserEditTitle.textContent = editingGuestName || "Add user";
  }
  if (guestRemoveBtn) guestRemoveBtn.hidden = !editingGuestName;
  if (guestRenameBtn) guestRenameBtn.hidden = !editingGuestName;
  refreshGuestEditNotes();
  navigate("settings-user-edit");
  setTimeout(() => {
    if (editingGuestName) guestNotesInput?.focus();
    else guestNameInput?.focus();
  }, 50);
}

function renderGuestHub(guests) {
  if (!guestHubGrid) return;
  guestHubGrid.innerHTML = "";
  const list = Array.isArray(guests) ? guests : [];

  for (const g of list) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "settings-hub-card";
    btn.innerHTML = `
      <span class="settings-hub-title"></span>
      <span class="settings-hub-stat"></span>
      <span class="settings-hub-desc"></span>
    `;
    btn.querySelector(".settings-hub-title").textContent = g.name || "Guest";
    btn.querySelector(".settings-hub-stat").textContent = guestHubStat(g);
    btn.querySelector(".settings-hub-desc").textContent = guestHubDesc(g);
    btn.addEventListener("click", () => openGuestEditor(g));
    guestHubGrid.appendChild(btn);
  }

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "settings-hub-card settings-hub-card-full";
  addBtn.id = "guest-add-card";
  addBtn.innerHTML = `
    <span class="settings-hub-title">Add user</span>
    <span class="settings-hub-desc">New requestor notes and birthday</span>
  `;
  addBtn.addEventListener("click", () => openGuestEditor(null));
  guestHubGrid.appendChild(addBtn);
}

function refreshGuestEditNotes() {
  if (!guestListEl) return;
  guestListEl.innerHTML = "";
  const name = (guestNameInput?.value || editingGuestName || "").trim();
  const g =
    cachedGuests.find(
      (x) => (x.name || "").toLowerCase() === name.toLowerCase()
    ) || null;
  const notes = Array.isArray(g?.notes) ? g.notes : g?.notes ? [g.notes] : [];

  if (!name) {
    const empty = document.createElement("p");
    empty.className = "guest-list-empty";
    empty.textContent = "Enter a name, then add notes.";
    guestListEl.appendChild(empty);
    return;
  }
  if (!notes.length) {
    const empty = document.createElement("p");
    empty.className = "guest-list-empty";
    empty.textContent = "No notes yet — add one below.";
    guestListEl.appendChild(empty);
    return;
  }

  const notesUl = document.createElement("ul");
  notesUl.className = "guest-note-list";
  notes.forEach((note, idx) => {
    const li = document.createElement("li");
    li.className = "guest-note-item";
    const text = document.createElement("span");
    text.textContent = note;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "pill-btn guest-note-remove";
    rm.textContent = "×";
    rm.title = "Remove note";
    rm.setAttribute("aria-label", "Remove note");
    rm.addEventListener("click", async () => {
      try {
        const res = await fetch(
          `/api/guests/${encodeURIComponent(g.name || "")}/notes/${idx}`,
          { method: "DELETE" }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Could not remove note.");
        setGuests(data.guests);
      } catch (err) {
        showToast(err.message, true);
      }
    });
    li.appendChild(text);
    li.appendChild(rm);
    notesUl.appendChild(li);
  });
  guestListEl.appendChild(notesUl);
}

async function loadGuests() {
  try {
    const res = await hostFetch("/api/guests");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not load users.");
    setGuests(data.guests);
  } catch {
    /* leave list as-is on transient errors */
  }
}

if (guestSaveBtn) {
  guestSaveBtn.addEventListener("click", async () => {
    const name = guestNameInput?.value?.trim() || "";
    const note = guestNotesInput?.value?.trim() || "";
    if (!name) {
      showToast("Enter a name.", true);
      return;
    }
    if (!note) {
      showToast("Enter a short note.", true);
      return;
    }
    guestSaveBtn.disabled = true;
    try {
      const res = await hostFetch("/api/guests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, note }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not save note.");
      editingGuestName = name;
      if (settingsUserEditTitle) settingsUserEditTitle.textContent = name;
      if (guestRemoveBtn) guestRemoveBtn.hidden = false;
      setGuests(data.guests);
      if (guestNotesInput) guestNotesInput.value = "";
      showToast("Note added");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      guestSaveBtn.disabled = false;
    }
  });
}

if (guestBdaySaveBtn) {
  guestBdaySaveBtn.addEventListener("click", async () => {
    const name = guestNameInput?.value?.trim() || "";
    if (!name) {
      showToast("Enter a name.", true);
      return;
    }
    const month = guestBdayMonth?.value || "";
    const day = guestBdayDay?.value || "";
    const birthday =
      month && day ? `${month}/${day}` : null;
    const birthdayRole = guestBdayRole?.value || "star";
    guestBdaySaveBtn.disabled = true;
    try {
      const res = await hostFetch("/api/guests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, birthday, birthdayRole }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not save birthday.");
      editingGuestName = name;
      if (settingsUserEditTitle) settingsUserEditTitle.textContent = name;
      if (guestRemoveBtn) guestRemoveBtn.hidden = false;
      setGuests(data.guests);
      showToast(birthday ? "Birthday saved" : "Birthday cleared");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      guestBdaySaveBtn.disabled = false;
    }
  });
}

if (guestRenameBtn) {
  guestRenameBtn.addEventListener("click", async () => {
    const from = editingGuestName || "";
    const to = guestNameInput?.value?.trim() || "";
    if (!from) {
      showToast("Open a user first.", true);
      return;
    }
    if (!to) {
      showToast("Enter the new name.", true);
      return;
    }
    if (from === to) {
      showToast("Change the name field, then tap Rename.");
      return;
    }
    const ok = await confirmModal(
      `Rename ${from} to ${to}? Notes that mention the old name will be updated.`,
      "Rename"
    );
    if (!ok) return;
    guestRenameBtn.disabled = true;
    try {
      const res = await hostFetch("/api/guests/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not rename user.");
      editingGuestName = data.guest?.name || to;
      if (guestNameInput) guestNameInput.value = editingGuestName;
      if (settingsUserEditTitle) {
        settingsUserEditTitle.textContent = editingGuestName;
      }
      setGuests(data.guests);
      showToast(`Renamed to ${editingGuestName}`);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      guestRenameBtn.disabled = false;
    }
  });
}

if (guestRemoveBtn) {
  guestRemoveBtn.addEventListener("click", async () => {
    const name = guestNameInput?.value?.trim() || editingGuestName || "";
    if (!name) {
      showToast("Enter or select a name.", true);
      return;
    }
    const ok = await confirmModal(
      `Remove ${name}? Their notes and birthday will be deleted.`,
      "Remove user"
    );
    if (!ok) return;
    guestRemoveBtn.disabled = true;
    try {
      const res = await hostFetch(`/api/guests/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not remove user.");
      editingGuestName = null;
      setGuests(data.guests);
      showToast("Removed");
      navigate("settings-users");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      guestRemoveBtn.disabled = false;
    }
  });
}

if (guestBdayForgetBtn) {
  guestBdayForgetBtn.addEventListener("click", async () => {
    const name = guestNameInput?.value?.trim() || "";
    if (!name) {
      showToast("Enter or select a name.", true);
      return;
    }
    const ok = await confirmModal(
      `Reset tonight's birthday shout for ${name}? Their next request can get a first-request birthday wish again.`,
      "Reset birthday shout"
    );
    if (!ok) return;
    guestBdayForgetBtn.disabled = true;
    try {
      const res = await hostFetch(
        `/api/guests/${encodeURIComponent(name)}/forget-birthday-shout`,
        { method: "POST" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not reset birthday shout.");
      showToast(`Birthday shout reset for ${name}`);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      guestBdayForgetBtn.disabled = false;
    }
  });
}

// ---- DJ icon picker (Settings page; same pattern as banners) ------------
function renderDjIcons(data) {
  if (!djIconGallery) return;
  const active = data.active ?? data.djIcon ?? null;
  activeDjIconName = active || null;
  updateDjHubSummaries();
  const defaultUrl = data.defaultUrl || "/dj-icons/flat.png";
  const defaultIconName =
    settingsDefaults?.djIcon || "dj-icon-flat.png";
  djIconGallery.innerHTML = "";

  const tiles = [{ name: null, url: defaultUrl, starter: true }];
  for (const b of data.icons || []) {
    // Default tile already represents the seeded flat starter.
    if (b.name === defaultIconName) continue;
    tiles.push({ name: b.name, url: b.url, starter: !!b.starter });
  }

  for (const t of tiles) {
    const isActive =
      t.name === null
        ? !active || active === defaultIconName
        : active === t.name;
    const isStarter = !!t.starter;
    const tile = document.createElement("div");
    tile.className = "banner-thumb" + (isActive ? " active" : "");
    const tag = isActive ? "Active" : t.name === null ? "Default" : "";
    tile.innerHTML = `
      <img src="${t.url}" alt="" loading="lazy" />
      ${t.name && !isStarter ? '<button class="banner-del" type="button" aria-label="Delete DJ icon" title="Delete">\u00d7</button>' : ""}
      ${tag ? `<span class="banner-tag">${tag}</span>` : ""}
    `;
    tile.addEventListener("click", () => selectDjIcon(t.name));
    const del = tile.querySelector(".banner-del");
    if (del) {
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteDjIcon(t.name);
      });
    }
    djIconGallery.appendChild(tile);
  }
}

async function loadDjIcons() {
  try {
    const res = await fetch("/api/dj-icon");
    if (!res.ok) return;
    renderDjIcons(await res.json());
  } catch {
    /* leave gallery as-is on transient errors */
  }
}

async function selectDjIcon(name) {
  try {
    const res = await hostFetch("/api/dj-icon/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not switch DJ icon.");
    renderDjIcons(data);
  } catch (err) {
    showToast(err.message, true);
  }
}

async function deleteDjIcon(name) {
  try {
    const res = await hostFetch(`/api/dj-icon/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not delete DJ icon.");
    renderDjIcons(data);
  } catch (err) {
    showToast(err.message, true);
  }
}

if (djIconUploadBtn && djIconFileInput) {
  djIconUploadBtn.addEventListener("click", () => djIconFileInput.click());
  djIconFileInput.addEventListener("change", () => {
    const file = djIconFileInput.files && djIconFileInput.files[0];
    if (!file) return;
    if (file.size > MAX_DJ_ICON_BYTES) {
      showToast("Image is too large (2 MB max).", true);
      djIconFileInput.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      djIconUploadBtn.disabled = true;
      try {
        const res = await hostFetch("/api/dj-icon", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: reader.result }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed.");
        renderDjIcons(data);
        showToast("DJ Icon updated");
      } catch (err) {
        showToast(err.message, true);
      } finally {
        djIconUploadBtn.disabled = false;
        djIconFileInput.value = "";
      }
    };
    reader.readAsDataURL(file);
  });
}

// Look → Text: explicit Save (independent of Queue Song Selection Save).
const lookTextSaveBtn = document.getElementById("look-text-save");
function saveLookText() {
  saveSettings(
    {
      eventName: eventNameInput.value,
      subtitle: subtitleInput.value,
    },
    { toastMessage: "Saved" }
  );
}
lookTextSaveBtn?.addEventListener("click", saveLookText);
for (const input of [eventNameInput, subtitleInput]) {
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveLookText();
    }
  });
}
showVersionInput.addEventListener("change", () => {
  saveSettings({ showVersion: showVersionInput.checked });
  if (headerVersion) headerVersion.hidden = !showVersionInput.checked;
  persistBrandingCache({ showVersion: showVersionInput.checked });
});
if (showQueueGenreInput) {
  showQueueGenreInput.addEventListener("change", () => {
    syncShowQueueGenre(showQueueGenreInput.checked, { rerender: true });
    saveSettings({ showQueueGenre: showQueueGenreInput.checked });
  });
}

// ---- Hero banner picker (Settings page) --------------------------------
const bannerUploadBtn = document.getElementById("banner-upload-btn");
const bannerFileInput = document.getElementById("banner-file");
const bannerGallery = document.getElementById("banner-gallery");
const MAX_BANNER_BYTES = 8 * 1024 * 1024;

function renderBanners(data) {
  if (!bannerGallery) return;
  const active = data.active ?? null;
  const defaultUrl = data.defaultUrl || "hero.jpg";
  bannerGallery.innerHTML = "";

  const tiles = [{ name: null, url: defaultUrl, starter: true }];
  for (const b of data.banners || []) {
    tiles.push({ name: b.name, url: b.url, starter: !!b.starter });
  }

  for (const t of tiles) {
    const isActive = active === t.name;
    const isStarter = !!t.starter;
    const tile = document.createElement("div");
    tile.className = "banner-thumb" + (isActive ? " active" : "");
    const tag = isActive ? "Active" : t.name === null ? "Default" : "";
    tile.innerHTML = `
      <img src="${t.url}" alt="" loading="lazy" />
      ${t.name && !isStarter ? '<button class="banner-del" type="button" aria-label="Delete banner" title="Delete">\u00d7</button>' : ""}
      ${tag ? `<span class="banner-tag">${tag}</span>` : ""}
    `;
    tile.addEventListener("click", () => selectBanner(t.name));
    const del = tile.querySelector(".banner-del");
    if (del) {
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteBanner(t.name);
      });
    }
    bannerGallery.appendChild(tile);
  }
}

async function loadBanners() {
  try {
    const res = await fetch("/api/banners");
    if (!res.ok) return;
    renderBanners(await res.json());
  } catch {
    /* leave gallery as-is on transient errors */
  }
}

// Spotify Developer app credentials (DJ Booth → Connections).
// Client secret is write-only — status never returns the secret.
const spotifyAppStatusEl = document.getElementById("spotify-app-status");
const spotifyClientIdInput = document.getElementById("set-spotify-client-id");
const spotifyClientSecretInput = document.getElementById("set-spotify-client-secret");
const spotifyRedirectInput = document.getElementById("set-spotify-redirect");
const spotifyMarketInput = document.getElementById("set-spotify-market");
const spotifySecretHint = document.getElementById("spotify-secret-hint");
const spotifyAppSaveBtn = document.getElementById("spotify-app-save");
const spotifyAppTestBtn = document.getElementById("spotify-app-test");
const spotifyAppClearBtn = document.getElementById("spotify-app-clear");

function applySpotifyAppStatus(data) {
  if (!spotifyAppStatusEl) return;
  spotifyAppStatusEl.classList.remove(
    "status-connected",
    "status-limited",
    "status-disconnected",
    "status-unknown"
  );
  if (data.configured) {
    spotifyAppStatusEl.classList.add("status-connected");
    spotifyAppStatusEl.textContent = "Credentials OK";
  } else {
    spotifyAppStatusEl.classList.add("status-disconnected");
    spotifyAppStatusEl.textContent = "Credentials missing";
  }
  if (spotifyClientIdInput && document.activeElement !== spotifyClientIdInput) {
    spotifyClientIdInput.value = data.clientId || "";
    spotifyClientIdInput.readOnly = false;
  }
  if (spotifyClientSecretInput && document.activeElement !== spotifyClientSecretInput) {
    // Mask only — never the real secret. All-asterisks means "already saved".
    spotifyClientSecretInput.value = data.clientSecretSet ? "********" : "";
    spotifyClientSecretInput.placeholder = data.clientSecretSet
      ? ""
      : "Paste Client Secret";
    spotifyClientSecretInput.readOnly = false;
  }
  if (spotifyRedirectInput && document.activeElement !== spotifyRedirectInput) {
    // Prefer saved URI; otherwise suggest this host's callback for Spotify Dashboard.
    spotifyRedirectInput.value =
      data.redirectUri || `${window.location.origin}/auth/callback`;
    spotifyRedirectInput.readOnly = false;
  }
  if (spotifyMarketInput && document.activeElement !== spotifyMarketInput) {
    spotifyMarketInput.value = data.market || "US";
    spotifyMarketInput.readOnly = false;
  }
  if (spotifySecretHint) {
    spotifySecretHint.textContent =
      "Dots mean a client secret is already saved.";
  }
  if (spotifyAppSaveBtn) spotifyAppSaveBtn.disabled = false;
  if (spotifyAppClearBtn) spotifyAppClearBtn.disabled = false;
}

async function loadSpotifyAppStatus() {
  if (!spotifyAppStatusEl) return;
  try {
    const res = await hostFetch("/api/spotify/app/status");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not load Spotify app status.");
    applySpotifyAppStatus(data);
  } catch {
    spotifyAppStatusEl.classList.remove(
      "status-connected",
      "status-limited",
      "status-disconnected"
    );
    spotifyAppStatusEl.classList.add("status-unknown");
    spotifyAppStatusEl.textContent = "Unavailable";
  }
}

// Clear the asterisk mask when focusing so a new secret can be typed/pasted.
if (spotifyClientSecretInput) {
  spotifyClientSecretInput.addEventListener("focus", () => {
    if (/^\*+$/.test(spotifyClientSecretInput.value)) {
      spotifyClientSecretInput.value = "";
    }
  });
}

if (spotifyAppSaveBtn) {
  spotifyAppSaveBtn.addEventListener("click", async () => {
    spotifyAppSaveBtn.disabled = true;
    try {
      const body = {
        clientId: spotifyClientIdInput?.value ?? "",
        redirectUri: spotifyRedirectInput?.value ?? "",
        market: spotifyMarketInput?.value ?? "",
      };
      const secret = (spotifyClientSecretInput?.value ?? "").trim();
      // Ignore the display mask (all *) and blanks — keep the saved secret.
      if (secret && !/^\*+$/.test(secret)) body.clientSecret = secret;
      const res = await hostFetch("/api/spotify/app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save Spotify app settings.");
      applySpotifyAppStatus(data);
      showToast("Spotify app settings saved");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      if (spotifyClientIdInput && !spotifyClientIdInput.readOnly) {
        spotifyAppSaveBtn.disabled = false;
      }
    }
  });
}

if (spotifyAppTestBtn) {
  spotifyAppTestBtn.addEventListener("click", async () => {
    spotifyAppTestBtn.disabled = true;
    try {
      const res = await hostFetch("/api/spotify/app/test", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Connection failed.");
      showToast(data.message || "Spotify app credentials work");
      loadSpotifyAppStatus();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      spotifyAppTestBtn.disabled = false;
    }
  });
}

if (spotifyAppClearBtn) {
  spotifyAppClearBtn.addEventListener("click", async () => {
    if (!confirm("Clear saved Spotify Client ID, Secret, Redirect URI, and Market?")) return;
    spotifyAppClearBtn.disabled = true;
    try {
      const res = await hostFetch("/api/spotify/app/clear", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not clear Spotify app settings.");
      applySpotifyAppStatus(data);
      showToast("Spotify app settings cleared");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      if (spotifyClientIdInput && !spotifyClientIdInput.readOnly) {
        spotifyAppClearBtn.disabled = false;
      }
    }
  });
}

// Last.fm API key (Settings → Last.fm). Key is write-only from the browser.
const lastfmStatusEl = document.getElementById("lastfm-status");
const lastfmKeyInput = document.getElementById("set-lastfm-key");
const lastfmKeyHint = document.getElementById("lastfm-key-hint");
const lastfmSaveBtn = document.getElementById("lastfm-save");
const lastfmTestBtn = document.getElementById("lastfm-test");
const lastfmClearBtn = document.getElementById("lastfm-clear");

function applyLastfmStatus(data) {
  if (!lastfmStatusEl) return;
  lastfmStatusEl.classList.remove(
    "status-connected",
    "status-limited",
    "status-disconnected",
    "status-unknown"
  );
  if (data.configured) {
    lastfmStatusEl.classList.add("status-connected");
    lastfmStatusEl.textContent = "Credentials OK";
  } else {
    lastfmStatusEl.classList.add("status-disconnected");
    lastfmStatusEl.textContent = "Credentials missing";
  }
  if (lastfmKeyInput && document.activeElement !== lastfmKeyInput) {
    lastfmKeyInput.value = data.apiKeySet ? "********" : "";
    lastfmKeyInput.placeholder = data.apiKeySet ? "" : "Paste Last.fm API key";
    lastfmKeyInput.readOnly = false;
  }
  if (lastfmKeyHint) {
    lastfmKeyHint.textContent = "Dots mean an API key is already saved.";
  }
  if (lastfmSaveBtn) lastfmSaveBtn.disabled = false;
  if (lastfmClearBtn) lastfmClearBtn.disabled = false;
}

async function loadLastfmStatus() {
  if (!lastfmStatusEl) return;
  try {
    const res = await hostFetch("/api/lastfm/status");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not load Last.fm status.");
    applyLastfmStatus(data);
  } catch {
    lastfmStatusEl.classList.remove(
      "status-connected",
      "status-limited",
      "status-disconnected"
    );
    lastfmStatusEl.classList.add("status-unknown");
    lastfmStatusEl.textContent = "Unavailable";
  }
}

if (lastfmKeyInput) {
  lastfmKeyInput.addEventListener("focus", () => {
    if (/^\*+$/.test(lastfmKeyInput.value)) {
      lastfmKeyInput.value = "";
    }
  });
}

if (lastfmSaveBtn) {
  lastfmSaveBtn.addEventListener("click", async () => {
    lastfmSaveBtn.disabled = true;
    try {
      const body = {};
      const key = (lastfmKeyInput?.value ?? "").trim();
      // Ignore the display mask (all *) and blanks — keep the saved key.
      if (key && !/^\*+$/.test(key)) body.apiKey = key;
      const res = await hostFetch("/api/lastfm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save Last.fm settings.");
      applyLastfmStatus(data);
      showToast("Saved");
      loadGenres();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      lastfmSaveBtn.disabled = false;
    }
  });
}

if (lastfmTestBtn) {
  lastfmTestBtn.addEventListener("click", async () => {
    lastfmTestBtn.disabled = true;
    try {
      const res = await hostFetch("/api/lastfm/test", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Connection failed.");
      showToast(data.message || "Last.fm API key works");
      loadLastfmStatus();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      lastfmTestBtn.disabled = false;
    }
  });
}

if (lastfmClearBtn) {
  lastfmClearBtn.addEventListener("click", async () => {
    if (!confirm("Clear saved Last.fm API key?")) return;
    lastfmClearBtn.disabled = true;
    try {
      const res = await hostFetch("/api/lastfm/clear", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not clear Last.fm settings.");
      applyLastfmStatus(data);
      showToast("Last.fm settings cleared");
      loadGenres();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      if (lastfmKeyInput && !lastfmKeyInput.readOnly) lastfmClearBtn.disabled = false;
    }
  });
}

// Home Assistant credentials (Settings → Home Assistant). Token is write-only
// from the browser's perspective — status never returns the secret value.
const haStatusEl = document.getElementById("ha-status");
const haUrlInput = document.getElementById("set-ha-url");
const haTokenInput = document.getElementById("set-ha-token");
const haTokenHint = document.getElementById("ha-token-hint");
const haSaveBtn = document.getElementById("ha-save");
const haTestBtn = document.getElementById("ha-test");
const haClearBtn = document.getElementById("ha-clear");

function applyHaStatus(data) {
  if (!haStatusEl) return;
  haStatusEl.classList.remove(
    "status-connected",
    "status-limited",
    "status-disconnected",
    "status-unknown"
  );
  if (data.configured) {
    haStatusEl.classList.add("status-connected");
    haStatusEl.textContent = "Credentials OK";
  } else {
    haStatusEl.classList.add("status-disconnected");
    haStatusEl.textContent = "Credentials missing";
  }
  if (haUrlInput && document.activeElement !== haUrlInput) {
    haUrlInput.value = data.url || "";
    haUrlInput.readOnly = false;
  }
  if (haTokenInput && document.activeElement !== haTokenInput) {
    haTokenInput.value = data.tokenSet ? "********" : "";
    haTokenInput.placeholder = data.tokenSet ? "" : "Paste long-lived token";
    haTokenInput.readOnly = false;
  }
  if (haTokenHint) {
    haTokenHint.textContent = "Dots mean a token is already saved.";
  }
  if (haSaveBtn) haSaveBtn.disabled = false;
  if (haClearBtn) haClearBtn.disabled = false;
}

async function loadHaStatus() {
  if (!haStatusEl) return;
  try {
    const res = await hostFetch("/api/homeassistant/status");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not load Home Assistant status.");
    applyHaStatus(data);
  } catch {
    haStatusEl.classList.remove(
      "status-connected",
      "status-limited",
      "status-disconnected"
    );
    haStatusEl.classList.add("status-unknown");
    haStatusEl.textContent = "Unavailable";
  }
}

if (haTokenInput) {
  haTokenInput.addEventListener("focus", () => {
    if (/^\*+$/.test(haTokenInput.value)) {
      haTokenInput.value = "";
    }
  });
}

if (haSaveBtn) {
  haSaveBtn.addEventListener("click", async () => {
    haSaveBtn.disabled = true;
    try {
      const body = { url: haUrlInput?.value ?? "" };
      const token = (haTokenInput?.value ?? "").trim();
      // Ignore the display mask (all *) and blanks — keep the saved token.
      if (token && !/^\*+$/.test(token)) body.token = token;
      const res = await hostFetch("/api/homeassistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save Home Assistant settings.");
      applyHaStatus(data);
      showToast("Saved");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      haSaveBtn.disabled = false;
    }
  });
}

if (haTestBtn) {
  haTestBtn.addEventListener("click", async () => {
    haTestBtn.disabled = true;
    try {
      const res = await hostFetch("/api/homeassistant/test", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Connection failed.");
      showToast(data.message || "Home Assistant connected");
      loadHaStatus();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      haTestBtn.disabled = false;
    }
  });
}

if (haClearBtn) {
  haClearBtn.addEventListener("click", async () => {
    if (!confirm("Clear saved Home Assistant URL and token?")) return;
    haClearBtn.disabled = true;
    try {
      const res = await hostFetch("/api/homeassistant/clear", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not clear Home Assistant settings.");
      applyHaStatus(data);
      showToast("Home Assistant settings cleared");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      haClearBtn.disabled = false;
    }
  });
}

// Sonos speaker IP + room (Connections). Not secrets — shown in the fields.
const sonosConnStatusEl = document.getElementById("sonos-conn-status");
const sonosHostInput = document.getElementById("set-sonos-host");
const sonosRoomInput = document.getElementById("set-sonos-room");
const sonosConnSaveBtn = document.getElementById("sonos-conn-save");
const sonosConnTestBtn = document.getElementById("sonos-conn-test");
const sonosConnClearBtn = document.getElementById("sonos-conn-clear");

function applySonosConnStatus(data) {
  if (!sonosConnStatusEl) return;
  sonosConnStatusEl.classList.remove(
    "status-connected",
    "status-limited",
    "status-disconnected",
    "status-unknown"
  );
  if (data.hostSet) {
    sonosConnStatusEl.classList.add("status-connected");
    sonosConnStatusEl.textContent = "Pinned IP";
  } else {
    sonosConnStatusEl.classList.add("status-limited");
    sonosConnStatusEl.textContent = "Discovery";
  }
  if (sonosHostInput && document.activeElement !== sonosHostInput) {
    sonosHostInput.value = data.host || "";
  }
  if (sonosRoomInput && document.activeElement !== sonosRoomInput) {
    sonosRoomInput.value = data.room || "";
  }
  if (sonosConnSaveBtn) sonosConnSaveBtn.disabled = false;
  if (sonosConnClearBtn) sonosConnClearBtn.disabled = false;
}

async function loadSonosConnStatus() {
  if (!sonosConnStatusEl) return;
  try {
    const res = await hostFetch("/api/sonos/connection");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not load Sonos settings.");
    applySonosConnStatus(data);
  } catch {
    sonosConnStatusEl.classList.remove(
      "status-connected",
      "status-limited",
      "status-disconnected"
    );
    sonosConnStatusEl.classList.add("status-unknown");
    sonosConnStatusEl.textContent = "Unavailable";
  }
}

if (sonosConnSaveBtn) {
  sonosConnSaveBtn.addEventListener("click", async () => {
    sonosConnSaveBtn.disabled = true;
    try {
      const res = await hostFetch("/api/sonos/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: sonosHostInput?.value ?? "",
          room: sonosRoomInput?.value ?? "",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save Sonos settings.");
      applySonosConnStatus(data);
      showToast("Sonos settings saved");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      sonosConnSaveBtn.disabled = false;
    }
  });
}

if (sonosConnTestBtn) {
  sonosConnTestBtn.addEventListener("click", async () => {
    sonosConnTestBtn.disabled = true;
    showToast("Looking for Sonos…", false, 8000);
    try {
      // Save current fields first so Test uses what you typed.
      const saveRes = await hostFetch("/api/sonos/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: sonosHostInput?.value ?? "",
          room: sonosRoomInput?.value ?? "",
        }),
      });
      const saveData = await saveRes.json().catch(() => ({}));
      if (!saveRes.ok) {
        throw new Error(saveData.error || "Could not save Sonos settings.");
      }
      applySonosConnStatus(saveData);
      const res = await hostFetch("/api/sonos/connection/test", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Connection failed.");
      showToast(data.message || "Sonos connected", false, 5000);
      loadSonosConnStatus();
    } catch (err) {
      showToast(err.message, true, 5000);
    } finally {
      sonosConnTestBtn.disabled = false;
    }
  });
}

if (sonosConnClearBtn) {
  sonosConnClearBtn.addEventListener("click", async () => {
    if (!confirm("Clear saved Sonos speaker IP and room name?")) return;
    sonosConnClearBtn.disabled = true;
    try {
      const res = await hostFetch("/api/sonos/connection/clear", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not clear Sonos settings.");
      applySonosConnStatus(data);
      showToast("Sonos settings cleared");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      sonosConnClearBtn.disabled = false;
    }
  });
}

// Update the Settings "Spotify" indicator: connected (green), rate-limited
// (amber, with how long is left), or not connected (red). Reads local server
// state only - never triggers a Spotify call.
async function loadSpotifyStatus() {
  if (!spotifyStatus) return;
  try {
    const res = await fetch("/api/spotify/status");
    const data = await res.json();
    spotifyStatus.classList.remove(
      "status-connected",
      "status-limited",
      "status-disconnected",
      "status-unknown"
    );
    if (!data.connected) {
      spotifyStatus.classList.add("status-disconnected");
      spotifyStatus.textContent = "Account not linked";
    } else if (data.rateLimited) {
      spotifyStatus.classList.add("status-limited");
      spotifyStatus.textContent = `Rate-limited \u2014 retry in ${formatDuration(data.cooldownSeconds)}`;
    } else {
      spotifyStatus.classList.add("status-connected");
      spotifyStatus.textContent = "Account linked";
    }
    if (cacheWarmed) {
      if (data.connected && data.poolWarmedAt) {
        cacheWarmed.value = formatTimeAgo(data.poolWarmedAt);
      } else if (data.connected) {
        cacheWarmed.value = "Never";
      } else {
        cacheWarmed.value = "Account not linked";
      }
    }
  } catch {
    spotifyStatus.classList.remove(
      "status-connected",
      "status-limited",
      "status-disconnected"
    );
    spotifyStatus.classList.add("status-unknown");
    spotifyStatus.textContent = "Status unavailable";
    if (cacheWarmed) cacheWarmed.value = "Unavailable";
  }
}

async function selectBanner(name) {
  try {
    const res = await hostFetch("/api/banners/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not switch banner.");
    applyHero(data.active);
    renderBanners(data);
  } catch (err) {
    showToast(err.message, true);
  }
}

async function deleteBanner(name) {
  if (!name) return;
  try {
    const res = await hostFetch(`/api/banners/${encodeURIComponent(name)}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not delete banner.");
    applyHero(data.active);
    renderBanners(data);
    showToast("Banner deleted");
  } catch (err) {
    showToast(err.message, true);
  }
}

if (bannerUploadBtn && bannerFileInput) {
  bannerUploadBtn.addEventListener("click", () => bannerFileInput.click());
  bannerFileInput.addEventListener("change", () => {
    const file = bannerFileInput.files && bannerFileInput.files[0];
    if (!file) return;
    if (file.size > MAX_BANNER_BYTES) {
      showToast("Image is too large (8 MB max).", true);
      bannerFileInput.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      bannerUploadBtn.disabled = true;
      try {
        const res = await hostFetch("/api/banners", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: reader.result }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed.");
        applyHero(data.active);
        renderBanners(data);
        showToast("Banner updated");
      } catch (err) {
        showToast(err.message, true);
      } finally {
        bannerUploadBtn.disabled = false;
        bannerFileInput.value = "";
      }
    };
    reader.readAsDataURL(file);
  });
}

settingsResetBtn?.addEventListener("click", () => {
  // Leave Vibe / DJ persona / branding alone; each has its own control
  // and shouldn't be wiped by the Queue defaults.
  const rest = { ...settingsDefaults };
  delete rest.filterExplicit;
  delete rest.requestsPaused;
  delete rest.hostControlsOnly;
  delete rest.kidsLock;
  delete rest.djVoiceEnabled;
  delete rest.djName;
  delete rest.djIcon;
  delete rest.djNameIntroPercent;
  delete rest.djAnnounceMaxWords;
  delete rest.djVolumeBumpLowPct;
  delete rest.djVolumeBumpMidPct;
  delete rest.djVolumeBumpHighPct;
  delete rest.djVolumeBump;
  delete rest.djSilenceSec;
  delete rest.djHandoffSilenceSec;
  delete rest.djTtsVoice;
  delete rest.djTtsProvider;
  delete rest.djTtsVoiceOpenAi;
  delete rest.djTtsVoiceElevenlabs;
  delete rest.djTtsEngine;
  delete rest.djTtsSpeed;
  delete rest.djCharacterIntensity;
  delete rest.djCatchphrase;
  delete rest.djBanList;
  delete rest.eventName;
  delete rest.subtitle;
  delete rest.showVersion;
  delete rest.showQueueGenre;
  delete rest.heroBanner;
  fillSettings(rest);
  saveSettings({ ...rest }, { toastMessage: "Set to Default" });
});

settingsClearHistoryBtn.addEventListener("click", async () => {
  const ok = await confirmModal(
    "Reset song memory? Clears played/skipped song memory and artist skip cooldowns so Random can pick freely again.",
    "Reset song memory"
  );
  if (!ok) return;
  settingsClearHistoryBtn.disabled = true;
  try {
    const res = await hostFetch("/api/settings/clear-history", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not clear history.");
    showToast("Memory cleared");
    loadMemory(); // Refresh the (now-empty) Memory view for the next visit.
  } catch (err) {
    showToast(err.message, true);
  } finally {
    settingsClearHistoryBtn.disabled = false;
  }
});

settingsClearStatsBtn.addEventListener("click", async () => {
  const ok = await confirmModal(
    "Reset stats? Clears top songs, artists, requesters, and dedications.",
    "Reset stats"
  );
  if (!ok) return;
  settingsClearStatsBtn.disabled = true;
  try {
    const res = await hostFetch("/api/settings/clear-stats", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not clear stats.");
    showToast("Stats cleared");
    loadStats(); // Refresh the (now-empty) Stats view for the next visit.
  } catch (err) {
    showToast(err.message, true);
  } finally {
    settingsClearStatsBtn.disabled = false;
  }
});

settingsClearDjMemoryBtn?.addEventListener("click", async () => {
  const ok = await confirmModal(
    "Reset DJ memory? Clears recent set phrases, scripts, first-request, birthday, and guest shout-blurb memory.",
    "Reset DJ memory"
  );
  if (!ok) return;
  settingsClearDjMemoryBtn.disabled = true;
  try {
    const res = await hostFetch("/api/settings/clear-dj-memory", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not clear DJ memory.");
    showToast("DJ memory cleared");
  } catch (err) {
    showToast(err.message, true);
  } finally {
    settingsClearDjMemoryBtn.disabled = false;
  }
});

settingsClearSuggestionsBtn?.addEventListener("click", () => clearAllSuggestions(settingsClearSuggestionsBtn));

settingsClearReactionsBtn?.addEventListener("click", async () => {
  const ok = await confirmModal(
    "Reset reactions? Clears Now Playing mood reactions. Karaoke mic tags stay.",
    "Reset reactions"
  );
  if (!ok) return;
  settingsClearReactionsBtn.disabled = true;
  try {
    const res = await hostFetch("/api/settings/clear-reactions", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not clear reactions.");
    showToast("Mood reactions cleared");
    npReactionsSyncedFor = null;
    if (nowPlayingId) void syncMyReactions(nowPlayingId);
    else paintNpReactions({ mine: null, micMine: false });
    if (currentView === "stats") loadStats();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    settingsClearReactionsBtn.disabled = false;
  }
});

settingsClearKaraokeBtn?.addEventListener("click", async () => {
  const ok = await confirmModal(
    "Reset Karaoke list? Clears mic tags. Mood reactions stay.",
    "Reset Karaoke list"
  );
  if (!ok) return;
  settingsClearKaraokeBtn.disabled = true;
  try {
    const res = await hostFetch("/api/settings/clear-karaoke", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not clear Karaoke list.");
    showToast("Karaoke list cleared");
    npReactionsSyncedFor = null;
    if (nowPlayingId) void syncMyReactions(nowPlayingId);
    if (currentView === "stats") loadStats();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    settingsClearKaraokeBtn.disabled = false;
  }
});

async function clearAllSuggestions(btn = null) {
  const ok = await confirmModal(
    "Reset suggestions? Clears all open and done ideas from the guest inbox.",
    "Reset suggestions"
  );
  if (!ok) return;
  if (btn) btn.disabled = true;
  try {
    const res = await hostFetch("/api/settings/clear-suggestions", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not clear suggestions.");
    showToast("Suggestions cleared");
    loadSuggestions();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Memory view: the recently-played "memory" the picker avoids. Lazy-loaded on
// first expand so a normal page load triggers no extra Spotify lookups.
const memoryCount = document.getElementById("memory-count");
const memoryIntro = document.getElementById("memory-intro");
const memoryList = document.getElementById("memory-list");
const memoryEmpty = document.getElementById("memory-empty");

function memorySourceBadge(source, skipped, requestedBy, mood) {
  const parts = [];
  switch (source) {
    case "searched": {
      const by = sanitizeDisplayName(requestedBy || "");
      const label = by ? `Requested \u00b7 ${escapeHtml(by)}` : "Requested";
      const title = by
        ? `Requested by ${escapeHtml(by)}`
        : "Guest searched and added this";
      parts.push(
        `<span class="searched-badge" title="${title}">\u{1F50D} ${label}</span>`
      );
      break;
    }
    case "discovered":
      parts.push(
        `<span class="songs-like-badge" title="Added by Discover">\u2728 Discover</span>`
      );
      break;
    case "mood": {
      // Same wording as the queue badges: "80's Hit" when the decade is known.
      const era = mood ? DECADE_LABELS[mood] || null : null;
      const label = era ? `${era} Hit` : "Era Hit";
      parts.push(
        `<span class="mood-badge" title="Era hit added by the Decades mood">\u{1F4FC} ${escapeHtml(label)}</span>`
      );
      break;
    }
    case "filler":
      parts.push(
        `<span class="memory-random-badge" title="Added by Random / Never-Ending">\u{1F3B2} Random</span>`
      );
      break;
    default:
      break;
  }
  if (skipped) {
    parts.push(
      `<span class="memory-skipped-badge" title="Skipped while playing">\u23ED Skipped</span>`
    );
  }
  return parts.join("");
}

function renderMemory(tracks) {
  memoryList.innerHTML = "";
  memoryEmpty.hidden = tracks.length > 0;
  memoryIntro.hidden = tracks.length === 0;
  memoryCount.textContent = tracks.length ? `(${tracks.length})` : "";

  tracks.forEach((track, i) => {
    const li = document.createElement("li");
    li.className = "track";
    const art = track.image
      ? `<img src="${track.image}" alt="" loading="lazy" />`
      : `<div class="art-fallback"></div>`;
    const badge = memorySourceBadge(
      track.source,
      track.skipped,
      track.requestedBy,
      track.mood
    );
    li.innerHTML = `
      <span class="queue-index">${i + 1}</span>
      ${art}
      <div class="meta">
        <div class="title">${escapeHtml(track.title || "Unknown")}${badge}</div>
        <div class="artist">${escapeHtml(track.artist || "")}</div>
      </div>
    `;
    memoryList.appendChild(li);
  });
}

async function loadMemory() {
  memoryEmpty.hidden = true;
  memoryIntro.hidden = true;
  memoryCount.textContent = "...";
  try {
    const res = await hostFetch("/api/history");
    if (!res.ok) throw new Error("Could not load memory.");
    const data = await res.json();
    renderMemory(data.tracks || []);
  } catch {
    memoryCount.textContent = "";
    memoryEmpty.hidden = false;
    memoryEmpty.textContent = "Could not load memory.";
  }
}

// ---- Suggestion Box (guest submit + host inbox) ----------------------------
const suggestionText = document.getElementById("suggestion-text");
const suggestionSubmit = document.getElementById("suggestion-submit");
const suggestionCharCount = document.getElementById("suggestion-count");
const suggestionsList = document.getElementById("suggestions-list");
const suggestionsEmpty = document.getElementById("suggestions-empty");
const suggestionsCountEl = document.getElementById("suggestions-count");
const SUGGESTION_TEXT_MAX = 280;
let suggestionsCache = [];
let suggestionsFilter = "open";

function syncSuggestionCharCount() {
  if (!suggestionCharCount || !suggestionText) return;
  const n = suggestionText.value.length;
  suggestionCharCount.textContent = `${n} / ${SUGGESTION_TEXT_MAX}`;
}

suggestionText?.addEventListener("input", syncSuggestionCharCount);
syncSuggestionCharCount();

suggestionSubmit?.addEventListener("click", async () => {
  const displayName = await ensureDisplayName();
  if (!displayName) {
    showToast("Enter your name before sending a suggestion.", true);
    return;
  }
  const text = (suggestionText?.value || "").trim();
  if (text.length < 3) {
    showToast("Write a bit more — at least a few characters.", true);
    return;
  }
  suggestionSubmit.disabled = true;
  try {
    const res = await fetch("/api/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, ...guestIdentityPayload() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not send suggestion.");
    if (suggestionText) suggestionText.value = "";
    syncSuggestionCharCount();
    showToast(`Thanks, ${guestBadgeName() || displayName}!`);
  } catch (err) {
    showToast(err.message || "Could not send suggestion.", true);
  } finally {
    suggestionSubmit.disabled = false;
  }
});

function renderSuggestions() {
  if (!suggestionsList) return;
  const all = Array.isArray(suggestionsCache) ? suggestionsCache : [];
  const filtered =
    suggestionsFilter === "open"
      ? all.filter((s) => !s.done)
      : suggestionsFilter === "done"
        ? all.filter((s) => s.done)
        : all;
  const openCount = all.filter((s) => !s.done).length;
  if (suggestionsCountEl) {
    suggestionsCountEl.textContent = all.length
      ? `(${openCount} open · ${all.length})`
      : "";
  }
  suggestionsList.innerHTML = "";
  if (suggestionsEmpty) {
    suggestionsEmpty.hidden = filtered.length > 0;
    suggestionsEmpty.textContent =
      suggestionsFilter === "done"
        ? "No implemented suggestions yet."
        : suggestionsFilter === "open"
          ? "No open suggestions — inbox zero."
          : "No suggestions yet.";
  }
  for (const s of filtered) {
    const li = document.createElement("li");
    li.className = "track track-noart suggestion-row" + (s.done ? " done" : "");
    li.dataset.id = s.id;
    const who = sanitizeDisplayName(s.requestedBy || "") || "Guest";
    const when = formatSuggestionWhen(s.ts);
    li.innerHTML = `
      <input type="checkbox" class="suggestion-check" ${s.done ? "checked" : ""} title="Mark implemented" aria-label="Mark implemented" />
      <div class="suggestion-meta">
        <div class="suggestion-text">${escapeHtml(s.text || "")}</div>
        <div class="suggestion-byline">${escapeHtml(who)}${when ? ` · ${escapeHtml(when)}` : ""}</div>
      </div>
    `;
    const box = li.querySelector(".suggestion-check");
    box.addEventListener("change", () => toggleSuggestionDone(s.id, box.checked, box));
    suggestionsList.appendChild(li);
  }
}

async function toggleSuggestionDone(id, done, checkbox) {
  try {
    const res = await hostFetch(`/api/suggestions/${encodeURIComponent(id)}/done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: !!done }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not update.");
    const idx = suggestionsCache.findIndex((s) => s.id === id);
    if (idx >= 0 && data.suggestion) suggestionsCache[idx] = data.suggestion;
    renderSuggestions();
  } catch (err) {
    if (checkbox) checkbox.checked = !done;
    showToast(err.message || "Could not update suggestion.", true);
  }
}

async function loadSuggestions() {
  if (suggestionsEmpty) {
    suggestionsEmpty.hidden = true;
  }
  if (suggestionsCountEl) suggestionsCountEl.textContent = "...";
  try {
    const res = await hostFetch("/api/suggestions");
    if (!res.ok) throw new Error("Could not load suggestions.");
    const data = await res.json();
    suggestionsCache = Array.isArray(data.suggestions) ? data.suggestions : [];
    renderSuggestions();
  } catch {
    suggestionsCache = [];
    if (suggestionsCountEl) suggestionsCountEl.textContent = "";
    if (suggestionsEmpty) {
      suggestionsEmpty.hidden = false;
      suggestionsEmpty.textContent = "Could not load suggestions.";
    }
    if (suggestionsList) suggestionsList.innerHTML = "";
  }
}

document.querySelectorAll("[data-sug-filter]").forEach((btn) => {
  btn.addEventListener("click", () => {
    suggestionsFilter = btn.getAttribute("data-sug-filter") || "open";
    document.querySelectorAll("[data-sug-filter]").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    renderSuggestions();
  });
});

document.getElementById("suggestions-clear-all")?.addEventListener("click", (e) => {
  clearAllSuggestions(e.currentTarget);
});

// Stats: most-requested songs/artists/requesters from guest search-and-adds.
// Lazy-loaded on first open; the Tonight/All-time toggle re-renders cached data.
const statsBody = document.getElementById("stats-body");
const statsCards = document.getElementById("stats-cards");
const statsSongs = document.getElementById("stats-songs");
const statsArtists = document.getElementById("stats-artists");
const statsRequesters = document.getElementById("stats-requesters");
const statsDedicationsWrap = document.getElementById("stats-dedications-wrap");
const statsDedications = document.getElementById("stats-dedications");
const statsDedicationsLabel = document.getElementById("stats-dedications-label");
const statsTopLikedWrap = document.getElementById("stats-top-liked-wrap");
const statsTopLiked = document.getElementById("stats-top-liked");
const statsPartyMusicWrap = document.getElementById("stats-party-music-wrap");
const statsPartyMusic = document.getElementById("stats-party-music");
const statsMostHatedWrap = document.getElementById("stats-most-hated-wrap");
const statsMostHated = document.getElementById("stats-most-hated");
const statsKaraokeWrap = document.getElementById("stats-karaoke-wrap");
const statsKaraoke = document.getElementById("stats-karaoke");
const statsReactedWrap = document.getElementById("stats-reacted-wrap");
const statsReacted = document.getElementById("stats-reacted");
const statsEmpty = document.getElementById("stats-empty");
const statsWinBtns = document.querySelectorAll("#stats-box .stats-win-btn");
let statsData = null;
let statsWindow = "tonight";

const REACTION_EMOJI = {
  up: "\u{1F44D}",
  down: "\u{1F44E}",
  heart: "\u2764\uFE0F",
  fire: "\u{1F525}",
  laugh: "\u{1F602}",
  vomit: "\u{1F92E}",
  party: "\u{1F389}",
  mic: "\u{1F3A4}",
};

function paintStatsReactionList(wrap, listEl, items, { byPrefix = "" } = {}) {
  if (!wrap || !listEl) return;
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) {
    wrap.hidden = true;
    listEl.innerHTML = "";
    return;
  }
  wrap.hidden = false;
  listEl.innerHTML = rows
    .map((it, i) => {
      const main = escapeHtml(it.name || "Unknown");
      const artist = it.artist
        ? `<span class="stats-sub">${escapeHtml(it.artist)}</span>`
        : "";
      const groups = (Array.isArray(it.reactions) ? it.reactions : [])
        .map((r) => {
          const emoji = REACTION_EMOJI[r.kind] || r.kind;
          const who = formatNameList(r.by);
          return who ? `${emoji} ${escapeHtml(who)}` : "";
        })
        .filter(Boolean)
        .join(" \u00b7 ");
      const whoLine =
        !groups && byPrefix
          ? (() => {
              const who = formatNameList(it.by);
              return who
                ? `<span class="stats-sub">${escapeHtml(byPrefix)} ${escapeHtml(who)}</span>`
                : "";
            })()
          : groups
            ? `<span class="stats-sub">${groups}</span>`
            : "";
      return `<li class="stats-row"><span class="stats-rank">${i + 1}</span><span class="stats-name">${main}${artist}${whoLine}</span><span class="stats-count">${it.count}\u00d7</span></li>`;
    })
    .join("");
}

function statRows(items, primaryKey) {
  return (Array.isArray(items) ? items : [])
    .map((it, i) => {
      const main =
        primaryKey === "song"
          ? escapeHtml(it.name || "Unknown")
          : primaryKey === "requester"
            ? escapeHtml(it.name || "Guest")
            : escapeHtml(it.artist);
      const sub =
        primaryKey === "song" && it.artist
          ? `<span class="stats-sub">${escapeHtml(it.artist)}</span>`
          : "";
      return `<li class="stats-row"><span class="stats-rank">${i + 1}</span><span class="stats-name">${main}${sub}</span><span class="stats-count">${it.count}\u00d7</span></li>`;
    })
    .join("");
}

function formatNameList(names) {
  return (Array.isArray(names) ? names : [])
    .map((n) => sanitizeDisplayName(n) || "Guest")
    .filter(Boolean)
    .join(", ");
}

function renderStats() {
  if (!statsData) return;
  const s = statsData[statsWindow] || {
    total: 0,
    topSongs: [],
    topArtists: [],
    topRequesters: [],
  };
  const karaoke = Array.isArray(statsData.karaoke) ? statsData.karaoke : [];
  const reacted = Array.isArray(statsData.reacted) ? statsData.reacted : [];
  const topLiked = Array.isArray(statsData.topLiked) ? statsData.topLiked : [];
  const partyMusic = Array.isArray(statsData.partyMusic)
    ? statsData.partyMusic
    : [];
  const mostHated = Array.isArray(statsData.mostHated)
    ? statsData.mostHated
    : [];
  const empty =
    !s.total &&
    !karaoke.length &&
    !reacted.length &&
    !topLiked.length &&
    !partyMusic.length &&
    !mostHated.length;
  statsEmpty.hidden = !empty;
  statsEmpty.textContent =
    statsWindow === "tonight"
      ? "No requests yet tonight \u2014 search and add a song to get the party started."
      : "No requests yet \u2014 search and add a song to get the party started.";
  statsBody.hidden = empty;
  if (empty) return;

  const topSong = s.topSongs?.[0];
  const topArtist = s.topArtists?.[0];
  const topRequester = s.topRequesters?.[0];
  statsCards.innerHTML = `
    <div class="stat-card"><div class="stat-num">${s.total || 0}</div><div class="stat-cap">requests</div></div>
    <div class="stat-card"><div class="stat-lead">${topSong ? escapeHtml(topSong.name || "Unknown") : "\u2014"}</div><div class="stat-cap">top song</div></div>
    <div class="stat-card"><div class="stat-lead">${topArtist ? escapeHtml(topArtist.artist) : "\u2014"}</div><div class="stat-cap">top artist</div></div>
    <div class="stat-card"><div class="stat-lead">${topRequester ? escapeHtml(topRequester.name) : "\u2014"}</div><div class="stat-cap">top requestor${topRequester ? ` \u00b7 ${topRequester.count}\u00d7` : ""}</div></div>
  `;
  statsSongs.innerHTML = s.total
    ? statRows(s.topSongs, "song")
    : `<li class="stats-row stats-row-empty"><span class="stats-name">No requests yet</span></li>`;
  statsArtists.innerHTML = s.total
    ? statRows(s.topArtists, "artist")
    : `<li class="stats-row stats-row-empty"><span class="stats-name">No requests yet</span></li>`;
  if (statsRequesters) {
    const people = Array.isArray(s.topRequesters) ? s.topRequesters : [];
    statsRequesters.innerHTML = people.length
      ? statRows(people, "requester")
      : `<li class="stats-row stats-row-empty"><span class="stats-name">No named requesters yet</span></li>`;
  }
  if (statsDedicationsWrap && statsDedications) {
    const wall = Array.isArray(s.dedications) ? s.dedications : [];
    if (statsDedicationsLabel) {
      statsDedicationsLabel.textContent =
        statsWindow === "tonight"
          ? "Tonight's dedications"
          : "Dedications";
    }
    if (!wall.length) {
      statsDedicationsWrap.hidden = true;
      statsDedications.innerHTML = "";
    } else {
      statsDedicationsWrap.hidden = false;
      statsDedications.innerHTML = wall
        .map((d) => {
          const label = dedicationDisplayLabel(d.dedication, d.requestedBy);
          const song = [d.name, d.artist].filter(Boolean).join(" — ");
          return `<li class="stats-row"><span class="stats-name">${escapeHtml(label)}${
            song
              ? `<span class="stats-sub">${escapeHtml(song)}</span>`
              : ""
          }</span></li>`;
        })
        .join("");
    }
  }
  paintStatsReactionList(statsTopLikedWrap, statsTopLiked, topLiked);
  paintStatsReactionList(statsPartyMusicWrap, statsPartyMusic, partyMusic);
  paintStatsReactionList(statsMostHatedWrap, statsMostHated, mostHated);

  if (statsKaraokeWrap && statsKaraoke) {
    if (!karaoke.length) {
      statsKaraokeWrap.hidden = true;
      statsKaraoke.innerHTML = "";
    } else {
      statsKaraokeWrap.hidden = false;
      statsKaraoke.innerHTML = karaoke
        .map((it, i) => {
          const main = escapeHtml(it.name || "Unknown");
          const artist = it.artist
            ? `<span class="stats-sub">${escapeHtml(it.artist)}</span>`
            : "";
          const who = formatNameList(it.by);
          const byLine = who
            ? `<span class="stats-sub">Mic'd by ${escapeHtml(who)}</span>`
            : "";
          return `<li class="stats-row"><span class="stats-rank">${i + 1}</span><span class="stats-name">${main}${artist}${byLine}</span><span class="stats-count" title="Mic taps">${REACTION_EMOJI.mic} ${it.count}</span></li>`;
        })
        .join("");
    }
  }
  paintStatsReactionList(statsReactedWrap, statsReacted, reacted);
}

async function loadStats() {
  statsEmpty.hidden = true;
  try {
    const res = await fetch("/api/stats");
    if (!res.ok) throw new Error("Could not load stats.");
    statsData = await res.json();
    renderStats();
  } catch {
    statsData = null;
    statsBody.hidden = true;
    statsEmpty.hidden = false;
    statsEmpty.textContent = "Could not load stats.";
  }
}

statsWinBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    statsWindow = btn.dataset.window;
    statsWinBtns.forEach((b) => b.classList.toggle("active", b === btn));
    renderStats();
  });
});

// ---- View router: Main / Settings / Stats ------------------------------
// Three swappable views in one page (no reloads), driven by the URL hash so the
// phone Back button and deep links work. Element IDs are unchanged, so all the
// existing wiring above keeps functioning regardless of which view a block is in.
const viewMain = document.getElementById("view-main");
const viewSettingsLook = document.getElementById("view-settings-look");
const viewSettingsQueue = document.getElementById("view-settings-queue");
const viewSettingsDj = document.getElementById("view-settings-dj");
const viewSettingsDjBanner = document.getElementById("view-settings-dj-banner");
const viewSettingsDjName = document.getElementById("view-settings-dj-name");
const viewSettingsDjVoice = document.getElementById("view-settings-dj-voice");
const viewSettingsDjAdvanced = document.getElementById("view-settings-dj-advanced");
const viewSettingsDjVolume = document.getElementById("view-settings-dj-volume");
const viewSettingsDjShouts = document.getElementById("view-settings-dj-shouts");
const viewSettingsDjLastcall = document.getElementById("view-settings-dj-lastcall");
const viewSettingsUsers = document.getElementById("view-settings-users");
const viewSettingsUserEdit = document.getElementById("view-settings-user-edit");
const viewSettingsConnections = document.getElementById("view-settings-connections");
const viewSettingsReset = document.getElementById("view-settings-reset");
const viewStats = document.getElementById("view-stats");
const viewPlaylists = document.getElementById("view-playlists");
const viewMemory = document.getElementById("view-memory");
const viewSuggestions = document.getElementById("view-suggestions");
const viewSonos = document.getElementById("view-sonos");
const viewMood = document.getElementById("view-mood");
const viewMoodPresets = document.getElementById("view-mood-presets");
const viewGenres = document.getElementById("view-genres");
const viewBooth = document.getElementById("view-booth");
const openMemoryBtn = document.getElementById("open-memory");
const openSuggestionsBtn = document.getElementById("open-suggestions");
const openResetBtn = document.getElementById("open-reset");
const restartAppBtn = document.getElementById("restart-app");
const settingsLookBackBtn = document.getElementById("settings-look-back");
const settingsQueueBackBtn = document.getElementById("settings-queue-back");
const settingsDjBackBtn = document.getElementById("settings-dj-back");
const settingsDjBannerBackBtn = document.getElementById("settings-dj-banner-back");
const settingsDjNameBackBtn = document.getElementById("settings-dj-name-back");
const settingsDjVoiceBackBtn = document.getElementById("settings-dj-voice-back");
const settingsDjAdvancedBackBtn = document.getElementById(
  "settings-dj-advanced-back"
);
const settingsDjVolumeBackBtn = document.getElementById("settings-dj-volume-back");
const settingsDjShoutsBackBtn = document.getElementById("settings-dj-shouts-back");
const settingsDjLastcallBackBtn = document.getElementById("settings-dj-lastcall-back");
const settingsUsersBackBtn = document.getElementById("settings-users-back");
const settingsUserEditBackBtn = document.getElementById("settings-user-edit-back");
const settingsConnectionsBackBtn = document.getElementById("settings-connections-back");
const settingsResetBackBtn = document.getElementById("settings-reset-back");
const statsBackBtn = document.getElementById("stats-back");
const playlistsBackBtn = document.getElementById("playlists-back");
const memoryBackBtn = document.getElementById("memory-back");
const suggestionsBackBtn = document.getElementById("suggestions-back");
const sonosBackBtn = document.getElementById("sonos-back");
const moodBackBtn = document.getElementById("mood-back");
const moodPresetsBackBtn = document.getElementById("mood-presets-back");
const genresBackBtn = document.getElementById("genres-back");
const boothBackBtn = document.getElementById("booth-back");
const joinBackBtn = document.getElementById("join-back");
const viewJoin = document.getElementById("view-join");
const viewDisplay = document.getElementById("view-display");
const joinQrEl = document.getElementById("join-qr");
const joinUrlEl = document.getElementById("join-url");
const joinErrorEl = document.getElementById("join-error");
const joinRefreshBtn = document.getElementById("join-refresh");
const joinCopyBtn = document.getElementById("join-copy");
const displayEventName = document.getElementById("display-event-name");
const displayConnectionStatus = document.getElementById(
  "display-connection-status"
);
const displayArt = document.getElementById("display-art");
const displayEmpty = document.getElementById("display-empty");
const displayState = document.getElementById("display-state");
const displayOriginPill = document.getElementById("display-origin");
const displayTitle = document.getElementById("display-title");
const displayArtist = document.getElementById("display-artist");
const displayAlbum = document.getElementById("display-album");
const displayProgress = document.getElementById("display-progress");
const displayProgressFill = document.getElementById("display-progress-fill");
const displayProgressElapsed = document.getElementById(
  "display-progress-elapsed"
);
const displayProgressDuration = document.getElementById(
  "display-progress-duration"
);
const displayReactions = document.getElementById("display-reactions");
const displayQueueCount = document.getElementById("display-queue-count");
const displayQueue = document.getElementById("display-queue");
const displayQueueEmpty = document.getElementById("display-queue-empty");
const displayJoinQr = document.getElementById("display-join-qr");
const displayJoinUrl = document.getElementById("display-join-url");
const displayJoinError = document.getElementById("display-join-error");
const recapOverlay = document.getElementById("recap-overlay");
const recapBody = document.getElementById("recap-body");
const recapDismissBtn = document.getElementById("recap-dismiss");
const VIEWS = {
  main: viewMain,
  "settings-look": viewSettingsLook,
  "settings-queue": viewSettingsQueue,
  "settings-dj": viewSettingsDj,
  "settings-dj-banner": viewSettingsDjBanner,
  "settings-dj-name": viewSettingsDjName,
  "settings-dj-voice": viewSettingsDjVoice,
  "settings-dj-advanced": viewSettingsDjAdvanced,
  "settings-dj-volume": viewSettingsDjVolume,
  "settings-dj-shouts": viewSettingsDjShouts,
  "settings-dj-lastcall": viewSettingsDjLastcall,
  "settings-users": viewSettingsUsers,
  "settings-user-edit": viewSettingsUserEdit,
  "settings-connections": viewSettingsConnections,
  "settings-reset": viewSettingsReset,
  stats: viewStats,
  playlists: viewPlaylists,
  memory: viewMemory,
  suggestions: viewSuggestions,
  sonos: viewSonos,
  mix: viewMood,
  "mood-presets": viewMoodPresets,
  genres: viewGenres,
  booth: viewBooth,
  join: viewJoin,
  display: viewDisplay,
};
let currentView = "main";
/** Last non-Settings view — PIN Cancel returns here (fallback: main). */
let lastNonSettingsView = "main";

function isSettingsArea(name) {
  return name === "settings" || String(name || "").startsWith("settings-");
}

function isMusicMixArea(name) {
  return (
    name === "mix" ||
    name === "mood-presets" ||
    name === "genres" ||
    name === "playlists"
  );
}

/**
 * Everything behind the DJ Booth — the hub itself plus every page it links to
 * (Look, Queue, DJ, Users, Connections, Reset, Memory, Suggestions). All of it
 * asks for the host PIN when one is configured, even when a page is reached
 * directly by URL hash or a toast shortcut.
 */
function isHostArea(name) {
  return (
    name === "booth" ||
    name === "memory" ||
    name === "suggestions" ||
    isSettingsArea(name)
  );
}

function syncHostControlsVisibility() {
  const body = document.getElementById("controls-body");
  const protectedControls = document.getElementById("controls-host-protected");
  const lock = document.getElementById("controls-host-lock");
  const locked =
    hostControlsOnly && settingsPinRequired && !settingsUnlocked();
  if (body) body.hidden = false;
  if (protectedControls) protectedControls.hidden = locked;
  if (lock) lock.hidden = !locked;
  queueEditLockedForGuests = locked;
  syncQueueEditButton();
  if (locked && queueEditMode) {
    queueEditMode = false;
    queueEditToggle?.classList.remove("active");
    queueEditToggle?.setAttribute("aria-pressed", "false");
    if (queueEditToggle) queueEditToggle.textContent = "Edit";
    if (queueEditHint) queueEditHint.hidden = true;
    syncSortable();
    void loadQueue(true);
  }
}

document.getElementById("controls-host-unlock")?.addEventListener("click", () => {
  openPinGate({ title: "Unlock party controls", action: "reveal-controls" });
});

// ---- Host PIN gate -----------------------------------------------------
// Optional gate for the DJ Booth and everything behind it (all settings
// pages, Users, Connections, Memory, Suggestions, Reset, Restart). PIN is
// verified by the server (never shipped to the browser). Vibe, Stats, Sonos
// groups, Join Code, Party Display, and the rest of the party UI stay open
// without a PIN.
const pinOverlay = document.getElementById("pin-overlay");
const pinInput = document.getElementById("pin-input");
const pinError = document.getElementById("pin-error");
const pinUnlockBtn = document.getElementById("pin-unlock");
const pinCancelBtn = document.getElementById("pin-cancel");
const PIN_UNLOCK_KEY = "pq.settingsUnlocked";
let settingsPinRequired = false;
/** @type {null | "reveal-settings" | "reveal-controls" | "restart"} */
let pendingPinAction = null;

function settingsUnlocked() {
  try {
    return sessionStorage.getItem(PIN_UNLOCK_KEY) === "1";
  } catch {
    return false;
  }
}

function setSettingsUnlocked(on) {
  try {
    if (on) {
      sessionStorage.setItem(PIN_UNLOCK_KEY, "1");
    } else {
      sessionStorage.removeItem(PIN_UNLOCK_KEY);
    }
  } catch {
    /* ignore storage errors */
  }
}

function settingsGateOk() {
  return !settingsPinRequired || settingsUnlocked();
}

// The unlocked flag lives in sessionStorage, so a long-lived tab can keep it
// after the server-side host session expired (TTL or a restart). On host-area
// entry we confirm the session with the server and re-lock when it's gone.
let hostSessionCheckedAt = 0;
async function verifyHostSessionStillValid() {
  if (!settingsPinRequired || !settingsUnlocked()) return;
  const now = Date.now();
  if (now - hostSessionCheckedAt < 15000) return; // debounce booth browsing
  hostSessionCheckedAt = now;
  try {
    const res = await fetch("/api/settings/pin-session", {
      credentials: "same-origin",
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.ok === false) {
      setSettingsUnlocked(false);
      syncHostControlsVisibility();
      if (isHostArea(currentView)) {
        if (VIEWS[currentView]) VIEWS[currentView].hidden = true;
        openPinGate({ title: "DJ Booth is locked", action: "reveal-host" });
      }
    }
  } catch {
    /* offline / transient — host APIs still re-lock on 401 */
  }
}

/** fetch() for host-only APIs — uses the HttpOnly session cookie; re-locks on 401. */
async function hostFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const res = await fetch(url, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  if (res.status === 401 && settingsPinRequired) {
    try {
      const data = await res.clone().json();
      if (data && data.pinRequired) {
        setSettingsUnlocked(false);
        syncHostControlsVisibility();
        openPinGate({
          title: "Host PIN required",
          action: pendingPinAction || "reveal-host",
        });
      }
    } catch {
      /* ignore parse errors */
    }
  }
  return res;
}

const PIN_SETUP_SEEN_KEY = "pq.pinSetupSeen";
const pinSetupOverlay = document.getElementById("pin-setup-overlay");
const pinSetupBootstrap = document.getElementById("pin-setup-bootstrap");
const pinSetupInput = document.getElementById("pin-setup-input");
const pinSetupConfirm = document.getElementById("pin-setup-confirm");
const pinSetupError = document.getElementById("pin-setup-error");
const pinSetupSkipBtn = document.getElementById("pin-setup-skip");
const pinSetupSaveBtn = document.getElementById("pin-setup-save");
const hostPinStatusEl = document.getElementById("host-pin-status");
const hostPinCurrentRow = document.getElementById("host-pin-current-row");
const hostPinCurrentInput = document.getElementById("host-pin-current");
const hostPinBootstrapRow = document.getElementById("host-pin-bootstrap-row");
const hostPinBootstrapInput = document.getElementById("host-pin-bootstrap");
const hostPinNewInput = document.getElementById("host-pin-new");
const hostPinConfirmInput = document.getElementById("host-pin-confirm");
const hostPinSaveBtn = document.getElementById("host-pin-save");
const hostPinClearBtn = document.getElementById("host-pin-clear");
/** @type {{ required?: boolean, source?: string|null, removable?: boolean, bootstrapRequired?: boolean }|null} */
let hostPinInfo = null;

function pinSetupSeen() {
  try {
    return localStorage.getItem(PIN_SETUP_SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

function markPinSetupSeen() {
  try {
    localStorage.setItem(PIN_SETUP_SEEN_KEY, "1");
  } catch {
    /* ignore */
  }
}

function showPinSetupError(msg) {
  if (!pinSetupError) return;
  pinSetupError.textContent = msg || "";
  pinSetupError.hidden = !msg;
}

/** @type {{ close: () => void }|null} */
let pinSetupModalSession = null;

function openPinSetupPrompt() {
  if (!pinSetupOverlay || pinSetupSeen()) return;
  showPinSetupError("");
  if (pinSetupBootstrap) pinSetupBootstrap.value = "";
  if (pinSetupInput) pinSetupInput.value = "";
  if (pinSetupConfirm) pinSetupConfirm.value = "";
  pinSetupModalSession?.close();
  pinSetupModalSession = attachModal(pinSetupOverlay, {
    initialFocus: pinSetupBootstrap || pinSetupInput,
    onEscape: () => closePinSetupPrompt(),
    allowBackdrop: true,
    onBackdrop: () => closePinSetupPrompt(),
  });
}

function closePinSetupPrompt() {
  markPinSetupSeen();
  if (pinSetupModalSession) {
    const session = pinSetupModalSession;
    pinSetupModalSession = null;
    session.close();
    return;
  }
  if (pinSetupOverlay) pinSetupOverlay.hidden = true;
}

/** Soft first-run nudge when Spotify app credentials are still missing. */
async function maybeNudgeSpotifySetup() {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) return;
    const data = await res.json();
    if (data?.spotifyConfigured) return;
    showToast(
      "Next: add Spotify credentials under DJ Booth → Connections",
      false,
      10000,
      {
        actionLabel: "Open",
        onAction: () => navigate("settings-connections"),
      }
    );
  } catch {
    /* ignore */
  }
}

function paintHostPinSettings() {
  if (!hostPinStatusEl) return;
  const required = !!hostPinInfo?.required;
  const source = hostPinInfo?.source || null;
  if (!required) {
    hostPinStatusEl.textContent =
      "No host PIN set. Enter the six-digit setup code from data/host-bootstrap-code.json to claim the DJ Booth.";
  } else if (source === "file") {
    hostPinStatusEl.textContent = "Host PIN is set (saved on this server).";
  } else if (source === "env") {
    hostPinStatusEl.textContent =
      "Host PIN is set via SETTINGS_PIN in .env. Saving a new PIN here moves it into a hashed server file and clears .env.";
  } else {
    hostPinStatusEl.textContent = "Host PIN is set.";
  }
  if (hostPinCurrentRow) hostPinCurrentRow.hidden = !required;
  if (hostPinBootstrapRow) {
    hostPinBootstrapRow.hidden = required || !hostPinInfo?.bootstrapRequired;
  }
  if (hostPinClearBtn) {
    hostPinClearBtn.hidden = !hostPinInfo?.removable;
  }
}

async function refreshHostPinStatus() {
  try {
    const res = await fetch("/api/settings/pin-required");
    if (!res.ok) throw new Error("status failed");
    hostPinInfo = await res.json();
    settingsPinRequired = !!hostPinInfo.required;
  } catch {
    hostPinInfo = { required: true };
    settingsPinRequired = true;
  }
  paintHostPinSettings();
  syncHostControlsVisibility();
}

async function loadPinRequired() {
  await refreshHostPinStatus();
  // If we already landed on a Booth page before this resolved, enforce the gate.
  if (isHostArea(currentView) && !settingsGateOk()) {
    if (VIEWS[currentView]) VIEWS[currentView].hidden = true;
    openPinGate({
      title: "DJ Booth is locked",
      action: "reveal-host",
    });
  } else if (!settingsPinRequired && !pinSetupSeen()) {
    openPinSetupPrompt();
  }
}

async function saveHostPin({
  pin,
  currentPin = "",
  bootstrapCode = "",
  fromSetup = false,
} = {}) {
  const res = await fetch("/api/settings/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      pin,
      currentPin: currentPin || undefined,
      bootstrapCode: bootstrapCode || undefined,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Could not save PIN.");
  }
  setSettingsUnlocked(true);
  hostPinInfo = {
    required: !!data.required,
    source: data.source ?? null,
    removable: !!data.removable,
    bootstrapRequired: !!data.bootstrapRequired,
  };
  settingsPinRequired = !!hostPinInfo.required;
  paintHostPinSettings();
  syncHostControlsVisibility();
  if (fromSetup) {
    closePinSetupPrompt();
    showToast("Host PIN saved");
    maybeNudgeSpotifySetup();
    return data;
  }
  showToast("Host PIN saved");
  return data;
}

hostPinSaveBtn?.addEventListener("click", async () => {
  const pin = (hostPinNewInput?.value || "").trim();
  const confirm = (hostPinConfirmInput?.value || "").trim();
  const currentPin = (hostPinCurrentInput?.value || "").trim();
  const bootstrapCode = (hostPinBootstrapInput?.value || "").trim();
  if (!pin || pin.length < 4) {
    showToast("PIN must be at least 4 characters.", true);
    return;
  }
  if (pin !== confirm) {
    showToast("PIN confirmation does not match.", true);
    return;
  }
  hostPinSaveBtn.disabled = true;
  try {
    await saveHostPin({
      pin,
      currentPin: settingsPinRequired ? currentPin : "",
      bootstrapCode: settingsPinRequired ? "" : bootstrapCode,
    });
    if (hostPinNewInput) hostPinNewInput.value = "";
    if (hostPinConfirmInput) hostPinConfirmInput.value = "";
    if (hostPinCurrentInput) hostPinCurrentInput.value = "";
    if (hostPinBootstrapInput) hostPinBootstrapInput.value = "";
  } catch (err) {
    showToast(err.message || "Could not save PIN.", true);
  } finally {
    hostPinSaveBtn.disabled = false;
  }
});

hostPinClearBtn?.addEventListener("click", async () => {
  const ok = await confirmModal(
    "Remove host PIN? DJ Booth and host APIs will be open to anyone on the LAN.",
    "Remove PIN"
  );
  if (!ok) return;
  hostPinClearBtn.disabled = true;
  try {
    const res = await hostFetch("/api/settings/pin", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPin: (hostPinCurrentInput?.value || "").trim() || undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Could not remove PIN.");
    }
    setSettingsUnlocked(false);
    hostPinInfo = data;
    settingsPinRequired = !!data.required;
    paintHostPinSettings();
    syncHostControlsVisibility();
    if (hostPinCurrentInput) hostPinCurrentInput.value = "";
    showToast(data.required ? "File PIN removed (env PIN may still apply)" : "Host PIN removed");
  } catch (err) {
    showToast(err.message || "Could not remove PIN.", true);
  } finally {
    hostPinClearBtn.disabled = false;
  }
});

pinSetupSkipBtn?.addEventListener("click", () => {
  closePinSetupPrompt();
  maybeNudgeSpotifySetup();
});

pinSetupSaveBtn?.addEventListener("click", async () => {
  const bootstrapCode = (pinSetupBootstrap?.value || "").trim();
  const pin = (pinSetupInput?.value || "").trim();
  const confirm = (pinSetupConfirm?.value || "").trim();
  if (!/^\d{6}$/.test(bootstrapCode)) {
    showPinSetupError("Enter the six-digit setup code from data/host-bootstrap-code.json.");
    return;
  }
  if (!pin || pin.length < 4) {
    showPinSetupError("PIN must be at least 4 characters.");
    return;
  }
  if (pin !== confirm) {
    showPinSetupError("PIN confirmation does not match.");
    return;
  }
  pinSetupSaveBtn.disabled = true;
  try {
    await saveHostPin({ pin, bootstrapCode, fromSetup: true });
  } catch (err) {
    showPinSetupError(err.message || "Could not save PIN.");
  } finally {
    pinSetupSaveBtn.disabled = false;
  }
});

[pinSetupBootstrap, pinSetupInput, pinSetupConfirm].forEach((el) => {
  el?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") pinSetupSaveBtn?.click();
  });
});

function showPinError(msg) {
  if (!pinError) return;
  pinError.textContent = msg;
  pinError.hidden = false;
}

/** @type {{ close: () => void }|null} */
let pinModalSession = null;

function dismissPinGate() {
  pendingPinAction = null;
  closePinGate();
  const backTo = VIEWS[lastNonSettingsView] ? lastNonSettingsView : "main";
  navigate(backTo);
}

function openPinGate({ title = "Locked", action = "reveal-settings" } = {}) {
  if (!pinOverlay) return;
  pendingPinAction = action;
  if (pinError) {
    pinError.hidden = true;
    pinError.textContent = "";
  }
  if (pinInput) pinInput.value = "";
  const pinTitle = document.getElementById("pin-title");
  if (pinTitle) pinTitle.textContent = title;
  pinModalSession?.close();
  pinModalSession = attachModal(pinOverlay, {
    initialFocus: pinInput,
    onEscape: dismissPinGate,
    allowBackdrop: false,
  });
}

function closePinGate() {
  if (pinModalSession) {
    const session = pinModalSession;
    pinModalSession = null;
    session.close();
    return;
  }
  if (pinOverlay) pinOverlay.hidden = true;
}

async function submitPin() {
  const pin = (pinInput?.value || "").trim();
  if (!pin) {
    showPinError("Enter your PIN.");
    return;
  }
  if (pinUnlockBtn) pinUnlockBtn.disabled = true;
  try {
    const res = await fetch("/api/settings/verify-pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      setSettingsUnlocked(true);
      closePinGate();
      syncHostControlsVisibility();
      // Host session is live — pull full settings immediately so Booth/Vibe
      // toggles aren't stuck on HTML defaults until the next save.
      void loadSettings();
      void loadAutoFill();
      const action = pendingPinAction;
      pendingPinAction = null;
      if (action === "restart") {
        void confirmAndRestart();
      } else if (isHostArea(currentView)) {
        // Re-run the view now that the gate passes: reveals it and fires the
        // data loads showView skipped while locked.
        showView(currentView);
      }
      return;
    }
    if (res.status === 429) {
      const secs = Math.ceil((data.retryMs || 30000) / 1000);
      showPinError(`Too many attempts. Try again in ${secs}s.`);
    } else {
      showPinError("Incorrect PIN.");
    }
    if (pinInput) {
      pinInput.value = "";
      pinInput.focus();
    }
  } catch {
    showPinError("Could not verify PIN. Try again.");
  } finally {
    if (pinUnlockBtn) pinUnlockBtn.disabled = false;
  }
}

if (pinUnlockBtn) pinUnlockBtn.addEventListener("click", submitPin);
if (pinInput) {
  pinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitPin();
  });
}
if (pinCancelBtn) {
  pinCancelBtn.addEventListener("click", dismissPinGate);
}

// ---- Shared live Now Playing + queue + party streams ---------------------
// Visible main views share demand-driven server monitors through SSE. Hidden
// tabs and sub-pages close streams so idle phones produce no Sonos reads.
// Party toggles ride /api/party (not Now Playing).
const NOW_PLAYING_FALLBACK_MS = 15000;
const NOW_PLAYING_FALLBACK_DELAY_MS = 5000;
const QUEUE_FALLBACK_MS = 15000;
const QUEUE_FALLBACK_DELAY_MS = 5000;
const PARTY_FALLBACK_MS = 20000;
const PARTY_FALLBACK_DELAY_MS = 5000;
let nowPlayingSource = null;
let nowPlayingStreamConnected = false;
let nowPlayingFallbackTimer = null;
let nowPlayingFallbackDelayTimer = null;
let nowPlayingStreamSession = "";
let nowPlayingStreamSequence = 0;
let nowPlayingStreamVersion = 0;
let queueSource = null;
let queueStreamConnected = false;
let queueFallbackTimer = null;
let queueFallbackDelayTimer = null;
let queueStreamSession = "";
let queueStreamSequence = 0;
let queueStreamVersion = 0;
let queueHttpRequest = 0;
let pendingQueueStreamTracks = null;
let partySource = null;
let partyStreamConnected = false;
let partyFallbackTimer = null;
let partyFallbackDelayTimer = null;
let partyStreamSession = "";
let partyStreamSequence = 0;
let lastPartySettings = null;
let appReady = false;

function shouldPoll() {
  // Include Vibe (`mix`) so Discover / Never-Ending / Filter toggles keep
  // hydrating from /api/party while the host is adjusting the mix — otherwise
  // phones that open straight into Vibe sit on HTML defaults until a save.
  return (
    document.visibilityState === "visible" &&
    (currentView === "main" ||
      currentView === "display" ||
      currentView === "mix")
  );
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
  if (!shouldPoll() || nowPlayingStreamConnected || nowPlayingFallbackDelayTimer ||
      nowPlayingFallbackTimer) {
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
  const session = typeof snapshot?.streamSession === "string"
    ? snapshot.streamSession
    : "";
  const sequence = Number(snapshot?.streamSequence);
  if (
    session &&
    session === nowPlayingStreamSession &&
    Number.isFinite(sequence) &&
    sequence <= nowPlayingStreamSequence
  ) {
    return;
  }
  if (session && session !== nowPlayingStreamSession) {
    nowPlayingStreamSession = session;
    nowPlayingStreamSequence = 0;
  }
  if (Number.isFinite(sequence)) nowPlayingStreamSequence = sequence;
  nowPlayingStreamVersion += 1;
  renderNowPlaying(snapshot);
}

function setNowPlayingConnectionStatus(status, message = "") {
  const disconnected = status === "disconnected";
  if (disconnected && npIsPlayingOverlay) {
    npPositionBase = estimatedPositionSec();
    npPositionAt = playbackClockNow();
    npIsPlayingOverlay = false;
    updateTrackProgress();
  }
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

function openNowPlayingStream() {
  if (nowPlayingSource || !shouldPoll()) return;
  void loadNowPlaying();
  if (typeof EventSource !== "function") {
    startNowPlayingFallback();
    return;
  }
  // A new connection's initial event is also a clock resynchronization. Accept
  // it even when its track-change sequence matches the prior connection.
  nowPlayingStreamSession = "";
  nowPlayingStreamSequence = 0;
  const source = new EventSource("/api/nowplaying/stream");
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
    // Transport reconnects are normal when an SSE response ends. Keep the local
    // playhead moving — only server sonos-status "disconnected" means Sonos
    // itself is unreachable and should freeze the clock.
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
  const session =
    typeof snapshot?.streamSession === "string" ? snapshot.streamSession : "";
  const sequence = Number(snapshot?.streamSequence);
  if (
    session &&
    session === queueStreamSession &&
    Number.isFinite(sequence) &&
    sequence <= queueStreamSequence
  ) {
    return;
  }
  if (session && session !== queueStreamSession) {
    queueStreamSession = session;
    queueStreamSequence = 0;
  }
  if (Number.isFinite(sequence)) queueStreamSequence = sequence;
  queueStreamVersion += 1;
  const tracks = Array.isArray(snapshot?.tracks) ? snapshot.tracks : [];
  if (queueEditMode) {
    pendingQueueStreamTracks = tracks;
    return;
  }
  pendingQueueStreamTracks = null;
  applyQueueTracks(tracks);
}

function openQueueStream() {
  if (queueSource || !shouldPoll()) return;
  if (typeof EventSource !== "function") {
    void loadQueue();
    startQueueFallback();
    return;
  }
  queueStreamSession = "";
  queueStreamSequence = 0;
  const source = new EventSource("/api/queue/stream");
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

/** Apply guest-safe party flags from /api/party (SSE or HTTP). */
function applyPartySettings(payload) {
  if (!payload || typeof payload !== "object") return;
  lastPartySettings = payload;
  if ("neverEnding" in payload) syncAutoFillFromServer(payload.neverEnding);
  if ("discoverEnabled" in payload) {
    syncDiscoverFromServer(payload.discoverEnabled);
  }
  syncContentTogglesFromServer(payload);
  if (payload.showQueueGenre != null) {
    syncShowQueueGenre(!!payload.showQueueGenre, { rerender: true });
  }
  syncRotationFromServer(payload);
  updateMixSelectionFromServer(payload);
  if (payload.requestsPaused != null) {
    setRequestsPausedUi(!!payload.requestsPaused);
  }
  if (payload.partyOver != null && Date.now() - partyOverTouchedAt > 4000) {
    setPartyOverUi(!!payload.partyOver);
  }
  if (payload.hostControlsOnly != null) {
    hostControlsOnly = !!payload.hostControlsOnly;
    if (hostControlsInput) hostControlsInput.checked = hostControlsOnly;
    syncHostControlsVisibility();
  }
  maybeAnnounceClosingTime(payload.closingTimeAt, payload.partyRecap);
}

function applyPartyStreamSnapshot(snapshot) {
  const session =
    typeof snapshot?.streamSession === "string" ? snapshot.streamSession : "";
  const sequence = Number(snapshot?.streamSequence);
  if (
    session &&
    session === partyStreamSession &&
    Number.isFinite(sequence) &&
    sequence <= partyStreamSequence
  ) {
    return;
  }
  if (session && session !== partyStreamSession) {
    partyStreamSession = session;
    partyStreamSequence = 0;
  }
  if (Number.isFinite(sequence)) partyStreamSequence = sequence;
  applyPartySettings(snapshot);
}

async function loadPartySettings() {
  try {
    const res = await fetch("/api/party");
    if (!res.ok) return;
    applyPartySettings(await res.json());
  } catch {
    /* leave toggles as-is on transient errors */
  }
}

function openPartyStream() {
  if (partySource || !shouldPoll()) return;
  void loadPartySettings();
  if (typeof EventSource !== "function") {
    startPartyFallback();
    return;
  }
  partyStreamSession = "";
  partyStreamSequence = 0;
  const source = new EventSource("/api/party/stream");
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

// Open/close live streams to match the active visible view. An initial HTTP
// read paints immediately while SSE establishes and remains the fallback path.
function syncPolling() {
  if (shouldPoll()) {
    void loadQueue();
    if (currentView !== "display") void loadGroups();
    openNowPlayingStream();
    openQueueStream();
    openPartyStream();
  } else {
    closeNowPlayingStream();
    closeQueueStream();
    closePartyStream();
  }
}

function showView(name) {
  const target = VIEWS[name] ? name : "main";
  const previousView = currentView;
  if (!isHostArea(target)) lastNonSettingsView = target;
  currentView = target;
  for (const key of Object.keys(VIEWS)) VIEWS[key].hidden = key !== target;
  document.body.classList.toggle("party-display-active", target === "display");
  // The DJ Booth and everything behind it require the host PIN. While locked,
  // keep the view hidden and skip its data loads (they'd 401 anyway).
  const hostLocked = isHostArea(target) && !settingsGateOk();
  if (hostLocked) {
    VIEWS[target].hidden = true;
    openPinGate({
      title: "DJ Booth is locked",
      action: "reveal-host",
    });
  } else if (pinOverlay && !pinOverlay.hidden && pendingPinAction !== "restart") {
    pendingPinAction = null;
    closePinGate(); // leaving the Booth (e.g. phone Back) dismisses the gate
  }
  if (target === "stats") loadStats();
  if (target === "join" || target === "display") loadJoinCode();
  if (target === "display" && displayEventName) {
    displayEventName.textContent =
      document.getElementById("event-name")?.textContent?.trim() || "PartyQueue";
  }
  if (target === "display") {
    syncNowPlayingLyrics(lastNowPlaying);
  } else if (previousView === "display" && !npOverlayOpen) {
    clearLyricsRetry();
    stopLyricTicker();
    npLyricsFetchId += 1;
  }
  if (!hostLocked) {
    if (target === "booth") updateBoothHubSummaries();
    if (target === "settings-dj") updateDjHubSummaries();
    if (target === "settings-dj-advanced") void loadDjEffectivePrompt();
    // Booth holds most host toggles; hydrate them the same way Settings does
    // (eager boot loadSettings often 401s before PIN unlock).
    if (target === "booth" || isSettingsArea(target)) revealSettings();
    if (target === "memory") loadMemory();
    if (target === "suggestions") loadSuggestions();
    // A long-lived tab can outlive the server's host session (restart or
    // expiry). Confirm it in the background and re-lock if it's gone.
    if (isHostArea(target)) void verifyHostSessionStillValid();
  }
  if (target === "sonos") loadGroups(true);
  if (isMusicMixArea(target)) {
    syncToolbarMoodVisibility();
    // Public toggle hydrate — don't wait for playlists/genres.
    void loadAutoFill();
    if (target === "playlists") loadPlaylists();
    if (target === "mix") updateMusicMixHubSummaries();
  }
  syncHostControlsVisibility();
  // Start/stop polling to match the new view (skipped during initial load).
  if (appReady) syncPolling();
  window.scrollTo(0, 0);
}

// Settings-entry data loads whenever a Settings panel is opened.
function revealSettings() {
  if (VIEWS[currentView]) VIEWS[currentView].hidden = false;
  // The eager startup request can receive 401 before a host PIN is unlocked.
  // Retry here so every Settings panel receives persisted/effective values.
  void loadSettings();
  loadBanners(); // refresh banner gallery on entry
  loadDjIcons(); // refresh DJ icon gallery on entry
  loadGuests(); // refresh shout-out user notes
  loadSpotifyStatus(); // refresh the connected / rate-limited indicator
  loadSpotifyAppStatus();
  loadSonosConnStatus();
  loadLastfmStatus();
  loadHaStatus();
  void refreshHostPinStatus();
}

function routeFromHash() {
  let h = (location.hash || "").replace(/^#\/?/, "");
  if (h === "options") h = "booth"; // old bookmark alias
  if (h === "settings") h = "booth"; // Settings hub folded into the Booth
  if (h === "mood") h = "mix"; // old Vibe (Music Mix) bookmark alias
  showView(VIEWS[h] ? h : "main");
}

function navigate(name) {
  const hash = name === "main" ? "#/" : `#/${name}`;
  if (location.hash === hash) routeFromHash();
  else location.hash = hash;
}

// Mood / Genres / Playlists Back returns here (Vibe hub, main, etc.) instead of
// always jumping to the Vibe hub — e.g. Now Playing Mood/Genre labels.
let mixPanelReturnView = "mix";

function isMixPanelView(name) {
  return (
    name === "mood-presets" || name === "genres" || name === "playlists"
  );
}

function rememberMixPanelReturn() {
  if (isMixPanelView(currentView)) return;
  mixPanelReturnView =
    currentView && VIEWS[currentView] ? currentView : "main";
}

function navigateMixPanel(panel) {
  if (!panel || !VIEWS[panel]) return;
  rememberMixPanelReturn();
  navigate(panel);
}

function navigateMixPanelBack() {
  const back =
    mixPanelReturnView && VIEWS[mixPanelReturnView]
      ? mixPanelReturnView
      : "mix";
  navigate(back);
}

document.querySelectorAll("[data-settings-panel]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const panel = btn.getAttribute("data-settings-panel");
    if (panel && VIEWS[panel]) navigate(panel);
  });
});
document.querySelectorAll("[data-dj-panel]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const panel = btn.getAttribute("data-dj-panel");
    if (panel && VIEWS[panel]) navigate(panel);
  });
});
document.querySelectorAll("[data-mix-panel]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const panel = btn.getAttribute("data-mix-panel");
    navigateMixPanel(panel);
  });
});
openMemoryBtn?.addEventListener("click", () => navigate("memory"));
openSuggestionsBtn?.addEventListener("click", () => navigate("suggestions"));
openResetBtn?.addEventListener("click", () => navigate("settings-reset"));

let boothMediaUrlCache = "";

/** Fill the Sonos media URL card (lives on the DJ hub) and cache it for Copy. */
async function refreshBoothMediaUrl() {
  const mediaUrlEl = document.getElementById("booth-stat-media-url");
  if (!mediaUrlEl) return;
  try {
    const r = await fetch("/api/media-base");
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "unavailable");
    boothMediaUrlCache = data.url || "";
    mediaUrlEl.textContent = boothMediaUrlCache || "—";
  } catch {
    boothMediaUrlCache = "";
    mediaUrlEl.textContent = "unavailable";
  }
}

/** Live counts on DJ Booth hub cards (title + stat + static desc, like Vibe). */
async function updateBoothHubSummaries() {
  const memoryEl = document.getElementById("booth-stat-memory");
  const suggestionsEl = document.getElementById("booth-stat-suggestions");

  const tasks = [];
  if (memoryEl) {
    tasks.push(
      hostFetch("/api/history")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          const n = Array.isArray(data?.tracks) ? data.tracks.length : 0;
          memoryEl.textContent =
            n === 1 ? "1 song remembered" : `${n} songs remembered`;
        })
        .catch(() => {
          memoryEl.textContent = "—";
        })
    );
  }
  if (suggestionsEl) {
    tasks.push(
      hostFetch("/api/suggestions?includeDone=1")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          const open = Number(data?.counts?.open);
          const n = Number.isFinite(open)
            ? open
            : Array.isArray(data?.suggestions)
              ? data.suggestions.filter((s) => !s.done).length
              : 0;
          suggestionsEl.textContent =
            n === 1 ? "1 open suggestion" : `${n} open suggestions`;
        })
        .catch(() => {
          suggestionsEl.textContent = "—";
        })
    );
  }
  await Promise.all(tasks);
}

const boothMediaUrlCopyBtn = document.getElementById("booth-media-url-copy");
if (boothMediaUrlCopyBtn) {
  boothMediaUrlCopyBtn.addEventListener("click", async () => {
    if (!boothMediaUrlCache) {
      showToast("No media URL to copy yet.", true);
      return;
    }
    try {
      await navigator.clipboard.writeText(boothMediaUrlCache);
      showToast("Media URL copied");
    } catch {
      showToast(boothMediaUrlCache, false, 6000);
    }
  });
}

async function confirmAndRestart() {
  const ok = await confirmModal(
    "Restart PartyQueue now? Playback may pause briefly while the server comes back.",
    "Restart",
    "Cancel"
  );
  if (!ok) return;
  if (restartAppBtn) restartAppBtn.disabled = true;
  showToast("Restarting…", false, 8000);
  try {
    const res = await hostFetch("/api/restart", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not restart.");
    // Poll until the new process answers health again.
    const started = Date.now();
    while (Date.now() - started < 20000) {
      await new Promise((r) => setTimeout(r, 800));
      try {
        const h = await fetch("/api/health", { cache: "no-store" });
        if (h.ok) {
          showToast("Back online");
          location.reload();
          return;
        }
      } catch {
        /* still down */
      }
    }
    showToast("Restarted — refresh if the page looks stuck.", false, 5000);
  } catch (err) {
    showToast(err.message || "Restart failed.", true);
    if (restartAppBtn) restartAppBtn.disabled = false;
  }
}

restartAppBtn?.addEventListener("click", () => {
  void confirmAndRestart();
});
settingsLookBackBtn?.addEventListener("click", () => navigate("booth"));
settingsQueueBackBtn?.addEventListener("click", () => navigate("booth"));
settingsDjBackBtn?.addEventListener("click", () => navigate("booth"));
settingsDjBannerBackBtn?.addEventListener("click", () => navigate("settings-dj"));
settingsDjNameBackBtn?.addEventListener("click", () => navigate("settings-dj"));
settingsDjVoiceBackBtn?.addEventListener("click", () => navigate("settings-dj"));
settingsDjAdvancedBackBtn?.addEventListener("click", () => navigate("settings-dj"));
settingsDjVolumeBackBtn?.addEventListener("click", () => navigate("settings-dj"));
settingsDjShoutsBackBtn?.addEventListener("click", () => navigate("settings-dj"));
settingsDjLastcallBackBtn?.addEventListener("click", () => navigate("settings-dj"));
settingsUsersBackBtn?.addEventListener("click", () => navigate("booth"));
settingsUserEditBackBtn?.addEventListener("click", () => navigate("settings-users"));
settingsConnectionsBackBtn?.addEventListener("click", () => navigate("booth"));
settingsResetBackBtn?.addEventListener("click", () => navigate("booth"));
statsBackBtn?.addEventListener("click", () => navigate("main"));
playlistsBackBtn.addEventListener("click", () => navigateMixPanelBack());
memoryBackBtn.addEventListener("click", () => navigate("booth"));
suggestionsBackBtn?.addEventListener("click", () => navigate("booth"));
sonosBackBtn?.addEventListener("click", () => navigate("main"));
moodBackBtn?.addEventListener("click", () => navigate("main"));
moodPresetsBackBtn?.addEventListener("click", () => navigateMixPanelBack());
genresBackBtn?.addEventListener("click", () => navigateMixPanelBack());
boothBackBtn?.addEventListener("click", () => navigate("main"));
joinBackBtn?.addEventListener("click", () => navigate("main"));
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && currentView === "display") {
    event.preventDefault();
    navigate("main");
  }
});
window.addEventListener("hashchange", routeFromHash);
// The initial route runs at the bottom of this file (before appReady): view
// hooks like the Vibe summaries touch state declared later, and routing
// here would crash module evaluation on a #/mood or #/display deep link,
// killing every boot fetch — toggles then read "off" until a plain reload.

let joinUrlCache = "";

async function loadJoinCode() {
  for (const errorEl of [joinErrorEl, displayJoinError]) {
    if (!errorEl) continue;
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
  for (const qrEl of [joinQrEl, displayJoinQr]) {
    if (qrEl) qrEl.innerHTML = "";
  }
  if (joinUrlEl) joinUrlEl.textContent = "Loading…";
  if (displayJoinUrl) displayJoinUrl.textContent = "Loading…";
  try {
    const res = await fetch("/api/join");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not load join code.");
    joinUrlCache = data.url || "";
    if (joinUrlEl) joinUrlEl.textContent = joinUrlCache;
    if (displayJoinUrl) displayJoinUrl.textContent = joinUrlCache;
    if (data.qrSvg) {
      if (joinQrEl) joinQrEl.innerHTML = data.qrSvg;
      if (displayJoinQr) displayJoinQr.innerHTML = data.qrSvg;
    }
  } catch (err) {
    joinUrlCache = "";
    if (joinUrlEl) joinUrlEl.textContent = "";
    if (displayJoinUrl) displayJoinUrl.textContent = "";
    for (const errorEl of [joinErrorEl, displayJoinError]) {
      if (!errorEl) continue;
      errorEl.hidden = false;
      errorEl.textContent = err.message || "Join code unavailable.";
    }
  }
}

if (joinRefreshBtn) {
  joinRefreshBtn.addEventListener("click", () => loadJoinCode());
}
if (joinCopyBtn) {
  joinCopyBtn.addEventListener("click", async () => {
    if (!joinUrlCache) {
      showToast("No link to copy yet.", true);
      return;
    }
    try {
      await navigator.clipboard.writeText(joinUrlCache);
      showToast("Link copied");
    } catch {
      showToast(joinUrlCache, false, 6000);
    }
  });
}

const EMPTY_MESSAGE =
  "Nothing is playing, add some music to the queue to start the party";
const CONNECTING_MESSAGE = "Connecting\u2026";
let npIsPlaying = false;
// First paint placeholders so the main view isn't blank while SSE/poll catch up.
if (npEmpty && npCard) {
  npCard.classList.add("is-empty");
  npEmpty.hidden = false;
  npEmpty.textContent = CONNECTING_MESSAGE;
}
if (queueEmpty) {
  queueEmpty.hidden = false;
  queueEmpty.textContent = CONNECTING_MESSAGE;
}

let debounceTimer = null;
let currentQuery = "";

searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim();
  searchClear.hidden = searchInput.value.length === 0;
  clearTimeout(debounceTimer);
  if (!q) {
    resultsEl.innerHTML = "";
    statusEl.textContent = "";
    return;
  }
  debounceTimer = setTimeout(() => runSearch(q), 300);
});

searchClear.addEventListener("click", () => {
  clearTimeout(debounceTimer);
  searchInput.value = "";
  searchClear.hidden = true;
  resultsEl.innerHTML = "";
  statusEl.textContent = "";
  searchInput.focus();
});

async function runSearch(q) {
  currentQuery = q;
  statusEl.textContent = "Searching...";
  resultsEl.setAttribute("aria-busy", "true");
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    // Ignore stale responses if the user kept typing.
    if (q !== currentQuery) return;

    if (!res.ok) {
      resultsEl.innerHTML = "";
      statusEl.textContent = data.error || "Search failed.";
      return;
    }
    renderResults(data.tracks || []);
  } catch {
    if (q !== currentQuery) return;
    resultsEl.innerHTML = "";
    statusEl.textContent = "Network error. Try again.";
  } finally {
    if (q === currentQuery) resultsEl.removeAttribute("aria-busy");
  }
}

// Track IDs currently in the queue + the one now playing, so search results can
// flag songs that are already queued.
let queuedIdSet = new Set();
let searchedQueuedIdSet = new Set(); // queued via guest search (the priority lane)
let queuedKeySet = new Set(); // song keys (title+artist) of everything queued
let searchedQueuedKeySet = new Set(); // song keys queued via guest search
let nowPlayingId = null;
let nowPlayingKey = "";

function trackIdFromUri(uri) {
  if (!uri) return null;
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    /* use as-is if it isn't valid percent-encoding */
  }
  const m = /spotify:track:([A-Za-z0-9]+)/.exec(decoded);
  return m ? m[1] : null;
}

// Loose "same song" key (title + primary artist), mirroring the server. Spotify
// has many IDs for one song (album vs single vs remaster), so we also match by
// this key to flag dupes that ID matching alone would miss.
function songMatchKey(title, artist) {
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\(.*?\)|\[.*?\]/g, " ")
      .replace(/\s[-\u2013]\s.*$/, " ")
      .replace(/\bfeat\.?\b.*$/, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const t = norm(title);
  const a = norm(String(artist || "").split(",")[0]);
  return t && a ? `${t}|${a}` : "";
}

function isQueued(id, key) {
  if (id && (queuedIdSet.has(id) || id === nowPlayingId)) return true;
  return !!key && (queuedKeySet.has(key) || key === nowPlayingKey);
}

// Flag any visible search result whose song is already in the queue / playing.
// A song waiting as filler (Random / Never-Ending / discovery) gets a distinct
// "Random queue" badge; a guest-searched (or now-playing) song reads "In queue".
function updateResultsQueuedState() {
  for (const li of resultsEl.children) {
    const id = li.dataset.id;
    const key = li.dataset.key || "";
    const queued = isQueued(id, key);
    li.classList.toggle("in-queue", queued);
    const badge = li.querySelector(".in-queue-badge");
    if (!badge) continue;
    badge.hidden = !queued;
    if (queued) {
      const isSearched =
        (id && (searchedQueuedIdSet.has(id) || id === nowPlayingId)) ||
        (key && (searchedQueuedKeySet.has(key) || key === nowPlayingKey));
      const isRandom = !isSearched;
      badge.textContent = isRandom ? "\u{1F3B2} In Random queue" : "\u2713 In queue";
      badge.classList.toggle("random", isRandom);
    }
  }
}

function renderResults(tracks) {
  resultsEl.innerHTML = "";
  statusEl.textContent = tracks.length ? "" : "No songs found.";

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

async function addToQueue(track, btn) {
  if (partyOver) {
    showToast(GUEST_BANNER_PARTY_OVER, true);
    return;
  }
  if (requestsPaused) {
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
  const exactMatch = !!id && (queuedIdSet.has(id) || id === nowPlayingId);
  // A *different* Spotify version (same song, different track ID) is already in
  // the queue. Let the guest decide: add this version too, or just move the one
  // that's already waiting up to the front. (Exact-same versions skip the prompt
  // and are simply promoted - we never want a true duplicate.)
  const versionMatch =
    !exactMatch && !!key && (queuedKeySet.has(key) || key === nowPlayingKey);

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
    const res = await fetch("/api/queue", {
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
      lastClosingShown = data.closingTimeAt || Date.now(); // don't re-toast on poll
      showPartyRecap(data.partyRecap);
    } else {
      const msg = data.alreadyRequested
        ? `"${track.name}" is already in the requested queue.`
        : await buildAddToastMessage(track, data);
      // Optional dedicate — does not block Add. Toast action opens a short field.
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
    // Keep Stats current if that page is open.
    if (currentView === "stats") loadStats();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Add";
    showToast(err.message, true);
  }
}

/** Build add/move toast; mention when a DJ pad sits ahead of the song. */
async function buildAddToastMessage(track, data) {
  const pos = Number(data.queuePosition);
  let afterDj = false;
  try {
    const res = await fetch("/api/queue/list");
    if (res.ok) {
      const q = await res.json();
      const tracks = Array.isArray(q) ? q : q?.tracks || [];
      const id = trackIdFromUri(track.uri);
      const idx = id
        ? tracks.findIndex((t) => trackIdFromUri(t.uri) === id)
        : -1;
      if (idx > 0) {
        afterDj = tracks.slice(0, idx).some((t) => t.djVoice);
      } else if (idx < 0 && Number.isFinite(pos) && pos > 1) {
        afterDj = tracks.slice(0, pos - 1).some((t) => t.djVoice);
      }
    }
  } catch {
    /* ignore — toast still works without the DJ hint */
  }
  const djSuffix = afterDj ? " \u00b7 after DJ" : "";
  if (data.started) {
    return `Added "${track.name}" \u2014 now playing`;
  }
  if (data.promoted) {
    return Number.isFinite(pos) && pos > 0
      ? `Moved "${track.name}" up \u2014 you\u2019re #${pos}${djSuffix}`
      : `Moved "${track.name}" up \u2014 it was already queued`;
  }
  return Number.isFinite(pos) && pos > 0
    ? `Added \u2014 you\u2019re #${pos}${djSuffix}`
    : `Added "${track.name}" to the queue`;
}

function openDedicationModal(track) {
  if (!dedicationOverlay || !dedicationInput) return;
  dedicationError.hidden = true;
  dedicationError.textContent = "";
  dedicationInput.value = "";

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
      dedicationError.textContent = "Enter a name or short note, or tap Skip.";
      dedicationError.hidden = false;
      return;
    }
    dedicationSaveBtn.disabled = true;
    try {
      const res = await fetch("/api/queue/dedication", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uri: track.uri,
          name: track.name,
          artist: track.artists,
          dedication: note,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not save dedication.");
      cleanup();
      const by = getDisplayAlias() || getDisplayName();
      showToast(dedicationDisplayLabel(note, by) || "Dedication saved");
      refreshSonos();
    } catch (err) {
      dedicationError.textContent = err.message || "Could not save.";
      dedicationError.hidden = false;
    } finally {
      dedicationSaveBtn.disabled = false;
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

// Promise-based confirm modal. Resolves true if the user confirms.
function confirmModal(message, confirmLabel = "Yes", cancelLabel = "Cancel") {
  return new Promise((resolve) => {
    modalMessage.textContent = message;
    modalConfirm.textContent = confirmLabel;
    modalCancel.textContent = cancelLabel;

    let session = null;
    const cleanup = (result) => {
      modalConfirm.removeEventListener("click", onConfirm);
      modalCancel.removeEventListener("click", onCancel);
      session?.close();
      session = null;
      resolve(result);
    };
    const onConfirm = () => cleanup(true);
    const onCancel = () => cleanup(false);

    modalConfirm.addEventListener("click", onConfirm);
    modalCancel.addEventListener("click", onCancel);
    session = attachModal(modalOverlay, {
      initialFocus: modalConfirm,
      onEscape: onCancel,
      allowBackdrop: true,
      onBackdrop: onCancel,
    });
  });
}

clearBtn.addEventListener("click", async () => {
  // Double confirm — intentional; Clear Queue is open to the party but destructive.
  const first = await confirmModal("Are you sure you want to clear the Queue?");
  if (!first) return;

  const second = await confirmModal(
    "Are you sure? This will clear the existing Queue.",
    "Clear Queue"
  );
  if (!second) return;

  clearBtn.disabled = true;
  clearBtn.textContent = "Clearing...";
  try {
    const res = await hostFetch("/api/queue/clear", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not clear the queue.");
    showToast("Queue cleared");
    refreshSonos();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    clearBtn.disabled = false;
    clearBtn.textContent = "Clear Queue";
  }
});

// ---- Full-screen Now Playing + lyrics ------------------------------------
/** Latest transport snapshot from SSE/HTTP (may include metadataPending). */
let lastTransportNp = null;
/** What the card/overlay/display paint (confirmed or optimistic). */
let lastNowPlaying = null;
/** Last coherent non-pending track used while Sonos metadata lags. */
let lastConfirmedNp = null;
/** Optimistic next-queue paint after host Skip, until transport confirms. */
let optimisticNp = null;
/** confirmed | optimistic | converging | empty */
let nowPlayingDisplayMode = "empty";
let lastQueueTracks = [];
let nowPlayingHttpRequest = 0;
// Queue editing (delete + drag-reorder). Off by default.
let queueEditMode = false;
let sortable = null;
let lastArtPrefetchKey = "";

/** Skip art prefetch on Save-Data / very slow cellular. */
function shouldPrefetchMedia() {
  try {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn?.saveData) return false;
    const type = String(conn?.effectiveType || "");
    if (type === "slow-2g" || type === "2g") return false;
  } catch {
    /* ignore */
  }
  return true;
}

/** Warm browser/HTTP cache for upcoming covers (next 1–2 in queue). */
function prefetchUpcomingAlbumArt(queueTracks = lastQueueTracks) {
  if (!shouldPrefetchMedia() || document.visibilityState !== "visible") return;
  const seen = new Set();
  const upcoming = [];
  for (const track of Array.isArray(queueTracks) ? queueTracks : []) {
    if (!track?.albumArt || track.djVoice || seen.has(track.albumArt)) continue;
    seen.add(track.albumArt);
    upcoming.push(track);
    if (upcoming.length === 2) break;
  }
  const key = upcoming.map((t) => t.albumArt).join("|");
  if (!key || key === lastArtPrefetchKey) return;
  lastArtPrefetchKey = key;
  for (const t of upcoming) {
    const img = new Image();
    img.decoding = "async";
    img.src = t.albumArt;
  }
}
let npOverlayOpen = false;
let npLyricsKey = "";
let npLyricsFetchId = 0;
/** @type {{ t: number, text: string }[]|null} */
let npSyncedLines = null;
let npPositionBase = 0;
let npPositionAt = 0;
let npIsPlayingOverlay = false;
let npProgressClockKey = "";
let npLyricTick = null;
let npLyricsRetryTimer = null;
let npOverlayHistoryPushed = false;

function playbackClockNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function lyricsTrackKey(np) {
  return playbackIdentity(np);
}

function lyricsActive() {
  return npOverlayOpen || currentView === "display";
}

function lyricsContainers() {
  return [npFsLyrics, displayLyrics].filter(Boolean);
}

function lyricsContainerHasPaint(el) {
  return !!el?.querySelector(
    ".np-fs-lyrics-synced, .np-fs-lyrics-plain, .np-fs-lyrics-status"
  );
}

/** Copy a filled lyrics panel into any empty sibling targets. */
function mirrorLyricsContainers() {
  const containers = lyricsContainers();
  const source = containers.find((el) => lyricsContainerHasPaint(el));
  if (!source) return;
  for (const el of containers) {
    if (el === source || lyricsContainerHasPaint(el)) continue;
    // Party Display uses a 3-line window for synced lyrics — not a full list clone.
    if (
      el === displayLyrics &&
      npSyncedLines &&
      source.querySelector(".np-fs-lyrics-synced")
    ) {
      continue;
    }
    el.innerHTML = source.innerHTML;
  }
}

/**
 * Party Display karaoke window: previous / current / next only.
 * Avoids scrollIntoView, which can shove the TV layout off-screen.
 */
function paintDisplayLyricWindow(activeIdx) {
  if (!displayLyrics || !npSyncedLines) return;
  const ul = document.createElement("ul");
  ul.className = "np-fs-lyrics-synced party-display-lyrics-window";
  const slots = [
    { i: activeIdx - 1, cls: "is-past" },
    { i: activeIdx, cls: "is-active" },
    { i: activeIdx + 1, cls: "is-next" },
  ];
  for (const slot of slots) {
    const li = document.createElement("li");
    li.className = "np-fs-line";
    const line =
      slot.i >= 0 && slot.i < npSyncedLines.length
        ? npSyncedLines[slot.i]
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

function setNpFsLyricsStatus(msg) {
  npSyncedLines = null;
  const html = `<p class="np-fs-lyrics-status">${escapeHtml(msg)}</p>`;
  for (const el of lyricsContainers()) el.innerHTML = html;
}

function renderPlainLyrics(text) {
  npSyncedLines = null;
  for (const el of lyricsContainers()) {
    const pre = document.createElement("pre");
    pre.className = "np-fs-lyrics-plain";
    pre.textContent = text;
    el.innerHTML = "";
    el.appendChild(pre);
  }
}

function renderSyncedLyrics(lines) {
  npSyncedLines = lines;
  // Full scrolling sheet for the phone overlay; TV uses a 3-line window.
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
  // Attribution stays on the phone overlay only — keep the TV lyrics box compact.
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
  let pos = npPositionBase;
  if (npIsPlayingOverlay && npPositionAt) {
    pos += (playbackClockNow() - npPositionAt) / 1000;
  }
  return pos;
}

function formatTrackTime(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
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
  const isAnnouncement =
    !!lastNowPlaying?.djVoice || !!lastNowPlaying?.djSilence;
  // Keep the bar visible during transitions; duration may be unknown for
  // optimistic queue rows until Sonos confirms.
  const duration = isAnnouncement
    ? Number.NaN
    : Number(lastNowPlaying?.durationSec);
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

// Advance synced lyrics slightly to offset Sonos reporting, polling, ticker,
// and display latency. This affects lyric highlighting only, not playback.
const LYRICS_LEAD_SEC = 0.75;

/**
 * Keep a smooth local playhead. Sonos provides sparse position anchors, so the
 * browser advances them using a monotonic clock. Resync only on initial load,
 * track/play-state changes, or a real seek (large drift).
 */
function applyPlaybackClock(np, { force = false } = {}) {
  const clockNow = playbackClockNow();
  // Display models already strip metadataPending; keep the playhead moving
  // through converging/optimistic phases.
  const playing = !!(np && np.isPlaying && !np.djVoice);
  // Snapshot age is calculated server-side; never compare server wall time with
  // the phone clock.
  const serverPos = serverPlaybackPosition(np);
  const hasServer = serverPos != null;

  if (force || !npPositionAt) {
    npPositionBase = hasServer ? serverPos : 0;
    npPositionAt = clockNow;
    npIsPlayingOverlay = playing;
    return;
  }

  const estimated = estimatedPositionSec();

  if (!hasServer) {
    if (playing !== npIsPlayingOverlay && !playing) {
      npPositionBase = estimated;
      npPositionAt = clockNow;
    }
    npIsPlayingOverlay = playing;
    return;
  }

  const drift = Math.abs(serverPos - estimated);
  const playChanged = playing !== npIsPlayingOverlay;
  // Replayed SSE anchors (reconnect / retained snapshot) can be older than the
  // local playhead. Never yank time backward for the same track — only snap on
  // pause/play changes, forward seeks, or large forward drift.
  const staleReplay = playing && !playChanged && serverPos + 0.75 < estimated;
  if (playChanged || !playing) {
    npPositionBase = hasServer ? serverPos : estimated;
    npPositionAt = clockNow;
  } else if (!staleReplay && drift > 1.5) {
    npPositionBase = serverPos;
    npPositionAt = clockNow;
  }
  npIsPlayingOverlay = playing;
}

function shouldScrollLyricsRoot(root) {
  if (root === npFsLyrics) return npOverlayOpen;
  if (root === displayLyrics) return currentView === "display";
  return false;
}

function updateSyncedHighlight(forceScroll) {
  if (!npSyncedLines) return;
  const pos = estimatedPositionSec();
  let idx = -1;
  for (let i = 0; i < npSyncedLines.length; i++) {
    if (npSyncedLines[i].t <= pos + LYRICS_LEAD_SEC) idx = i;
    else break;
  }
  if (currentView === "display") paintDisplayLyricWindow(idx);
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

function startLyricTicker() {
  stopLyricTicker();
  if (!lyricsActive() || !npSyncedLines) return;
  let lastIdx = -1;
  const tick = () => {
    if (!lyricsActive() || !npSyncedLines) return;
    const pos = estimatedPositionSec();
    let idx = -1;
    for (let i = 0; i < npSyncedLines.length; i++) {
      if (npSyncedLines[i].t <= pos + LYRICS_LEAD_SEC) idx = i;
      else break;
    }
    if (idx !== lastIdx) {
      lastIdx = idx;
      updateSyncedHighlight(false);
    }
    npLyricTick = setTimeout(tick, 250);
  };
  updateSyncedHighlight(true);
  npLyricTick = setTimeout(tick, 250);
}

function stopLyricTicker() {
  if (npLyricTick) {
    clearTimeout(npLyricTick);
    npLyricTick = null;
  }
}

function clearLyricsRetry() {
  if (npLyricsRetryTimer) {
    clearTimeout(npLyricsRetryTimer);
    npLyricsRetryTimer = null;
  }
}

const artworkRequests = new WeakMap();

function bindNowPlayingArtwork(img, np) {
  if (!img) return;
  const key = playbackIdentity(np) || mediaIdentity(np);
  const url = String(np?.albumArt || "");
  const alt = np?.album
    ? `Album art for ${np.album}`
    : np?.title
      ? `Artwork for ${np.title}`
      : "";
  if (!url) {
    // Keep prior pixels when the next cover is unknown; only clear on empty UI.
    if (!np || !(np.title || np.artist)) {
      artworkRequests.delete(img);
      img.removeAttribute("src");
      img.alt = "";
      delete img.dataset.artIdentity;
    }
    return;
  }
  if (img.dataset.artIdentity === key && img.getAttribute("src") === url) {
    img.alt = alt;
    return;
  }

  const request = { key, url };
  artworkRequests.set(img, request);
  // Keep current pixels visible until the replacement decodes so track changes
  // never flash an empty art frame.
  const preload = new Image();
  preload.decoding = "async";
  preload.src = url;
  const ready =
    typeof preload.decode === "function"
      ? preload.decode().catch(() => {
          if (!preload.complete || !preload.naturalWidth) throw new Error("decode failed");
        })
      : new Promise((resolve, reject) => {
          preload.onload = resolve;
          preload.onerror = reject;
        });
  ready
    .then(() => {
      if (artworkRequests.get(img) !== request) return;
      img.decoding = "async";
      img.src = url;
      img.alt = alt;
      img.dataset.artIdentity = key;
    })
    .catch(() => {
      if (artworkRequests.get(img) !== request) return;
      // Keep prior pixels on failure. If nothing is showing yet, still bind the
      // URL so the browser can retry / show a broken-image affordance.
      if (!img.getAttribute("src")) {
        img.src = url;
        img.alt = alt;
        img.dataset.artIdentity = key;
      }
    });
}

function fillNpOverlayMeta(np) {
  if (!npFsTitle) return;
  const hasTrack = np && (np.title || np.artist);
  npFsTitle.textContent = hasTrack ? np.title || "" : "";
  npFsArtist.textContent = hasTrack ? np.artist || "" : "";
  npFsAlbum.textContent = hasTrack ? np.album || "" : "";
  bindNowPlayingArtwork(npFsArt, np);
}

function lyricsMissMessage(data) {
  if (data?.degraded) {
    return "No lyrics found — providers are having trouble";
  }
  return "No lyrics found";
}

async function loadOverlayLyrics(np, { retryCount = 0 } = {}) {
  clearLyricsRetry();
  const fetchId = ++npLyricsFetchId;
  if (!np || np.djVoice || !(np.title && np.artist)) {
    setNpFsLyricsStatus(
      np?.djVoice ? "DJ Voice — no lyrics" : "No lyrics for this track"
    );
    return;
  }
  // Keep an already-painted lyric sheet visible while a quiet refresh runs.
  const hasPaintedLyrics = lyricsContainers().some((el) =>
    el.querySelector(".np-fs-lyrics-synced, .np-fs-lyrics-plain")
  );
  if (!hasPaintedLyrics) setNpFsLyricsStatus("Loading lyrics…");
  const params = new URLSearchParams({
    title: np.title,
    artist: np.artist,
  });
  if (np.album) params.set("album", np.album);
  if (np.uri) params.set("uri", np.uri);
  if (np.durationSec != null && Number.isFinite(np.durationSec) && np.durationSec > 0) {
    params.set("duration", String(Math.round(np.durationSec)));
  }
  try {
    const res = await fetch(`/api/lyrics?${params}`);
    const data = await res.json();
    if (fetchId !== npLyricsFetchId) return;
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
    if (fetchId !== npLyricsFetchId) return;
    if (err.status === 503 && retryCount < 2 && lyricsActive()) {
      const retryAfterSec = Number.isFinite(err.retryAfterSec)
        ? Math.max(1, Math.min(30, err.retryAfterSec))
        : 10;
      if (!hasPaintedLyrics) {
        setNpFsLyricsStatus(
          `Lyrics service is busy — retrying in ${retryAfterSec}s…`
        );
      }
      npLyricsRetryTimer = setTimeout(() => {
        npLyricsRetryTimer = null;
        if (lyricsActive() && lyricsTrackKey(lastNowPlaying) === npLyricsKey) {
          loadOverlayLyrics(lastNowPlaying, { retryCount: retryCount + 1 });
        }
      }, retryAfterSec * 1000);
      return;
    }
    if (!hasPaintedLyrics) {
      setNpFsLyricsStatus(err.message || "Could not load lyrics");
    }
  }
}

/** Keep overlay + Party Display lyrics in sync with the current track. */
function syncNowPlayingLyrics(np) {
  if (!lyricsActive()) return;
  const key = lyricsTrackKey(np);
  const trackChanged = key !== npLyricsKey;
  if (npOverlayOpen) fillNpOverlayMeta(np);
  // Only refetch when the displayed track identity changes. Brief updating /
  // converging toggles must not wipe a successful lyric paint.
  if (trackChanged) {
    npLyricsKey = key;
    clearLyricsRetry();
    stopLyricTicker();
    loadOverlayLyrics(np);
    return;
  }
  mirrorLyricsContainers();
  if (npSyncedLines) startLyricTicker();
}

function syncNpOverlay(np) {
  syncNowPlayingLyrics(np);
}

function openNpOverlay() {
  const np = lastNowPlaying;
  if (!np || !(np.title || np.artist) || !npOverlay) return;
  npOverlayOpen = true;
  npOverlay.hidden = false;
  document.body.classList.add("np-overlay-open");
  npLyricsKey = lyricsTrackKey(np);
  // The overlay is another view of the shared playhead. Re-anchoring from
  // lastNowPlaying here can move time backward when its SSE payload is old.
  fillNpOverlayMeta(np);
  updateTrackProgress();
  loadOverlayLyrics(np);
  try {
    history.pushState({ npOverlay: true }, "");
    npOverlayHistoryPushed = true;
  } catch {
    npOverlayHistoryPushed = false;
  }
  npOverlayClose?.focus();
}

function closeNpOverlay({ fromPopstate = false } = {}) {
  if (!npOverlayOpen) return;
  npOverlayOpen = false;
  if (!lyricsActive()) {
    clearLyricsRetry();
    stopLyricTicker();
    npLyricsFetchId += 1;
  }
  if (npOverlay) npOverlay.hidden = true;
  document.body.classList.remove("np-overlay-open");
  if (!fromPopstate && npOverlayHistoryPushed && history.state?.npOverlay) {
    npOverlayHistoryPushed = false;
    history.back();
  } else {
    npOverlayHistoryPushed = false;
  }
}

if (npCard) {
  npCard.addEventListener("click", () => {
    if (npCard.classList.contains("is-empty")) return;
    openNpOverlay();
  });
  npCard.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (npCard.classList.contains("is-empty")) return;
    e.preventDefault();
    openNpOverlay();
  });
}

npOverlayClose?.addEventListener("click", () => closeNpOverlay());

npOverlay?.addEventListener("click", (e) => {
  if (e.target === npOverlay) closeNpOverlay();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && npOverlayOpen && !isModalOpen()) {
    e.preventDefault();
    closeNpOverlay();
  }
});

window.addEventListener("popstate", () => {
  if (npOverlayOpen) closeNpOverlay({ fromPopstate: true });
});

function nowPlayingOriginLabel(np, hasTrack) {
  if (!hasTrack || !np || np.djVoice) return null;
  const origin = np.origin || (np.discovered ? "discovered" : np.searched ? "searched" : null);
  if (origin === "discovered") {
    return {
      text: "Discover",
      title: "Added by Discover (similar to your music)",
      cls: "origin-discovered",
    };
  }
  if (origin === "searched") {
    const dedication = sanitizeDedication(np.dedication || "");
    const requester = sanitizeDisplayName(np.requestedBy || "");
    if (dedication) {
      const label = dedicationDisplayLabel(dedication, requester);
      return {
        text: label,
        title: label,
        cls: "origin-searched",
      };
    }
    if (requester) {
      return {
        text: `Requested · ${requester}`,
        title: `Requested by ${requester}`,
        cls: "origin-searched",
      };
    }
    return {
      text: "Requested",
      title: "A guest searched and added this song",
      cls: "origin-searched",
    };
  }
  if (origin === "filler") {
    return {
      text: "Random",
      title: "Added by Random / Never-Ending",
      cls: "origin-random",
    };
  }
  return null;
}

function paintNpReactions(data) {
  npReactionCounts = Object.fromEntries(
    NP_REACTION_KINDS.map((k) => [k, Math.max(0, Number(data?.[k]) || 0)])
  );
  if (data && Object.prototype.hasOwnProperty.call(data, "mine")) {
    npMyMood =
      data.mine && NP_MOOD_REACTION_KINDS.includes(data.mine) ? data.mine : null;
  }
  if (data && Object.prototype.hasOwnProperty.call(data, "micMine")) {
    npMyMic = !!data.micMine;
  }
  if (!npReactions) return;
  for (const el of npReactions.querySelectorAll("[data-count]")) {
    const kind = el.getAttribute("data-count");
    el.textContent = String(npReactionCounts[kind] || 0);
  }
  for (const btn of npReactions.querySelectorAll("[data-react]")) {
    const kind = btn.getAttribute("data-react");
    const on = kind === "mic" ? npMyMic : kind === npMyMood;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  if (displayReactions) {
    for (const el of displayReactions.querySelectorAll("[data-display-count]")) {
      const kind = el.getAttribute("data-display-count");
      el.textContent = String(npReactionCounts[kind] || 0);
    }
  }
}

async function syncMyReactions(trackId) {
  if (!trackId) {
    npMyMood = null;
    npMyMic = false;
    npReactionsSyncedFor = null;
    paintNpReactions({});
    return;
  }
  if (npReactionsSyncedFor === trackId) return;
  try {
    const qs = new URLSearchParams({
      id: trackId,
      guestId: getReactGuestId(),
    });
    const res = await fetch(`/api/reactions?${qs}`);
    if (!res.ok) return;
    const data = await res.json();
    npReactionsSyncedFor = trackId;
    paintNpReactions(data);
  } catch {
    /* keep prior paint */
  }
}

function renderPartyDisplayNowPlaying(np, hasTrack) {
  if (!displayTitle || !displayEmpty || !displayArt) return;
  if (!hasTrack) {
    bindNowPlayingArtwork(displayArt, null);
    displayEmpty.hidden = false;
    displayEmpty.textContent = EMPTY_MESSAGE;
    displayTitle.textContent = "";
    if (displayArtist) displayArtist.textContent = "";
    if (displayAlbum) displayAlbum.textContent = "";
    if (displayState) displayState.hidden = true;
    if (displayOriginPill) displayOriginPill.hidden = true;
    if (displayReactions) displayReactions.hidden = true;
    if (displayLyrics && currentView === "display") {
      displayLyrics.innerHTML = "";
    }
    return;
  }

  displayEmpty.hidden = true;
  displayTitle.textContent = np.title || "";
  if (displayArtist) displayArtist.textContent = np.artist || "";
  if (displayAlbum) displayAlbum.textContent = np.album || "";
  bindNowPlayingArtwork(displayArt, np);
  if (displayState) {
    displayState.hidden = false;
    const playing = !!np.isPlaying;
    const updating = !!np.updating || nowPlayingDisplayMode === "optimistic";
    displayState.textContent = updating
      ? "Updating"
      : playing
        ? "Now Playing"
        : "Paused";
    displayState.classList.toggle("playing", playing && !updating);
  }
  if (displayReactions) {
    displayReactions.hidden = !!np.djVoice || !!np.updating;
  }
  if (displayOriginPill) {
    // Same "how it got here" tag as the Up Next rows; DJ clips aren't songs.
    const hide = !!np.djVoice || !!np.updating;
    displayOriginPill.hidden = hide;
    if (!hide) displayOriginPill.textContent = displayOriginLabel(np);
  }
}

function beginOptimisticSkipFromQueue() {
  const next =
    (Array.isArray(lastQueueTracks) ? lastQueueTracks : []).find(
      (t) => t && !t.djVoice && (t.title || t.artist || t.albumArt)
    ) || null;
  if (!next) return false;
  optimisticNp = queueTrackAsNowPlaying(next, {
    room: lastConfirmedNp?.room || lastTransportNp?.room || null,
    neverEnding: lastPartySettings?.neverEnding,
    requestsPaused: lastPartySettings?.requestsPaused,
    hostControlsOnly: lastPartySettings?.hostControlsOnly,
  });
  if (lastTransportNp) renderNowPlaying(lastTransportNp);
  else {
    renderNowPlaying({
      metadataPending: true,
      isPlaying: true,
      queuePlaying: true,
      muted: false,
      shuffle: false,
    });
  }
  return true;
}

function adoptTransportConfirmation(transport) {
  if (!transport) return;
  if (transport.metadataPending) return;
  const hasTrack = !!(transport.title || transport.artist || transport.uri);
  if (!hasTrack) {
    lastConfirmedNp = null;
    optimisticNp = null;
    return;
  }

  if (optimisticNp) {
    const transportMedia = mediaIdentity(transport);
    const optimisticMedia = mediaIdentity(optimisticNp);
    const confirmedMedia = mediaIdentity(lastConfirmedNp);
    if (transportMedia && optimisticMedia && transportMedia === optimisticMedia) {
      optimisticNp = null;
      lastConfirmedNp = transport;
      return;
    }
    // Skip not reflected yet — keep optimistic paint over the prior track.
    if (transportMedia && confirmedMedia && transportMedia === confirmedMedia) {
      return;
    }
    // Landed on an unexpected track; trust Sonos.
    optimisticNp = null;
  }
  lastConfirmedNp = transport;
}

function renderNowPlaying(transport) {
  lastTransportNp = transport || null;
  // Party toggles / Vibe selection / Closing Time arrive via /api/party.
  // NP only owns the per-track Genre header (and reactions further below).
  if (transport) updateMixGenreHeaderFromServer(transport);

  adoptTransportConfirmation(transport);
  const resolved = resolveNowPlayingDisplay({
    transport,
    lastConfirmed: lastConfirmedNp,
    optimistic: optimisticNp,
  });
  nowPlayingDisplayMode = resolved.mode;
  if (resolved.confirmed) lastConfirmedNp = resolved.confirmed;
  const np = resolved.display;
  lastNowPlaying = np;

  const hasTrack = !!(np && (np.title || np.artist || np.albumArt));
  const progressClockKey = lyricsTrackKey(np);
  applyPlaybackClock(np, {
    force: progressClockKey !== npProgressClockKey,
  });
  npProgressClockKey = progressClockKey;
  updateTrackProgress();
  // Transport owns play/pause affordances so Skip optimism cannot hide Pause.
  npIsPlaying = !!(transport && transport.queuePlaying);
  npToggle.textContent = npIsPlaying ? "\u23F8\uFE0F" : "\u25B6\uFE0F";
  const muted = !!(transport && transport.muted);
  muteBtn.textContent = muted ? "\u{1F507}" : "\u{1F508}";
  muteBtn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  const shuffling = !!(transport && transport.shuffle);
  shuffleBtn.classList.toggle("active", shuffling);
  shuffleBtn.setAttribute("aria-pressed", shuffling ? "true" : "false");

  const updating = !!np?.updating || nowPlayingDisplayMode === "optimistic";
  const nextNpId = hasTrack && !updating ? trackIdFromUri(np.uri) : null;
  if (nextNpId !== npReactionsSyncedFor) {
    npMyMood = null;
    npMyMic = false;
    npReactionsSyncedFor = null;
  }
  nowPlayingId = nextNpId;
  nowPlayingKey = hasTrack ? songMatchKey(np.title, np.artist) : "";
  updateResultsQueuedState();

  // Playing/Paused + origin pills: stacked and centered on the right.
  if (npPills) npPills.hidden = !hasTrack;
  npState.hidden = !hasTrack;
  if (hasTrack) {
    const transportPlaying = !!(transport?.isPlaying ?? np.isPlaying);
    npState.textContent = updating
      ? "Updating"
      : transportPlaying
        ? "Playing"
        : "Paused";
    npState.classList.toggle("playing", transportPlaying && !updating);
    npState.classList.toggle("paused", !transportPlaying || updating);
  }
  if (npOrigin) {
    const origin = nowPlayingOriginLabel(np, hasTrack && !updating);
    if (origin) {
      npOrigin.hidden = false;
      npOrigin.textContent = origin.text;
      npOrigin.title = origin.title;
      npOrigin.classList.remove(
        "origin-searched",
        "origin-discovered",
        "origin-random"
      );
      npOrigin.classList.add(origin.cls);
    } else {
      npOrigin.hidden = true;
      npOrigin.textContent = "";
      npOrigin.removeAttribute("title");
    }
  }

  if (hasTrack) {
    npCard.classList.remove("is-empty");
    npEmpty.hidden = true;
    npTitle.hidden = false;
    npArtist.hidden = false;
    npAlbum.hidden = false;
    npTitle.textContent = np.title || "";
    npArtist.textContent = np.artist || "";
    npAlbum.textContent = np.album || "";
    bindNowPlayingArtwork(npArt, np);
    if (npReactions) npReactions.hidden = updating;
    if (np?.reactions) {
      // Poll has counts only; keep local mine/micMine until sync finishes.
      paintNpReactions({
        ...np.reactions,
        mine: npMyMood,
        micMine: npMyMic,
      });
    }
    if (!updating) void syncMyReactions(nowPlayingId);
  } else {
    npCard.classList.add("is-empty");
    npTitle.hidden = true;
    npArtist.hidden = true;
    npAlbum.hidden = true;
    bindNowPlayingArtwork(npArt, null);
    npEmpty.hidden = false;
    npEmpty.textContent = EMPTY_MESSAGE;
    if (npReactions) npReactions.hidden = true;
    npReactionsSyncedFor = null;
    paintNpReactions({ mine: null, micMine: false });
    if (npOverlayOpen) closeNpOverlay();
  }

  renderPartyDisplayNowPlaying(np, hasTrack);
  syncNpOverlay(np);
  prefetchUpcomingAlbumArt(lastQueueTracks);
}

window.setInterval(
  updateTrackProgress,
  prefersReducedMotion() ? 1000 : 250
);

npReactions?.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-react]");
  if (!btn || npReactBusy) return;
  e.preventDefault();
  e.stopPropagation();
  const kind = btn.getAttribute("data-react");
  const id = nowPlayingId;
  if (!id || !NP_REACTION_KINDS.includes(kind)) return;

  const displayName = await ensureDisplayName({ required: true });
  if (!displayName) return;

  npReactBusy = true;
  btn.disabled = true;

  // Optimistic: mood is exclusive; mic toggles on its own.
  const next = { ...npReactionCounts };
  let nextMine = npMyMood;
  let nextMic = npMyMic;
  if (kind === "mic") {
    nextMic = !npMyMic;
    next.mic = Math.max(0, (next.mic || 0) + (nextMic ? 1 : -1));
  } else if (npMyMood === kind) {
    nextMine = null;
    next[kind] = Math.max(0, (next[kind] || 0) - 1);
  } else {
    if (npMyMood) next[npMyMood] = Math.max(0, (next[npMyMood] || 0) - 1);
    nextMine = kind;
    next[kind] = (next[kind] || 0) + 1;
  }
  paintNpReactions({ ...next, mine: nextMine, micMine: nextMic });

  try {
    const res = await fetch("/api/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        kind,
        guestId: getReactGuestId(),
        by: guestBadgeName() || displayName,
        name: lastNowPlaying?.title || "",
        artist: lastNowPlaying?.artist || "",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not react.");
    npReactionsSyncedFor = id;
    paintNpReactions(data);
    if (kind === "mic") {
      showToast(
        data.micMine ? "Added to the Karaoke List" : "Removed from the Karaoke List"
      );
    }
    if (currentView === "stats") loadStats();
  } catch (err) {
    npReactionsSyncedFor = null;
    void syncMyReactions(id);
    showToast(err.message || "Could not react.", true);
  } finally {
    btn.disabled = false;
    npReactBusy = false;
  }
});

async function loadNowPlaying() {
  const requestId = ++nowPlayingHttpRequest;
  const streamVersionAtStart = nowPlayingStreamVersion;
  try {
    const res = await fetch("/api/nowplaying");
    if (!res.ok) return;
    const snapshot = await res.json();
    if (
      requestId !== nowPlayingHttpRequest ||
      nowPlayingStreamVersion !== streamVersionAtStart
    ) {
      return;
    }
    renderNowPlaying(snapshot);
  } catch {
    /* retain the last good stream or fallback snapshot */
  }
}

/**
 * "How it got here" label shared by the Party Display's Now Playing pill and
 * Up Next rows: dedication > requested > era hit > Discover > Random. Works
 * for both queue tracks and the Now Playing payload (same origin fields).
 */
function displayOriginLabel(track) {
  const requester = sanitizeDisplayName(track.requestedBy || "");
  const dedication = sanitizeDedication(track.dedication || "");
  if (dedication) return dedicationDisplayLabel(dedication, requester);
  if (track.searched) return requester ? `Requested by ${requester}` : "Requested";
  if (track.moodPick) {
    const era = trackEraLabel(track);
    return era ? `${era} Hit` : "Era Hit";
  }
  if (track.discovered) return "Discover";
  return "Random";
}

function renderPartyDisplayQueue(tracks) {
  if (!displayQueue || !displayQueueEmpty || !displayQueueCount) return;
  // DJ announce rows stay in the list (same as the main page's Up Next) so
  // guests can see the DJ coming between requests. Cap at three on the TV
  // so Up Next + Join stay compact and leave room for lyrics.
  const visible = tracks.slice(0, 3);
  displayQueueCount.textContent = tracks.length
    ? `${tracks.length} queued`
    : "";
  displayQueueEmpty.hidden = visible.length > 0;
  displayQueueEmpty.textContent = "The queue is empty.";
  displayQueue.innerHTML = "";

  visible.forEach((track, index) => {
    const row = document.createElement("li");
    const number = document.createElement("span");
    number.className = "party-display-queue-index";
    number.textContent = String(index + 1);

    const meta = document.createElement("div");
    meta.className = "party-display-queue-meta";
    const title = document.createElement("strong");
    title.textContent = track.title || "Untitled";
    const artist = document.createElement("span");
    artist.textContent = track.artist || "";
    meta.append(title, artist);

    // Tag every song row with how it got here (same precedence as the main
    // queue badges): dedication > requested > era hit > Discover > Random.
    // DJ clips aren't songs — no origin tag, matching the main page.
    if (!track.djVoice) {
      const source = document.createElement("span");
      source.className = "party-display-queue-source";
      source.textContent = displayOriginLabel(track);
      meta.appendChild(source);
    }

    row.append(number, meta);
    displayQueue.appendChild(row);
  });
}

function applyQueueTracks(tracks) {
  lastQueueTracks = tracks;
  queuedIdSet = new Set(tracks.map((t) => trackIdFromUri(t.uri)).filter(Boolean));
  searchedQueuedIdSet = new Set(
    tracks.filter((t) => t.searched).map((t) => trackIdFromUri(t.uri)).filter(Boolean)
  );
  queuedKeySet = new Set(tracks.map((t) => songMatchKey(t.title, t.artist)).filter(Boolean));
  searchedQueuedKeySet = new Set(
    tracks.filter((t) => t.searched).map((t) => songMatchKey(t.title, t.artist)).filter(Boolean)
  );
  renderQueue(tracks);
  renderPartyDisplayQueue(tracks);
  updateResultsQueuedState();
  prefetchUpcomingAlbumArt(tracks);
}

async function loadQueue(force = false) {
  // While editing, don't let fallback HTTP rebuild the list under the user's
  // hands (it would interrupt a drag or wipe the delete buttons). Explicit
  // reconciliation calls pass force=true.
  if (queueEditMode && !force) return;
  const requestId = ++queueHttpRequest;
  const streamVersionAtStart = queueStreamVersion;
  try {
    const res = await fetch("/api/queue/list");
    if (!res.ok) return;
    const data = await res.json();
    if (
      requestId !== queueHttpRequest ||
      queueStreamVersion !== streamVersionAtStart
    ) {
      return;
    }
    const tracks = Array.isArray(data.tracks) ? data.tracks : [];
    applyQueueTracks(tracks);
  } catch {
    /* leave previous queue on transient errors */
  }
}

function queueTrackSig(track) {
  return [
    track.uri || "",
    track.position || "",
    track.searched ? 1 : 0,
    track.discovered ? 1 : 0,
    track.moodPick ? 1 : 0,
    track.mood || "",
    track.requestedBy || "",
    track.dedication || "",
    track.title || "",
    track.artist || "",
    track.djVoice ? 1 : 0,
    showQueueGenre ? 1 : 0,
    track.fromPlaylist ? 1 : 0,
    track.genreLane || "",
    track.genreLabel || "",
    Array.isArray(track.genreLabels) ? track.genreLabels.join(",") : "",
  ].join("\0");
}

function queueOriginBadgeHtml(track) {
  const requester = sanitizeDisplayName(track.requestedBy || "");
  const dedication = sanitizeDedication(track.dedication || "");
  if (track.moodPick) {
    const era = trackEraLabel(track);
    const label = era ? `${era} Hit` : "Era Hit";
    return `<span class="mood-badge" title="Era hit added by the Decades mood (from outside your playlists)">\u{1F4FC} ${escapeHtml(label)}</span>`;
  }
  if (track.discovered) {
    return `<span class="songs-like-badge" title="Added by Discover (similar to your music)">\u2728 Discover</span>`;
  }
  if (track.searched) {
    if (dedication) {
      const label = dedicationDisplayLabel(dedication, requester);
      return `<span class="searched-badge" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
    }
    const tip = requester
      ? `Requested by ${escapeHtml(requester)}`
      : "A guest searched and added this song (plays before auto-added songs)";
    const label = requester
      ? `\u{1F50D} Requested \u00b7 ${escapeHtml(requester)}`
      : `\u{1F50D} Requested`;
    return `<span class="searched-badge" title="${tip}">${label}</span>`;
  }
  if (track.djVoice) return "";
  return `<span class="memory-random-badge" title="Added by Random / Never-Ending">\u{1F3B2} Random</span>`;
}

function queueGenreBadgeHtml(track) {
  if (!showQueueGenre || track.djVoice) return "";
  // Matched / primary genre only — second genre slot is "From Playlists".
  const label =
    Array.isArray(track.genreLabels) && track.genreLabels[0]
      ? track.genreLabels[0]
      : typeof track.genreLabel === "string" && track.genreLabel
        ? track.genreLabel
        : typeof track.genreLane === "string" && track.genreLane
          ? track.genreLane
          : "";
  if (!label) return "";
  return `<span class="queue-genre-badge" title="Matched song genre">${escapeHtml(label)}</span>`;
}

function queuePlaylistBadgeHtml(track) {
  if (!showQueueGenre || track.djVoice || !track.fromPlaylist) return "";
  return `<span class="queue-playlist-badge" title="This song is in your Spotify playlists">From Playlists</span>`;
}

function queueBadgeHtml(track) {
  return `${queueOriginBadgeHtml(track)}${queueGenreBadgeHtml(track)}${queuePlaylistBadgeHtml(track)}`;
}

function fillQueueRow(li, track, index) {
  li.className = "track track-noart" + (queueEditMode ? " editing" : "");
  li.dataset.uri = track.uri || "";
  li.dataset.position = String(track.position || index + 1);
  li.dataset.sig = queueTrackSig(track);
  const del = queueEditMode
    ? `<button class="track-delete" type="button" aria-label="Remove from queue" title="Remove from queue">&times;</button>`
    : "";
  const badge = queueBadgeHtml(track);
  li.innerHTML = `
      <span class="queue-index">${index + 1}</span>
      <div class="meta">
        <div class="title">${escapeHtml(track.title)}</div>
        <div class="artist">${escapeHtml(track.artist)}</div>
        ${badge ? `<div class="queue-tag">${badge}</div>` : ""}
      </div>
      ${del}
    `;
  if (queueEditMode) {
    li.querySelector(".track-delete").addEventListener("click", () =>
      removeQueueItem(li)
    );
  }
}

function renderQueue(tracks) {
  queueCount.textContent = tracks.length ? `(${tracks.length})` : "";
  if (queueEmpty) {
    queueEmpty.textContent = "The queue is empty.";
    queueEmpty.hidden = tracks.length > 0;
  }
  queueHasTracks = tracks.length > 0;
  syncQueueEditButton();

  const wantEdit = queueEditMode;
  const kids = [...queueList.children];
  // Rows still dressed for editing (delete X + drag border) must be rebuilt,
  // not patched — their data-sig matches, so patching would leave the edit
  // chrome visible after tapping Done.
  const canPatch =
    !wantEdit &&
    kids.length === tracks.length &&
    kids.every(
      (li) =>
        li.classList.contains("track") && !li.classList.contains("editing")
    );

  if (canPatch) {
    let changed = false;
    tracks.forEach((track, i) => {
      const li = kids[i];
      const sig = queueTrackSig(track);
      if (li.dataset.sig !== sig) {
        fillQueueRow(li, track, i);
        changed = true;
      } else {
        const idxEl = li.querySelector(".queue-index");
        if (idxEl && idxEl.textContent !== String(i + 1)) {
          idxEl.textContent = String(i + 1);
          changed = true;
        }
        li.dataset.position = String(track.position || i + 1);
      }
    });
    if (!changed) return;
    syncSortable();
    return;
  }

  // Full rebuild when length changes or edit mode needs delete handles.
  queueList.innerHTML = "";
  tracks.forEach((track, i) => {
    const li = document.createElement("li");
    fillQueueRow(li, track, i);
    queueList.appendChild(li);
  });
  syncSortable();
}

function refreshSonos() {
  // App-owned mutations nudge the shared server monitor. HTTP remains the
  // immediate path only when the queue stream is unavailable.
  if (!queueStreamConnected) void loadQueue();
  if (currentView !== "display") void loadGroups();
}

async function postControl(btn, endpoint, onOk) {
  btn.disabled = true;
  try {
    const res = await hostFetch(endpoint, { method: "POST" });
    const data = await res.json();
    if (res.status === 423) {
      showToast(data.error || "DJ volume handoff in progress.");
      return;
    }
    if (!res.ok) throw new Error(data.error || "Action failed.");
    if (onOk) onOk(data);
    refreshSonos();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

npToggle.addEventListener("click", () => {
  postControl(npToggle, npIsPlaying ? "/api/pause" : "/api/play");
});

shuffleBtn.addEventListener("click", () => {
  postControl(shuffleBtn, "/api/shuffle", (d) =>
    showToast(d.shuffle ? "Shuffle on" : "Shuffle off")
  );
});

prevBtn.addEventListener("click", () => {
  // No reliable previous row in the upcoming queue list — keep last confirmed
  // paint until Sonos confirms (never blank art).
  postControl(prevBtn, "/api/previous");
});

nextBtn.addEventListener("click", () => {
  beginOptimisticSkipFromQueue();
  postControl(nextBtn, "/api/next", (d) => {
    if (d.skipped) showToast("Skipped — remembered for the DJ");
  });
});

muteBtn.addEventListener("click", () => {
  postControl(muteBtn, "/api/mute", (d) =>
    showToast(d.muted ? "Muted" : "Unmuted")
  );
});

volDownBtn.addEventListener("click", () => {
  postControl(volDownBtn, "/api/volume/down", (d) =>
    showToast(`Volume: ${d.volume}`)
  );
});

volUpBtn.addEventListener("click", () => {
  postControl(volUpBtn, "/api/volume/up", (d) =>
    showToast(`Volume: ${d.volume}`)
  );
});

volDown10Btn.addEventListener("click", () => {
  postControl(volDown10Btn, "/api/volume/down?step=10", (d) =>
    showToast(`Volume: ${d.volume}`)
  );
});

volUp10Btn.addEventListener("click", () => {
  postControl(volUp10Btn, "/api/volume/up?step=10", (d) =>
    showToast(`Volume: ${d.volume}`)
  );
});

groupAllBtn.addEventListener("click", () => {
  postControl(groupAllBtn, "/api/group-all", (d) => {
    lastGroupsAt = 0;
    loadGroups(true);
    showToast(`Grouped ${d.players} speakers · Volume ${d.volume}`);
  });
});

// Queue editing listeners (state declared near lastQueueTracks).

// Create/destroy the drag-reorder behavior to match the current edit mode.
function syncSortable() {
  if (sortable) {
    sortable.destroy();
    sortable = null;
  }
  if (queueEditMode && window.Sortable && queueList.children.length) {
    sortable = window.Sortable.create(queueList, {
      animation: 150,
      filter: ".track-delete", // taps on the X delete, don't start a drag
      preventOnFilter: false,
      delay: 200, // hold-to-drag on touch so the page can still scroll
      delayOnTouchOnly: true,
      onEnd: onQueueReorder,
    });
  }
}

async function onQueueReorder(evt) {
  if (evt.oldIndex === evt.newIndex) return;
  const li = evt.item;
  const before = li.nextElementSibling;
  const body = {
    uri: li.dataset.uri,
    fromPosition: Number(li.dataset.position),
    beforeUri: before ? before.dataset.uri : null,
    beforePosition: before ? Number(before.dataset.position) : null,
  };
  try {
    const res = await hostFetch("/api/queue/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not move the song.");
    showToast("Moved");
  } catch (err) {
    showToast(err.message, true);
  } finally {
    loadQueue(true); // reconcile order + refresh positions
  }
}

async function removeQueueItem(li) {
  const title = li.querySelector(".title")?.textContent || "song";
  const body = {
    uri: li.dataset.uri,
    position: Number(li.dataset.position),
  };
  li.style.opacity = "0.4";
  try {
    const res = await hostFetch("/api/queue/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not remove the song.");
    showToast(`Removed "${title}"`);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    loadQueue(true); // refresh positions after the change
  }
}

queueEditToggle.addEventListener("click", () => {
  queueEditMode = !queueEditMode;
  queueEditToggle.classList.toggle("active", queueEditMode);
  queueEditToggle.setAttribute("aria-pressed", String(queueEditMode));
  queueEditToggle.textContent = queueEditMode ? "Done" : "Edit";
  queueEditHint.hidden = !queueEditMode;
  if (!queueEditMode && pendingQueueStreamTracks) {
    const tracks = pendingQueueStreamTracks;
    pendingQueueStreamTracks = null;
    applyQueueTracks(tracks);
  } else {
    // Flip the edit chrome immediately from what we already have on screen —
    // waiting on the reconcile fetch left delete buttons visible after Done.
    renderQueue(lastQueueTracks);
    loadQueue(true); // enter edit fresh, or reconcile when no event arrived
  }
});

function songCount(n) {
  return n === 1 ? "1 song" : `${n} songs`;
}

async function loadPlaylists() {
  try {
    const res = await fetch("/api/playlists");
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
  const genres = currentGenreIds();
  if (genreBuckets.length && genres.length === 0) {
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
    if (currentMoodId()) payload.mood = currentMoodId();
    const res = await fetch("/api/queue/random", {
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

// ---- Genre filters ----
// Toggle which broad genres feed Random / Never-Ending. Selection persists in
// the browser AND on the server so every phone shares one host pool.
// `null` = not chosen yet -> all on.
const genreChips = document.getElementById("genre-chips");
const genrePresets = document.getElementById("genre-presets");
const poolSizeHint = document.getElementById("pool-size-hint");
const taggingPill = document.getElementById("tagging-pill");
const genreToggleAll = document.getElementById("genre-toggle-all");
const GENRE_KEY = "pq.genres";
let genreBuckets = [];
let genreCountsCache = {};
let genreDataEnabled = true;
let genreSelection = loadGenreSelection();
let poolSizeTimer = null;

// Mix-label state (declared before the decade block below runs its initial
// sync, which paints the label). Server-broadcast mix wins; undefined = not
// seen yet, so local state fills in until the first Now Playing payload.
const npMoodLabel = document.getElementById("np-mood-label");
const npGenreLabel = document.getElementById("np-genre-label");
const displayMixPill = document.getElementById("display-mix");
const displayGenrePill = document.getElementById("display-genre");
let serverMix = { genres: undefined, mood: undefined, genreLabel: undefined };

npMoodLabel?.addEventListener("click", () => navigateMixPanel("mood-presets"));
npGenreLabel?.addEventListener("click", () => navigateMixPanel("genres"));

// ---- Era mood (Decades) ----
// One decade at a time (or none = off). Playlist picks stay in the era and
// shortfalls fill with era hits from outside the library. Persists locally +
// on the server so Random and Never-Ending share it across phones.
const decadeChips = document.getElementById("decade-chips");
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
  return serverMix.mood !== undefined ? serverMix.mood : eraMood;
}

/**
 * Era label for one queued track. Prefers the decade stamped on the track at
 * add time (survives the host switching decades mid-party); falls back to the
 * active decade only for rows queued before per-track stamping existed.
 */
function trackEraLabel(track) {
  return trackEraDisplayLabel(track, activeEraMoodId());
}

function presetNameForIds(ids) {
  return presetNameForIdList(
    ids,
    genreBuckets.map((b) => b.id)
  );
}

function updateMixLabels() {
  const genres =
    serverMix.genres !== undefined ? serverMix.genres : currentGenreIds();
  const mood = serverMix.mood !== undefined ? serverMix.mood : eraMood;
  const era = mood ? DECADE_LABELS[mood] : null;
  const preset = presetNameForIds(genres);
  const moodText = era ? `Mood: ${preset} - ${era}` : `Mood: ${preset}`;
  if (npMoodLabel) {
    npMoodLabel.textContent = moodText;
    npMoodLabel.hidden = false;
  }
  if (npGenreLabel) {
    const genre = serverMix.genreLabel;
    // Keep the "Genre" affordance clickable even when idle — only clear the value.
    npGenreLabel.textContent = genre ? `Genre: ${genre}` : "Genre:";
    npGenreLabel.hidden = false;
  }
  if (displayMixPill) {
    displayMixPill.textContent = moodText;
    displayMixPill.hidden = false;
  }
  if (displayGenrePill) {
    const genre = serverMix.genreLabel;
    displayGenrePill.textContent = genre ? `Genre: ${genre}` : "Genre:";
    displayGenrePill.hidden = false;
  }
}

/** Vibe mix selection (genres + era mood) — owned by /api/party. */
function updateMixSelectionFromServer(party) {
  if (!party || (!("mixGenres" in party) && !("mixMood" in party))) return;
  if ("mixGenres" in party) {
    serverMix.genres = Array.isArray(party.mixGenres) ? party.mixGenres : null;
  }
  if ("mixMood" in party) {
    serverMix.mood = typeof party.mixMood === "string" ? party.mixMood : null;
  }
  updateMixLabels();
  applyServerMixToPickers();
}

/** Per-track Genre header — owned by Now Playing. */
function updateMixGenreHeaderFromServer(np) {
  if (!np || (!("mixGenreLabel" in np) && !("mixGenreLane" in np))) return;
  const label =
    typeof np.mixGenreLabel === "string" && np.mixGenreLabel
      ? np.mixGenreLabel
      : typeof np.mixGenreLane === "string" && np.mixGenreLane
        ? np.mixGenreLane
        : null;
  serverMix.genreLabel = label;
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
    const res = await fetch(`/api/genres${qs}`);
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
    const label = currentMoodLabel();
    const era = eraMood ? DECADE_LABELS[eraMood] : null;
    moodEl.textContent = [label, era].filter(Boolean).join(" \u00b7 ") || "—";
  }

  if (genresEl) {
    const total = genreBuckets.length;
    if (!total) {
      genresEl.textContent = "—";
    } else {
      const selected = currentGenreIds().length;
      genresEl.textContent = `${selected} of ${total} selected`;
    }
  }

  if (playlistsEl) {
    const total = currentPlaylists.length;
    if (!total || selectedPlaylistIds == null) {
      playlistsEl.textContent = "—";
    } else {
      const ids = currentPlaylists.map((p) => p.id);
      const selected = ids.filter((id) => selectedPlaylistIds.has(id)).length;
      playlistsEl.textContent = `${selected} of ${total} selected`;
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
      const res = await fetch("/api/pool-size", {
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
  return selectedPlaylistIds ? [...selectedPlaylistIds] : [];
}

// Most recent "Closing Time" event this client has already announced, so the
// last-call toast / recap shows once per event (not on every 5s poll).
let lastClosingShown = 0;
let lastPartyRecapPayload = null;

/** @type {{ close: () => void }|null} */
let recapModalSession = null;

function showPartyRecap(recap) {
  lastPartyRecapPayload = recap && typeof recap === "object" ? recap : null;
  const songName =
    (lastPartyRecapPayload?.endOfNightName || endOfNightTrack.name || "Last call").trim();
  if (recapHintEl) {
    recapHintEl.textContent = `Last call — ${songName} is next`;
  }
  if (!recapOverlay || !recapBody || !lastPartyRecapPayload) {
    showToast(`\u{1F37A} Last call \u2014 ${songName}!`);
    return;
  }
  const lines = [];
  const total = Number(lastPartyRecapPayload.total) || 0;
  lines.push(
    `<p><span class="recap-stat">${total}</span> request${total === 1 ? "" : "s"} tonight</p>`
  );
  const songs = Array.isArray(lastPartyRecapPayload.topSongs)
    ? lastPartyRecapPayload.topSongs
    : [];
  if (songs.length) {
    lines.push("<p class=\"recap-stat\">Top songs</p><ul>");
    for (const s of songs.slice(0, 3)) {
      const label = s.artist ? `${s.name} — ${s.artist}` : s.name;
      lines.push(`<li>${escapeHtml(label)} (${s.count})</li>`);
    }
    lines.push("</ul>");
  }
  const people = Array.isArray(lastPartyRecapPayload.topRequesters)
    ? lastPartyRecapPayload.topRequesters
    : [];
  if (people.length) {
    lines.push("<p class=\"recap-stat\">Top requestors</p><ul>");
    for (const p of people.slice(0, 3)) {
      lines.push(`<li>${escapeHtml(p.name)} (${p.count})</li>`);
    }
    lines.push("</ul>");
  }
  recapBody.innerHTML = lines.join("");
  recapModalSession?.close();
  recapModalSession = attachModal(recapOverlay, {
    initialFocus: recapDismissBtn,
    onEscape: hidePartyRecap,
    allowBackdrop: true,
    onBackdrop: hidePartyRecap,
  });
}

function hidePartyRecap() {
  if (recapModalSession) {
    const session = recapModalSession;
    recapModalSession = null;
    session.close();
    return;
  }
  if (recapOverlay) recapOverlay.hidden = true;
}

if (recapDismissBtn) {
  recapDismissBtn.addEventListener("click", hidePartyRecap);
}

// Announce "Closing Time" (last call) to whoever is looking. Driven by the
// server timestamp broadcast in the Now Playing poll, so every guest sees it,
// not just the person who added the song. Stale events (e.g. a page opened long
// after) are marked seen but not toasted.
function maybeAnnounceClosingTime(ts, partyRecap) {
  if (!ts || ts <= lastClosingShown) return;
  lastClosingShown = ts;
  if (Date.now() - ts > 60000) return;
  showPartyRecap(partyRecap);
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
    const res = await fetch("/api/autofill");
    const data = await res.json();
    autofillToggle.checked = !!data.enabled;
    let playlistsChanged = false;
    if (Array.isArray(data.playlistIds) && data.playlistIds.length) {
      selectedPlaylistIds = new Set(data.playlistIds);
      saveSelection();
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
    if (playlistsChanged && currentPlaylists.length) {
      renderPlaylists(currentPlaylists);
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

autofillToggle.addEventListener("change", async () => {
  const enabled = autofillToggle.checked;
  if (enabled && (!selectedPlaylistIds || selectedPlaylistIds.size === 0)) {
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
  if (autofillToggle.checked) setAutoFill(true).catch(() => {});
}

// Back-compat alias used by playlist checkbox handlers.
function syncAutoFillSelection() {
  syncPickerSelection();
  refreshPoolSizeHint();
}

connectSpotifyBtn.addEventListener("click", () => {
  window.open("/auth/login", "_blank", "noopener");
});

// Re-check the connection (and refresh playlists) when returning to the tab,
// e.g. right after completing the one-time Spotify login. The server caches
// these now, but we still debounce so rapid tab-switching (common on phones)
// can't fan out into back-to-back requests.
let lastFocusRefresh = 0;
const FOCUS_REFRESH_MS = 5 * 60_000;
window.addEventListener("focus", () => {
  if (Date.now() - lastFocusRefresh < FOCUS_REFRESH_MS) return;
  lastFocusRefresh = Date.now();
  loadPlaylists();
  loadGenres();
});

// Host action: rebuild the cached playlist list / track pool / genre tags after
// changing playlists, instead of paying for a Spotify read on every page load.
if (cacheRefreshBtn) {
  cacheRefreshBtn.addEventListener("click", async () => {
    cacheRefreshBtn.disabled = true;
    const original = cacheRefreshBtn.textContent;
    cacheRefreshBtn.textContent = "Re-warming...";
    if (cacheStatus) cacheStatus.textContent = "Reading your playlists from Spotify...";
    try {
      const res = await hostFetch("/api/cache/refresh", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not re-warm the cache.");
      if (cacheStatus) {
        cacheStatus.textContent = `Cached ${data.tracks} tracks across ${data.poolPlaylists} playlists.`;
      }
      showToast(`Cache re-warmed \u2014 ${data.tracks} tracks ready`);
      lastFocusRefresh = Date.now(); // we just refreshed; skip the next focus pull
      loadPlaylists();
      loadGenres();
      loadSpotifyStatus();
    } catch (err) {
      if (cacheStatus) cacheStatus.textContent = err.message;
      showToast(err.message, true);
      loadSpotifyStatus(); // reflect a fresh cooldown if the attempt got throttled
    } finally {
      cacheRefreshBtn.disabled = false;
      cacheRefreshBtn.textContent = original;
    }
  });
}

loadGroups(true);
loadSettings();
// Public toggle hydrate immediately — don't wait on Spotify playlist/genre
// sweeps or phones open looking like Discover / Never-Ending are off.
void loadAutoFill();
void loadPartySettings();
// Spotify app / Last.fm / HA status: deferred until Settings opens (revealSettings).
loadVersion();
loadPinRequired();

// Playlists + genres first, then re-apply the server's shared selection so every
// phone lands on the same Random / Never-Ending pool.
(async () => {
  await Promise.all([loadPlaylists(), loadGenres()]);
  await loadAutoFill();
  syncPickerSelection();
  refreshPoolSizeHint();
})();

// Pause/resume polling when the tab is hidden/shown (locked phone, backgrounded
// tab). Then mark the app ready and kick off the first poll cycle (an immediate
// refresh plus the interval), which only actually runs when we're visible and on
// the main view.
document.addEventListener("visibilitychange", syncPolling);
// Phones: collapse Up next by default so Search + Now Playing own the first screen.
try {
  if (
    queueSection &&
    queueToggle &&
    window.matchMedia("(max-width: 640px)").matches
  ) {
    queueSection.classList.add("collapsed");
    queueToggle.setAttribute("aria-expanded", "false");
  }
} catch {
  /* matchMedia unavailable */
}

// Initial route: deferred to here (see the hashchange listener) so deep links
// land on their view only after every declaration above has run.
routeFromHash();

appReady = true;
syncPolling();

// Version is usually painted with branding on first load. Refresh from health
// only when missing or different (avoids title+pill layout flash on restart).
async function loadVersion() {
  const el = document.getElementById("app-version");
  if (!el) return;
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (!data?.version) return;
    const next = `v${data.version}`;
    if (el.textContent !== next) el.textContent = next;
    persistBrandingCache({ version: data.version });
    document.getElementById("header-title")?.setAttribute("data-ready", "1");
  } catch {
    /* leave whatever the boot script painted */
  }
}

let toastTimer = null;
/**
 * @param {string} message
 * @param {boolean} [isError]
 * @param {number} [durationMs]
 * @param {{ actionLabel?: string, onAction?: () => void }} [opts]
 */
function showToast(message, isError = false, durationMs = 2600, opts = {}) {
  clearTimeout(toastTimer);
  toastEl.replaceChildren();
  toastEl.classList.toggle("error", isError);
  const actionLabel = opts?.actionLabel;
  const onAction = opts?.onAction;
  if (actionLabel && typeof onAction === "function" && !isError) {
    toastEl.classList.add("has-action");
    const msg = document.createElement("span");
    msg.className = "toast-msg";
    msg.textContent = message;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = actionLabel;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      clearTimeout(toastTimer);
      toastEl.classList.remove("show", "has-action");
      onAction();
    });
    toastEl.append(msg, btn);
  } else {
    toastEl.classList.remove("has-action");
    toastEl.textContent = message;
  }
  toastEl.classList.add("show");
  const ms = Math.max(1000, Number(durationMs) || 2600);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("show", "has-action");
  }, ms);
}

