import { isModalOpen } from "./modal.js";
import { createGuestHubUi } from "./guest-hub-ui.js";
import {
  mediaIdentity,
  playbackIdentity,
  queueTrackAsNowPlaying,
  resolveNowPlayingDisplay,
} from "./now-playing-utils.js";
import { showToast } from "./toast.js";
import { wirePanelCollapse } from "./panel-collapse.js";
import { createConfirmModal } from "./confirm-modal.js";
import { createHostPinUi } from "./host-pin-ui.js";
import { createGuestNameUi } from "./guest-name-ui.js";
import { createGuestFairnessUi } from "./guest-fairness-ui.js";
import { createDebounced } from "./debounce.js";
import { createSameArtistCountdownUi } from "./same-artist-countdown-ui.js";
import { loadMemory as loadMemoryUi } from "./memory-ui.js";
import { createPartyRecapUi } from "./party-recap.js";
import { createSonosGroups } from "./sonos-groups.js";
import { createConnectionsUi } from "./connections-ui.js";
import {
  createBrandingUi,
  persistBrandingCache,
  applyBrandTypeForViewport,
  normalizeBrandFontSize,
  DESKTOP_BANNER_MQ,
} from "./branding-ui.js";
import {
  nowPlayingOriginLabel,
  displayOriginLabel,
  displayOriginTone,
  paintOriginToneClass,
} from "./now-playing-origin.js";
import { trackIdFromUri } from "./search-track.js";
import { createSearchUi } from "./search-ui.js";
import { createReactionsUi } from "./reactions-ui.js";
import { createQueueUi } from "./queue-ui.js";
import { createLyricsUi } from "./lyrics-ui.js";
import { createLiveStreams } from "./live-streams.js";
import { createMusicMixUi } from "./music-mix-ui.js";
import {
  paintVolumeLabel,
  volumePollMs,
} from "./mix-labels.js";
import { createPlaylistsUi } from "./playlists-ui.js";
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
  paintDisplayTonightStats,
  dedicationsHtml,
  karaokeRowsHtml,
  statsEmptyMessage,
} from "./stats-ui.js";
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
import {
  isPartyDisplayKiosk,
  isPartyDisplayPreview,
  isTvStageView,
  karaokeDisplayFullyStartUrl,
  partyDisplayFullyStartUrl,
  syncPartyDisplayViewport,
} from "./party-display-viewport.js";
import {
  hashForView,
  resolveViewName,
  searchBackAction,
} from "./view-nav.js";
import { blurSoftKeyboard } from "./visual-viewport-box.js";
import { createPartyDisplayIdle } from "./party-display-idle.js";
import { createPartyDisplayClock } from "./party-display-clock.js";

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
  isPinStatusReady,
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
    navigate: (name, opts) => navigate(name, opts),
    showView: (name) => showView(name),
    loadSettings: () => loadSettings(),
    loadAutoFill: () => loadAutoFill(),
    confirmAndRestart: () => confirmAndRestart(),
    syncHostControlsVisibility: () => syncHostControlsVisibility(),
  }
);

/** Filled after fairness UI is created — name modal calls this on save. */
let refreshGuestFairness = () => {};

const {
  ensureDisplayName,
  guestBadgeName,
  guestIdentityPayload,
} = createGuestNameUi({
  nameOverlay: document.getElementById("name-overlay"),
  nameTitle: document.getElementById("name-title"),
  nameInput: document.getElementById("name-input"),
  aliasInput: document.getElementById("alias-input"),
  nameUserHint: document.getElementById("name-user-hint"),
  nameError: document.getElementById("name-error"),
  nameSaveBtn: document.getElementById("name-save"),
  nameCancelBtn: document.getElementById("name-cancel"),
  guestNameBtn: document.getElementById("guest-name"),
  onNameChange: () => {
    refreshGuestFairness();
  },
});

const guestFairnessUi = createGuestFairnessUi({
  el: document.getElementById("guest-fairness"),
  getUser: () => guestIdentityPayload()?.requestedByUser || "",
});
refreshGuestFairness = () => {
  guestFairnessUi.refresh();
};
// Queue SSE ticks ~3s; debounce so fairness follows the live list without
// a GET /api/fairness on every snapshot.
const scheduleFairnessRefresh = createDebounced(() => {
  refreshGuestFairness();
}, 400);
let lastFairnessTrackKey = "";

const sameArtistCountdownUi = createSameArtistCountdownUi({
  el: document.getElementById("special-set-countdown"),
});

const dedicationOverlay = document.getElementById("dedication-overlay");
const dedicationInput = document.getElementById("dedication-input");
const dedicationError = document.getElementById("dedication-error");
const dedicationSaveBtn = document.getElementById("dedication-save");
const dedicationCancelBtn = document.getElementById("dedication-cancel");

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
const queueSection = document.getElementById("queue-section");
const queueConnectionStatus = document.getElementById("queue-connection-status");
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
const karaokeLyrics = document.getElementById("karaoke-lyrics");
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

// Late-bound playlists UI (created with Music Mix).
let playlistsUi = null;
function loadPlaylists() {
  return playlistsUi?.loadPlaylists();
}

// Main-page panels (Up Next, Controls, Tools, Suggestion) stay open on phone
// and desktop — no collapse chrome.
const canCollapseMainOps = () => false;

const queuePanel = wirePanelCollapse(
  "queue-section",
  "queue-toggle",
  "pq.queueCollapsed",
  {
    defaultCollapsed: false,
    // Edit sits inside the queue header; don't collapse when it's used.
    ignoreClickSelector: "#queue-edit-toggle",
    canCollapse: canCollapseMainOps,
  }
);
// loadGroups bound after createSonosGroups (below)
let loadGroups = async () => {};
let reloadGroupsAfterTopology = async () => {};
const controlsPanel = wirePanelCollapse(
  "controls-section",
  "controls-toggle",
  "pq.controlsCollapsed",
  {
    defaultCollapsed: false,
    onExpand: () => loadGroups(true),
    canCollapse: canCollapseMainOps,
  }
);

const toolbarPanel = wirePanelCollapse(
  "toolbar-section",
  "toolbar-toggle",
  "pq.toolbarCollapsed",
  {
    defaultCollapsed: false,
    canCollapse: canCollapseMainOps,
  }
);
const suggestionPanel = wirePanelCollapse(
  "suggestion-section",
  "suggestion-toggle",
  "pq.suggestionCollapsed",
  {
    defaultCollapsed: false,
    canCollapse: canCollapseMainOps,
    ignoreClickSelector: "#suggestion-submit",
  }
);

function syncMainPanelsOpen() {
  queuePanel?.setCollapsed(false, { persist: false });
  controlsPanel?.setCollapsed(false, {
    persist: false,
    fireOnExpand: true,
  });
  toolbarPanel?.setCollapsed(false, { persist: false });
  suggestionPanel?.setCollapsed(false, { persist: false });
}
syncMainPanelsOpen();
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
const toolbarKaraokeBtn = document.getElementById("toolbar-karaoke");
const moodNeedSpotify = document.getElementById("mood-need-spotify");
const musicMixHub = document.getElementById("music-mix-hub");

// Late-bound Music Mix (created after navigateMixPanel + playlist state exist).
let musicMix = null;
/** Last host-session open state for Controls auto-expand edge detection. */
let hostChromeOpen = null;

