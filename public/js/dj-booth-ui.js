/** DJ Booth voice / shouts / last-call form UI + hub summary paint. */

import { escapeHtml } from "./format.js";
import {
  formatDjIconLabel,
  formatDjVoiceHubLine,
  formatDjAdvancedHubLine,
  formatDjVolumeHubLine,
  formatDjShoutsHubLine,
  formatDjTaglinesHubLine,
  formatDjRosterHubLine,
  formatDjLastCallHubLine,
  formatEndOfNightLabel,
} from "./dj-hub-summaries.js";
import {
  paintDjTtsProviderRows,
  paintDjShoutModeRows,
} from "./dj-form-ui.js";

export const DEFAULT_END_OF_NIGHT = {
  uri: null,
  name: "Closing Time",
  artist: "Semisonic",
};

/**
 * @param {object} els DJ form + last-call DOM refs
 * @param {{
 *   hostFetch: typeof fetch,
 *   fetch?: typeof fetch,
 *   showToast: (msg: string, isError?: boolean, durationMs?: number) => void,
 *   saveSettings: (values: object, opts?: object) => Promise<boolean>|boolean,
 *   selectDjIcon: (name: string|null) => Promise<void>,
 *   getSettingsDefaults: () => object,
 *   refreshBoothMediaUrl?: () => void|Promise<void>,
 * }} deps
 */
