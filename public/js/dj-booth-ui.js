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
 *   selectDjIcon: (name: string|null, persona?: string) => Promise<void>,
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

  const ssNameInput = document.getElementById("set-ss-name");
  const ssTaglinesInput = document.getElementById("set-ss-taglines");
  const ssIntroPercentInput = document.getElementById("set-ss-intro-percent");
  const ssMaxWordsInput = document.getElementById("set-ss-max-words");
  const ssTtsProviderInput = document.getElementById("set-ss-tts-provider");
  const ssTtsVoiceInput = document.getElementById("set-ss-tts-voice");
  const ssTtsVoiceElevenlabsInput = document.getElementById(
    "set-ss-tts-voice-elevenlabs"
  );
  const ssTtsVoiceOpenaiRow = document.getElementById(
    "dj-ss-tts-voice-openai-row"
  );
  const ssTtsVoiceElevenlabsRow = document.getElementById(
    "dj-ss-tts-voice-elevenlabs-row"
  );
  const ssTtsSpeedInput = document.getElementById("set-ss-tts-speed");
  const ssIntensityInput = document.getElementById("set-ss-intensity");
  const ssCatchphraseInput = document.getElementById("set-ss-catchphrase");
  const ssBanListInput = document.getElementById("set-ss-ban-list");
  const ssPersonaNotesInput = document.getElementById("set-ss-persona-notes");
  const ssAlwaysInstructionsInput = document.getElementById(
    "set-ss-always-instructions"
  );
  const ssNeverInstructionsInput = document.getElementById(
    "set-ss-never-instructions"
  );
  const ssPronunciationsInput = document.getElementById("set-ss-pronunciations");
  const ssEffectivePromptInput = document.getElementById("ss-effective-prompt");
  const ssVoiceTestBtn = document.getElementById("dj-ss-voice-test");
  const ssVoiceTestElevenlabsBtn = document.getElementById(
    "dj-ss-voice-test-elevenlabs"
  );
  const ssVoicePreviewPlayer = document.getElementById(
    "dj-ss-voice-preview-player"
  );

  const hostFetch = deps.hostFetch;
  const fetchFn = deps.fetch || fetch;
  const showToast = deps.showToast;
  const saveSettings = deps.saveSettings;
  const selectDjIcon = deps.selectDjIcon;
  const getSettingsDefaults = deps.getSettingsDefaults || (() => ({}));
  const refreshBoothMediaUrl = deps.refreshBoothMediaUrl || (() => {});

  const PERSONA_HR = "holy-roller";
  const PERSONA_SS = "sister-static";

  /** @type {{ uri: string|null, name: string, artist: string }} */
  let endOfNightTrack = { ...DEFAULT_END_OF_NIGHT };
  let endOfNightSearchTimer = 0;
  /** @type {object} */
  let lastDjSettings = {};

  const hrMap = {
    name: djNameInput,
    taglines: djTaglinesInput,
    intro: djIntroPercentInput,
    maxWords: djMaxWordsInput,
    provider: djTtsProviderInput,
    voiceOpenAi: djTtsVoiceInput,
    voiceEleven: djTtsVoiceElevenlabsInput,
    openaiRow: djTtsVoiceOpenaiRow,
    elevenRow: djTtsVoiceElevenlabsRow,
    speed: djTtsSpeedInput,
    intensity: djIntensityInput,
    catchphrase: djCatchphraseInput,
    banList: djBanListInput,
    notes: djPersonaNotesInput,
    always: djAlwaysInstructionsInput,
    never: djNeverInstructionsInput,
    pronunciations: djPronunciationsInput,
  };
  const ssMap = {
    name: ssNameInput,
    taglines: ssTaglinesInput,
    intro: ssIntroPercentInput,
    maxWords: ssMaxWordsInput,
    provider: ssTtsProviderInput,
    voiceOpenAi: ssTtsVoiceInput,
    voiceEleven: ssTtsVoiceElevenlabsInput,
    openaiRow: ssTtsVoiceOpenaiRow,
    elevenRow: ssTtsVoiceElevenlabsRow,
    speed: ssTtsSpeedInput,
    intensity: ssIntensityInput,
    catchphrase: ssCatchphraseInput,
    banList: ssBanListInput,
    notes: ssPersonaNotesInput,
    always: ssAlwaysInstructionsInput,
    never: ssNeverInstructionsInput,
    pronunciations: ssPronunciationsInput,
  };

  function setActiveDjIconName(name, persona = PERSONA_HR) {
    if (persona === PERSONA_SS) {
      lastDjSettings.djSisterStatic = {
        ...(lastDjSettings.djSisterStatic || {}),
        djIcon: name || null,
      };
      return;
    }
    lastDjSettings.djIcon = name || null;
  }

  function getEditingPersona() {
    return PERSONA_HR;
  }

  function sisterStaticFrom(s) {
    return (s && s.djSisterStatic) || {};
  }

  function wrapSs(partial) {
    return { djSisterStatic: partial };
  }

  function syncDjRosterUi() {
    const mix = djRosterModeInput?.value === "mix";
    if (djMixRow) djMixRow.hidden = !mix;
    if (djBanterRow) djBanterRow.hidden = !mix;
  }

  function paintTaglinesEl(input, lines) {
    if (!input) return;
    const pack = Array.isArray(lines)
      ? lines
      : String(lines || "").split(/\r?\n/);
    input.value = pack
      .map((line) => String(line || "").trim())
      .filter(Boolean)
      .join("\n");
  }

  function taglinesFromEl(input) {
    return String(input?.value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function syncTtsRows(map) {
    paintDjTtsProviderRows(
      { openaiRow: map.openaiRow, elevenlabsRow: map.elevenRow },
      map.provider?.value
    );
  }

  function paintPersonaFields(src, map) {
    if (!src || typeof src !== "object" || !map) return;
    if (src.djName != null && map.name) map.name.value = src.djName;
    if (src.djTaglines != null) paintTaglinesEl(map.taglines, src.djTaglines);
    if (src.djTtsProvider != null && map.provider) {
      map.provider.value = String(src.djTtsProvider);
    }
    if (src.djTtsVoiceOpenAi != null && map.voiceOpenAi) {
      map.voiceOpenAi.value = String(src.djTtsVoiceOpenAi);
    } else if (
      src.djTtsVoice != null &&
      map.voiceOpenAi &&
      src.djTtsProvider === "openai_ha"
    ) {
      map.voiceOpenAi.value = String(src.djTtsVoice);
    }
    if (src.djTtsVoiceElevenlabs != null && map.voiceEleven) {
      map.voiceEleven.value = String(src.djTtsVoiceElevenlabs);
    } else if (
      src.djTtsVoice != null &&
      map.voiceEleven &&
      src.djTtsProvider === "elevenlabs_ha"
    ) {
      map.voiceEleven.value = String(src.djTtsVoice);
    }
    syncTtsRows(map);
    if (src.djTtsSpeed != null && map.speed) {
      map.speed.value = String(src.djTtsSpeed);
    }
    if (src.djCharacterIntensity != null && map.intensity) {
      map.intensity.value = String(src.djCharacterIntensity);
    }
    if (src.djCatchphrase != null && map.catchphrase) {
      map.catchphrase.value = String(src.djCatchphrase);
    }
    if (src.djBanList != null && map.banList) {
      map.banList.value = String(src.djBanList);
    }
    if (src.djPersonaNotes != null && map.notes) {
      map.notes.value = String(src.djPersonaNotes);
    }
    if (src.djAlwaysInstructions != null && map.always) {
      map.always.value = String(src.djAlwaysInstructions);
    }
    if (src.djNeverInstructions != null && map.never) {
      map.never.value = String(src.djNeverInstructions);
    }
    if (src.djPronunciations != null && map.pronunciations) {
      map.pronunciations.value = String(src.djPronunciations);
    }
    if (src.djNameIntroPercent != null && map.intro) {
      map.intro.value = src.djNameIntroPercent;
    }
    if (src.djAnnounceMaxWords != null && map.maxWords) {
      map.maxWords.value = src.djAnnounceMaxWords;
    }
  }

  function identityPayloadFrom(map) {
    const provider = map.provider?.value || "elevenlabs_ha";
    return {
      djName: map.name?.value ?? "",
      djTaglines: taglinesFromEl(map.taglines),
      djNameIntroPercent: Number(map.intro?.value),
      djAnnounceMaxWords: Number(map.maxWords?.value),
      djTtsProvider: provider,
      djTtsVoiceOpenAi: map.voiceOpenAi?.value ?? "onyx",
      djTtsVoiceElevenlabs: map.voiceEleven?.value?.trim() || "",
      djTtsVoice:
        provider === "openai_ha"
          ? map.voiceOpenAi?.value ?? "onyx"
          : map.voiceEleven?.value?.trim() || "",
      djTtsSpeed: Number(map.speed?.value ?? 1),
      djCharacterIntensity: map.intensity?.value ?? "classic",
      djCatchphrase: map.catchphrase?.value ?? "",
      djBanList: map.banList?.value ?? "",
      djPersonaNotes: map.notes?.value ?? "",
      djAlwaysInstructions: map.always?.value ?? "",
      djNeverInstructions: map.never?.value ?? "",
      djPronunciations: map.pronunciations?.value ?? "",
    };
  }

  function voiceOnlyPayloadFrom(map) {
    const all = identityPayloadFrom(map);
    return {
      djNameIntroPercent: all.djNameIntroPercent,
      djAnnounceMaxWords: all.djAnnounceMaxWords,
      djTtsProvider: all.djTtsProvider,
      djTtsVoiceOpenAi: all.djTtsVoiceOpenAi,
      djTtsVoiceElevenlabs: all.djTtsVoiceElevenlabs,
      djTtsVoice: all.djTtsVoice,
      djTtsSpeed: all.djTtsSpeed,
      djCharacterIntensity: all.djCharacterIntensity,
      djCatchphrase: all.djCatchphrase,
      djBanList: all.djBanList,
    };
  }

  function advancedPayloadFrom(map) {
    return {
      djPersonaNotes: map.notes?.value ?? "",
      djAlwaysInstructions: map.always?.value ?? "",
      djNeverInstructions: map.never?.value ?? "",
      djPronunciations: map.pronunciations?.value ?? "",
    };
  }

  function getEndOfNightName() {
    return endOfNightTrack.name;
  }

  function syncDjTtsProviderUi() {
    syncTtsRows(hrMap);
    syncTtsRows(ssMap);
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

  function paintPersonaHubStats(suffix, src, fallback) {
    const bannerEl = document.getElementById(`dj-stat-banner${suffix}`);
    const nameEl = document.getElementById(`dj-stat-name${suffix}`);
    const taglinesEl = document.getElementById(`dj-stat-taglines${suffix}`);
    const voiceEl = document.getElementById(`dj-stat-voice${suffix}`);
    const advancedEl = document.getElementById(`dj-stat-advanced${suffix}`);
    if (bannerEl) bannerEl.textContent = formatDjIconLabel(src?.djIcon);
    if (nameEl) {
      nameEl.textContent =
        String(src?.djName || "").trim() ||
        String(fallback?.djName || "").trim() ||
        "—";
    }
    if (taglinesEl) {
      const raw = src?.djTaglines;
      if (Array.isArray(raw) ? raw.length : String(raw || "").trim()) {
        taglinesEl.textContent = formatDjTaglinesHubLine(raw);
      } else {
        const pack = fallback?.djTaglines;
        taglinesEl.textContent =
          Array.isArray(pack) && pack.length
            ? formatDjTaglinesHubLine(pack)
            : "—";
      }
    }
    if (voiceEl) {
      voiceEl.textContent = formatDjVoiceHubLine({
        intensity: src?.djCharacterIntensity,
        provider: src?.djTtsProvider,
        speed: src?.djTtsSpeed ?? 1,
      });
    }
    if (advancedEl) {
      advancedEl.textContent = formatDjAdvancedHubLine({
        personaNotes: src?.djPersonaNotes,
        alwaysInstructions: src?.djAlwaysInstructions,
        neverInstructions: src?.djNeverInstructions,
        pronunciations: src?.djPronunciations,
      });
    }
  }

  function updateDjHubSummaries() {
    void refreshBoothMediaUrl();
    const defaults = getSettingsDefaults() || {};
    paintPersonaHubStats("", lastDjSettings, defaults);
    paintPersonaHubStats(
      "-ss",
      sisterStaticFrom(lastDjSettings),
      defaults.djSisterStatic || {}
    );

    const volumeEl = document.getElementById("dj-stat-volume");
    const shoutsEl = document.getElementById("dj-stat-shouts");
    const cohostsEl = document.getElementById("dj-stat-cohosts");

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
    paintPersonaFields(lastDjSettings, hrMap);
    paintPersonaFields(sisterStaticFrom(lastDjSettings), ssMap);
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
    updateDjHubSummaries();
  }

  function volumePayload() {
    return {
      djVolumeBumpLowPct: Number(djVolumeLowInput?.value),
      djVolumeBumpMidPct: Number(djVolumeMidInput?.value),
      djVolumeBumpHighPct: Number(djVolumeHighInput?.value),
      djHandoffSilenceSec: Number(djSilenceInput?.value),
    };
  }

  function shoutsPayload() {
    return {
      djShoutEnabled: !!djShoutEnabledInput?.checked,
      djShoutMode: djShoutModeInput?.value || "every",
      djShoutPercent: Number(djShoutPercentInput?.value),
      djShoutEveryN: Number(djShoutEveryInput?.value),
    };
  }

  async function runDjVoicePreview(btn, map, player) {
    const provider = map.provider?.value || "elevenlabs_ha";
    const voice =
      provider === "openai_ha"
        ? map.voiceOpenAi?.value || "onyx"
        : map.voiceEleven?.value?.trim() || "";
    const speed = Number(map.speed?.value || 1);
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

      if (player) {
        player.hidden = false;
        player.src = data.url;
        player.load();
        try {
          await player.play();
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

  async function loadPromptForPersona(personaId, input, btn) {
    if (!input) return;
    if (btn) btn.disabled = true;
    input.value = "Loading effective prompt…";
    try {
      const res = await hostFetch(
        `/api/dj-voice/prompt-preview?persona=${encodeURIComponent(personaId)}`,
        { cache: "no-store" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not load prompt preview.");
      input.value = data.prompt || "(No prompt returned.)";
    } catch (err) {
      input.value = "";
      showToast(err.message || "Could not load prompt preview.", true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function loadDjEffectivePrompt() {
    await Promise.all([
      loadPromptForPersona(
        PERSONA_HR,
        djEffectivePromptInput,
        djAdvancedPreviewRefreshBtn
      ),
      loadPromptForPersona(
        PERSONA_SS,
        ssEffectivePromptInput,
        document.getElementById("dj-ss-advanced-preview-refresh")
      ),
    ]);
  }

  function defaultHrVoice() {
    const d = getSettingsDefaults() || {};
    return {
      djNameIntroPercent: d.djNameIntroPercent ?? 25,
      djAnnounceMaxWords: d.djAnnounceMaxWords ?? 55,
      djTtsProvider: d.djTtsProvider ?? "elevenlabs_ha",
      djTtsVoiceOpenAi: d.djTtsVoiceOpenAi ?? "onyx",
      djTtsVoiceElevenlabs: d.djTtsVoiceElevenlabs ?? "",
      djTtsSpeed: d.djTtsSpeed ?? 1,
      djCharacterIntensity: d.djCharacterIntensity ?? "extra",
      djCatchphrase: d.djCatchphrase ?? "",
      djBanList: d.djBanList ?? "",
    };
  }

  function defaultSsIdentity() {
    const ss = getSettingsDefaults()?.djSisterStatic || {};
    return {
      djName: ss.djName ?? "Sister Static",
      djTaglines: Array.isArray(ss.djTaglines) ? ss.djTaglines : [],
      djNameIntroPercent: ss.djNameIntroPercent ?? 25,
      djAnnounceMaxWords: ss.djAnnounceMaxWords ?? 55,
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
  }

  function resetVolumeDefaults() {
    const d = getSettingsDefaults() || {};
    const values = {
      djVolumeBumpLowPct: d.djVolumeBumpLowPct ?? 20,
      djVolumeBumpMidPct: d.djVolumeBumpMidPct ?? 8,
      djVolumeBumpHighPct: d.djVolumeBumpHighPct ?? 4,
      djHandoffSilenceSec: d.djHandoffSilenceSec ?? 3,
    };
    applyFromSettings(values);
    saveSettings(values, { toastMessage: "Set to Default" });
  }

  function resetShoutDefaults() {
    const d = getSettingsDefaults() || {};
    const values = {
      djShoutEnabled: d.djShoutEnabled ?? true,
      djShoutMode: d.djShoutMode ?? "every",
      djShoutPercent: d.djShoutPercent ?? 25,
      djShoutEveryN: d.djShoutEveryN ?? 5,
    };
    applyFromSettings(values);
    saveSettings(values, { toastMessage: "Set to Default" });
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

  djTtsProviderInput?.addEventListener("change", () => syncTtsRows(hrMap));
  ssTtsProviderInput?.addEventListener("change", () => syncTtsRows(ssMap));

  function viewIdFor(btn) {
    return btn?.closest(".view")?.id || "";
  }

  (djVoiceSaveBtns || []).forEach((btn) => {
    btn.addEventListener("click", () => {
      const viewId = viewIdFor(btn);
      if (viewId === "view-settings-dj-shouts") {
        saveSettings(shoutsPayload(), { toastMessage: "Saved" });
        return;
      }
      saveSettings(volumePayload(), { toastMessage: "Saved" });
    });
  });

  (djVoiceResetBtns || []).forEach((btn) => {
    btn.addEventListener("click", () => {
      const viewId = viewIdFor(btn);
      if (viewId === "view-settings-dj-shouts") {
        resetShoutDefaults();
        return;
      }
      resetVolumeDefaults();
    });
  });

  document.getElementById("dj-name-save")?.addEventListener("click", () => {
    const values = { djName: djNameInput?.value ?? "" };
    lastDjSettings = { ...lastDjSettings, ...values };
    saveSettings(values, { toastMessage: "Saved" });
    updateDjHubSummaries();
  });
  document.getElementById("dj-name-reset")?.addEventListener("click", () => {
    const values = { djName: getSettingsDefaults()?.djName ?? "Party DJ" };
    paintPersonaFields(values, hrMap);
    lastDjSettings = { ...lastDjSettings, ...values };
    saveSettings(values, { toastMessage: "Set to Default" });
    updateDjHubSummaries();
  });
  document.getElementById("dj-ss-name-save")?.addEventListener("click", () => {
    const values = { djName: ssNameInput?.value ?? "" };
    lastDjSettings.djSisterStatic = {
      ...(lastDjSettings.djSisterStatic || {}),
      ...values,
    };
    saveSettings(wrapSs(values), { toastMessage: "Saved" });
    updateDjHubSummaries();
  });
  document.getElementById("dj-ss-name-reset")?.addEventListener("click", () => {
    const values = { djName: defaultSsIdentity().djName };
    paintPersonaFields(values, ssMap);
    lastDjSettings.djSisterStatic = {
      ...(lastDjSettings.djSisterStatic || {}),
      ...values,
    };
    saveSettings(wrapSs(values), { toastMessage: "Set to Default" });
    updateDjHubSummaries();
  });

  document.getElementById("dj-hr-voice-save")?.addEventListener("click", () => {
    const values = voiceOnlyPayloadFrom(hrMap);
    lastDjSettings = { ...lastDjSettings, ...values };
    saveSettings(values, { toastMessage: "Saved" });
    updateDjHubSummaries();
  });
  document.getElementById("dj-hr-voice-reset")?.addEventListener("click", () => {
    const values = defaultHrVoice();
    paintPersonaFields(values, hrMap);
    lastDjSettings = { ...lastDjSettings, ...values };
    saveSettings(values, { toastMessage: "Set to Default" });
    updateDjHubSummaries();
  });
  document.getElementById("dj-ss-voice-save")?.addEventListener("click", () => {
    const values = voiceOnlyPayloadFrom(ssMap);
    lastDjSettings.djSisterStatic = {
      ...(lastDjSettings.djSisterStatic || {}),
      ...values,
    };
    saveSettings(wrapSs(values), { toastMessage: "Saved" });
    updateDjHubSummaries();
  });
  document.getElementById("dj-ss-voice-reset")?.addEventListener("click", () => {
    const ss = defaultSsIdentity();
    const values = {
      djNameIntroPercent: ss.djNameIntroPercent,
      djAnnounceMaxWords: ss.djAnnounceMaxWords,
      djTtsProvider: ss.djTtsProvider,
      djTtsVoiceOpenAi: ss.djTtsVoiceOpenAi,
      djTtsVoiceElevenlabs: ss.djTtsVoiceElevenlabs,
      djTtsSpeed: ss.djTtsSpeed,
      djCharacterIntensity: ss.djCharacterIntensity,
      djCatchphrase: ss.djCatchphrase,
      djBanList: ss.djBanList,
    };
    paintPersonaFields(values, ssMap);
    lastDjSettings.djSisterStatic = {
      ...(lastDjSettings.djSisterStatic || {}),
      ...values,
    };
    saveSettings(wrapSs(values), { toastMessage: "Set to Default" });
    updateDjHubSummaries();
  });

  async function saveAdvanced(map, wrap, personaId, input, refreshBtn) {
    const values = advancedPayloadFrom(map);
    if (wrap) {
      lastDjSettings.djSisterStatic = {
        ...(lastDjSettings.djSisterStatic || {}),
        ...values,
      };
    } else {
      lastDjSettings = { ...lastDjSettings, ...values };
    }
    const saved = await saveSettings(wrap ? wrapSs(values) : values, {
      toastMessage: "Advanced DJ saved",
    });
    if (saved) await loadPromptForPersona(personaId, input, refreshBtn);
    updateDjHubSummaries();
  }

  djAdvancedSaveBtn?.addEventListener("click", async () => {
    djAdvancedSaveBtn.disabled = true;
    try {
      await saveAdvanced(
        hrMap,
        false,
        PERSONA_HR,
        djEffectivePromptInput,
        djAdvancedPreviewRefreshBtn
      );
    } finally {
      djAdvancedSaveBtn.disabled = false;
    }
  });

  djAdvancedPreviewRefreshBtn?.addEventListener("click", () => {
    void loadPromptForPersona(
      PERSONA_HR,
      djEffectivePromptInput,
      djAdvancedPreviewRefreshBtn
    );
  });

  djAdvancedResetBtn?.addEventListener("click", async () => {
    const d = getSettingsDefaults() || {};
    const values = {
      djPersonaNotes: d.djPersonaNotes ?? "",
      djAlwaysInstructions: d.djAlwaysInstructions ?? "",
      djNeverInstructions: d.djNeverInstructions ?? "",
      djPronunciations: d.djPronunciations ?? "",
    };
    paintPersonaFields(values, hrMap);
    lastDjSettings = { ...lastDjSettings, ...values };
    const saved = await saveSettings(values, {
      toastMessage: "Advanced DJ set to defaults",
    });
    if (saved) {
      await loadPromptForPersona(
        PERSONA_HR,
        djEffectivePromptInput,
        djAdvancedPreviewRefreshBtn
      );
    }
    updateDjHubSummaries();
  });

  const ssAdvancedSaveBtn = document.getElementById("dj-ss-advanced-save");
  const ssAdvancedResetBtn = document.getElementById("dj-ss-advanced-reset");
  const ssAdvancedPreviewRefreshBtn = document.getElementById(
    "dj-ss-advanced-preview-refresh"
  );

  ssAdvancedSaveBtn?.addEventListener("click", async () => {
    ssAdvancedSaveBtn.disabled = true;
    try {
      await saveAdvanced(
        ssMap,
        true,
        PERSONA_SS,
        ssEffectivePromptInput,
        ssAdvancedPreviewRefreshBtn
      );
    } finally {
      ssAdvancedSaveBtn.disabled = false;
    }
  });
  ssAdvancedPreviewRefreshBtn?.addEventListener("click", () => {
    void loadPromptForPersona(
      PERSONA_SS,
      ssEffectivePromptInput,
      ssAdvancedPreviewRefreshBtn
    );
  });
  ssAdvancedResetBtn?.addEventListener("click", async () => {
    const ss = defaultSsIdentity();
    const values = {
      djPersonaNotes: ss.djPersonaNotes,
      djAlwaysInstructions: ss.djAlwaysInstructions,
      djNeverInstructions: ss.djNeverInstructions,
      djPronunciations: ss.djPronunciations,
    };
    paintPersonaFields(values, ssMap);
    lastDjSettings.djSisterStatic = {
      ...(lastDjSettings.djSisterStatic || {}),
      ...values,
    };
    const saved = await saveSettings(wrapSs(values), {
      toastMessage: "Advanced DJ set to defaults",
    });
    if (saved) {
      await loadPromptForPersona(
        PERSONA_SS,
        ssEffectivePromptInput,
        ssAdvancedPreviewRefreshBtn
      );
    }
    updateDjHubSummaries();
  });

  djVoiceTestBtn?.addEventListener("click", () =>
    runDjVoicePreview(djVoiceTestBtn, hrMap, djVoicePreviewPlayer)
  );
  djVoiceTestElevenlabsBtn?.addEventListener("click", () =>
    runDjVoicePreview(djVoiceTestElevenlabsBtn, hrMap, djVoicePreviewPlayer)
  );
  ssVoiceTestBtn?.addEventListener("click", () =>
    runDjVoicePreview(ssVoiceTestBtn, ssMap, ssVoicePreviewPlayer)
  );
  ssVoiceTestElevenlabsBtn?.addEventListener("click", () =>
    runDjVoicePreview(ssVoiceTestElevenlabsBtn, ssMap, ssVoicePreviewPlayer)
  );

  djTaglinesSaveBtn?.addEventListener("click", () => {
    const values = { djTaglines: taglinesFromEl(djTaglinesInput) };
    lastDjSettings = { ...lastDjSettings, ...values };
    saveSettings(values, { toastMessage: "Saved" });
    updateDjHubSummaries();
  });

  djTaglinesResetBtn?.addEventListener("click", () => {
    const pack = getSettingsDefaults()?.djTaglines;
    const lines = Array.isArray(pack) ? pack : [];
    paintTaglinesEl(djTaglinesInput, lines);
    lastDjSettings = { ...lastDjSettings, djTaglines: lines };
    saveSettings({ djTaglines: lines }, { toastMessage: "Set to Default" });
    updateDjHubSummaries();
  });

  djTaglinesInput?.addEventListener("input", updateDjHubSummaries);
  ssTaglinesInput?.addEventListener("input", updateDjHubSummaries);

  document.getElementById("dj-ss-taglines-save")?.addEventListener("click", () => {
    const values = { djTaglines: taglinesFromEl(ssTaglinesInput) };
    lastDjSettings.djSisterStatic = {
      ...(lastDjSettings.djSisterStatic || {}),
      ...values,
    };
    saveSettings(wrapSs(values), { toastMessage: "Saved" });
    updateDjHubSummaries();
  });
  document
    .getElementById("dj-ss-taglines-reset")
    ?.addEventListener("click", () => {
      const lines = defaultSsIdentity().djTaglines;
      paintTaglinesEl(ssTaglinesInput, lines);
      lastDjSettings.djSisterStatic = {
        ...(lastDjSettings.djSisterStatic || {}),
        djTaglines: lines,
      };
      saveSettings(wrapSs({ djTaglines: lines }), {
        toastMessage: "Set to Default",
      });
      updateDjHubSummaries();
    });

  document.getElementById("dj-icon-default-hr")?.addEventListener("click", () => {
    void selectDjIcon(null, PERSONA_HR);
  });
  document.getElementById("dj-icon-default-ss")?.addEventListener("click", () => {
    void selectDjIcon(null, PERSONA_SS);
  });

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

  return {
    applyFromSettings,
    updateDjHubSummaries,
    loadDjEffectivePrompt,
    getEndOfNightName,
    setActiveDjIconName,
    getEditingPersona,
  };
}
