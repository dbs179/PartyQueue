/** DJ Booth → Connections: Spotify app, Last.fm, HA, Sonos HTTP, account status. */

import {
  applySpotifyAppStatus as paintSpotifyAppStatus,
  applyLastfmStatus as paintLastfmStatus,
  applyHaStatus as paintHaStatus,
  applySonosConnStatus as paintSonosConnStatus,
  applySpotifyAccountStatus as paintSpotifyAccountStatus,
  paintConnStatusUnavailable,
  paintSpotifyAccountUnavailable,
} from "./connection-status.js";

/**
 * @param {{
 *   spotifyApp?: {
 *     statusEl?: HTMLElement|null,
 *     clientIdInput?: HTMLInputElement|null,
 *     clientSecretInput?: HTMLInputElement|null,
 *     redirectInput?: HTMLInputElement|null,
 *     marketInput?: HTMLInputElement|null,
 *     secretHint?: HTMLElement|null,
 *     saveBtn?: HTMLElement|null,
 *     testBtn?: HTMLElement|null,
 *     clearBtn?: HTMLElement|null,
 *   },
 *   lastfm?: {
 *     statusEl?: HTMLElement|null,
 *     keyInput?: HTMLInputElement|null,
 *     keyHint?: HTMLElement|null,
 *     saveBtn?: HTMLElement|null,
 *     testBtn?: HTMLElement|null,
 *     clearBtn?: HTMLElement|null,
 *   },
 *   ha?: {
 *     statusEl?: HTMLElement|null,
 *     urlInput?: HTMLInputElement|null,
 *     tokenInput?: HTMLInputElement|null,
 *     tokenHint?: HTMLElement|null,
 *     saveBtn?: HTMLElement|null,
 *     testBtn?: HTMLElement|null,
 *     clearBtn?: HTMLElement|null,
 *   },
 *   sonos?: {
 *     statusEl?: HTMLElement|null,
 *     hostInput?: HTMLInputElement|null,
 *     roomInput?: HTMLInputElement|null,
 *     saveBtn?: HTMLElement|null,
 *     testBtn?: HTMLElement|null,
 *     clearBtn?: HTMLElement|null,
 *   },
 *   spotifyAccount?: {
 *     statusEl?: HTMLElement|null,
 *     cacheWarmed?: HTMLElement|null,
 *   },
 * }} els
 * @param {{
 *   hostFetch: typeof fetch,
 *   fetch?: typeof fetch,
 *   showToast: (msg: string, isError?: boolean, durationMs?: number) => void,
 *   loadGenres?: () => void,
 * }} deps
 */
