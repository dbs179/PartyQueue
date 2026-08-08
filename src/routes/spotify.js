// Spotify routes: guest search, the one-time host OAuth flow, playlists,
// the lightweight status poll, and the host-triggered cache re-warm.

import crypto from "node:crypto";
import { asyncHandler } from "../http/async-handler.js";
import { requireHost, requireHostPage } from "../host-auth.js";
import {
  exchangeCodeForTokens,
  getAuthorizeUrl,
  isUserConnected,
  getPlaylists,
  searchTracks,
  searchArtists,
  rewarmCaches,
  spotifyCooldownMs,
  getPoolWarmedAt,
} from "../spotify.js";
import { getContentSettings } from "../settings.js";
import { warmGenresFromPool } from "../genres.js";

/**
 * @param {import('express').Express} app
 * @param {{ searchLimit: import('express').RequestHandler }} ctx
 */
export function registerSpotifyRoutes(app, ctx) {
  const { searchLimit } = ctx;
  app.get("/api/search", searchLimit, asyncHandler(async (req, res) => {
    const query = req.query.q;
    if (!query || !String(query).trim()) {
      return res.json({ tracks: [], artists: [] });
    }
    try {
      const q = String(query);
      const [trackHits, artistHits] = await Promise.all([
        searchTracks(q, 20),
        searchArtists(q, 5).catch((err) => {
          console.warn("[search] artists:", err.message);
          return [];
        }),
      ]);
      let tracks = trackHits;
      // Hide explicit results when the host's content filter is on.
      if (getContentSettings().filterExplicit) {
        tracks = tracks.filter((t) => !t.explicit);
      }
      // Prefer an exact (case-insensitive) name match for Set Request.
      const needle = q.trim().toLowerCase();
      const artists = [...artistHits].sort((a, b) => {
        const aExact = a.name.toLowerCase() === needle ? 0 : 1;
        const bExact = b.name.toLowerCase() === needle ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        return (b.popularity || 0) - (a.popularity || 0);
      });
      res.json({ tracks, artists });
    } catch (err) {
      console.error("[search]", err.message);
      res.status(502).json({ error: "Spotify search failed. Check your credentials." });
    }
  }));

  // ---- Spotify account connection (one-time host login) ----
  // Pending OAuth states for CSRF protection, with a short TTL.
  const pendingStates = new Map();
  const STATE_TTL_MS = 10 * 60_000;

  app.get("/api/auth/status", (_req, res) => {
    res.json({ connected: isUserConnected() });
  });

  app.get("/auth/login", requireHostPage, (_req, res) => {
    const state = crypto.randomUUID();
    pendingStates.set(state, Date.now());
    res.redirect(getAuthorizeUrl(state));
  });

  app.get("/auth/callback", asyncHandler(async (req, res) => {
    const { code, state, error } = req.query;
    if (error) {
      return res.status(400).send(`Spotify authorization failed: ${error}`);
    }
    const issuedAt = state && pendingStates.get(String(state));
    if (!issuedAt || Date.now() - issuedAt > STATE_TTL_MS) {
      return res.status(400).send("Invalid or expired login state. Try again.");
    }
    pendingStates.delete(String(state));

    try {
      await exchangeCodeForTokens(String(code));
      res.send(
        "<!doctype html><meta charset='utf-8'><title>Connected</title>" +
          "<body style='font-family:sans-serif;background:#0f0f17;color:#f5f5fa;" +
          "display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>" +
          "<div style='text-align:center'><h1>Spotify connected ✅</h1>" +
          "<p>You can close this tab and return to PartyQueue.</p></div></body>"
      );
    } catch (err) {
      console.error("[auth/callback]", err.message);
      res
        .status(502)
        .send("Could not connect Spotify. Check the PartyQueue server log for details.");
    }
  }));

  app.get("/api/playlists", asyncHandler(async (_req, res) => {
    if (!isUserConnected()) {
      return res.status(200).json({ connected: false, playlists: [] });
    }
    try {
      const playlists = await getPlaylists();
      res.json({ connected: true, playlists });
    } catch (err) {
      console.error("[playlists]", err.message);
      res.status(502).json({ error: err.message || "Could not load playlists." });
    }
  }));

  // Lightweight Spotify status for the Settings indicator. Reads only local state
  // (no Spotify calls), so it's safe to poll even during a rate-limit cooldown.
  app.get("/api/spotify/status", (_req, res) => {
    const cooldownMs = spotifyCooldownMs();
    res.json({
      connected: isUserConnected(),
      rateLimited: cooldownMs > 0,
      cooldownMs,
      cooldownSeconds: Math.ceil(cooldownMs / 1000),
      poolWarmedAt: getPoolWarmedAt(),
    });
  });

  // Host-triggered re-warm of the cached playlist list + track pool + genre tags.
  // Use this after adding/removing playlists rather than refetching on every load.
  app.post("/api/cache/refresh", requireHost, asyncHandler(async (_req, res) => {
    if (!isUserConnected()) {
      return res.status(400).json({ error: "Connect your Spotify account first." });
    }
    try {
      const summary = await rewarmCaches();
      // Refresh Last.fm genre tags from the freshly-built pool (best effort).
      warmGenresFromPool().catch((err) =>
        console.error("[cache/refresh] genre warm failed:", err.message)
      );
      res.json({ ok: true, ...summary });
    } catch (err) {
      console.error("[cache/refresh]", err.message);
      const cooldown = Math.ceil(spotifyCooldownMs() / 1000);
      res.status(502).json({
        error: cooldown
          ? `Spotify is rate-limited. Try again in about ${cooldown}s.`
          : err.message || "Could not refresh the cache.",
      });
    }
  }));
}
