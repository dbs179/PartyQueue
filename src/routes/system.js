// System routes: liveness/readiness probes, the guest Join QR, the resolved
// media base URL, and the host-triggered restart.

import QRCode from "qrcode";
import { asyncHandler } from "../http/async-handler.js";
import { getSpotifyAppStatus } from "../spotify-app.js";
import { getPublicBaseUrl } from "../dj-voice.js";
import { requireHostStrict } from "../host-auth.js";
import {
  nowPlayingDiagnostics,
  nowPlayingMonitor,
} from "../now-playing-http.js";

/** @param {import('express').Express} app @param {import('./api.js').ApiCtx} ctx */
export function registerSystemRoutes(app, ctx) {
  const { VERSION, isListening, isShuttingDown, destructiveLimit, requestShutdown } =
    ctx;

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      // Boolean only — never secrets. Helps first-run nudges on fresh installs.
      spotifyConfigured: !!getSpotifyAppStatus().configured,
    });
  });

  // Orchestrator / Docker readiness. Does not require Sonos or Spotify — a fresh
  // install must still serve the setup UI. Returns 503 while shutting down.
  app.get("/api/ready", (_req, res) => {
    const listening = isListening();
    const ready = listening && !isShuttingDown();
    const payload = {
      ready,
      version: VERSION,
      checks: {
        listening,
        shuttingDown: isShuttingDown(),
        spotifyConfigured: !!getSpotifyAppStatus().configured,
        sonos: nowPlayingMonitor?.health?.status || "unknown",
        nowPlaying: nowPlayingDiagnostics(),
      },
    };
    if (!ready) return res.status(503).json(payload);
    res.json(payload);
  });

  // Join Code: public LAN URL + QR SVG so guests can scan into the queue app.
  app.get("/api/join", asyncHandler(async (_req, res) => {
    try {
      const url = getPublicBaseUrl();
      const qrSvg = await QRCode.toString(url, {
        type: "svg",
        margin: 1,
        width: 280,
        errorCorrectionLevel: "M",
      });
      res.json({ url, qrSvg });
    } catch (err) {
      console.error("[join]", err.message);
      res.status(503).json({
        error:
          err.message ||
          "Could not build join URL. Set PUBLIC_BASE_URL=http://<this-pc-ip>:8088",
      });
    }
  }));

  // Booth status: resolved Sonos-reachable base URL (silence bridge + Join).
  app.get("/api/media-base", (_req, res) => {
    try {
      res.json({ url: getPublicBaseUrl() });
    } catch (err) {
      res.status(503).json({
        error:
          err.message ||
          "Could not resolve media URL. Set PUBLIC_BASE_URL=http://<this-host-ip>:8088",
      });
    }
  });

  app.post("/api/restart", requireHostStrict, destructiveLimit, (_req, res) => {
    res.json({ ok: true, restarting: true });
    setTimeout(() => {
      requestShutdown({ reason: "host restart", restart: true, exit: true });
    }, 400);
  });
}
