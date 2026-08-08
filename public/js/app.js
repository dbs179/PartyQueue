import {
  attachModal,
  isModalOpen,
} from "./modal.js";
import {
  sanitizeDisplayName,
  getDisplayName,
  getDisplayAlias,
  setDisplayName,
  setDisplayAlias,
  guestBadgeName as guestBadgeNameFrom,
  guestIdentityPayload as guestIdentityPayloadFrom,
} from "./guest.js";
import { createGuestHubUi } from "./guest-hub-ui.js";
import {
  mediaIdentity,
  playbackIdentity,
  queueTrackAsNowPlaying,
  resolveNowPlayingDisplay,
} from "./now-playing-utils.js";
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
  loadPlaylistSelection,
  savePlaylistSelection,
  reconcilePlaylistSelection,
} from "./playlist-selection.js";
import { showToast } from "./toast.js";
import { wirePanelCollapse } from "./panel-collapse.js";
import { createConfirmModal } from "./confirm-modal.js";
import { createHostPinUi } from "./host-pin-ui.js";
import { loadMemory as loadMemoryUi } from "./memory-ui.js";
import { createPartyRecapUi } from "./party-recap.js";
import { createSonosGroups } from "./sonos-groups.js";
import { createConnectionsUi } from "./connections-ui.js";
import {
  createBrandingUi,
  persistBrandingCache,
} from "./branding-ui.js";
import {
  nowPlayingOriginLabel,
  displayOriginLabel,
} from "./now-playing-origin.js";
import { trackIdFromUri } from "./search-track.js";
import { createSearchUi } from "./search-ui.js";
import { createReactionsUi } from "./reactions-ui.js";
import { createQueueUi } from "./queue-ui.js";
import { createLyricsUi } from "./lyrics-ui.js";
import { createLiveStreams } from "./live-streams.js";
import {
  SUGGESTION_TEXT_MAX,
  wireSuggestionCharCount,
  filterSuggestions,
  suggestionsCountLabel,
  suggestionsEmptyMessage,
  suggestionRowHtml,
} from "./suggestions.js";
import {
  paintStatsReactionList,
  statRows,
  statsSummaryCardsHtml,
  dedicationsHtml,
  karaokeRowsHtml,
  statsEmptyMessage,
} from "./stats-ui.js";
import {
  resolveActiveEraMoodId,
  buildMixLabelTexts,
  resolveMixGenreLabelFromNowPlaying,
  mixSelectionPatchFromParty,
  formatMixHubMoodLine,
  formatSelectedOfTotal,
  paintMixLabels,
} from "./mix-labels.js";
import { createDjBoothUi } from "./dj-booth-ui.js";
import {
  isSettingsArea,
  isMusicMixArea,
  isHostArea,
} from "./view-areas.js";
import {
  paintRotationPool,
  wireRotationPool,
} from "./rotation-pool.js";
import {
  GUEST_BANNER_PARTY_OVER,
  guestLockBannerView,
  paintGuestLockBanner,
} from "./guest-lock-banner.js";

const searchInput = document.getElementById("search");
const searchClear = document.getElementById("search-clear");
const resultsEl = document.getElementById("results");
const statusEl = document.getElementById("status");
const clearBtn = document.getElementById("clearQueue");
const modalOverlay = document.getElementById("modal-overlay");
const modalMessage = document.getElementById("modal-message");
const modalCancel = document.getElementById("modal-cancel");
const modalConfirm = document.getElementById("modal-confirm");

const confirmModal = createConfirmModal({
  overlay: modalOverlay,
  messageEl: modalMessage,
  confirmBtn: modalConfirm,
  cancelBtn: modalCancel,
});

