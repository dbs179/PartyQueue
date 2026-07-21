// Lyrics lookup via LRClib (https://lrclib.net) — free, no API key.
// Match by title/artist/album/duration; cache so party phones share one fetch.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LRCLIB_BASE = "https://lrclib.net";
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 80;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let appVersion = "0";
try {
  appVersion = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
  ).version;
} catch {
  /* keep default */
}

const USER_AGENT = `PartyQueue/${appVersion}`;

/** @type {Map<string, { at: number, value: object }>} */
const cache = new Map();

function cacheKey({ title, artist, album, duration }) {
  const d =
    duration != null && Number.isFinite(Number(duration))
      ? Math.round(Number(duration))
      : "";
  return [
    String(title || "").trim().toLowerCase(),
    String(artist || "").trim().toLowerCase(),
    String(album || "").trim().toLowerCase(),
    d,
  ].join("|");
}

function readCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // LRU touch
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function writeCache(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { at: Date.now(), value });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

function normalizeRecord(rec) {
  if (!rec || typeof rec !== "object") {
    return { found: false };
  }
  const plain = typeof rec.plainLyrics === "string" ? rec.plainLyrics : "";
  const synced = typeof rec.syncedLyrics === "string" ? rec.syncedLyrics : "";
  const instrumental = !!rec.instrumental;
  if (instrumental && !plain && !synced) {
    return { found: true, instrumental: true, plainLyrics: "", syncedLyrics: "" };
  }
  if (!plain && !synced) return { found: false };
  return {
    found: true,
    instrumental: false,
    plainLyrics: plain,
    syncedLyrics: synced,
    trackName: rec.trackName || null,
    artistName: rec.artistName || null,
  };
}

async function lrclibFetch(urlPath) {
  const res = await fetch(`${LRCLIB_BASE}${urlPath}`, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`LRClib ${res.status}`);
  }
  return res.json();
}

function pickBestSearchHit(results, duration) {
  if (!Array.isArray(results) || !results.length) return null;
  const pool = results.filter(
    (r) => r && (r.plainLyrics || r.syncedLyrics || r.instrumental)
  );
  if (!pool.length) return results[0] || null;

  const target =
    duration != null && Number.isFinite(duration) ? Math.round(duration) : null;

  let best = null;
  let bestScore = -Infinity;
  for (const r of pool) {
    let score = 0;
    if (r.syncedLyrics) score += 100;
    else if (r.plainLyrics) score += 40;
    if (r.instrumental) score += 5;
    if (target != null && Number.isFinite(Number(r.duration))) {
      const delta = Math.abs(Math.round(Number(r.duration)) - target);
      // Prefer close duration; within ±5s is a strong match.
      score += Math.max(0, 40 - delta * 4);
    }
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

/**
 * Look up lyrics for a track. Duration (seconds) improves LRClib matching.
 * @param {{ title?: string, artist?: string, album?: string, duration?: number|null }} q
 */
export async function lookupLyrics(q = {}) {
  const title = String(q.title || "").trim();
  const artist = String(q.artist || "").trim();
  if (!title || !artist) {
    return { found: false, error: "Missing title or artist." };
  }
  const album = String(q.album || "").trim();
  const durationRaw = q.duration;
  const duration =
    durationRaw != null && Number.isFinite(Number(durationRaw))
      ? Number(durationRaw)
      : null;

  const key = cacheKey({ title, artist, album, duration });
  const cached = readCache(key);
  if (cached) return { ...cached, cached: true };

  let record = null;

  if (duration != null && duration > 0 && album) {
    const params = new URLSearchParams({
      track_name: title,
      artist_name: artist,
      album_name: album,
      duration: String(Math.round(duration)),
    });
    try {
      record = await lrclibFetch(`/api/get?${params}`);
    } catch (err) {
      console.error("[lyrics] get failed:", err.message);
    }
  }

  // Always search as well when /get missed synced lyrics — search often has
  // alternate timed uploads for the same song.
  if (!record || !record.syncedLyrics) {
    const params = new URLSearchParams({
      track_name: title,
      artist_name: artist,
    });
    if (album) params.set("album_name", album);
    try {
      const results = await lrclibFetch(`/api/search?${params}`);
      const hit = pickBestSearchHit(results, duration);
      if (
        hit &&
        (!record ||
          (hit.syncedLyrics && !record.syncedLyrics) ||
          (!record.plainLyrics && hit.plainLyrics))
      ) {
        record = hit;
      }
    } catch (err) {
      if (!record) {
        console.error("[lyrics] search failed:", err.message);
        throw new Error(err.message || "Could not fetch lyrics.");
      }
      console.error("[lyrics] search failed:", err.message);
    }
  }

  const out = normalizeRecord(record);
  writeCache(key, out);
  return out;
}

/** Fire-and-forget cache warm so overlay opens hit LRClib less often. */
export function warmLyrics(q = {}) {
  const title = String(q.title || "").trim();
  const artist = String(q.artist || "").trim();
  if (!title || !artist) return;
  const album = String(q.album || "").trim();
  const durationRaw = q.duration;
  const duration =
    durationRaw != null && Number.isFinite(Number(durationRaw))
      ? Number(durationRaw)
      : null;
  const key = cacheKey({ title, artist, album, duration });
  if (readCache(key)) return;
  lookupLyrics({ title, artist, album, duration }).catch((err) => {
    console.error("[lyrics] warm failed:", err.message);
  });
}
