// Album-art proxy URLs and cache keys. Cover bytes must follow the playing
// Spotify id, not Sonos AlbumArtUri — DIDL often updates title/uri first and
// leaves the previous getaa URL (or a generic /getaa) in place.

import { spotifyTrackId } from "./sampler.js";

/** Pull a Spotify track id out of a (possibly multi-encoded) Sonos getaa URL. */
export function trackIdFromArtUrl(u) {
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

/** Prefer an explicit id (`t=`), then parse URIs / getaa URLs. */
export function albumArtTrackId(t, u) {
  const fromT = String(t || "").trim();
  if (/^[A-Za-z0-9]{16,32}$/.test(fromT)) return fromT;
  return spotifyTrackId(fromT) || trackIdFromArtUrl(fromT) || trackIdFromArtUrl(u);
}

/**
 * Cache key for proxied cover bytes. Track id wins so a lagged Sonos getaa
 * URL cannot keep serving the previous song under an immutable Cache-Control.
 */
export function albumArtCacheKey({ u = "", t = "" } = {}) {
  const id = albumArtTrackId(t, u);
  if (id) return `t:${id}`;
  const url = String(u || "");
  return url ? `u:${url}` : "";
}

/**
 * Guest-facing cover URL. `t=` is the playing/queue track so browsers and the
 * proxy cannot reuse another song's cached JPEG.
 */
export function buildAlbumArtProxyUrl(albumArtUri, host, trackUri) {
  const id = spotifyTrackId(trackUri);
  let absolute = "";
  if (albumArtUri) {
    const uri = String(albumArtUri);
    absolute = uri.startsWith("http")
      ? uri
      : host
        ? `http://${host}:1400${uri}`
        : "";
  }
  if (!absolute && !id) return null;
  const params = new URLSearchParams();
  if (absolute) params.set("u", absolute);
  if (id) params.set("t", id);
  return `/api/albumart?${params}`;
}
