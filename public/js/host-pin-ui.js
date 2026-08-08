/** Host PIN gate, setup prompt, settings form, and hostFetch wrapper. */

import { attachModal } from "./modal.js";

export const PIN_UNLOCK_KEY = "pq.settingsUnlocked";
export const PIN_SETUP_SEEN_KEY = "pq.pinSetupSeen";

/**
 * @param {boolean} required
 * @param {boolean} unlocked
 */
export function settingsGateOk(required, unlocked) {
  return !required || !!unlocked;
}

/**
 * @param {string} pin
 * @param {string} confirm
 * @returns {string|null} error message or null if ok
 */
export function validateNewPin(pin, confirm) {
  const p = String(pin || "").trim();
  const c = String(confirm || "").trim();
  if (!p || p.length < 4) return "PIN must be at least 4 characters.";
  if (p !== c) return "PIN confirmation does not match.";
  return null;
}

/**
 * @param {string} code
 */
export function validateBootstrapCode(code) {
  return /^\d{6}$/.test(String(code || "").trim());
}

/**
 * @param {{ required?: boolean, source?: string|null, removable?: boolean, bootstrapRequired?: boolean }|null|undefined} info
 */
export function hostPinStatusView(info) {
  const required = !!info?.required;
  const source = info?.source || null;
  let text;
  if (!required) {
    text =
      "No host PIN set. Enter the six-digit setup code from data/host-bootstrap-code.json to claim the DJ Booth.";
  } else if (source === "file") {
    text = "Host PIN is set (saved on this server).";
  } else if (source === "env") {
    text =
      "Host PIN is set via SETTINGS_PIN in .env. Saving a new PIN here moves it into a hashed server file and clears .env.";
  } else {
    text = "Host PIN is set.";
  }
  return {
    text,
    showCurrentRow: required,
    showBootstrapRow: !required && !!info?.bootstrapRequired,
    showClear: !!info?.removable,
  };
}

/**
 * @param {number|null|undefined} retryMs
 */
export function pinRateLimitMessage(retryMs) {
  const secs = Math.ceil((Number(retryMs) || 30000) / 1000);
  return `Too many attempts. Try again in ${secs}s.`;
}

/**
 * @param {object} els
 * @param {{
 *   fetch?: typeof fetch,
 *   showToast: (msg: string, isError?: boolean, durationMs?: number, opts?: object) => void,
 *   confirmModal: (message: string, confirmLabel?: string, cancelLabel?: string) => Promise<boolean>,
 *   isHostArea: (name: string) => boolean,
 *   getCurrentView: () => string,
 *   hideView: (name: string) => void,
 *   getLastNonSettingsView: () => string,
 *   navigate: (name: string) => void,
 *   showView: (name: string) => void,
 *   loadSettings: () => void|Promise<void>,
 *   loadAutoFill: () => void|Promise<void>,
 *   confirmAndRestart: () => void|Promise<void>,
 *   syncHostControlsVisibility: () => void,
 * }} deps
 */
