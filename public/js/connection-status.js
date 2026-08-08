/** Settings connection status pills + credential field painters. */

import { formatDuration, formatTimeAgo } from "./format.js";

const STATUS_CLASSES = [
  "status-connected",
  "status-limited",
  "status-disconnected",
  "status-unknown",
];

/**
 * @param {HTMLElement|null|undefined} el
 * @param {"connected"|"limited"|"disconnected"|"unknown"} kind
 * @param {string} text
 */
export function setConnStatus(el, kind, text) {
  if (!el) return;
  el.classList.remove(...STATUS_CLASSES);
  el.classList.add(`status-${kind}`);
  el.textContent = text;
}

/**
 * @param {HTMLElement|null|undefined} el
 * @param {string} [label]
 */
export function paintConnStatusUnavailable(el, label = "Unavailable") {
  setConnStatus(el, "unknown", label);
}

/**
 * @param {{
 *   statusEl?: HTMLElement|null,
 *   clientIdInput?: HTMLInputElement|null,
 *   clientSecretInput?: HTMLInputElement|null,
 *   redirectInput?: HTMLInputElement|null,
 *   marketInput?: HTMLInputElement|null,
 *   secretHint?: HTMLElement|null,
 *   saveBtn?: HTMLButtonElement|null,
 *   clearBtn?: HTMLButtonElement|null,
 * }} els
 * @param {{
 *   configured?: boolean,
 *   clientId?: string,
 *   clientSecretSet?: boolean,
 *   redirectUri?: string,
 *   market?: string,
 * }} data
 */
export function applySpotifyAppStatus(els, data) {
  const {
    statusEl,
    clientIdInput,
    clientSecretInput,
    redirectInput,
    marketInput,
    secretHint,
    saveBtn,
    clearBtn,
  } = els || {};
  if (!statusEl) return;

  if (data.configured) {
    setConnStatus(statusEl, "connected", "Credentials OK");
  } else {
    setConnStatus(statusEl, "disconnected", "Credentials missing");
  }

  if (clientIdInput && document.activeElement !== clientIdInput) {
    clientIdInput.value = data.clientId || "";
    clientIdInput.readOnly = false;
  }
  if (clientSecretInput && document.activeElement !== clientSecretInput) {
    // Mask only — never the real secret. All-asterisks means "already saved".
    clientSecretInput.value = data.clientSecretSet ? "********" : "";
    clientSecretInput.placeholder = data.clientSecretSet
      ? ""
      : "Paste Client Secret";
    clientSecretInput.readOnly = false;
  }
  if (redirectInput && document.activeElement !== redirectInput) {
    // Prefer saved URI; otherwise suggest this host's callback for Spotify Dashboard.
    redirectInput.value =
      data.redirectUri || `${window.location.origin}/auth/callback`;
    redirectInput.readOnly = false;
  }
  if (marketInput && document.activeElement !== marketInput) {
    marketInput.value = data.market || "US";
    marketInput.readOnly = false;
  }
  if (secretHint) {
    secretHint.textContent =
      "Dots mean a client secret is already saved.";
  }
  if (saveBtn) saveBtn.disabled = false;
  if (clearBtn) clearBtn.disabled = false;
}

/**
 * @param {{
 *   statusEl?: HTMLElement|null,
 *   keyInput?: HTMLInputElement|null,
 *   keyHint?: HTMLElement|null,
 *   saveBtn?: HTMLButtonElement|null,
 *   clearBtn?: HTMLButtonElement|null,
 * }} els
 * @param {{ configured?: boolean, apiKeySet?: boolean }} data
 */
export function applyLastfmStatus(els, data) {
  const { statusEl, keyInput, keyHint, saveBtn, clearBtn } = els || {};
  if (!statusEl) return;

  if (data.configured) {
    setConnStatus(statusEl, "connected", "Credentials OK");
  } else {
    setConnStatus(statusEl, "disconnected", "Credentials missing");
  }

  if (keyInput && document.activeElement !== keyInput) {
    keyInput.value = data.apiKeySet ? "********" : "";
    keyInput.placeholder = data.apiKeySet ? "" : "Paste Last.fm API key";
    keyInput.readOnly = false;
  }
  if (keyHint) {
    keyHint.textContent = "Dots mean an API key is already saved.";
  }
  if (saveBtn) saveBtn.disabled = false;
  if (clearBtn) clearBtn.disabled = false;
}