// Host PIN + hostFetch — created early so other UI factories can share hostFetch.
const {
  hostFetch,
  settingsGateOk,
  settingsUnlocked,
  openPinGate,
  closePinGate,
  loadPinRequired,
  refreshHostPinStatus,
  verifyHostSessionStillValid,
  isPinRequired,
  isPinGateOpen,
  getPendingPinAction,
  clearPendingPinAction,
} = createHostPinUi(
  {
    pinOverlay: document.getElementById("pin-overlay"),
    pinInput: document.getElementById("pin-input"),
    pinError: document.getElementById("pin-error"),
    pinUnlockBtn: document.getElementById("pin-unlock"),
    pinCancelBtn: document.getElementById("pin-cancel"),
    pinSetupOverlay: document.getElementById("pin-setup-overlay"),
    pinSetupBootstrap: document.getElementById("pin-setup-bootstrap"),
    pinSetupInput: document.getElementById("pin-setup-input"),
    pinSetupConfirm: document.getElementById("pin-setup-confirm"),
    pinSetupError: document.getElementById("pin-setup-error"),
    pinSetupSkipBtn: document.getElementById("pin-setup-skip"),
    pinSetupSaveBtn: document.getElementById("pin-setup-save"),
    hostPinStatusEl: document.getElementById("host-pin-status"),
    hostPinCurrentRow: document.getElementById("host-pin-current-row"),
    hostPinCurrentInput: document.getElementById("host-pin-current"),
    hostPinBootstrapRow: document.getElementById("host-pin-bootstrap-row"),
    hostPinBootstrapInput: document.getElementById("host-pin-bootstrap"),
    hostPinNewInput: document.getElementById("host-pin-new"),
    hostPinConfirmInput: document.getElementById("host-pin-confirm"),
    hostPinSaveBtn: document.getElementById("host-pin-save"),
    hostPinClearBtn: document.getElementById("host-pin-clear"),
    controlsHostUnlockBtn: document.getElementById("controls-host-unlock"),
  },
  {
    showToast,
    confirmModal,
    isHostArea,
    getCurrentView: () => currentView,
    hideView: (name) => {
      if (VIEWS[name]) VIEWS[name].hidden = true;
    },
    getLastNonSettingsView: () =>
      VIEWS[lastNonSettingsView] ? lastNonSettingsView : "main",
    navigate: (name) => navigate(name),
    showView: (name) => showView(name),
    loadSettings: () => loadSettings(),
    loadAutoFill: () => loadAutoFill(),
    confirmAndRestart: () => confirmAndRestart(),
    syncHostControlsVisibility: () => syncHostControlsVisibility(),
  }
);

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

// Collapse/expand Up Next + main-page panels (Controls, Suggestion Box, …).
// Each panel remembers its own state in localStorage.
wirePanelCollapse("queue-section", "queue-toggle", "pq.queueCollapsed", {
  defaultCollapsed: false,
  // Edit sits inside the queue header; don't collapse when it's used.
  ignoreClickSelector: "#queue-edit-toggle",
});
// loadGroups bound after createSonosGroups (below)
let loadGroups = async () => {};
let invalidateGroups = () => {};
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
const {
  loadGroups: loadGroupsImpl,
  invalidate: invalidateGroupsImpl,
} = createSonosGroups(
  {
    groupChips: document.getElementById("group-chips"),
    groupEmpty: document.getElementById("group-empty"),
    groupIntro: document.getElementById("group-intro"),
    groupPicker: document.getElementById("group-picker"),
    groupEdit: document.getElementById("group-edit"),
    groupEditAnchor: document.getElementById("group-edit-anchor"),
    groupMembers: document.getElementById("group-members"),
    groupAvailable: document.getElementById("group-available"),
    groupEditEmpty: document.getElementById("group-edit-empty"),
    groupEditToggle: document.getElementById("group-edit-toggle"),
    groupUngroupAllBtn: document.getElementById("group-ungroup-all"),
  },
  {
    hostFetch,
    showToast,
    refreshSonos,
  }
);
loadGroups = loadGroupsImpl;
invalidateGroups = invalidateGroupsImpl;

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
let requestsPaused = false;
let partyOver = false;
let hostControlsOnly = false;
// DJ booth UI bound after branding (selectDjIcon) is created
let updateDjHubSummaries = () => {};
let setActiveDjIconName = () => {};
let applyDjFromSettings = () => {};
let loadDjEffectivePrompt = async () => {};
let getEndOfNightName = () => "Last call";
const djIconUploadBtn = document.getElementById("dj-icon-upload-btn");
const djIconFileInput = document.getElementById("dj-icon-file");
const djIconGallery = document.getElementById("dj-icon-gallery");
const recapHintEl = document.getElementById("recap-hint");
const eventNameInput = document.getElementById("set-event-name");
const subtitleInput = document.getElementById("set-subtitle");
const showVersionInput = document.getElementById("set-show-version");
const showQueueGenreInput = document.getElementById("set-show-queue-genre");
const headerEventName = document.getElementById("event-name");
const headerSubtitle = document.getElementById("subtitle");
const headerVersion = document.getElementById("app-version");
const heroImg = document.getElementById("hero");
const lookTextSaveBtn = document.getElementById("look-text-save");
const bannerUploadBtn = document.getElementById("banner-upload-btn");
const bannerFileInput = document.getElementById("banner-file");
const bannerGallery = document.getElementById("banner-gallery");
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
    queueUi.render(lastQueueTracks);
    queueUi.renderPartyDisplay(lastQueueTracks);
  }
}