function syncToolbarMoodVisibility() {
  musicMix?.syncToolbarMoodVisibility();
}
function loadGenres() {
  return musicMix?.loadGenres();
}
function loadAutoFill() {
  return musicMix?.loadAutoFill();
}
function setAutofillToggle(checked) {
  musicMix?.setAutofillToggle(checked);
}
function syncAutoFillFromServer(enabled) {
  musicMix?.syncAutoFillFromServer(enabled);
}
function updateMixSelectionFromServer(party) {
  musicMix?.updateMixSelectionFromServer(party);
}
function updateMixGenreHeaderFromServer(np) {
  musicMix?.updateMixGenreHeaderFromServer(np);
}
function updateMusicMixHubSummaries() {
  musicMix?.updateMusicMixHubSummaries();
}
function refreshPoolSizeHint() {
  musicMix?.refreshPoolSizeHint();
}
function syncPickerSelection() {
  musicMix?.syncPickerSelection();
}
function syncAutoFillSelection() {
  musicMix?.syncAutoFillSelection();
}
function activeEraMoodId() {
  return musicMix?.activeEraMoodId() ?? null;
}
function currentGenreIds() {
  return musicMix?.currentGenreIds() ?? [];
}
function currentMoodId() {
  return musicMix?.currentMoodId() ?? null;
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
if (toolbarKaraokeBtn) {
  toolbarKaraokeBtn.addEventListener("click", () => navigate("karaoke"));
}
syncToolbarMoodVisibility();

// ---- Sonos group picker + Edit groups ----
const {
  loadGroups: loadGroupsImpl,
  reloadAfterTopologyChange: reloadGroupsAfterTopologyImpl,
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
    typePicker: document.getElementById("sonos-type-picker"),
    typePickerRoom: document.getElementById("sonos-type-picker-room"),
    typePickerOptions: document.getElementById("sonos-type-picker-options"),
    typePickerCancel: document.getElementById("sonos-type-picker-cancel"),
  },
  {
    hostFetch,
    showToast,
    refreshSonos,
  }
);
loadGroups = loadGroupsImpl;
reloadGroupsAfterTopology = reloadGroupsAfterTopologyImpl;

// Randomness settings (song memory + per-artist budget), persisted server-side.
const songMemoryInput = document.getElementById("set-song-memory");
const artistWindowInput = document.getElementById("set-artist-window");
const artistCapInput = document.getElementById("set-artist-cap");
const sameArtistBatchInput = document.getElementById("set-same-artist-batch");
const specialSetEveryInput = document.getElementById("set-special-set-every");
const requestedReactionSetInput = document.getElementById(
  "set-requested-reaction-set"
);
const lovedReactionSetInput = document.getElementById("set-loved-reaction-set");
const hatedReactionSetInput = document.getElementById("set-hated-reaction-set");
const strictFillInput = document.getElementById("set-strict-fill");
const settingsSaveBtn = document.getElementById("settings-save");
const settingsResetBtn = document.getElementById("settings-reset");
const settingsClearHistoryBtn = document.getElementById("settings-clear-history");
const settingsClearStatsBtn = document.getElementById("settings-clear-stats");
const settingsClearDjMemoryBtn = document.getElementById("settings-clear-dj-memory");
const settingsClearDjShoutMemoryBtn = document.getElementById("settings-clear-dj-shout-memory");
const settingsClearSuggestionsBtn = document.getElementById("settings-clear-suggestions");
const settingsClearReactionsBtn = document.getElementById("settings-clear-reactions");
const settingsClearKaraokeBtn = document.getElementById("settings-clear-karaoke");
const settingsClearFairnessBtn = document.getElementById("settings-clear-fairness");
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
const setRequestFairnessEnabledInput = document.getElementById(
  "set-set-request-fairness-enabled"
);
const setRequestFairnessWindowInput = document.getElementById(
  "set-set-request-fairness-window"
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
let getDjBoothEditingPersona = () => "holy-roller";
let getEndOfNightName = () => "Last call";
const djIconUploadBtn = document.getElementById("dj-icon-upload-btn");
const djIconFileInput = document.getElementById("dj-icon-file");
const djIconGallery = document.getElementById("dj-icon-gallery");
const recapHintEl = document.getElementById("recap-hint");
const eventNameInput = document.getElementById("set-event-name");
const guestWifiSsidInput = document.getElementById("set-guest-wifi-ssid");
const guestWifiPasswordInput = document.getElementById("set-guest-wifi-password");
const guestWifiSaveBtn = document.getElementById("guest-wifi-save");
const subtitleInput = document.getElementById("set-subtitle");
const headerFontSizeInput = document.getElementById("set-header-font-size");
const subtitleFontSizeInput = document.getElementById("set-subtitle-font-size");
const versionFontSizeInput = document.getElementById("set-version-font-size");
const headerAllCapsInput = document.getElementById("set-header-all-caps");
const subtitleAllCapsInput = document.getElementById("set-subtitle-all-caps");
const headerFontSizeMobileInput = document.getElementById(
  "set-header-font-size-mobile"
);
const subtitleFontSizeMobileInput = document.getElementById(
  "set-subtitle-font-size-mobile"
);
const versionFontSizeMobileInput = document.getElementById(
  "set-version-font-size-mobile"
);
const headerAllCapsMobileInput = document.getElementById(
  "set-header-all-caps-mobile"
);
const subtitleAllCapsMobileInput = document.getElementById(
  "set-subtitle-all-caps-mobile"
);
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
const bannerMobileUploadBtn = document.getElementById("banner-mobile-upload-btn");
const bannerMobileFileInput = document.getElementById("banner-mobile-file");
const bannerMobileGallery = document.getElementById("banner-mobile-gallery");
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
  applyHeroMobile,
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
    headerFontSizeInput,
    subtitleFontSizeInput,
    versionFontSizeInput,
    headerAllCapsInput,
    subtitleAllCapsInput,
    headerFontSizeMobileInput,
    subtitleFontSizeMobileInput,
    versionFontSizeMobileInput,
    headerAllCapsMobileInput,
    subtitleAllCapsMobileInput,
    showVersionInput,
    showQueueGenreInput,
    lookTextSaveBtn,
    bannerUploadBtn,
    bannerFileInput,
    bannerGallery,
    bannerMobileUploadBtn,
    bannerMobileFileInput,
    bannerMobileGallery,
    djIconUploadBtn,
    djIconFileInput,
    djIconGallery,
  },
  {
    hostFetch,
    showToast,
    saveSettings,
    getDefaultDjIconName: () => settingsDefaults?.djIcon || "dj-icon-headphones.png",
    getEditingPersona: () => getDjBoothEditingPersona(),
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
    djTaglinesInput: document.getElementById("set-dj-taglines"),
    djTaglinesSaveBtn: document.getElementById("dj-taglines-save"),
    djTaglinesResetBtn: document.getElementById("dj-taglines-reset"),
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
    djRosterModeInput: document.getElementById("set-dj-roster-mode"),
    djMixPercentInput: document.getElementById("set-dj-mix-percent"),
    djBanterPercentInput: document.getElementById("set-dj-banter-percent"),
    djMixRow: document.getElementById("dj-mix-row"),
    djBanterRow: document.getElementById("dj-banter-row"),
    djRosterSaveBtn: document.getElementById("dj-roster-save"),
    djRosterResetBtn: document.getElementById("dj-roster-reset"),
  },
  {
    hostFetch,
    showToast,
    saveSettings,
    selectDjIcon,
    getSettingsDefaults: () => settingsDefaults,
    refreshBoothMediaUrl,
    loadDjIcons,
  }
);
updateDjHubSummaries = djBooth.updateDjHubSummaries;
setActiveDjIconName = djBooth.setActiveDjIconName;
applyDjFromSettings = djBooth.applyFromSettings;
loadDjEffectivePrompt = djBooth.loadDjEffectivePrompt;
getEndOfNightName = djBooth.getEndOfNightName;
getDjBoothEditingPersona = djBooth.getEditingPersona;