export function createDjBoothUi(els, deps) {
  const {
    djVoiceToggle,
    djNameInput,
    djTaglinesInput,
    djTaglinesSaveBtn,
    djTaglinesResetBtn,
    djIntroPercentInput,
    djMaxWordsInput,
    djVolumeLowInput,
    djVolumeMidInput,
    djVolumeHighInput,
    djSilenceInput,
    djTtsProviderInput,
    djTtsVoiceInput,
    djTtsVoiceElevenlabsInput,
    djTtsVoiceOpenaiRow,
    djTtsVoiceElevenlabsRow,
    djTtsSpeedInput,
    djIntensityInput,
    djCatchphraseInput,
    djBanListInput,
    djPersonaNotesInput,
    djAlwaysInstructionsInput,
    djNeverInstructionsInput,
    djPronunciationsInput,
    djAdvancedSaveBtn,
    djAdvancedResetBtn,
    djAdvancedPreviewRefreshBtn,
    djEffectivePromptInput,
    djShoutEnabledInput,
    djShoutModeInput,
    djShoutPercentInput,
    djShoutEveryInput,
    djPartyRecapEnabledInput,
    endOfNightLabelEl,
    endOfNightSearchInput,
    endOfNightResultsEl,
    endOfNightResetBtn,
    djShoutPercentRow,
    djShoutEveryRow,
    djVoiceTestBtn,
    djVoiceTestElevenlabsBtn,
    djVoicePreviewPlayer,
    djVoiceSaveBtns,
    djVoiceResetBtns,
    djRosterModeInput,
    djMixPercentInput,
    djBanterPercentInput,
    djMixRow,
    djBanterRow,
    djRosterSaveBtn,
    djRosterResetBtn,
  } = els || {};

  const hostFetch = deps.hostFetch;
  const fetchFn = deps.fetch || fetch;
  const showToast = deps.showToast;
  const saveSettings = deps.saveSettings;
  const selectDjIcon = deps.selectDjIcon;
  const getSettingsDefaults = deps.getSettingsDefaults || (() => ({}));
  const refreshBoothMediaUrl = deps.refreshBoothMediaUrl || (() => {});
  const loadDjIcons = deps.loadDjIcons || (() => {});

  const PERSONA_HR = "holy-roller";
  const PERSONA_SS = "sister-static";
  const PERSONA_KEYS = [
    "djName",
    "djTaglines",
    "djTtsProvider",
    "djTtsVoiceOpenAi",
    "djTtsVoiceElevenlabs",
    "djTtsVoice",
    "djTtsSpeed",
    "djCharacterIntensity",
    "djCatchphrase",
    "djBanList",
    "djPersonaNotes",
    "djAlwaysInstructions",
    "djNeverInstructions",
    "djPronunciations",
  ];

  /** @type {{ uri: string|null, name: string, artist: string }} */
  let endOfNightTrack = { ...DEFAULT_END_OF_NIGHT };
  let endOfNightSearchTimer = 0;
  /** @type {object} */
  let lastDjSettings = {};
  let editingPersona = PERSONA_HR;

  function setActiveDjIconName(name) {
    if (editingPersona === PERSONA_SS) {
      lastDjSettings.djSisterStatic = {
        ...(lastDjSettings.djSisterStatic || {}),
        djIcon: name || null,
      };
      return;
    }
    lastDjSettings.djIcon = name || null;
  }

  function getEditingPersona() {
    return editingPersona;
  }

  function sisterStaticFrom(s) {
    return (s && s.djSisterStatic) || {};
  }

  function identitySource() {
    if (editingPersona === PERSONA_SS) return sisterStaticFrom(lastDjSettings);
    return lastDjSettings;
  }

  function payloadForSave(partial) {
    if (editingPersona !== PERSONA_SS) return partial;
    const nested = {};
    const rest = { ...partial };
    for (const key of PERSONA_KEYS) {
      if (Object.prototype.hasOwnProperty.call(partial, key)) {
        nested[key] = partial[key];
        delete rest[key];
      }
    }
    if (Object.keys(nested).length) rest.djSisterStatic = nested;
    return rest;
  }

  function syncDjRosterUi() {
    const mix = djRosterModeInput?.value === "mix";
    if (djMixRow) djMixRow.hidden = !mix;
    if (djBanterRow) djBanterRow.hidden = !mix;
  }

  function paintPersonaSwitcher() {
    document.querySelectorAll(".dj-persona-btn").forEach((btn) => {
      const id = btn.getAttribute("data-dj-persona");
      const on = id === editingPersona;
      btn.classList.toggle("accent", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function paintIdentityFields(src) {
    if (!src || typeof src !== "object") return;
    if (src.djName != null && djNameInput) djNameInput.value = src.djName;
    if (src.djTaglines != null) paintTaglines(src.djTaglines);
    if (src.djTtsProvider != null && djTtsProviderInput) {
      djTtsProviderInput.value = String(src.djTtsProvider);
    }
    if (src.djTtsVoiceOpenAi != null && djTtsVoiceInput) {
      djTtsVoiceInput.value = String(src.djTtsVoiceOpenAi);
    } else if (
      src.djTtsVoice != null &&
      djTtsVoiceInput &&
      src.djTtsProvider === "openai_ha"
    ) {
      djTtsVoiceInput.value = String(src.djTtsVoice);
    }
    if (src.djTtsVoiceElevenlabs != null && djTtsVoiceElevenlabsInput) {
      djTtsVoiceElevenlabsInput.value = String(src.djTtsVoiceElevenlabs);
    } else if (
      src.djTtsVoice != null &&
      djTtsVoiceElevenlabsInput &&
      src.djTtsProvider === "elevenlabs_ha"
    ) {
      djTtsVoiceElevenlabsInput.value = String(src.djTtsVoice);
    }
    syncDjTtsProviderUi();
    if (src.djTtsSpeed != null && djTtsSpeedInput) {
      djTtsSpeedInput.value = String(src.djTtsSpeed);
    }
    if (src.djCharacterIntensity != null && djIntensityInput) {
      djIntensityInput.value = String(src.djCharacterIntensity);
    }
    if (src.djCatchphrase != null && djCatchphraseInput) {
      djCatchphraseInput.value = String(src.djCatchphrase);
    }
    if (src.djBanList != null && djBanListInput) {
      djBanListInput.value = String(src.djBanList);
    }
    if (src.djPersonaNotes != null && djPersonaNotesInput) {
      djPersonaNotesInput.value = String(src.djPersonaNotes);
    }
    if (src.djAlwaysInstructions != null && djAlwaysInstructionsInput) {
      djAlwaysInstructionsInput.value = String(src.djAlwaysInstructions);
    }
    if (src.djNeverInstructions != null && djNeverInstructionsInput) {
      djNeverInstructionsInput.value = String(src.djNeverInstructions);
    }
    if (src.djPronunciations != null && djPronunciationsInput) {
      djPronunciationsInput.value = String(src.djPronunciations);
    }
  }

  function setEditingPersona(id) {
    editingPersona = id === PERSONA_SS ? PERSONA_SS : PERSONA_HR;
    paintPersonaSwitcher();
    paintIdentityFields(identitySource());
    updateDjHubSummaries();
    void loadDjIcons();
  }

  function getEndOfNightName() {
    return endOfNightTrack.name;
  }

  function taglinesFromInput() {
    return String(djTaglinesInput?.value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function paintTaglines(lines) {
    if (!djTaglinesInput) return;
    const pack = Array.isArray(lines)
      ? lines
      : String(lines || "").split(/\r?\n/);
    djTaglinesInput.value = pack
      .map((line) => String(line || "").trim())
      .filter(Boolean)
      .join("\n");
  }

  function syncDjTtsProviderUi() {
    paintDjTtsProviderRows(
      {
        openaiRow: djTtsVoiceOpenaiRow,
        elevenlabsRow: djTtsVoiceElevenlabsRow,
      },
      djTtsProviderInput?.value
    );
  }

  function syncDjShoutModeUi() {
    paintDjShoutModeRows(
      {
        percentRow: djShoutPercentRow,
        everyRow: djShoutEveryRow,
      },
      djShoutModeInput?.value
    );
  }

  function updateDjHubSummaries() {
    void refreshBoothMediaUrl();
    const bannerEl = document.getElementById("dj-stat-banner");
    const nameEl = document.getElementById("dj-stat-name");
    const taglinesEl = document.getElementById("dj-stat-taglines");
    const voiceEl = document.getElementById("dj-stat-voice");
    const advancedEl = document.getElementById("dj-stat-advanced");
    const volumeEl = document.getElementById("dj-stat-volume");
    const shoutsEl = document.getElementById("dj-stat-shouts");
    const cohostsEl = document.getElementById("dj-stat-cohosts");

    if (bannerEl) bannerEl.textContent = formatDjIconLabel(lastDjSettings.djIcon);

    if (nameEl) {
      const name = String(lastDjSettings.djName || "").trim() || "Party DJ";
      nameEl.textContent = name;
    }

    if (taglinesEl) {
      const raw = lastDjSettings.djTaglines;
      if (Array.isArray(raw) ? raw.length : String(raw || "").trim()) {
        taglinesEl.textContent = formatDjTaglinesHubLine(raw);
      } else {
        const fallback = getSettingsDefaults()?.djTaglines;
        taglinesEl.textContent =
          Array.isArray(fallback) && fallback.length
            ? formatDjTaglinesHubLine(fallback)
            : "—";
      }
    }

    if (voiceEl) {
      voiceEl.textContent = formatDjVoiceHubLine({
        intensity: lastDjSettings.djCharacterIntensity,
        provider: lastDjSettings.djTtsProvider,
        speed: lastDjSettings.djTtsSpeed ?? 1,
      });
    }

    if (advancedEl) {
      advancedEl.textContent = formatDjAdvancedHubLine({
        personaNotes: lastDjSettings.djPersonaNotes,
        alwaysInstructions: lastDjSettings.djAlwaysInstructions,
        neverInstructions: lastDjSettings.djNeverInstructions,
        pronunciations: lastDjSettings.djPronunciations,
      });
    }

    if (volumeEl) {
      volumeEl.textContent = formatDjVolumeHubLine({
        low: djVolumeLowInput?.value ?? "—",
        mid: djVolumeMidInput?.value ?? "—",
        high: djVolumeHighInput?.value ?? "—",
        silence: djSilenceInput?.value ?? "—",
      });
    }

    if (shoutsEl) {
      shoutsEl.textContent = formatDjShoutsHubLine({
        mode: djShoutModeInput?.value,
        everyN: djShoutEveryInput?.value || "5",
        percent: djShoutPercentInput?.value ?? "25",
      });
    }

    if (cohostsEl) {
      cohostsEl.textContent = formatDjRosterHubLine({
        mode: djRosterModeInput?.value || lastDjSettings.djRosterMode,
        mixHr: djMixPercentInput?.value ?? lastDjSettings.djMixHolyRollerPercent,
        banter: djBanterPercentInput?.value ?? lastDjSettings.djBanterPercent,
      });
    }

    const lastCallEl = document.getElementById("dj-stat-lastcall");
    if (lastCallEl) {
      lastCallEl.textContent = formatDjLastCallHubLine(endOfNightTrack.name);
    }
  }

  function paintEndOfNightLabel() {
    if (endOfNightLabelEl) {
      endOfNightLabelEl.textContent = formatEndOfNightLabel(endOfNightTrack);
    }
    updateDjHubSummaries();
  }

  function applyFromSettings(s) {
    if (!s || typeof s !== "object") return;
    lastDjSettings = { ...lastDjSettings, ...s };
    if (s.djSisterStatic && typeof s.djSisterStatic === "object") {
      lastDjSettings.djSisterStatic = {
        ...(lastDjSettings.djSisterStatic || {}),
        ...s.djSisterStatic,
      };
    }
    if (s.djVoiceEnabled != null && djVoiceToggle) {
      djVoiceToggle.checked = !!s.djVoiceEnabled;
    }
    paintIdentityFields(identitySource());
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
    if (s.djRosterMode != null && djRosterModeInput) {
      djRosterModeInput.value = String(s.djRosterMode);
    }
    if (s.djMixHolyRollerPercent != null && djMixPercentInput) {
      djMixPercentInput.value = s.djMixHolyRollerPercent;
    }
    if (s.djBanterPercent != null && djBanterPercentInput) {
      djBanterPercentInput.value = s.djBanterPercent;
    }
    syncDjRosterUi();
    if (
      s.endOfNightTrackUri !== undefined ||
      s.endOfNightTrackName !== undefined ||
      s.endOfNightTrackArtist !== undefined
    ) {
      endOfNightTrack = {
        uri: s.endOfNightTrackUri || null,
        name: s.endOfNightTrackName || "Closing Time",
        artist:
          s.endOfNightTrackArtist || (s.endOfNightTrackUri ? "" : "Semisonic"),
      };
      if (!endOfNightTrack.uri) {
        endOfNightTrack = { ...DEFAULT_END_OF_NIGHT };
      }
      paintEndOfNightLabel();
    }
    if (Object.prototype.hasOwnProperty.call(s, "djIcon")) {
      lastDjSettings.djIcon = s.djIcon || null;
    }
    paintPersonaSwitcher();
    updateDjHubSummaries();
  }

  function currentDjVoicePayload() {
    const provider = djTtsProviderInput?.value || "elevenlabs_ha";
    return {
      djName: djNameInput?.value ?? "",
      djTaglines: taglinesFromInput(),
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
          showToast(
            "Sample ready — press play on the player below.",
            false,
            5000
          );
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

  async function loadDjEffectivePrompt() {
    if (!djEffectivePromptInput) return;
    const btn = djAdvancedPreviewRefreshBtn;
    if (btn) btn.disabled = true;
    djEffectivePromptInput.value = "Loading effective prompt…";
    try {
      const res = await hostFetch(
        `/api/dj-voice/prompt-preview?persona=${encodeURIComponent(editingPersona)}`,
        { cache: "no-store" }
      );
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

  async function resetDjVoiceDefaults() {
    const d = getSettingsDefaults() || {};
    const values = {
      djName: d.djName ?? "Party DJ",
      djTaglines: Array.isArray(d.djTaglines) ? d.djTaglines : [],
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
    };
    if (editingPersona === PERSONA_SS) {
      const ss = d.djSisterStatic || {};
      const ssValues = {
        djName: ss.djName ?? "Sister Static",
        djTaglines: Array.isArray(ss.djTaglines) ? ss.djTaglines : [],
        djTtsProvider: ss.djTtsProvider ?? "openai_ha",
        djTtsVoiceOpenAi: ss.djTtsVoiceOpenAi ?? "nova",
        djTtsVoiceElevenlabs: ss.djTtsVoiceElevenlabs ?? "",
        djTtsSpeed: ss.djTtsSpeed ?? 1,
        djCharacterIntensity: ss.djCharacterIntensity ?? "extra",
        djCatchphrase: ss.djCatchphrase ?? "",
        djBanList: ss.djBanList ?? "",
        djPersonaNotes: ss.djPersonaNotes ?? "",
        djAlwaysInstructions: ss.djAlwaysInstructions ?? "",
        djNeverInstructions: ss.djNeverInstructions ?? "",
        djPronunciations: ss.djPronunciations ?? "",
      };
      lastDjSettings.djSisterStatic = {
        ...(lastDjSettings.djSisterStatic || {}),
        ...ssValues,
        djIcon: null,
      };
      paintIdentityFields(ssValues);
      try {
        await selectDjIcon(null);
      } catch {
        /* icon select is best-effort; text defaults still save */
      }
      saveSettings(payloadForSave({ ...ssValues, djIcon: null }), {
        toastMessage: "Set to Default",
      });
      updateDjHubSummaries();
      return;
    }
    applyFromSettings(values);
    endOfNightTrack = { ...DEFAULT_END_OF_NIGHT };
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
        ...values,
        djIcon: null,
      },
      { toastMessage: "Set to Default" }
    );
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
      const res = await fetchFn(`/api/search?q=${encodeURIComponent(query)}`);
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
        btn.querySelector(".end-of-night-result-title").textContent =
          t.name || "Track";
        btn.querySelector(".end-of-night-result-artist").textContent =
          t.artist || "";
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

  djVoiceToggle?.addEventListener("change", () => {
    saveSettings({ djVoiceEnabled: djVoiceToggle.checked });
  });

  djTtsProviderInput?.addEventListener("change", syncDjTtsProviderUi);

  (djVoiceSaveBtns || []).forEach((btn) => {
    btn.addEventListener("click", () => {
      saveSettings(payloadForSave(currentDjVoicePayload()), {
        toastMessage: "Saved",
      });
    });
  });

  djAdvancedSaveBtn?.addEventListener("click", async () => {
    djAdvancedSaveBtn.disabled = true;
    try {
      const saved = await saveSettings(payloadForSave(currentDjVoicePayload()), {
        toastMessage: "Advanced DJ saved",
      });
      if (saved) await loadDjEffectivePrompt();
    } finally {
      djAdvancedSaveBtn.disabled = false;
    }
  });

  djAdvancedPreviewRefreshBtn?.addEventListener("click", () => {
    void loadDjEffectivePrompt();
  });

  djAdvancedResetBtn?.addEventListener("click", async () => {
    const d = getSettingsDefaults() || {};
    const values = {
      djPersonaNotes: d.djPersonaNotes ?? "",
      djAlwaysInstructions: d.djAlwaysInstructions ?? "",
      djNeverInstructions: d.djNeverInstructions ?? "",
      djPronunciations: d.djPronunciations ?? "",
    };
    paintIdentityFields({ ...identitySource(), ...values });
    if (editingPersona === PERSONA_SS) {
      lastDjSettings.djSisterStatic = {
        ...(lastDjSettings.djSisterStatic || {}),
        ...values,
      };
    } else {
      lastDjSettings = { ...lastDjSettings, ...values };
    }
    const saved = await saveSettings(payloadForSave(values), {
      toastMessage: "Advanced DJ set to defaults",
    });
    if (saved) await loadDjEffectivePrompt();
  });

  djVoiceTestBtn?.addEventListener("click", () =>
    runDjVoicePreview(djVoiceTestBtn)
  );
  djVoiceTestElevenlabsBtn?.addEventListener("click", () =>
    runDjVoicePreview(djVoiceTestElevenlabsBtn)
  );

  (djVoiceResetBtns || []).forEach((btn) => {
    btn.addEventListener("click", () => {
      void resetDjVoiceDefaults();
    });
  });

  djTaglinesSaveBtn?.addEventListener("click", () => {
    saveSettings(payloadForSave({ djTaglines: taglinesFromInput() }), {
      toastMessage: "Saved",
    });
  });

  djTaglinesResetBtn?.addEventListener("click", () => {
    const d = getSettingsDefaults() || {};
    const pack =
      editingPersona === PERSONA_SS
        ? d.djSisterStatic?.djTaglines
        : d.djTaglines;
    const lines = Array.isArray(pack) ? pack : [];
    paintTaglines(lines);
    saveSettings(payloadForSave({ djTaglines: lines }), {
      toastMessage: "Set to Default",
    });
    updateDjHubSummaries();
  });

  djTaglinesInput?.addEventListener("input", updateDjHubSummaries);

  function currentRosterPayload() {
    return {
      djRosterMode: djRosterModeInput?.value || PERSONA_HR,
      djMixHolyRollerPercent: Number(djMixPercentInput?.value),
      djBanterPercent: Number(djBanterPercentInput?.value),
    };
  }

  djRosterModeInput?.addEventListener("change", () => {
    syncDjRosterUi();
    updateDjHubSummaries();
  });
  djMixPercentInput?.addEventListener("input", updateDjHubSummaries);
  djBanterPercentInput?.addEventListener("input", updateDjHubSummaries);

  djRosterSaveBtn?.addEventListener("click", () => {
    saveSettings(currentRosterPayload(), { toastMessage: "Saved" });
  });
  djRosterResetBtn?.addEventListener("click", () => {
    const d = getSettingsDefaults() || {};
    const values = {
      djRosterMode: d.djRosterMode ?? PERSONA_HR,
      djMixHolyRollerPercent: d.djMixHolyRollerPercent ?? 70,
      djBanterPercent: d.djBanterPercent ?? 15,
    };
    if (djRosterModeInput) djRosterModeInput.value = values.djRosterMode;
    if (djMixPercentInput) djMixPercentInput.value = values.djMixHolyRollerPercent;
    if (djBanterPercentInput) djBanterPercentInput.value = values.djBanterPercent;
    lastDjSettings = { ...lastDjSettings, ...values };
    syncDjRosterUi();
    saveSettings(values, { toastMessage: "Set to Default" });
    updateDjHubSummaries();
  });

  document.querySelectorAll(".dj-persona-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setEditingPersona(btn.getAttribute("data-dj-persona"));
    });
  });

  djShoutModeInput?.addEventListener("change", syncDjShoutModeUi);
  djShoutEnabledInput?.addEventListener("change", () => {
    saveSettings({ djShoutEnabled: !!djShoutEnabledInput.checked });
  });
  djPartyRecapEnabledInput?.addEventListener("change", () => {
    saveSettings({
      djPartyRecapEnabled: !!djPartyRecapEnabledInput.checked,
    });
  });

  endOfNightSearchInput?.addEventListener("input", () => {
    clearTimeout(endOfNightSearchTimer);
    endOfNightSearchTimer = setTimeout(() => {
      void searchEndOfNightTracks(endOfNightSearchInput.value);
    }, 280);
  });

  endOfNightResetBtn?.addEventListener("click", async () => {
    try {
      await saveSettings(
        {
          endOfNightTrackUri: null,
          endOfNightTrackName: null,
          endOfNightTrackArtist: null,
        },
        { toastMessage: "Reset to Closing Time" }
      );
      endOfNightTrack = { ...DEFAULT_END_OF_NIGHT };
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

  syncDjTtsProviderUi();
  syncDjShoutModeUi();
  syncDjRosterUi();
  paintPersonaSwitcher();

  return {
    applyFromSettings,
    updateDjHubSummaries,
    loadDjEffectivePrompt,
    getEndOfNightName,
    setActiveDjIconName,
    getEditingPersona,
  };
}