export function createConnectionsUi(els, deps) {
  const hostFetch = deps.hostFetch;
  const fetchFn = deps.fetch || fetch;
  const showToast = deps.showToast;
  const loadGenres = deps.loadGenres || (() => {});

  const spotifyApp = els?.spotifyApp || {};
  const lastfm = els?.lastfm || {};
  const ha = els?.ha || {};
  const sonos = els?.sonos || {};
  const spotifyAccount = els?.spotifyAccount || {};

  const spotifyAppEls = {
    statusEl: spotifyApp.statusEl,
    clientIdInput: spotifyApp.clientIdInput,
    clientSecretInput: spotifyApp.clientSecretInput,
    redirectInput: spotifyApp.redirectInput,
    marketInput: spotifyApp.marketInput,
    secretHint: spotifyApp.secretHint,
    saveBtn: spotifyApp.saveBtn,
    clearBtn: spotifyApp.clearBtn,
  };

  const lastfmEls = {
    statusEl: lastfm.statusEl,
    keyInput: lastfm.keyInput,
    keyHint: lastfm.keyHint,
    saveBtn: lastfm.saveBtn,
    clearBtn: lastfm.clearBtn,
  };

  const haEls = {
    statusEl: ha.statusEl,
    urlInput: ha.urlInput,
    tokenInput: ha.tokenInput,
    tokenHint: ha.tokenHint,
    saveBtn: ha.saveBtn,
    clearBtn: ha.clearBtn,
  };

  const sonosConnEls = {
    statusEl: sonos.statusEl,
    hostInput: sonos.hostInput,
    roomInput: sonos.roomInput,
    saveBtn: sonos.saveBtn,
    clearBtn: sonos.clearBtn,
  };

  const spotifyAccountEls = {
    statusEl: spotifyAccount.statusEl,
    cacheWarmed: spotifyAccount.cacheWarmed,
  };

  function applySpotifyAppStatus(data) {
    paintSpotifyAppStatus(spotifyAppEls, data);
  }

  async function loadSpotifyAppStatus() {
    if (!spotifyApp.statusEl) return;
    try {
      const res = await hostFetch("/api/spotify/app/status");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load Spotify app status.");
      applySpotifyAppStatus(data);
    } catch {
      paintConnStatusUnavailable(spotifyApp.statusEl);
    }
  }

  function applyLastfmStatus(data) {
    paintLastfmStatus(lastfmEls, data);
  }

  async function loadLastfmStatus() {
    if (!lastfm.statusEl) return;
    try {
      const res = await hostFetch("/api/lastfm/status");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load Last.fm status.");
      applyLastfmStatus(data);
    } catch {
      paintConnStatusUnavailable(lastfm.statusEl);
    }
  }

  function applyHaStatus(data) {
    paintHaStatus(haEls, data);
  }

  async function loadHaStatus() {
    if (!ha.statusEl) return;
    try {
      const res = await hostFetch("/api/homeassistant/status");
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Could not load Home Assistant status.");
      }
      applyHaStatus(data);
    } catch {
      paintConnStatusUnavailable(ha.statusEl);
    }
  }

  function applySonosConnStatus(data) {
    paintSonosConnStatus(sonosConnEls, data);
  }

  async function loadSonosConnStatus() {
    if (!sonos.statusEl) return;
    try {
      const res = await hostFetch("/api/sonos/connection");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load Sonos settings.");
      applySonosConnStatus(data);
    } catch {
      paintConnStatusUnavailable(sonos.statusEl);
    }
  }

  async function loadSpotifyStatus() {
    if (!spotifyAccount.statusEl) return;
    try {
      const res = await fetchFn("/api/spotify/status");
      const data = await res.json();
      paintSpotifyAccountStatus(spotifyAccountEls, data);
    } catch {
      paintSpotifyAccountUnavailable(spotifyAccountEls);
    }
  }

  spotifyApp.clientSecretInput?.addEventListener("focus", () => {
    if (/^\*+$/.test(spotifyApp.clientSecretInput.value)) {
      spotifyApp.clientSecretInput.value = "";
    }
  });

  spotifyApp.saveBtn?.addEventListener("click", async () => {
    spotifyApp.saveBtn.disabled = true;
    try {
      const body = {
        clientId: spotifyApp.clientIdInput?.value ?? "",
        redirectUri: spotifyApp.redirectInput?.value ?? "",
        market: spotifyApp.marketInput?.value ?? "",
      };
      const secret = (spotifyApp.clientSecretInput?.value ?? "").trim();
      if (secret && !/^\*+$/.test(secret)) body.clientSecret = secret;
      const res = await hostFetch("/api/spotify/app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Could not save Spotify app settings.");
      }
      applySpotifyAppStatus(data);
      showToast("Spotify app settings saved");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      if (spotifyApp.clientIdInput && !spotifyApp.clientIdInput.readOnly) {
        spotifyApp.saveBtn.disabled = false;
      }
    }
  });

  spotifyApp.testBtn?.addEventListener("click", async () => {
    spotifyApp.testBtn.disabled = true;
    try {
      const res = await hostFetch("/api/spotify/app/test", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Connection failed.");
      showToast(data.message || "Spotify app credentials work");
      loadSpotifyAppStatus();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      spotifyApp.testBtn.disabled = false;
    }
  });

  spotifyApp.clearBtn?.addEventListener("click", async () => {
    if (
      !confirm(
        "Clear saved Spotify Client ID, Secret, Redirect URI, and Market?"
      )
    ) {
      return;
    }
    spotifyApp.clearBtn.disabled = true;
    try {
      const res = await hostFetch("/api/spotify/app/clear", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Could not clear Spotify app settings.");
      }
      applySpotifyAppStatus(data);
      showToast("Spotify app settings cleared");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      if (spotifyApp.clientIdInput && !spotifyApp.clientIdInput.readOnly) {
        spotifyApp.clearBtn.disabled = false;
      }
    }
  });

  lastfm.keyInput?.addEventListener("focus", () => {
    if (/^\*+$/.test(lastfm.keyInput.value)) {
      lastfm.keyInput.value = "";
    }
  });

  lastfm.saveBtn?.addEventListener("click", async () => {
    lastfm.saveBtn.disabled = true;
    try {
      const body = {};
      const key = (lastfm.keyInput?.value ?? "").trim();
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
      lastfm.saveBtn.disabled = false;
    }
  });

  lastfm.testBtn?.addEventListener("click", async () => {
    lastfm.testBtn.disabled = true;
    try {
      const res = await hostFetch("/api/lastfm/test", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Connection failed.");
      showToast(data.message || "Last.fm API key works");
      loadLastfmStatus();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      lastfm.testBtn.disabled = false;
    }
  });

  lastfm.clearBtn?.addEventListener("click", async () => {
    if (!confirm("Clear saved Last.fm API key?")) return;
    lastfm.clearBtn.disabled = true;
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
      if (lastfm.keyInput && !lastfm.keyInput.readOnly) {
        lastfm.clearBtn.disabled = false;
      }
    }
  });

  ha.tokenInput?.addEventListener("focus", () => {
    if (/^\*+$/.test(ha.tokenInput.value)) {
      ha.tokenInput.value = "";
    }
  });

  ha.saveBtn?.addEventListener("click", async () => {
    ha.saveBtn.disabled = true;
    try {
      const body = { url: ha.urlInput?.value ?? "" };
      const token = (ha.tokenInput?.value ?? "").trim();
      if (token && !/^\*+$/.test(token)) body.token = token;
      const res = await hostFetch("/api/homeassistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Could not save Home Assistant settings.");
      }
      applyHaStatus(data);
      showToast("Saved");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      ha.saveBtn.disabled = false;
    }
  });

  ha.testBtn?.addEventListener("click", async () => {
    ha.testBtn.disabled = true;
    try {
      const res = await hostFetch("/api/homeassistant/test", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Connection failed.");
      showToast(data.message || "Home Assistant connected");
      loadHaStatus();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      ha.testBtn.disabled = false;
    }
  });

  ha.clearBtn?.addEventListener("click", async () => {
    if (!confirm("Clear saved Home Assistant URL and token?")) return;
    ha.clearBtn.disabled = true;
    try {
      const res = await hostFetch("/api/homeassistant/clear", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Could not clear Home Assistant settings.");
      }
      applyHaStatus(data);
      showToast("Home Assistant settings cleared");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      ha.clearBtn.disabled = false;
    }
  });

  sonos.saveBtn?.addEventListener("click", async () => {
    sonos.saveBtn.disabled = true;
    try {
      const res = await hostFetch("/api/sonos/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: sonos.hostInput?.value ?? "",
          room: sonos.roomInput?.value ?? "",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save Sonos settings.");
      applySonosConnStatus(data);
      showToast("Sonos settings saved");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      sonos.saveBtn.disabled = false;
    }
  });

  sonos.testBtn?.addEventListener("click", async () => {
    sonos.testBtn.disabled = true;
    showToast("Looking for Sonos…", false, 8000);
    try {
      const saveRes = await hostFetch("/api/sonos/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: sonos.hostInput?.value ?? "",
          room: sonos.roomInput?.value ?? "",
        }),
      });
      const saveData = await saveRes.json().catch(() => ({}));
      if (!saveRes.ok) {
        throw new Error(saveData.error || "Could not save Sonos settings.");
      }
      applySonosConnStatus(saveData);
      const res = await hostFetch("/api/sonos/connection/test", {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Connection failed.");
      showToast(data.message || "Sonos connected", false, 5000);
      loadSonosConnStatus();
    } catch (err) {
      showToast(err.message, true, 5000);
    } finally {
      sonos.testBtn.disabled = false;
    }
  });

  sonos.clearBtn?.addEventListener("click", async () => {
    if (!confirm("Clear saved Sonos speaker IP and room name?")) return;
    sonos.clearBtn.disabled = true;
    try {
      const res = await hostFetch("/api/sonos/connection/clear", {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not clear Sonos settings.");
      applySonosConnStatus(data);
      showToast("Sonos settings cleared");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      sonos.clearBtn.disabled = false;
    }
  });

  return {
    loadSpotifyAppStatus,
    loadLastfmStatus,
    loadHaStatus,
    loadSonosConnStatus,
    loadSpotifyStatus,
  };
}