/**
 * @param {{
 *   statusEl?: HTMLElement|null,
 *   urlInput?: HTMLInputElement|null,
 *   tokenInput?: HTMLInputElement|null,
 *   tokenHint?: HTMLElement|null,
 *   saveBtn?: HTMLButtonElement|null,
 *   clearBtn?: HTMLButtonElement|null,
 * }} els
 * @param {{ configured?: boolean, url?: string, tokenSet?: boolean }} data
 */
export function applyHaStatus(els, data) {
  const {
    statusEl,
    urlInput,
    tokenInput,
    tokenHint,
    saveBtn,
    clearBtn,
  } = els || {};
  if (!statusEl) return;

  if (data.configured) {
    setConnStatus(statusEl, "connected", "Credentials OK");
  } else {
    setConnStatus(statusEl, "disconnected", "Credentials missing");
  }

  if (urlInput && document.activeElement !== urlInput) {
    urlInput.value = data.url || "";
    urlInput.readOnly = false;
  }
  if (tokenInput && document.activeElement !== tokenInput) {
    tokenInput.value = data.tokenSet ? "********" : "";
    tokenInput.placeholder = data.tokenSet ? "" : "Paste long-lived token";
    tokenInput.readOnly = false;
  }
  if (tokenHint) {
    tokenHint.textContent = "Dots mean a token is already saved.";
  }
  if (saveBtn) saveBtn.disabled = false;
  if (clearBtn) clearBtn.disabled = false;
}

/**
 * @param {{
 *   statusEl?: HTMLElement|null,
 *   hostInput?: HTMLInputElement|null,
 *   roomInput?: HTMLInputElement|null,
 *   saveBtn?: HTMLButtonElement|null,
 *   clearBtn?: HTMLButtonElement|null,
 * }} els
 * @param {{ hostSet?: boolean, host?: string, room?: string }} data
 */
export function applySonosConnStatus(els, data) {
  const { statusEl, hostInput, roomInput, saveBtn, clearBtn } = els || {};
  if (!statusEl) return;

  if (data.hostSet) {
    setConnStatus(statusEl, "connected", "Pinned IP");
  } else {
    setConnStatus(statusEl, "limited", "Discovery");
  }

  if (hostInput && document.activeElement !== hostInput) {
    hostInput.value = data.host || "";
  }
  if (roomInput && document.activeElement !== roomInput) {
    roomInput.value = data.room || "";
  }
  if (saveBtn) saveBtn.disabled = false;
  if (clearBtn) clearBtn.disabled = false;
}

/**
 * Account-link pill + cache last-warmed field (not the Developer app creds).
 *
 * @param {{
 *   statusEl?: HTMLElement|null,
 *   cacheWarmed?: HTMLInputElement|null,
 * }} els
 * @param {{
 *   connected?: boolean,
 *   rateLimited?: boolean,
 *   cooldownSeconds?: number,
 *   poolWarmedAt?: number|null,
 * }} data
 * @param {{ now?: number }} [opts]
 */
export function applySpotifyAccountStatus(els, data, opts = {}) {
  const { statusEl, cacheWarmed } = els || {};
  if (!statusEl) return;
  const now = opts.now ?? Date.now();

  if (!data.connected) {
    setConnStatus(statusEl, "disconnected", "Account not linked");
  } else if (data.rateLimited) {
    setConnStatus(
      statusEl,
      "limited",
      `Rate-limited \u2014 retry in ${formatDuration(data.cooldownSeconds)}`
    );
  } else {
    setConnStatus(statusEl, "connected", "Account linked");
  }

  if (cacheWarmed) {
    if (data.connected && data.poolWarmedAt) {
      cacheWarmed.value = formatTimeAgo(data.poolWarmedAt, now);
    } else if (data.connected) {
      cacheWarmed.value = "Never";
    } else {
      cacheWarmed.value = "Account not linked";
    }
  }
}

/**
 * @param {{
 *   statusEl?: HTMLElement|null,
 *   cacheWarmed?: HTMLInputElement|null,
 * }} els
 */
export function paintSpotifyAccountUnavailable(els) {
  const { statusEl, cacheWarmed } = els || {};
  paintConnStatusUnavailable(statusEl, "Status unavailable");
  if (cacheWarmed) cacheWarmed.value = "Unavailable";
}