export function createHostPinUi(els, deps) {
  const {
    pinOverlay,
    pinInput,
    pinError,
    pinUnlockBtn,
    pinCancelBtn,
    pinSetupOverlay,
    pinSetupBootstrap,
    pinSetupInput,
    pinSetupConfirm,
    pinSetupError,
    pinSetupSkipBtn,
    pinSetupSaveBtn,
    hostPinStatusEl,
    hostPinCurrentRow,
    hostPinCurrentInput,
    hostPinBootstrapRow,
    hostPinBootstrapInput,
    hostPinNewInput,
    hostPinConfirmInput,
    hostPinSaveBtn,
    hostPinClearBtn,
    controlsHostUnlockBtn,
  } = els || {};

  const fetchFn = deps.fetch || fetch;
  const showToast = deps.showToast;
  const confirmModal = deps.confirmModal;
  const isHostArea = deps.isHostArea;
  const getCurrentView = deps.getCurrentView;
  const hideView = deps.hideView;
  const getLastNonSettingsView = deps.getLastNonSettingsView;
  const navigate = deps.navigate;
  const showView = deps.showView;
  const loadSettings = deps.loadSettings;
  const loadAutoFill = deps.loadAutoFill;
  const confirmAndRestart = deps.confirmAndRestart;
  const syncHostControlsVisibility = deps.syncHostControlsVisibility || (() => {});

  let settingsPinRequired = false;
  /** @type {null | "reveal-settings" | "reveal-controls" | "reveal-host" | "restart"} */
  let pendingPinAction = null;
  /** @type {{ required?: boolean, source?: string|null, removable?: boolean, bootstrapRequired?: boolean }|null} */
  let hostPinInfo = null;
  let hostSessionCheckedAt = 0;
  /** @type {{ close: () => void }|null} */
  let pinSetupModalSession = null;
  /** @type {{ close: () => void }|null} */
  let pinModalSession = null;

  function settingsUnlocked() {
    try {
      return sessionStorage.getItem(PIN_UNLOCK_KEY) === "1";
    } catch {
      return false;
    }
  }

  function setSettingsUnlocked(on) {
    try {
      if (on) sessionStorage.setItem(PIN_UNLOCK_KEY, "1");
      else sessionStorage.removeItem(PIN_UNLOCK_KEY);
    } catch {
      /* ignore storage errors */
    }
  }

  function gateOk() {
    return settingsGateOk(settingsPinRequired, settingsUnlocked());
  }

  function isPinRequired() {
    return !!settingsPinRequired;
  }

  function isPinGateOpen() {
    return !!(pinOverlay && !pinOverlay.hidden);
  }

  function getPendingPinAction() {
    return pendingPinAction;
  }

  function clearPendingPinAction() {
    pendingPinAction = null;
  }

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

  function showPinError(msg) {
    if (!pinError) return;
    pinError.textContent = msg;
    pinError.hidden = false;
  }

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

  async function maybeNudgeSpotifySetup() {
    try {
      const res = await fetchFn("/api/health");
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
    const view = hostPinStatusView(hostPinInfo);
    hostPinStatusEl.textContent = view.text;
    if (hostPinCurrentRow) hostPinCurrentRow.hidden = !view.showCurrentRow;
    if (hostPinBootstrapRow) hostPinBootstrapRow.hidden = !view.showBootstrapRow;
    if (hostPinClearBtn) hostPinClearBtn.hidden = !view.showClear;
  }

  async function refreshHostPinStatus() {
    try {
      const res = await fetchFn("/api/settings/pin-required");
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
    const currentView = getCurrentView();
    if (isHostArea(currentView) && !gateOk()) {
      hideView(currentView);
      openPinGate({
        title: "DJ Booth is locked",
        action: "reveal-host",
      });
    } else if (!settingsPinRequired && !pinSetupSeen()) {
      openPinSetupPrompt();
    }
  }

  async function verifyHostSessionStillValid() {
    if (!settingsPinRequired || !settingsUnlocked()) return;
    const now = Date.now();
    if (now - hostSessionCheckedAt < 15000) return;
    hostSessionCheckedAt = now;
    try {
      const res = await fetchFn("/api/settings/pin-session", {
        credentials: "same-origin",
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.ok === false) {
        setSettingsUnlocked(false);
        syncHostControlsVisibility();
        const currentView = getCurrentView();
        if (isHostArea(currentView)) {
          hideView(currentView);
          openPinGate({ title: "DJ Booth is locked", action: "reveal-host" });
        }
      }
    } catch {
      /* offline / transient — host APIs still re-lock on 401 */
    }
  }

  async function hostFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    const res = await fetchFn(url, {
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

  async function saveHostPin({
    pin,
    currentPin = "",
    bootstrapCode = "",
    fromSetup = false,
  } = {}) {
    const res = await fetchFn("/api/settings/pin", {
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

  function dismissPinGate() {
    pendingPinAction = null;
    closePinGate();
    const back = getLastNonSettingsView();
    navigate(back || "main");
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
      const res = await fetchFn("/api/settings/verify-pin", {
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
        void loadSettings();
        void loadAutoFill();
        const action = pendingPinAction;
        pendingPinAction = null;
        if (action === "restart") {
          void confirmAndRestart();
        } else if (isHostArea(getCurrentView())) {
          showView(getCurrentView());
        }
        return;
      }
      if (res.status === 429) {
        showPinError(pinRateLimitMessage(data.retryMs));
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

  hostPinSaveBtn?.addEventListener("click", async () => {
    const pin = (hostPinNewInput?.value || "").trim();
    const confirm = (hostPinConfirmInput?.value || "").trim();
    const currentPin = (hostPinCurrentInput?.value || "").trim();
    const bootstrapCode = (hostPinBootstrapInput?.value || "").trim();
    const err = validateNewPin(pin, confirm);
    if (err) {
      showToast(err, true);
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
    } catch (e) {
      showToast(e.message || "Could not save PIN.", true);
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
      showToast(
        data.required
          ? "File PIN removed (env PIN may still apply)"
          : "Host PIN removed"
      );
    } catch (e) {
      showToast(e.message || "Could not remove PIN.", true);
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
    if (!validateBootstrapCode(bootstrapCode)) {
      showPinSetupError(
        "Enter the six-digit setup code from data/host-bootstrap-code.json."
      );
      return;
    }
    const err = validateNewPin(pin, confirm);
    if (err) {
      showPinSetupError(err);
      return;
    }
    pinSetupSaveBtn.disabled = true;
    try {
      await saveHostPin({ pin, bootstrapCode, fromSetup: true });
    } catch (e) {
      showPinSetupError(e.message || "Could not save PIN.");
    } finally {
      pinSetupSaveBtn.disabled = false;
    }
  });

  for (const el of [pinSetupBootstrap, pinSetupInput, pinSetupConfirm]) {
    el?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") pinSetupSaveBtn?.click();
    });
  }

  pinUnlockBtn?.addEventListener("click", submitPin);
  pinInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitPin();
  });
  pinCancelBtn?.addEventListener("click", dismissPinGate);

  controlsHostUnlockBtn?.addEventListener("click", () => {
    openPinGate({ title: "Unlock party controls", action: "reveal-controls" });
  });

  return {
    hostFetch,
    settingsGateOk: gateOk,
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
  };
}
