/** DJ Booth voice / shouts / last-call form UI + hub summary paint. */

import { escapeHtml } from "./format.js";
import {
  formatDjIconLabel,
  formatDjVoiceHubLine,
  formatDjAdvancedHubLine,
  formatDjVolumeHubLine,
  formatDjShoutsHubLine,
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
  } = els || {};

  const hostFetch = deps.hostFetch;
  const fetchFn = deps.fetch || fetch;
  const showToast = deps.showToast;
  const saveSettings = deps.saveSettings;
  const selectDjIcon = deps.selectDjIcon;
  const getSettingsDefaults = deps.getSettingsDefaults || (() => ({}));
  const refreshBoothMediaUrl = deps.refreshBoothMediaUrl || (() => {});

  /** @type {{ uri: string|null, name: string, artist: string }} */
  let endOfNightTrack = { ...DEFAULT_END_OF_NIGHT };
  let endOfNightSearchTimer = 0;
  /** @type {string|null} */
  let activeDjIconName = null;

  function setActiveDjIconName(name) {
    activeDjIconName = name || null;
  }

  function getEndOfNightName() {
    return endOfNightTrack.name;
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
      voiceEl.textContent = formatDjVoiceHubLine({
        intensity: djIntensityInput?.value,
        provider: djTtsProviderInput?.value,
        speed: djTtsSpeedInput?.value ?? 1,
      });
    }

    if (advancedEl) {
      advancedEl.textContent = formatDjAdvancedHubLine({
        personaNotes: djPersonaNotesInput?.value,
        alwaysInstructions: djAlwaysInstructionsInput?.value,
        neverInstructions: djNeverInstructionsInput?.value,
        pronunciations: djPronunciationsInput?.value,
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
    } else if (
      s.djTtsVoice != null &&
      djTtsVoiceInput &&
      s.djTtsProvider === "openai_ha"
    ) {
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
        artist:
          s.endOfNightTrackArtist || (s.endOfNightTrackUri ? "" : "Semisonic"),
      };
      if (!endOfNightTrack.uri) {
        endOfNightTrack = { ...DEFAULT_END_OF_NIGHT };
      }
      paintEndOfNightLabel();
    }
    if (Object.prototype.hasOwnProperty.call(s, "djIcon")) {
      activeDjIconName = s.djIcon || null;
    }
    updateDjHubSummaries();
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

  async function resetDjVoiceDefaults() {
    const d = getSettingsDefaults() || {};
    const values = {
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
    };
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
      saveSettings(currentDjVoicePayload(), { toastMessage: "Saved" });
    });
  });

  djAdvancedSaveBtn?.addEventListener("click", async () => {
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
    applyFromSettings(values);
    const saved = await saveSettings(values, {
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

  return {
    applyFromSettings,
    updateDjHubSummaries,
    loadDjEffectivePrompt,
    getEndOfNightName,
    setActiveDjIconName,
  };
}
