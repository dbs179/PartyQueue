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
  getDjPersona,
  normalizeDjPersonaId,
  DJ_PERSONA_SISTER_STATIC,
} from "../settings.js";
import {
  listBanners,
  listBannersForSlot,
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

/** @param {unknown} raw @returns {"desktop"|"mobile"} */
function bannerSlot(raw) {
  return raw === "mobile" ? "mobile" : "desktop";
}

function bannersResponse() {
  const branding = getBrandingSettings();
  const all = listBanners();
  return {
    active: branding.heroBanner,
    activeMobile: branding.heroBannerMobile,
    defaultUrl: "/hero.jpg",
    banners: all,
    bannersDesktop: listBannersForSlot("desktop"),
    bannersMobile: listBannersForSlot("mobile"),
  };
}

function personaIdFromReq(req) {
  return normalizeDjPersonaId(req.body?.persona ?? req.query?.persona);
}

function applyDjIcon(name, personaId) {
  if (personaId === DJ_PERSONA_SISTER_STATIC) {
    return setDjVoiceSettings({ djSisterStatic: { djIcon: name } });
  }
  return setDjVoiceSettings({ djIcon: name });
}

function djIconListPayload(personaId) {
  const hr = getDjVoiceSettings();
  const ss = getDjPersona(DJ_PERSONA_SISTER_STATIC);
  const activePersona =
    personaId === DJ_PERSONA_SISTER_STATIC ? ss : hr;
  return {
    ok: true,
    active: activePersona.djIcon,
    djIcon: activePersona.djIcon,
    djIconUrl: activePersona.djIconUrl,
    sisterStaticActive: ss.djIcon,
    defaultUrl: "/dj-icons/headphones.png",
    icons: listDjIcons(),
  };
}

/** @param {import('express').Express} app */
export function registerMediaRoutes(app) {
  // Hero banners: shared upload pool with independent desktop / phone active picks.
  // Null desktop → built-in public/hero.jpg; null phone → falls back to desktop.
  app.get("/api/banners", requireHost, (_req, res) => {
    res.json(bannersResponse());
  });

  // Larger JSON limit only here, since banners arrive as base64 data URLs.
  app.post("/api/banners", requireHost, express.json({ limit: "12mb" }), (req, res) => {
    try {
      const name = saveBanner(req.body?.image);
      const slot = bannerSlot(req.body?.slot);
      if (slot === "mobile") {
        setBrandingSettings({ heroBannerMobile: name });
      } else {
        setBrandingSettings({ heroBanner: name });
      }
      res.json({ ok: true, ...bannersResponse() });
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
    const slot = bannerSlot(req.body?.slot);
    if (slot === "mobile") {
      setBrandingSettings({ heroBannerMobile: name });
    } else {
      setBrandingSettings({ heroBanner: name });
    }
    res.json({ ok: true, ...bannersResponse() });
  });

  app.delete("/api/banners/:name", requireHost, (req, res) => {
    try {
      const { name } = req.params;
      const branding = getBrandingSettings();
      const existed = deleteBanner(name);
      if (existed) {
        const patch = {};
        if (branding.heroBanner === name) patch.heroBanner = null;
        if (branding.heroBannerMobile === name) patch.heroBannerMobile = null;
        if (Object.keys(patch).length) setBrandingSettings(patch);
      }
      res.json({
        ok: true,
        ...bannersResponse(),
      });
    } catch (err) {
      res.status(400).json({ error: err.message || "Could not delete banner." });
    }
  });

  // DJ Voice icons: list + active, upload (newest becomes active), select, delete.
  app.get("/api/dj-icon", requireHost, (req, res) => {
    res.json(djIconListPayload(personaIdFromReq(req)));
  });

  app.post("/api/dj-icon", requireHost, express.json({ limit: "4mb" }), (req, res) => {
    try {
      const name = saveDjIcon(req.body?.image);
      applyDjIcon(name, personaIdFromReq(req));
      res.json(djIconListPayload(personaIdFromReq(req)));
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
    applyDjIcon(name, personaIdFromReq(req));
    res.json(djIconListPayload(personaIdFromReq(req)));
  });

  app.delete("/api/dj-icon/:name", requireHost, (req, res) => {
    try {
      const { name } = req.params;
      const existed = deleteDjIcon(name);
      if (existed) {
        const hr = getDjVoiceSettings();
        if (hr.djIcon === name) setDjVoiceSettings({ djIcon: null });
        if (hr.djSisterStatic?.djIcon === name) {
          setDjVoiceSettings({ djSisterStatic: { djIcon: null } });
        }
      }
      res.json(djIconListPayload(personaIdFromReq(req)));
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
