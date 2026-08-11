// System routes: liveness/readiness probes, the guest Join QR, the resolved
// media base URL, and the host-triggered restart.

import QRCode from "qrcode";
import { asyncHandler } from "../http/async-handler.js";
import { getSpotifyAppStatus } from "../spotify-app.js";
import { getPublicBaseUrl } from "../dj-voice.js";
import { requireHostStrict } from "../host-auth.js";
import { getSonosHost } from "../sonos-config.js";
import {
  evaluateReadiness,
  probeDataWritable,
} from "../readiness.js";
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

  // Readiness: process up + data writable. partyReady also needs Spotify keys
  // and Sonos connected/connecting or a configured speaker host. Fresh installs
  // can still be ready=true with partyReady=false so the setup UI serves.
  // Returns 503 when ready is false (not merely when partyReady is false).
  app.get("/api/ready", (_req, res) => {
    const payload = evaluateReadiness({
      version: VERSION,
      listening: isListening(),
      shuttingDown: isShuttingDown(),
      dataWritable: probeDataWritable(),
      spotifyConfigured: !!getSpotifyAppStatus().configured,
      sonosStatus: nowPlayingMonitor?.health?.status || "unknown",
      sonosHostConfigured: !!String(getSonosHost() || "").trim(),
    });
    payload.checks.nowPlaying = nowPlayingDiagnostics();
    if (!payload.ready) return res.status(503).json(payload);
    res.json(payload);
  });

  // Join Code: public LAN URL + QR (PNG for Fully/Android WebView; SVG kept for tools).
  app.get("/api/join", asyncHandler(async (_req, res) => {
    try {
      const url = getPublicBaseUrl();
      const qrOpts = {
        margin: 1,
        width: 280,
        errorCorrectionLevel: "M",
      };
      // PNG data URL — stroke-based SVG from qrcode often paints blank in Fully.
      const [qrPng, qrSvg] = await Promise.all([
        QRCode.toDataURL(url, qrOpts),
        QRCode.toString(url, { type: "svg", ...qrOpts }),
      ]);
      res.json({ url, qrPng, qrSvg });
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
