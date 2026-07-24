// Settings → Connections credential routes: Spotify app, Sonos speaker,
// Last.fm, and Home Assistant. Every family follows the same shape —
// status (never includes secrets), save, clear, test.

import { asyncHandler } from "../http/async-handler.js";
import { requireHost, requireHostStrict } from "../host-auth.js";
import {
  getSpotifyAppStatus,
  setSpotifyAppSettings,
  clearSpotifyAppSettings,
  testSpotifyAppConnection,
} from "../spotify-app.js";
import {
  getSonosConnectionStatus,
  setSonosConnectionSettings,
  clearSonosConnectionSettings,
  testSonosConnection,
} from "../sonos-config.js";
import {
  getLastfmStatus,
  setLastfmSettings,
  clearLastfmSettings,
  testLastfmConnection,
} from "../lastfm.js";
import {
  getHaStatus,
  setHaSettings,
  clearHaSettings,
  testHaConnection,
} from "../home-assistant.js";
import { setSonosTargetRoom } from "../settings.js";
import { resetSonosManager } from "../sonos.js";

/** @param {import('express').Express} app */
export function registerConnectionRoutes(app) {
  // Spotify Developer app credentials. Status never includes the client secret;
  // POST saves to data/spotify-app.json (env can override).
  app.get("/api/spotify/app/status", requireHost, (_req, res) => {
    res.json(getSpotifyAppStatus());
  });

  app.post("/api/spotify/app", requireHostStrict, (req, res) => {
    try {
      const body = req.body ?? {};
      const status = setSpotifyAppSettings({
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        redirectUri: body.redirectUri,
        market: body.market,
        clearSecret: !!body.clearSecret,
      });
      res.json({ ok: true, ...status });
    } catch (err) {
      console.error("[spotify/app]", err.message);
      res.status(400).json({ error: err.message || "Could not save Spotify app settings." });
    }
  });

  app.post("/api/spotify/app/clear", requireHostStrict, (_req, res) => {
    res.json({ ok: true, ...clearSpotifyAppSettings() });
  });

  app.post("/api/spotify/app/test", requireHost, asyncHandler(async (_req, res) => {
    try {
      const result = await testSpotifyAppConnection();
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (err) {
      console.error("[spotify/app/test]", err.message);
      res.status(502).json({ ok: false, error: err.message || "Could not reach Spotify." });
    }
  }));

  // Sonos speaker IP + room (Settings → Connections). Helps when SSDP discovery
  // fails across VLANs/VPNs. Saves to data/sonos.json + .env.
  app.get("/api/sonos/connection", requireHost, (_req, res) => {
    res.json(getSonosConnectionStatus());
  });

  app.post("/api/sonos/connection", requireHostStrict, (req, res) => {
    try {
      const body = req.body ?? {};
      const status = setSonosConnectionSettings({
        host: body.host,
        room: body.room,
        region: body.region,
        clearHost: !!body.clearHost,
        clearRoom: !!body.clearRoom,
      });
      // Keep the in-app Sonos Group picker aligned with the Connections room.
      if (body.room !== undefined) {
        setSonosTargetRoom(status.room || null);
      }
      resetSonosManager();
      res.json({ ok: true, ...status });
    } catch (err) {
      console.error("[sonos/connection]", err.message);
      res.status(400).json({ error: err.message || "Could not save Sonos settings." });
    }
  });

  app.post("/api/sonos/connection/clear", requireHostStrict, (_req, res) => {
    const status = clearSonosConnectionSettings();
    setSonosTargetRoom(null);
    resetSonosManager();
    res.json({ ok: true, ...status });
  });

  app.post("/api/sonos/connection/test", requireHost, asyncHandler(async (_req, res) => {
    try {
      const result = await testSonosConnection();
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (err) {
      console.error("[sonos/connection/test]", err.message);
      res
        .status(502)
        .json({ ok: false, error: err.message || "Could not reach Sonos." });
    }
  }));

  // Last.fm API key for genre tagging + Discover Similar. Status never includes
  // the key; POST saves to data/lastfm.json (env can override).
  app.get("/api/lastfm/status", requireHost, (_req, res) => {
    res.json(getLastfmStatus());
  });

  app.post("/api/lastfm", requireHostStrict, (req, res) => {
    try {
      const body = req.body ?? {};
      const status = setLastfmSettings({
        apiKey: body.apiKey,
        clearKey: !!body.clearKey,
      });
      res.json({ ok: true, ...status });
    } catch (err) {
      console.error("[lastfm]", err.message);
      res.status(400).json({ error: err.message || "Could not save Last.fm settings." });
    }
  });

  app.post("/api/lastfm/clear", requireHostStrict, (_req, res) => {
    res.json({ ok: true, ...clearLastfmSettings() });
  });

  app.post("/api/lastfm/test", requireHost, asyncHandler(async (_req, res) => {
    try {
      const result = await testLastfmConnection();
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (err) {
      console.error("[lastfm/test]", err.message);
      res.status(502).json({ ok: false, error: err.message || "Could not reach Last.fm." });
    }
  }));

  // Home Assistant credentials for DJ voice announcements. Status never includes
  // the token; POST saves URL/token to data/home-assistant.json (env can override).
  app.get("/api/homeassistant/status", requireHost, (_req, res) => {
    res.json(getHaStatus());
  });

  app.post("/api/homeassistant", requireHostStrict, (req, res) => {
    try {
      const body = req.body ?? {};
      const status = setHaSettings({
        url: body.url,
        token: body.token,
        clearToken: !!body.clearToken,
      });
      res.json({ ok: true, ...status });
    } catch (err) {
      console.error("[homeassistant]", err.message);
      res.status(400).json({ error: err.message || "Could not save Home Assistant settings." });
    }
  });

  app.post("/api/homeassistant/clear", requireHostStrict, (_req, res) => {
    res.json({ ok: true, ...clearHaSettings() });
  });

  app.post("/api/homeassistant/test", requireHost, asyncHandler(async (_req, res) => {
    try {
      const result = await testHaConnection();
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (err) {
      console.error("[homeassistant/test]", err.message);
      res.status(502).json({ ok: false, error: err.message || "Could not reach Home Assistant." });
    }
  }));
}
