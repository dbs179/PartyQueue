// Media routes: hero banners, DJ Voice icons, and the album-art proxy with
// its byte-bounded in-memory cache.

import express from "express";
import { asyncHandler } from "../http/async-handler.js";
import {
  createByteLruCache,
  createInFlightCoalescer,
} from "../byte-lru-cache.js";
import { requireHost } from "../host-auth.js";
import {
  getBrandingSettings,
  setBrandingSettings,
  getDjVoiceSettings,
  setDjVoiceSettings,
} from "../settings.js";
import {
  listBanners,
  saveBanner,
  deleteBanner,
  bannerExists,
} from "../banners.js";
import {
  listDjIcons,
  saveDjIcon,
  deleteDjIcon,
  djIconExists,
} from "../dj-icon.js";
import { spotifyTrackId } from "../sampler.js";
import { getTracksByIds } from "../spotify.js";
import { isKnownSonosHost } from "../sonos.js";

/** @param {import('express').Express} app */
export function registerMediaRoutes(app) {
  // Hero banners: list stored banners + the active one, upload a new one, pick an
  // existing one, or delete. The active banner is tracked in branding settings
  // (`heroBanner`); null means the built-in public/hero.jpg.
  app.get("/api/banners", requireHost, (_req, res) => {
    res.json({
      active: getBrandingSettings().heroBanner,
      defaultUrl: "/hero.jpg",
      banners: listBanners(),
    });
  });

  // Larger JSON limit only here, since banners arrive as base64 data URLs.
  app.post("/api/banners", requireHost, express.json({ limit: "12mb" }), (req, res) => {
    try {
      const name = saveBanner(req.body?.image);
      setBrandingSettings({ heroBanner: name }); // newly uploaded becomes active
      res.json({ ok: true, active: name, banners: listBanners() });
    } catch (err) {
      console.error("[banners] upload:", err.message);
      res.status(400).json({ error: err.message || "Could not save banner." });
    }
  });

  app.post("/api/banners/select", requireHost, (req, res) => {
    const name = req.body?.name ?? null;
    if (name !== null && !bannerExists(name)) {
      return res.status(404).json({ error: "Banner not found." });
    }
    setBrandingSettings({ heroBanner: name }); // null reverts to the built-in hero
    res.json({ ok: true, active: name, banners: listBanners() });
  });

  app.delete("/api/banners/:name", requireHost, (req, res) => {
    try {
      const { name } = req.params;
      const existed = deleteBanner(name);
      // If we just removed the active banner, fall back to the built-in default.
      if (existed && getBrandingSettings().heroBanner === name) {
        setBrandingSettings({ heroBanner: null });
      }
      res.json({
        ok: true,
        active: getBrandingSettings().heroBanner,
        banners: listBanners(),
      });
    } catch (err) {
      res.status(400).json({ error: err.message || "Could not delete banner." });
    }
  });

  // DJ Voice icons: list + active, upload (newest becomes active), select, delete.
  app.get("/api/dj-icon", requireHost, (_req, res) => {
    const dj = getDjVoiceSettings();
    res.json({
      ok: true,
      active: dj.djIcon,
      djIcon: dj.djIcon,
      djIconUrl: dj.djIconUrl,
      defaultUrl: "/dj-icons/flat.png",
      icons: listDjIcons(),
    });
  });

  app.post("/api/dj-icon", requireHost, express.json({ limit: "4mb" }), (req, res) => {
    try {
      const name = saveDjIcon(req.body?.image);
      const dj = setDjVoiceSettings({ djIcon: name });
      res.json({
        ok: true,
        active: dj.djIcon,
        djIcon: dj.djIcon,
        djIconUrl: dj.djIconUrl,
        icons: listDjIcons(),
      });
    } catch (err) {
      console.error("[dj-icon] upload:", err.message);
      res.status(400).json({ error: err.message || "Could not save DJ icon." });
    }
  });

  app.post("/api/dj-icon/select", requireHost, (req, res) => {
    const name = req.body?.name ?? null;
    if (name !== null && !djIconExists(name)) {
      return res.status(404).json({ error: "DJ icon not found." });
    }
    const dj = setDjVoiceSettings({ djIcon: name }); // null = bundled default
    res.json({
      ok: true,
      active: dj.djIcon,
      djIcon: dj.djIcon,
      djIconUrl: dj.djIconUrl,
      icons: listDjIcons(),
    });
  });

  app.delete("/api/dj-icon/:name", requireHost, (req, res) => {
    try {
      const { name } = req.params;
      const existed = deleteDjIcon(name);
      if (existed && getDjVoiceSettings().djIcon === name) {
        setDjVoiceSettings({ djIcon: null });
      }
      const dj = getDjVoiceSettings();
      res.json({
        ok: true,
        active: dj.djIcon,
        djIcon: dj.djIcon,
        djIconUrl: dj.djIconUrl,
        icons: listDjIcons(),
      });
    } catch (err) {
      res.status(400).json({ error: err.message || "Could not delete DJ icon." });
    }
  });

  // Proxy album art from the Sonos speakers (port 1400) to avoid exposing
  // speaker IPs to clients and to work across subnets.
  // Small in-memory cache of album-art bytes, keyed by the upstream URL. Art is
  // immutable per URL, so once one client (or a poll) fetches a track's cover we
  // serve it instantly to everyone and stop re-hitting the (slow) Sonos speaker.
  // The LRU is byte-bounded so unusually large images cannot consume unbounded RAM.
  const ART_CACHE_MAX_BYTES = 16 * 1024 * 1024;
  const artCache = createByteLruCache(ART_CACHE_MAX_BYTES);
  const artInFlight = createInFlightCoalescer();

  /** Pull a Spotify track id out of a (possibly multi-encoded) Sonos getaa URL. */
  function trackIdFromArtUrl(u) {
    let s = String(u || "");
    for (let i = 0; i < 4; i++) {
      const id = spotifyTrackId(s);
      if (id) return id;
      try {
        const next = decodeURIComponent(s);
        if (next === s) break;
        s = next;
      } catch {
        break;
      }
    }
    return null;
  }

  function sendCachedArt(res, key, hit) {
    res.set("Content-Type", hit.type);
    res.set("Cache-Control", "public, max-age=86400, immutable");
    return res.send(hit.body);
  }

  function putArtCache(key, hit) {
    artCache.set(key, hit);
  }

  /** Fetch + cache album art bytes from a Spotify CDN image URL. */
  async function fetchSpotifyArtBytes(trackId) {
    if (!trackId) return null;
    const info = (await getTracksByIds([trackId])).get(trackId);
    const imageUrl = info?.image;
    if (!imageUrl) return null;
    const upstream = await fetch(imageUrl, {
      signal: AbortSignal.timeout(5000),
    });
    if (!upstream.ok) return null;
    const type = upstream.headers.get("content-type") || "image/jpeg";
    const body = Buffer.from(await upstream.arrayBuffer());
    if (!body.length) return null;
    return { body, type };
  }

  async function loadAlbumArt(key) {
    const target = new URL(key);
    const allowed =
      target.port === "1400" && (await isKnownSonosHost(target.hostname));
    if (!allowed) {
      const error = new Error("Album-art host is not allowed.");
      error.status = 403;
      throw error;
    }

    const trackId = trackIdFromArtUrl(key);
    if (trackId) {
      try {
        const art = await fetchSpotifyArtBytes(trackId);
        if (art) return art;
      } catch (err) {
        console.warn("[albumart] Spotify fallback failed:", err.message);
      }
    }

    const upstream = await fetch(target.toString(), {
      signal: AbortSignal.timeout(2500),
    });
    if (!upstream.ok) throw new Error(`Sonos artwork ${upstream.status}`);
    const type = upstream.headers.get("content-type") || "image/jpeg";
    const body = Buffer.from(await upstream.arrayBuffer());
    if (!body.length) throw new Error("Sonos returned empty artwork.");
    return { body, type };
  }

  app.get("/api/albumart", asyncHandler(async (req, res) => {
    const u = req.query.u;
    if (!u) return res.status(400).end();
    const key = String(u);

    const hit = artCache.get(key);
    if (hit) return sendCachedArt(res, key, hit);

    const pending = artInFlight.run(key, () => loadAlbumArt(key));
    try {
      const art = await pending;
      putArtCache(key, art);
      return sendCachedArt(res, key, art);
    } catch (err) {
      res.status(err.status || 502).end();
    }
  }));
}