function fillSettings(s) {
  if (s.songMemory != null) songMemoryInput.value = s.songMemory;
  if (s.artistWindow != null) artistWindowInput.value = s.artistWindow;
  if (s.artistCap != null) artistCapInput.value = s.artistCap;
  if (s.strictFill != null) strictFillInput.checked = !!s.strictFill;
  if (s.sameArtistBatchEnabled != null && sameArtistBatchInput) {
    sameArtistBatchInput.checked = !!s.sameArtistBatchEnabled;
  }
  if (s.specialSetEveryN != null && specialSetEveryInput) {
    specialSetEveryInput.value = s.specialSetEveryN;
  } else if (s.sameArtistBatchEveryN != null && specialSetEveryInput) {
    specialSetEveryInput.value = s.sameArtistBatchEveryN;
  }
  if (s.requestedReactionSetEnabled != null && requestedReactionSetInput) {
    requestedReactionSetInput.checked = !!s.requestedReactionSetEnabled;
  }
  if (s.lovedReactionSetEnabled != null && lovedReactionSetInput) {
    lovedReactionSetInput.checked = !!s.lovedReactionSetEnabled;
  }
  if (s.hatedReactionSetEnabled != null && hatedReactionSetInput) {
    hatedReactionSetInput.checked = !!s.hatedReactionSetEnabled;
  }
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
  if (
    s.setRequestFairnessEnabled != null &&
    setRequestFairnessEnabledInput
  ) {
    setRequestFairnessEnabledInput.checked = !!s.setRequestFairnessEnabled;
  }
  if (
    s.setRequestFairnessWindowMinutes != null &&
    setRequestFairnessWindowInput
  ) {
    setRequestFairnessWindowInput.value = s.setRequestFairnessWindowMinutes;
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
    musicMix?.applyGenresFromSettings(s.genres);
  }
  applyDjFromSettings(s);
  if (s.eventName != null) eventNameInput.value = s.eventName;
  if (s.guestWifiSsid != null && guestWifiSsidInput) {
    guestWifiSsidInput.value = s.guestWifiSsid;
  }
  if (s.guestWifiPassword != null && guestWifiPasswordInput) {
    guestWifiPasswordInput.value = s.guestWifiPassword;
  }
  if (s.subtitle != null) subtitleInput.value = s.subtitle;
  if (
    s.headerFontSize != null ||
    s.subtitleFontSize != null ||
    s.versionFontSize != null ||
    s.headerFontSizeMobile != null ||
    s.subtitleFontSizeMobile != null ||
    s.versionFontSizeMobile != null ||
    s.headerAllCaps != null ||
    s.subtitleAllCaps != null ||
    s.headerAllCapsMobile != null ||
    s.subtitleAllCapsMobile != null
  ) {
    const typeState = {
      headerFontSize: normalizeBrandFontSize(s.headerFontSize, "header"),
      subtitleFontSize: normalizeBrandFontSize(s.subtitleFontSize, "subtitle"),
      versionFontSize: normalizeBrandFontSize(s.versionFontSize, "version"),
      headerAllCaps: s.headerAllCaps != null ? !!s.headerAllCaps : true,
      subtitleAllCaps: s.subtitleAllCaps != null ? !!s.subtitleAllCaps : true,
      headerFontSizeMobile: normalizeBrandFontSize(
        s.headerFontSizeMobile ?? s.headerFontSize,
        "header"
      ),
      subtitleFontSizeMobile: normalizeBrandFontSize(
        s.subtitleFontSizeMobile ?? s.subtitleFontSize,
        "subtitle"
      ),
      versionFontSizeMobile: normalizeBrandFontSize(
        s.versionFontSizeMobile ?? s.versionFontSize,
        "version"
      ),
      headerAllCapsMobile:
        s.headerAllCapsMobile != null
          ? !!s.headerAllCapsMobile
          : s.headerAllCaps != null
            ? !!s.headerAllCaps
            : true,
      subtitleAllCapsMobile:
        s.subtitleAllCapsMobile != null
          ? !!s.subtitleAllCapsMobile
          : s.subtitleAllCaps != null
            ? !!s.subtitleAllCaps
            : true,
    };
    if (headerFontSizeInput) {
      headerFontSizeInput.value = String(typeState.headerFontSize);
    }
    if (subtitleFontSizeInput) {
      subtitleFontSizeInput.value = String(typeState.subtitleFontSize);
    }
    if (versionFontSizeInput) {
      versionFontSizeInput.value = String(typeState.versionFontSize);
    }
    if (headerAllCapsInput) {
      headerAllCapsInput.value = typeState.headerAllCaps ? "1" : "0";
    }
    if (subtitleAllCapsInput) {
      subtitleAllCapsInput.value = typeState.subtitleAllCaps ? "1" : "0";
    }
    if (headerFontSizeMobileInput) {
      headerFontSizeMobileInput.value = String(typeState.headerFontSizeMobile);
    }
    if (subtitleFontSizeMobileInput) {
      subtitleFontSizeMobileInput.value = String(
        typeState.subtitleFontSizeMobile
      );
    }
    if (versionFontSizeMobileInput) {
      versionFontSizeMobileInput.value = String(
        typeState.versionFontSizeMobile
      );
    }
    if (headerAllCapsMobileInput) {
      headerAllCapsMobileInput.value = typeState.headerAllCapsMobile
        ? "1"
        : "0";
    }
    if (subtitleAllCapsMobileInput) {
      subtitleAllCapsMobileInput.value = typeState.subtitleAllCapsMobile
        ? "1"
        : "0";
    }
    applyBrandTypeForViewport(typeState);
    persistBrandingCache(typeState);
  }
  if (s.showVersion != null) {
    showVersionInput.checked = !!s.showVersion;
    if (headerVersion) headerVersion.hidden = !s.showVersion;
    const displayVersion = document.getElementById("display-version");
    if (displayVersion) displayVersion.hidden = !s.showVersion;
    persistBrandingCache({ showVersion: !!s.showVersion });
  }
  if (s.showQueueGenre != null) {
    syncShowQueueGenre(!!s.showQueueGenre, { rerender: true });
  }
  if (s.heroBanner !== undefined) applyHero(s.heroBanner);
  if (s.heroBannerMobile !== undefined) applyHeroMobile(s.heroBannerMobile);
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

/** Vibe toggles — public POST /api/party (no host PIN). */
async function savePartyToggle(values, { toastMessage = null } = {}) {
  try {
    const res = await fetch("/api/party", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not save.");
    syncDiscoverFromServer(data.discoverEnabled);
    syncRotationFromServer(data);
    syncContentTogglesFromServer(data);
    if (toastMessage) showToast(toastMessage);
    return true;
  } catch (err) {
    showToast(err.message, true);
    return false;
  }
}

function currentSettingsPayload() {
  return {
    songMemory: Number(songMemoryInput.value),
    artistWindow: Number(artistWindowInput.value),
    artistCap: Number(artistCapInput.value),
    strictFill: strictFillInput.checked,
    specialSetEveryN: Number(specialSetEveryInput?.value),
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
    setRequestFairnessEnabled: !!setRequestFairnessEnabledInput?.checked,
    setRequestFairnessWindowMinutes: Number(
      setRequestFairnessWindowInput?.value
    ),
    randomMoodEverySets: Number(randomMoodEveryInput?.value),
    randomDecadeEverySets: Number(randomDecadeEveryInput?.value),
  };
}

settingsSaveBtn?.addEventListener("click", () => {
  saveSettings(currentSettingsPayload(), { toastMessage: "Saved" });
});

guestWifiSaveBtn?.addEventListener("click", () => {
  saveSettings(
    {
      guestWifiSsid: guestWifiSsidInput?.value || "",
      guestWifiPassword: guestWifiPasswordInput?.value || "",
    },
    { toastMessage: "Guest Wi-Fi saved" }
  ).then((ok) => {
    if (ok) loadJoinCode();
  });
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
discoverEnabledInput.addEventListener("change", async () => {
  discoverTouchedAt = Date.now();
  const on = !!discoverEnabledInput.checked;
  const ok = await savePartyToggle({ discoverEnabled: on });
  if (!ok) discoverEnabledInput.checked = !on;
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
randomMoodToggle?.addEventListener("change", async () => {
  rotationTouchedAt = Date.now();
  const on = !!randomMoodToggle.checked;
  const ok = await savePartyToggle(
    { randomMoodEnabled: on },
    {
      toastMessage: on
        ? "Random Mood on — mood rotates between sets"
        : "Random Mood off",
    }
  );
  if (!ok) randomMoodToggle.checked = !on;
});
randomDecadeToggle?.addEventListener("change", async () => {
  rotationTouchedAt = Date.now();
  const on = !!randomDecadeToggle.checked;
  const ok = await savePartyToggle(
    { randomDecadeEnabled: on },
    {
      toastMessage: on
        ? "Random Decade on — decade rotates between sets"
        : "Random Decade off",
    }
  );
  if (!ok) randomDecadeToggle.checked = !on;
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

sameArtistBatchInput?.addEventListener("change", () => {
  saveSettings({ sameArtistBatchEnabled: !!sameArtistBatchInput.checked });
});

requestedReactionSetInput?.addEventListener("change", () => {
  saveSettings({
    requestedReactionSetEnabled: !!requestedReactionSetInput.checked,
  });
});

lovedReactionSetInput?.addEventListener("change", () => {
  saveSettings({
    lovedReactionSetEnabled: !!lovedReactionSetInput.checked,
  });
});

hatedReactionSetInput?.addEventListener("change", () => {
  saveSettings({
    hatedReactionSetEnabled: !!hatedReactionSetInput.checked,
  });
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

setRequestFairnessEnabledInput?.addEventListener("change", () => {
  saveSettings(
    {
      setRequestFairnessEnabled: !!setRequestFairnessEnabledInput.checked,
    },
    {
      toastMessage: setRequestFairnessEnabledInput.checked
        ? "Set Request fairness enabled"
        : "Set Request fairness disabled",
    }
  );
});

// The explicit filter is an independent switch (like Never-Ending Queue): it
// saves on its own and isn't touched by the Song Selection Save / Defaults.
filterExplicitInput.addEventListener("change", async () => {
  contentToggleTouchedAt = Date.now();
  const on = !!filterExplicitInput.checked;
  const ok = await savePartyToggle({ filterExplicit: on });
  if (!ok) filterExplicitInput.checked = !on;
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
    const ok = await savePartyToggle(
      { kidsLock: on },
      { toastMessage: on ? "Kids lock on" : "Kids lock off" }
    );
    if (!ok) kidsLockInput.checked = !on;
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
  delete rest.djTaglines;
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
  delete rest.djRosterMode;
  delete rest.djMixHolyRollerPercent;
  delete rest.djBanterPercent;
  delete rest.djSisterStatic;
  delete rest.djPersonas;
  delete rest.eventName;
  delete rest.subtitle;
  delete rest.headerFontSize;
  delete rest.subtitleFontSize;
  delete rest.versionFontSize;
  delete rest.headerAllCaps;
  delete rest.subtitleAllCaps;
  delete rest.headerFontSizeMobile;
  delete rest.subtitleFontSizeMobile;
  delete rest.versionFontSizeMobile;
  delete rest.headerAllCapsMobile;
  delete rest.subtitleAllCapsMobile;
  delete rest.showVersion;
  delete rest.showQueueGenre;
  delete rest.heroBanner;
  delete rest.heroBannerMobile;
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

settingsClearDjShoutMemoryBtn?.addEventListener("click", async () => {
  const ok = await confirmModal(
    "Reset DJ shout-out memory? Guests can get first-request and birthday shouts again. Set intro phrases and DJ Voice taglines stay.",
    "Reset shout-outs"
  );
  if (!ok) return;
  settingsClearDjShoutMemoryBtn.disabled = true;
  try {
    const res = await hostFetch("/api/settings/clear-dj-shout-memory", {
      method: "POST",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not clear DJ shout-out memory.");
    showToast("DJ shout-out memory cleared");
  } catch (err) {
    showToast(err.message, true);
  } finally {
    settingsClearDjShoutMemoryBtn.disabled = false;
  }
});

settingsClearSuggestionsBtn?.addEventListener("click", () => clearAllSuggestions(settingsClearSuggestionsBtn));

settingsClearFairnessBtn?.addEventListener("click", async () => {
  const ok = await confirmModal(
    "Reset fairness? Clears rolling song-request and Set Request limits so guests can request again. Queued songs and Stats stay.",
    "Reset fairness"
  );
  if (!ok) return;
  settingsClearFairnessBtn.disabled = true;
  try {
    const res = await hostFetch("/api/settings/clear-fairness", {
      method: "POST",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not reset fairness.");
    showToast("Fairness limits cleared");
    refreshGuestFairness();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    settingsClearFairnessBtn.disabled = false;
  }
});

const boothNewPartyBtn = document.getElementById("booth-new-party");
boothNewPartyBtn?.addEventListener("click", async () => {
  const ok = await confirmModal(
    "Start a new party? Clears DJ shout memory, fairness limits, and Loved/Hated already-played-this-party memory. Song memory, reactions, Karaoke, Stats, and the queue stay.",
    "New party"
  );
  if (!ok) return;
  boothNewPartyBtn.disabled = true;
  try {
    const res = await hostFetch("/api/settings/new-party", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not start a new party.");
    showToast("New party ready — DJ memory, fairness, and Loved/Hated set memory cleared");
    refreshGuestFairness();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    boothNewPartyBtn.disabled = false;
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
const statsSets = document.getElementById("stats-sets");
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
let statsWindow = "allTime";

function renderStats() {
  if (!statsData) return;
  const s = statsData[statsWindow] || {
    total: 0,
    topSongs: [],
    topSets: [],
    topArtists: [],
    topRequesters: [],
  };
  const karaoke = Array.isArray(statsData.karaoke) ? statsData.karaoke : [];
  const partyMusic = Array.isArray(statsData.partyMusic)
    ? statsData.partyMusic
    : [];
  // Window-scoped reaction lists (Tonight vs All time).
  const reacted = Array.isArray(s.reacted) ? s.reacted : [];
  const topLiked = Array.isArray(s.topLiked) ? s.topLiked : [];
  const mostHated = Array.isArray(s.mostHated) ? s.mostHated : [];
  const sets = Array.isArray(s.topSets) ? s.topSets : [];
  const dedications = Array.isArray(s.dedications) ? s.dedications : [];
  const empty =
    !s.total &&
    !sets.length &&
    !dedications.length &&
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
  if (statsSets) {
    statsSets.innerHTML = sets.length
      ? statRows(sets, "set")
      : `<li class="stats-row stats-row-empty"><span class="stats-name">No set requests yet</span></li>`;
  }
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
    if (statsDedicationsLabel) {
      statsDedicationsLabel.textContent =
        statsWindow === "tonight"
          ? "Tonight's dedications"
          : "Dedications";
    }
    statsDedicationsWrap.hidden = false;
    statsDedications.innerHTML = dedications.length
      ? dedicationsHtml(dedications)
      : `<li class="stats-row stats-row-empty"><span class="stats-name">No dedications yet</span></li>`;
  }
  paintStatsReactionList(statsReactedWrap, statsReacted, reacted, {
    alwaysShow: true,
    emptyLabel: "No reactions yet",
  });
  paintStatsReactionList(statsTopLikedWrap, statsTopLiked, topLiked, {
    alwaysShow: true,
    emptyLabel: "No liked songs yet",
  });
  paintStatsReactionList(statsMostHatedWrap, statsMostHated, mostHated, {
    alwaysShow: true,
    emptyLabel: "No hated songs yet",
  });
  paintStatsReactionList(statsPartyMusicWrap, statsPartyMusic, partyMusic);

  if (statsKaraokeWrap && statsKaraoke) {
    if (!karaoke.length) {
      statsKaraokeWrap.hidden = true;
      statsKaraoke.innerHTML = "";
    } else {
      statsKaraokeWrap.hidden = false;
      statsKaraoke.innerHTML = karaokeRowsHtml(karaoke);
    }
  }
}

let displayStatsTimer = null;
function syncDisplayStatsPolling(on) {
  if (displayStatsTimer) {
    clearInterval(displayStatsTimer);
    displayStatsTimer = null;
  }
  if (!on) return;
  displayStatsTimer = setInterval(() => {
    void loadStats();
  }, 45_000);
  displayStatsTimer.unref?.();
}

async function loadStats() {
  statsEmpty.hidden = true;
  try {
    const res = await fetch("/api/stats");
    if (!res.ok) throw new Error("Could not load stats.");
    statsData = await res.json();
    renderStats();
    paintDisplayTonightStats(
      {
        tonightGrid: document.getElementById("display-stats-grid"),
        allTimeGrid: document.getElementById("display-stats-all-grid"),
      },
      statsData
    );
  } catch {
    statsData = null;
    statsBody.hidden = true;
    statsEmpty.hidden = false;
    statsEmpty.textContent = "Could not load stats.";
    paintDisplayTonightStats(
      {
        tonightGrid: document.getElementById("display-stats-grid"),
        allTimeGrid: document.getElementById("display-stats-all-grid"),
      },
      null
    );
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
const viewSettingsDjCohosts = document.getElementById("view-settings-dj-cohosts");
const viewSettingsDjBanner = document.getElementById("view-settings-dj-banner");
const viewSettingsDjName = document.getElementById("view-settings-dj-name");
const viewSettingsDjTaglines = document.getElementById("view-settings-dj-taglines");
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
const settingsDjCohostsBackBtn = document.getElementById("settings-dj-cohosts-back");
const settingsDjBannerBackBtn = document.getElementById("settings-dj-banner-back");
const settingsDjNameBackBtn = document.getElementById("settings-dj-name-back");
const settingsDjTaglinesBackBtn = document.getElementById("settings-dj-taglines-back");
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
const viewKaraoke = document.getElementById("view-karaoke");
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
const displayQueueSection = document.getElementById("display-queue-section");
const displayQueueStatus = document.getElementById("display-queue-status");
const displayQueue = document.getElementById("display-queue");
const displayQueueEmpty = document.getElementById("display-queue-empty");
const karaokeConnectionStatus = document.getElementById(
  "karaoke-connection-status"
);
const karaokeArt = document.getElementById("karaoke-art");
const karaokeEmpty = document.getElementById("karaoke-empty");
const karaokeTitle = document.getElementById("karaoke-title");
const karaokeArtist = document.getElementById("karaoke-artist");
const karaokeProgress = document.getElementById("karaoke-progress");
const karaokeProgressFill = document.getElementById("karaoke-progress-fill");
const karaokeProgressElapsed = document.getElementById(
  "karaoke-progress-elapsed"
);
const karaokeProgressDuration = document.getElementById(
  "karaoke-progress-duration"
);
const karaokeQueueCount = document.getElementById("karaoke-queue-count");
const karaokeQueueSection = document.getElementById("karaoke-queue-section");
const karaokeQueueStatus = document.getElementById("karaoke-queue-status");
const karaokeQueue = document.getElementById("karaoke-queue");
const karaokeQueueEmpty = document.getElementById("karaoke-queue-empty");
const displayJoinQr = document.getElementById("display-join-qr");
const displayWifiQr = document.getElementById("display-wifi-qr");
const displayJoinUrl = document.getElementById("display-join-url");
const displayJoinError = document.getElementById("display-join-error");
const recapOverlay = document.getElementById("recap-overlay");
const recapBody = document.getElementById("recap-body");
const recapDismissBtn = document.getElementById("recap-dismiss");
const {
  showPartyRecap,
  hidePartyRecap,
  maybeAnnounceClosingTime,
  markClosingShown,
} = createPartyRecapUi(
  {
    overlay: recapOverlay,
    body: recapBody,
    hintEl: recapHintEl,
    titleEl: document.getElementById("recap-title"),
    dismissBtn: recapDismissBtn,
  },
  {
    showToast,
    getEndOfNightName,
    getCurrentView: () => currentView,
  }
);
const VIEWS = {
  main: viewMain,
  "settings-look": viewSettingsLook,
  "settings-queue": viewSettingsQueue,
  "settings-dj": viewSettingsDj,
  "settings-dj-cohosts": viewSettingsDjCohosts,
  "settings-dj-banner": viewSettingsDjBanner,
  "settings-dj-name": viewSettingsDjName,
  "settings-dj-taglines": viewSettingsDjTaglines,
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
  karaoke: viewKaraoke,
};
let currentView = "main";
/** Last non-Settings view — PIN Cancel returns here (fallback: main). */
let lastNonSettingsView = "main";

function syncHostChrome() {
  // Wait for pin-required status so guests don't open Controls before we know
  // a PIN is required.
  if (!isPinStatusReady()) return;
  const open = settingsGateOk();
  // Expand Controls when the host session opens; leave guest collapse alone.
  // Do not re-expand on every sync — hosts can still collapse while unlocked.
  if (open && hostChromeOpen !== true) {
    controlsPanel?.setCollapsed(false, { persist: true, fireOnExpand: true });
  }
  hostChromeOpen = open;
}

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
  syncHostChrome();
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
  const prev = lastPartySettings;
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
  sameArtistCountdownUi.paint(payload.nextSpecialSet);
  const fairnessChanged =
    payload.requestFairnessEnabled !== prev?.requestFairnessEnabled ||
    payload.setRequestFairnessEnabled !== prev?.setRequestFairnessEnabled ||
    payload.fairnessResetAt !== prev?.fairnessResetAt;
  if (fairnessChanged) refreshGuestFairness();
}

const partyDisplayIdle = createPartyDisplayIdle();
const partyDisplayClock = createPartyDisplayClock({
  el: document.getElementById("display-clock"),
});

function syncPartyDisplayIdleState() {
  partyDisplayIdle.setDisplayState({
    active: isTvStageView(currentView),
    // Phone/laptop TV preview uses kiosk padding styles but must not idle.
    kiosk: isPartyDisplayKiosk() && !isPartyDisplayPreview(),
  });
}

function syncPartyDisplayBackLabel() {
  const preview = isPartyDisplayPreview();
  const displayBack = document.getElementById("display-back");
  if (displayBack) {
    displayBack.textContent =
      currentView === "display" && preview ? "Exit TV preview" : "Back";
  }
  const karaokeBack = document.getElementById("karaoke-back");
  if (karaokeBack) {
    karaokeBack.textContent =
      currentView === "karaoke" && preview ? "Exit TV preview" : "Back";
  }
}

function refreshBoothTvFullyUrl() {
  const origin = joinUrlCache || location.origin;
  const displayInput = document.getElementById("booth-tv-fully-url");
  if (displayInput) displayInput.value = partyDisplayFullyStartUrl(origin);
  const karaokeInput = document.getElementById("booth-karaoke-fully-url");
  if (karaokeInput) karaokeInput.value = karaokeDisplayFullyStartUrl(origin);
}

function showView(name) {
  const target = VIEWS[name] ? name : "main";
  const previousView = currentView;
  if (!isHostArea(target)) lastNonSettingsView = target;
  currentView = target;
  if (target !== "main") closeSearchQuietly();
  // Suggestion Box (and any other field) can keep the Android keyboard up
  // after the main view is hidden, which squeezes Karaoke/Party Display.
  if (target !== "main") blurSoftKeyboard();
  for (const key of Object.keys(VIEWS)) VIEWS[key].hidden = key !== target;
  document.body.classList.toggle("party-display-active", target === "display");
  document.body.classList.toggle("karaoke-display-active", target === "karaoke");
  syncPartyDisplayViewport(isTvStageView(target));
  syncPartyDisplayIdleState();
  syncPartyDisplayBackLabel();
  if (target === "display") {
    hidePartyRecap();
    partyDisplayClock.start();
  } else if (target === "karaoke") {
    hidePartyRecap();
    partyDisplayClock.stop();
  } else {
    partyDisplayClock.stop();
  }
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
  if (target === "stats" || target === "display") loadStats();
  if (target === "join" || target === "display") loadJoinCode();
  if (target === "display" && displayEventName) {
    displayEventName.textContent =
      document.getElementById("event-name")?.textContent?.trim() || "PartyQueue";
  }
  syncDisplayStatsPolling(target === "display");
  lyricsUi.onViewChange({ target, previous: previousView });
  // Main search-bar fairness is view-local; refresh when Back lands here so
  // Booth toggles show without a hard reload.
  if (target === "main" && previousView !== "main") refreshGuestFairness();
  if (!hostLocked) {
    if (target === "booth") {
      updateBoothHubSummaries();
      refreshBoothTvFullyUrl();
      if (!joinUrlCache) void loadJoinCode();
    }
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

function closeSearchQuietly() {
  try {
    searchUi.close({ fromPopstate: true });
  } catch {
    /* searchUi is declared later; hash events during boot are ignored */
  }
}

function scheduleRouteFromHash() {
  if (scheduleRouteFromHash.queued) return;
  scheduleRouteFromHash.queued = true;
  const run = () => {
    scheduleRouteFromHash.queued = false;
    routeFromHash();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else queueMicrotask(run);
}

function routeFromHash() {
  if (routeFromHash.busy) return;
  routeFromHash.busy = true;
  try {
    const target = resolveViewName(location.hash, VIEWS);
    let searchOpen = false;
    try {
      searchOpen = !!searchUi?.isOpen?.();
    } catch {
      searchOpen = false;
    }
    const action = searchBackAction({
      currentView,
      nextView: target,
      searchOpen,
    });
    if (action === "close-only") {
      searchUi.close({ fromPopstate: true });
      showView("main");
      return;
    }
    if (action === "restore-main") {
      searchUi.close({ fromPopstate: true });
      history.replaceState({ pq: 1, view: "main" }, "", "#/");
      showView("main");
      return;
    }
    if (!history.state?.pq) {
      history.replaceState(
        { pq: 1, view: target },
        "",
        location.hash || "#/"
      );
    }
    showView(target);
  } finally {
    queueMicrotask(() => {
      routeFromHash.busy = false;
    });
  }
}

function navigate(name, { replace = false } = {}) {
  const target = VIEWS[name] ? name : "main";
  const hash = hashForView(target);
  applyViewHash(hash, { replace, view: target });
}

function applyViewHash(hash, { replace = false, view = null } = {}) {
  const target = view || resolveViewName(hash, VIEWS);
  const url = hash || hashForView(target);
  const state = {
    pq: 1,
    view: target,
    pqFrom: replace || currentView === target ? undefined : currentView,
  };
  if (replace || location.hash === url) {
    history.replaceState(state, "", url);
    showView(target);
    return;
  }
  history.pushState(state, "", url);
  showView(target);
}

function goBack(fallback = "main") {
  if (history.state?.pqFrom) {
    history.back();
    return;
  }
  navigate(fallback, { replace: true });
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
  goBack(back);
}

playlistsUi = createPlaylistsUi(
  {
    playlistConnect,
    playlistBox,
    playlistsList,
    playlistsEmpty,
    toggleAllBtn,
    selectedCountEl,
    randomBar,
    controlsRandom,
    randomButtons,
    connectSpotifyBtn,
  },
  {
    hostFetch,
    showToast,
    confirmModal,
    refreshSonos,
    syncToolbarMoodVisibility: () => syncToolbarMoodVisibility(),
    updateMusicMixHubSummaries: () => updateMusicMixHubSummaries(),
    syncAutoFillSelection: () => syncAutoFillSelection(),
    getGenreIds: () => currentGenreIds(),
    getMoodId: () => currentMoodId(),
    getGenreBucketCount: () => musicMix?.getGenreBucketCount() ?? 0,
  }
);

musicMix = createMusicMixUi(
  {
    genreChips: document.getElementById("genre-chips"),
    genrePresets: document.getElementById("genre-presets"),
    poolSizeHint: document.getElementById("pool-size-hint"),
    taggingPill: document.getElementById("tagging-pill"),
    genreToggleAll: document.getElementById("genre-toggle-all"),
    decadeChips: document.getElementById("decade-chips"),
    npMoodLabel: document.getElementById("np-mood-label"),
    npGenreLabel: document.getElementById("np-genre-label"),
    displayMixPill: document.getElementById("display-mix"),
    displayGenrePill: document.getElementById("display-genre"),
    autofillToggle,
    musicMixHub,
    moodNeedSpotify,
    randomBar,
  },
  {
    hostFetch,
    showToast,
    navigateMixPanel,
    getPlaylistIds: () => playlistsUi.getSelectedIds(),
    getPlaylistHubStats: () => playlistsUi.getHubStats(),
    setPlaylistIdsFromServer: (ids) => playlistsUi.setSelectedIdsFromServer(ids),
    renderPlaylistsIfLoaded: () => playlistsUi.renderIfLoaded(),
    syncDiscoverFromServer,
    syncRotationFromServer,
    syncContentTogglesFromServer,
  }
);
syncToolbarMoodVisibility();

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
settingsLookBackBtn?.addEventListener("click", () => goBack("booth"));
settingsQueueBackBtn?.addEventListener("click", () => goBack("booth"));
settingsDjBackBtn?.addEventListener("click", () => goBack("booth"));
settingsDjCohostsBackBtn?.addEventListener("click", () => goBack("settings-dj"));
settingsDjBannerBackBtn?.addEventListener("click", () => goBack("settings-dj"));
settingsDjNameBackBtn?.addEventListener("click", () => goBack("settings-dj"));
settingsDjTaglinesBackBtn?.addEventListener("click", () => goBack("settings-dj"));
settingsDjVoiceBackBtn?.addEventListener("click", () => goBack("settings-dj"));
settingsDjAdvancedBackBtn?.addEventListener("click", () => goBack("settings-dj"));
settingsDjVolumeBackBtn?.addEventListener("click", () => goBack("settings-dj"));
settingsDjShoutsBackBtn?.addEventListener("click", () => goBack("settings-dj"));
settingsDjLastcallBackBtn?.addEventListener("click", () => goBack("settings-dj"));
settingsUsersBackBtn?.addEventListener("click", () => goBack("booth"));
settingsUserEditBackBtn?.addEventListener("click", () => goBack("settings-users"));
settingsConnectionsBackBtn?.addEventListener("click", () => goBack("booth"));
settingsResetBackBtn?.addEventListener("click", () => goBack("booth"));
statsBackBtn?.addEventListener("click", () => goBack("main"));
playlistsBackBtn.addEventListener("click", () => navigateMixPanelBack());
memoryBackBtn.addEventListener("click", () => goBack("booth"));
suggestionsBackBtn?.addEventListener("click", () => goBack("booth"));
sonosBackBtn?.addEventListener("click", () => goBack("main"));
moodBackBtn?.addEventListener("click", () => goBack("main"));
moodPresetsBackBtn?.addEventListener("click", () => navigateMixPanelBack());
genresBackBtn?.addEventListener("click", () => navigateMixPanelBack());
boothBackBtn?.addEventListener("click", () => goBack("main"));
joinBackBtn?.addEventListener("click", () => goBack("main"));
document.getElementById("display-back")?.addEventListener("click", (event) => {
  event.preventDefault();
  goBack("main");
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && currentView === "display") {
    event.preventDefault();
    goBack("main");
  }
});
window.addEventListener("hashchange", scheduleRouteFromHash);
window.addEventListener("popstate", scheduleRouteFromHash);
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
  for (const qrEl of [joinQrEl, displayJoinQr, displayWifiQr]) {
    if (!qrEl) continue;
    qrEl.innerHTML = "";
    qrEl.classList.remove("is-ready");
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
    refreshBoothTvFullyUrl();
    // Prefer PNG <img> — Fully/Android WebView often blanks stroke-based QR SVG.
    const paintQr = (qrEl, { png, svg, alt }) => {
      if (!qrEl) return;
      if (png) {
        const img = document.createElement("img");
        img.src = png;
        img.alt = alt;
        img.width = 280;
        img.height = 280;
        img.decoding = "async";
        qrEl.replaceChildren(img);
        qrEl.classList.add("is-ready");
        return;
      }
      if (svg) {
        qrEl.innerHTML = svg;
        qrEl.classList.add("is-ready");
      }
    };
    paintQr(joinQrEl, {
      png: data.qrPng,
      svg: data.qrSvg,
      alt: "Join PartyQueue QR code",
    });
    paintQr(displayJoinQr, {
      png: data.qrPng,
      svg: data.qrSvg,
      alt: "Join PartyQueue QR code",
    });
    paintQr(displayWifiQr, {
      png: data.wifiQrPng,
      svg: data.wifiQrSvg,
      alt: "Guest Wi-Fi QR code",
    });
  } catch (err) {
    joinUrlCache = "";
    if (joinUrlEl) joinUrlEl.textContent = "";
    refreshBoothTvFullyUrl();
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

const boothTvPreviewBtn = document.getElementById("booth-tv-preview");
const boothTvKioskBtn = document.getElementById("booth-tv-kiosk");
const boothTvFullyCopyBtn = document.getElementById("booth-tv-fully-copy");
const boothKaraokePreviewBtn = document.getElementById("booth-karaoke-preview");
const boothKaraokeKioskBtn = document.getElementById("booth-karaoke-kiosk");
const boothKaraokeFullyCopyBtn = document.getElementById(
  "booth-karaoke-fully-copy"
);

boothTvPreviewBtn?.addEventListener("click", () => {
  applyViewHash("#/display?preview=1");
});

boothTvKioskBtn?.addEventListener("click", () => {
  applyViewHash("#/display?kiosk=1");
});

boothTvFullyCopyBtn?.addEventListener("click", async () => {
  const url = partyDisplayFullyStartUrl(joinUrlCache || location.origin);
  try {
    await navigator.clipboard.writeText(url);
    showToast("Fully URL copied");
  } catch {
    showToast(url, false, 6000);
  }
});

boothKaraokePreviewBtn?.addEventListener("click", () => {
  applyViewHash("#/karaoke?preview=1");
});

boothKaraokeKioskBtn?.addEventListener("click", () => {
  applyViewHash("#/karaoke?kiosk=1");
});

boothKaraokeFullyCopyBtn?.addEventListener("click", async () => {
  const url = karaokeDisplayFullyStartUrl(joinUrlCache || location.origin);
  try {
    await navigator.clipboard.writeText(url);
    showToast("Karaoke Fully URL copied");
  } catch {
    showToast(url, false, 6000);
  }
});

refreshBoothTvFullyUrl();

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
    onFairnessRefresh: () => refreshGuestFairness(),
  }
);

refreshGuestFairness();


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
    getReactionPlayId: () =>
      lastNowPlaying?.reactionPlayId || lastNowPlaying?.reactions?.playId || "",
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
    karaokeQueue,
    karaokeQueueCount,
    karaokeQueueEmpty,
  },
  {
    hostFetch,
    showToast,
    getShowQueueGenre: () => showQueueGenre,
    getActiveEraMoodId: () => activeEraMoodId(),
    getLastQueueTracks: () => lastQueueTracks,
    applyQueueTracks: (tracks) => applyQueueTracks(tracks),
    loadQueue: (force) => loadQueue(force),
    getGuestUser: () => guestIdentityPayload()?.requestedByUser || "",
    onDedicate: (track) => searchUi.openDedicationModal(track),
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
    karaokeLyrics,
    npProgress,
    npProgressFill,
    npProgressElapsed,
    npProgressDuration,
    displayProgress,
    displayProgressFill,
    displayProgressElapsed,
    displayProgressDuration,
    karaokeProgress,
    karaokeProgressFill,
    karaokeProgressElapsed,
    karaokeProgressDuration,
    npCard,
  },
  {
    getLastNowPlaying: () => lastNowPlaying,
    getCurrentView: () => currentView,
    isModalOpen,
    bindArtwork: bindNowPlayingArtwork,
  }
);

function renderKaraokeNowPlaying(np, hasTrack) {
  if (!karaokeTitle || !karaokeEmpty || !karaokeArt) return;
  if (!hasTrack) {
    bindNowPlayingArtwork(karaokeArt, null);
    karaokeEmpty.hidden = false;
    karaokeEmpty.textContent = EMPTY_MESSAGE;
    karaokeTitle.textContent = "";
    if (karaokeArtist) karaokeArtist.textContent = "";
    return;
  }
  karaokeEmpty.hidden = true;
  karaokeTitle.textContent = np.title || "";
  if (karaokeArtist) karaokeArtist.textContent = np.artist || "";
  bindNowPlayingArtwork(karaokeArt, np);
}

function renderPartyDisplayNowPlaying(np, hasTrack) {
  renderKaraokeNowPlaying(np, hasTrack);
  if (!hasTrack && isTvStageView(currentView)) lyricsUi.clearDisplay();
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
      const originText = displayOriginLabel(np, activeEraMoodId());
      displayOriginPill.hidden = !originText;
      displayOriginPill.textContent = originText;
      paintOriginToneClass(displayOriginPill, originText ? displayOriginTone(np) : null);
    } else {
      paintOriginToneClass(displayOriginPill, null);
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
  const fairnessTrackKey = np?.djVoice
    ? lastFairnessTrackKey
    : np?.uri || `${np?.title || ""}\0${np?.artist || ""}`;
  if (fairnessTrackKey && fairnessTrackKey !== lastFairnessTrackKey) {
    lastFairnessTrackKey = fairnessTrackKey;
    scheduleFairnessRefresh();
  }

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
  reactionsUi.noteTrackChange(
    nextNpId,
    np?.reactionPlayId || np?.reactions?.playId || ""
  );
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
  partyDisplayIdle.syncPlayback({
    isPlaying: !!np?.isPlaying,
    hasTrack,
  });
  prefetchUpcomingAlbumArt(lastQueueTracks);
}

function applyQueueTracks(tracks) {
  lastQueueTracks = tracks;
  searchUi.setQueuedTracks(tracks);
  queueUi.render(tracks);
  queueUi.renderPartyDisplay(tracks);
  prefetchUpcomingAlbumArt(tracks);
  scheduleFairnessRefresh();
}


liveStreams = createLiveStreams(
  {
    npCard,
    npConnectionStatus,
    displayConnectionStatus,
    karaokeConnectionStatus,
    queueSection,
    queueConnectionStatus,
    displayQueueSection,
    displayQueueStatus,
    karaokeQueueSection,
    karaokeQueueStatus,
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
// Streams cover Now Playing, Up Next and the party toggles. Anything a view
// loads on entry (stats, Booth counts, Memory) has to be pulled again here, or
// a phone that was away for an hour comes back to whatever it painted then.
function refreshViewOnResume() {
  if (currentView === "display") {
    syncDisplayStatsPolling(true);
    void loadJoinCode();
  }
  if (currentView === "display" || currentView === "stats") void loadStats();
  if (currentView === "booth" && settingsGateOk()) void updateBoothHubSummaries();
  if (currentView === "memory" && settingsGateOk()) loadMemory();
  if (currentView === "suggestions" && settingsGateOk()) loadSuggestions();
  if (currentView === "sonos") loadGroups(true);
  if (isMusicMixArea(currentView)) void loadAutoFill();
}

liveStreams.bindResume({
  onResume: () => {
    refreshGuestFairness();
    refreshViewOnResume();
  },
  // A backgrounded Party Display phone should stop its 45s stats poll too.
  onSleep: () => syncDisplayStatsPolling(false),
});

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
    showToast(
      d.cleared || !d.shuffle
        ? "Shuffle off — PartyQueue needs queue order"
        : "Shuffle on"
    )
  );
});

prevBtn.addEventListener("click", () => {
  // No reliable previous row in the upcoming queue list — keep last confirmed
  // paint until Sonos confirms (never blank art).
  postControl(prevBtn, "/api/previous");
});

nextBtn.addEventListener("click", () => {
  const onAnnounce = !!(
    lastConfirmedNp?.djVoice ||
    lastTransportNp?.djVoice ||
    optimisticNp?.djVoice
  );
  const nextHead = Array.isArray(lastQueueTracks) ? lastQueueTracks[0] : null;
  // Next visible row is a DJ clip → server seeks near end of this song.
  // Don't paint the post-announce music yet.
  const nextIsAnnounce = !!nextHead?.djVoice;
  if (onAnnounce || !nextIsAnnounce) {
    beginOptimisticSkipFromQueue();
  }
  postControl(nextBtn, "/api/next", (d) => {
    if (d.abortedAnnounce) showToast("Skipped DJ announce");
    else if (d.seekNearEnd) showToast("Cueing DJ announce…");
    else if (d.skipped) showToast("Skipped — remembered for the DJ");
  });
});

muteBtn.addEventListener("click", () => {
  postControl(muteBtn, "/api/mute", (d) =>
    showToast(d.muted ? "Muted" : "Unmuted")
  );
});

const npVolumeLabel = document.getElementById("np-volume-label");
const desktopVolumeMq =
  typeof window.matchMedia === "function"
    ? window.matchMedia(DESKTOP_BANNER_MQ)
    : null;
let volumeWatchTimer = null;
let volumeWatchRamping = false;
let volumeWatchInFlight = false;

function noteDisplayedVolume(volume, ramping = volumeWatchRamping) {
  paintVolumeLabel(npVolumeLabel, volume);
  volumeWatchRamping = !!ramping;
}

async function pollNpVolume() {
  if (volumeWatchInFlight) return;
  if (document.visibilityState === "hidden") return;
  if (desktopVolumeMq && !desktopVolumeMq.matches) return;
  volumeWatchInFlight = true;
  try {
    const res = await fetch("/api/volume");
    if (!res.ok) return;
    const data = await res.json();
    if (data?.ok && data.volume != null) {
      noteDisplayedVolume(data.volume, !!data.ramping);
    }
  } catch {
    /* keep the last painted value */
  } finally {
    volumeWatchInFlight = false;
  }
}

function scheduleNpVolumeWatch() {
  if (volumeWatchTimer) clearTimeout(volumeWatchTimer);
  volumeWatchTimer = setTimeout(() => {
    void pollNpVolume().finally(() => scheduleNpVolumeWatch());
  }, volumePollMs(volumeWatchRamping));
}

function startNpVolumeWatch() {
  void pollNpVolume().finally(() => scheduleNpVolumeWatch());
}

desktopVolumeMq?.addEventListener?.("change", (event) => {
  if (event.matches) startNpVolumeWatch();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && desktopVolumeMq?.matches) {
    void pollNpVolume();
  }
});
if (!desktopVolumeMq || desktopVolumeMq.matches) startNpVolumeWatch();

volDownBtn.addEventListener("click", () => {
  postControl(volDownBtn, "/api/volume/down", (d) => {
    noteDisplayedVolume(d.volume, false);
    showToast(`Volume: ${d.volume}`);
  });
});

volUpBtn.addEventListener("click", () => {
  postControl(volUpBtn, "/api/volume/up", (d) => {
    noteDisplayedVolume(d.volume, false);
    showToast(`Volume: ${d.volume}`);
  });
});

volDown10Btn.addEventListener("click", () => {
  postControl(volDown10Btn, "/api/volume/down?step=10", (d) => {
    noteDisplayedVolume(d.volume, false);
    showToast(`Volume: ${d.volume}`);
  });
});

volUp10Btn.addEventListener("click", () => {
  postControl(volUp10Btn, "/api/volume/up?step=10", (d) => {
    noteDisplayedVolume(d.volume, false);
    showToast(`Volume: ${d.volume}`);
  });
});

groupAllBtn.addEventListener("click", () => {
  postControl(groupAllBtn, "/api/group-all", (d) => {
    reloadGroupsAfterTopology();
    if (d.volume != null) noteDisplayedVolume(d.volume, false);
    showToast(`Grouped ${d.players} speakers · Volume ${d.volume}`);
  });
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

// Pause streams when the tab is hidden; force-reconnect on mobile resume
// (pageshow / focus / visibility) so a frozen EventSource cannot stay stale.

// Initial route: deferred to here (see the hashchange listener) so deep links
// land on their view only after every declaration above has run.
routeFromHash();

appReady = true;
syncPolling();

// Version is usually painted with branding on first load. Refresh from health
// only when missing or different (avoids title+pill layout flash on restart).
async function loadVersion() {
  const el = document.getElementById("app-version");
  const displayEl = document.getElementById("display-version");
  if (!el && !displayEl) return;
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (!data?.version) return;
    const next = `v${data.version}`;
    if (el && el.textContent !== next) el.textContent = next;
    if (displayEl) displayEl.textContent = next;
    // Visibility follows Booth "Show version" (headerVersion.hidden / input).
    const show =
      showVersionInput != null
        ? !!showVersionInput.checked
        : headerVersion
          ? !headerVersion.hidden
          : true;
    if (el) el.hidden = !show;
    if (displayEl) displayEl.hidden = !show;
    persistBrandingCache({ version: data.version });
    document.getElementById("header-title")?.setAttribute("data-ready", "1");
  } catch {
    /* leave whatever the boot script painted */
  }
}