const {
  applyHero,
  applyBranding,
  loadBanners,
  loadDjIcons,
  selectDjIcon,
} = createBrandingUi(
  {
    heroImg,
    headerEventName,
    headerSubtitle,
    headerVersion,
    eventNameInput,
    subtitleInput,
    showVersionInput,
    showQueueGenreInput,
    lookTextSaveBtn,
    bannerUploadBtn,
    bannerFileInput,
    bannerGallery,
    djIconUploadBtn,
    djIconFileInput,
    djIconGallery,
  },
  {
    hostFetch,
    showToast,
    saveSettings,
    getDefaultDjIconName: () => settingsDefaults?.djIcon || "dj-icon-flat.png",
    onDjIconChange: (name) => {
      setActiveDjIconName(name);
      updateDjHubSummaries();
    },
    onShowQueueGenreChange: (enabled) => {
      syncShowQueueGenre(enabled, { rerender: true });
    },
  }
);

const djBooth = createDjBoothUi(
  {
    djVoiceToggle: document.getElementById("dj-voice-toggle"),
    djNameInput: document.getElementById("set-dj-name"),
    djIntroPercentInput: document.getElementById("set-dj-intro-percent"),
    djMaxWordsInput: document.getElementById("set-dj-max-words"),
    djVolumeLowInput: document.getElementById("set-dj-vol-low"),
    djVolumeMidInput: document.getElementById("set-dj-vol-mid"),
    djVolumeHighInput: document.getElementById("set-dj-vol-high"),
    djSilenceInput: document.getElementById("set-dj-silence"),
    djTtsProviderInput: document.getElementById("set-dj-tts-provider"),
    djTtsVoiceInput: document.getElementById("set-dj-tts-voice"),
    djTtsVoiceElevenlabsInput: document.getElementById(
      "set-dj-tts-voice-elevenlabs"
    ),
    djTtsVoiceOpenaiRow: document.getElementById("dj-tts-voice-openai-row"),
    djTtsVoiceElevenlabsRow: document.getElementById(
      "dj-tts-voice-elevenlabs-row"
    ),
    djTtsSpeedInput: document.getElementById("set-dj-tts-speed"),
    djIntensityInput: document.getElementById("set-dj-intensity"),
    djCatchphraseInput: document.getElementById("set-dj-catchphrase"),
    djBanListInput: document.getElementById("set-dj-ban-list"),
    djPersonaNotesInput: document.getElementById("set-dj-persona-notes"),
    djAlwaysInstructionsInput: document.getElementById(
      "set-dj-always-instructions"
    ),
    djNeverInstructionsInput: document.getElementById(
      "set-dj-never-instructions"
    ),
    djPronunciationsInput: document.getElementById("set-dj-pronunciations"),
    djAdvancedSaveBtn: document.getElementById("dj-advanced-save"),
    djAdvancedResetBtn: document.getElementById("dj-advanced-reset"),
    djAdvancedPreviewRefreshBtn: document.getElementById(
      "dj-advanced-preview-refresh"
    ),
    djEffectivePromptInput: document.getElementById("dj-effective-prompt"),
    djShoutEnabledInput: document.getElementById("set-dj-shout-enabled"),
    djShoutModeInput: document.getElementById("set-dj-shout-mode"),
    djShoutPercentInput: document.getElementById("set-dj-shout-percent"),
    djShoutEveryInput: document.getElementById("set-dj-shout-every"),
    djPartyRecapEnabledInput: document.getElementById(
      "set-dj-party-recap-enabled"
    ),
    endOfNightLabelEl: document.getElementById("end-of-night-label"),
    endOfNightSearchInput: document.getElementById("end-of-night-search"),
    endOfNightResultsEl: document.getElementById("end-of-night-results"),
    endOfNightResetBtn: document.getElementById("end-of-night-reset"),
    djShoutPercentRow: document.getElementById("dj-shout-percent-row"),
    djShoutEveryRow: document.getElementById("dj-shout-every-row"),
    djVoiceTestBtn: document.getElementById("dj-voice-test"),
    djVoiceTestElevenlabsBtn: document.getElementById(
      "dj-voice-test-elevenlabs"
    ),
    djVoicePreviewPlayer: document.getElementById("dj-voice-preview-player"),
    djVoiceSaveBtns: document.querySelectorAll(".dj-voice-save-btn"),
    djVoiceResetBtns: document.querySelectorAll(".dj-voice-reset-btn"),
  },
  {
    hostFetch,
    showToast,
    saveSettings,
    selectDjIcon,
    getSettingsDefaults: () => settingsDefaults,
    refreshBoothMediaUrl,
  }
);
updateDjHubSummaries = djBooth.updateDjHubSummaries;
setActiveDjIconName = djBooth.setActiveDjIconName;
applyDjFromSettings = djBooth.applyFromSettings;
loadDjEffectivePrompt = djBooth.loadDjEffectivePrompt;
getEndOfNightName = djBooth.getEndOfNightName;

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
  applyDjFromSettings(s);
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
wireRotationPool(rotationMoodPool, "data-pool-preset", (ids) => {
  saveSettings({ randomMoodPool: ids });
});
wireRotationPool(rotationDecadePool, "data-pool-decade", (ids) => {
  saveSettings({ randomDecadePool: ids });
});

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
  if (on && !isPinRequired()) {
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

// One banner serves both locks; Party's Over (the hard end-of-night state)
// wins over a plain request pause when both are set.
function updateGuestLockBanner() {
  paintGuestLockBanner(
    requestsPausedBanner,
    guestLockBannerView({ partyOver, requestsPaused })
  );
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

// ---- Users hub (DJ Booth → shout-out notes / birthdays) ----
const { loadGuests } = createGuestHubUi(
  {
    hubGrid: document.getElementById("guest-hub-grid"),
    listEl: document.getElementById("guest-list"),
    nameInput: document.getElementById("guest-name-input"),
    notesInput: document.getElementById("guest-notes-input"),
    saveBtn: document.getElementById("guest-save"),
    bdayMonth: document.getElementById("guest-bday-month"),
    bdayDay: document.getElementById("guest-bday-day"),
    bdayRole: document.getElementById("guest-bday-role"),
    bdaySaveBtn: document.getElementById("guest-bday-save"),
    bdayForgetBtn: document.getElementById("guest-bday-forget"),
    removeBtn: document.getElementById("guest-remove"),
    renameBtn: document.getElementById("guest-rename"),
    editTitle: document.getElementById("settings-user-edit-title"),
  },
  {
    hostFetch,
    showToast,
    confirmModal,
    navigate,
  }
);

// ---- Connections (Spotify app / Last.fm / HA / Sonos HTTP / account) ----
const {
  loadSpotifyAppStatus,
  loadLastfmStatus,
  loadHaStatus,
  loadSonosConnStatus,
  loadSpotifyStatus,
} = createConnectionsUi(
  {
    spotifyApp: {
      statusEl: document.getElementById("spotify-app-status"),
      clientIdInput: document.getElementById("set-spotify-client-id"),
      clientSecretInput: document.getElementById("set-spotify-client-secret"),
      redirectInput: document.getElementById("set-spotify-redirect"),
      marketInput: document.getElementById("set-spotify-market"),
      secretHint: document.getElementById("spotify-secret-hint"),
      saveBtn: document.getElementById("spotify-app-save"),
      testBtn: document.getElementById("spotify-app-test"),
      clearBtn: document.getElementById("spotify-app-clear"),
    },
    lastfm: {
      statusEl: document.getElementById("lastfm-status"),
      keyInput: document.getElementById("set-lastfm-key"),
      keyHint: document.getElementById("lastfm-key-hint"),
      saveBtn: document.getElementById("lastfm-save"),
      testBtn: document.getElementById("lastfm-test"),
      clearBtn: document.getElementById("lastfm-clear"),
    },
    ha: {
      statusEl: document.getElementById("ha-status"),
      urlInput: document.getElementById("set-ha-url"),
      tokenInput: document.getElementById("set-ha-token"),
      tokenHint: document.getElementById("ha-token-hint"),
      saveBtn: document.getElementById("ha-save"),
      testBtn: document.getElementById("ha-test"),
      clearBtn: document.getElementById("ha-clear"),
    },
    sonos: {
      statusEl: document.getElementById("sonos-conn-status"),
      hostInput: document.getElementById("set-sonos-host"),
      roomInput: document.getElementById("set-sonos-room"),
      saveBtn: document.getElementById("sonos-conn-save"),
      testBtn: document.getElementById("sonos-conn-test"),
      clearBtn: document.getElementById("sonos-conn-clear"),
    },
    spotifyAccount: {
      statusEl: spotifyStatus,
      cacheWarmed,
    },
  },
  {
    hostFetch,
    showToast,
    loadGenres,
  }
);

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
const memoryEls = {
  countEl: document.getElementById("memory-count"),
  introEl: document.getElementById("memory-intro"),
  listEl: document.getElementById("memory-list"),
  emptyEl: document.getElementById("memory-empty"),
};

async function loadMemory() {
  return loadMemoryUi(memoryEls, { hostFetch });
}

// ---- Suggestion Box (guest submit + host inbox) ----------------------------
const suggestionText = document.getElementById("suggestion-text");
const suggestionSubmit = document.getElementById("suggestion-submit");
const suggestionCharCount = document.getElementById("suggestion-count");
const suggestionsList = document.getElementById("suggestions-list");
const suggestionsEmpty = document.getElementById("suggestions-empty");
const suggestionsCountEl = document.getElementById("suggestions-count");
let suggestionsCache = [];
let suggestionsFilter = "open";

const syncSuggestionCharCount = wireSuggestionCharCount(
  suggestionText,
  suggestionCharCount,
  SUGGESTION_TEXT_MAX
);

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
  const filtered = filterSuggestions(all, suggestionsFilter);
  if (suggestionsCountEl) {
    suggestionsCountEl.textContent = suggestionsCountLabel(all);
  }
  suggestionsList.innerHTML = "";
  if (suggestionsEmpty) {
    suggestionsEmpty.hidden = filtered.length > 0;
    suggestionsEmpty.textContent = suggestionsEmptyMessage(suggestionsFilter);
  }
  for (const s of filtered) {
    const li = document.createElement("li");
    li.className = "track track-noart suggestion-row" + (s.done ? " done" : "");
    li.dataset.id = s.id;
    li.innerHTML = suggestionRowHtml(s);
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
  statsEmpty.textContent = statsEmptyMessage(statsWindow);
  statsBody.hidden = empty;
  if (empty) return;

  statsCards.innerHTML = statsSummaryCardsHtml(s);
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
      statsDedications.innerHTML = dedicationsHtml(wall);
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
      statsKaraoke.innerHTML = karaokeRowsHtml(karaoke);
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
const displayQueueCount = document.getElementById("display-queue-count");
const displayQueue = document.getElementById("display-queue");
const displayQueueEmpty = document.getElementById("display-queue-empty");
const displayJoinQr = document.getElementById("display-join-qr");
const displayJoinUrl = document.getElementById("display-join-url");
const displayJoinError = document.getElementById("display-join-error");
const recapOverlay = document.getElementById("recap-overlay");
const recapBody = document.getElementById("recap-body");
const recapDismissBtn = document.getElementById("recap-dismiss");
const {
  showPartyRecap,
  maybeAnnounceClosingTime,
  markClosingShown,
} = createPartyRecapUi(
  {
    overlay: recapOverlay,
    body: recapBody,
    hintEl: recapHintEl,
    dismissBtn: recapDismissBtn,
  },
  {
    showToast,
    getEndOfNightName,
  }
);
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

function syncHostControlsVisibility() {
  const body = document.getElementById("controls-body");
  const protectedControls = document.getElementById("controls-host-protected");
  const lock = document.getElementById("controls-host-lock");
  const locked =
    hostControlsOnly && isPinRequired() && !settingsUnlocked();
  if (body) body.hidden = false;
  if (protectedControls) protectedControls.hidden = locked;
  if (lock) lock.hidden = !locked;
  queueUi.setGuestEditLocked(locked);
}

// Late-bound live streams (created after NP/queue apply helpers exist).
let liveStreams = null;
let appReady = false;
let lastPartySettings = null;

function refreshSonos() {
  liveStreams?.refreshSonos();
}

async function loadQueue(force = false) {
  return liveStreams?.loadQueue(force);
}

async function loadPartySettings() {
  return liveStreams?.loadPartySettings();
}

function syncPolling() {
  liveStreams?.syncPolling();
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
  } else if (isPinGateOpen() && getPendingPinAction() !== "restart") {
    clearPendingPinAction();
    closePinGate(); // leaving the Booth (e.g. phone Back) dismisses the gate
  }
  if (target === "stats") loadStats();
  if (target === "join" || target === "display") loadJoinCode();
  if (target === "display" && displayEventName) {
    displayEventName.textContent =
      document.getElementById("event-name")?.textContent?.trim() || "PartyQueue";
  }
  lyricsUi.onViewChange({ target, previous: previousView });
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

const searchUi = createSearchUi(
  {
    searchInput,
    searchClear,
    resultsEl,
    statusEl,
    dedicationOverlay,
    dedicationInput,
    dedicationError,
    dedicationSaveBtn,
    dedicationCancelBtn,
  },
  {
    showToast,
    confirmModal,
    ensureDisplayName,
    guestIdentityPayload,
    getPartyLocks: () => ({ partyOver, requestsPaused }),
    partyOverMessage: GUEST_BANNER_PARTY_OVER,
    setAutofillToggle,
    markClosingShown,
    showPartyRecap,
    refreshSonos,
    getCurrentView: () => currentView,
    loadStats,
  }
);


const reactionsUi = createReactionsUi(
  {
    npReactions: document.getElementById("np-reactions"),
    displayReactions: document.getElementById("display-reactions"),
    clearReactionsBtn: settingsClearReactionsBtn,
    clearKaraokeBtn: settingsClearKaraokeBtn,
  },
  {
    hostFetch,
    showToast,
    confirmModal,
    getNowPlayingId: () => searchUi.getNowPlayingId(),
    getNowPlayingMeta: () => ({
      title: lastNowPlaying?.title || "",
      artist: lastNowPlaying?.artist || "",
    }),
    ensureDisplayName,
    guestBadgeName,
    getCurrentView: () => currentView,
    loadStats: () => loadStats(),
  }
);

const queueUi = createQueueUi(
  {
    queueList,
    queueCount,
    queueEmpty,
    queueEditToggle,
    queueEditHint,
    displayQueue,
    displayQueueCount,
    displayQueueEmpty,
  },
  {
    hostFetch,
    showToast,
    getShowQueueGenre: () => showQueueGenre,
    getActiveEraMoodId: () => activeEraMoodId(),
    getLastQueueTracks: () => lastQueueTracks,
    applyQueueTracks: (tracks) => applyQueueTracks(tracks),
    loadQueue: (force) => loadQueue(force),
  }
);

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


const lyricsUi = createLyricsUi(
  {
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
  },
  {
    getLastNowPlaying: () => lastNowPlaying,
    getCurrentView: () => currentView,
    isModalOpen,
    bindArtwork: bindNowPlayingArtwork,
  }
);

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
    reactionsUi.setDisplayHidden(true);
    if (currentView === "display") lyricsUi.clearDisplay();
    return;
  }

  displayEmpty.hidden = true;
  displayTitle.textContent = np.title || "";
  if (displayArtist) displayArtist.textContent = np.artist || "";
  if (displayAlbum) displayAlbum.textContent = np.album || "";
  bindNowPlayingArtwork(displayArt, np);
  // Match main NP: only grey "Updating" while holding the prior confirmed
  // track through a Sonos metadata gap — not for optimistic next-track.
  const stateUpdating =
    nowPlayingDisplayMode === "converging" &&
    !!lastConfirmedNp &&
    mediaIdentity(np) === mediaIdentity(lastConfirmedNp);
  if (displayState) {
    displayState.hidden = false;
    const playing = !!np.isPlaying;
    displayState.textContent = stateUpdating
      ? "Updating"
      : playing
        ? "Now Playing"
        : "Paused";
    displayState.classList.toggle("playing", playing && !stateUpdating);
    displayState.classList.toggle("paused", !playing && !stateUpdating);
    displayState.classList.toggle("updating", stateUpdating);
  }
  reactionsUi.setDisplayHidden(!!np.djVoice || !!np.updating);
  if (displayOriginPill) {
    // Same "how it got here" tag as the Up Next rows; DJ clips aren't songs.
    const hide = !!np.djVoice || stateUpdating;
    displayOriginPill.hidden = hide;
    if (!hide) {
      displayOriginPill.textContent = displayOriginLabel(np, activeEraMoodId());
    }
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
  lyricsUi.applyPlaybackClock(np);
  lyricsUi.updateTrackProgress();
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
  // Grey "Updating" only while we are still holding the prior confirmed track
  // through a Sonos metadata gap. Optimistic next-track (and first paint of the
  // new title) already know the song — show Playing/Paused + origin instead.
  const stateUpdating =
    nowPlayingDisplayMode === "converging" &&
    !!lastConfirmedNp &&
    mediaIdentity(np) === mediaIdentity(lastConfirmedNp);
  const nextNpId = hasTrack && !updating ? trackIdFromUri(np.uri) : null;
  reactionsUi.noteTrackChange(nextNpId);
  searchUi.setNowPlaying(hasTrack ? np : null, {
    includeId: hasTrack && !updating,
  });

  // Playing/Paused + origin pills: stacked and centered on the right.
  if (npPills) npPills.hidden = !hasTrack;
  npState.hidden = !hasTrack;
  if (hasTrack) {
    const transportPlaying = !!(transport?.isPlaying ?? np.isPlaying);
    npState.textContent = stateUpdating
      ? "Updating"
      : transportPlaying
        ? "Playing"
        : "Paused";
    npState.classList.toggle("playing", transportPlaying && !stateUpdating);
    npState.classList.toggle("paused", !transportPlaying && !stateUpdating);
    npState.classList.toggle("updating", stateUpdating);
  }
  if (npOrigin) {
    // Keep origin visible whenever we know it (incl. optimistic skip). Only
    // suppress while holding the prior track under a grey Updating state.
    const origin = nowPlayingOriginLabel(np, hasTrack && !stateUpdating);
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
    reactionsUi.applyFromNowPlaying(np, { hasTrack: true, updating });
  } else {
    npCard.classList.add("is-empty");
    npTitle.hidden = true;
    npArtist.hidden = true;
    npAlbum.hidden = true;
    bindNowPlayingArtwork(npArt, null);
    npEmpty.hidden = false;
    npEmpty.textContent = EMPTY_MESSAGE;
    reactionsUi.applyFromNowPlaying(null, { hasTrack: false, updating: false });
    if (lyricsUi.isOpen()) lyricsUi.close();
  }

  renderPartyDisplayNowPlaying(np, hasTrack);
  lyricsUi.sync(np);
  prefetchUpcomingAlbumArt(lastQueueTracks);
}

function applyQueueTracks(tracks) {
  lastQueueTracks = tracks;
  searchUi.setQueuedTracks(tracks);
  queueUi.render(tracks);
  queueUi.renderPartyDisplay(tracks);
  prefetchUpcomingAlbumArt(tracks);
}


liveStreams = createLiveStreams(
  {
    npCard,
    npConnectionStatus,
    displayConnectionStatus,
  },
  {
    getCurrentView: () => currentView,
    renderNowPlaying: (snapshot) => renderNowPlaying(snapshot),
    applyQueueTracks: (tracks) => applyQueueTracks(tracks),
    applyPartySettings: (payload) => applyPartySettings(payload),
    freezePlayhead: () => lyricsUi.freezePlayhead(),
    isQueueEditMode: () => queueUi.isEditMode(),
    setPendingStreamTracks: (tracks) => queueUi.setPendingStreamTracks(tracks),
    clearPendingStreamTracks: () => queueUi.clearPendingStreamTracks(),
    loadGroups: (force) => loadGroups(force),
  }
);

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
    invalidateGroups();
    loadGroups(true);
    showToast(`Grouped ${d.players} speakers · Volume ${d.volume}`);
  });
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
    const total = currentPlaylists.length;
    if (!total || selectedPlaylistIds == null) {
      playlistsEl.textContent = "—";
    } else {
      const ids = currentPlaylists.map((p) => p.id);
      const selected = ids.filter((id) => selectedPlaylistIds.has(id)).length;
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

