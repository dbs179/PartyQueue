// Lyrics lookup via LRClib (https://lrclib.net) — free, no API key.
// Match by title/artist/album/duration; cache so party phones share one fetch.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";

const LRCLIB_BASE = "https://lrclib.net";
const FOUND_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 200;
const LOOKUP_BUDGET_MS = 8_000;
const PROVIDER_BACKOFF_MS = 10_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE =
  process.env.PARTYQUEUE_LYRICS_CACHE_FILE ||
  (process.env.NODE_ENV === "production"
    ? path.join(__dirname, "..", "data", "lyrics-cache.json")
    : "");
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
/** @type {Map<string, Promise<object>>} */
const inFlight = new Map();
let providerBackoffUntil = 0;

function loadPersistentCache() {
  if (!CACHE_FILE) return;
  try {
    const rows = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (
        Array.isArray(row) &&
        row.length === 2 &&
        typeof row[0] === "string" &&
        row[1] &&
        typeof row[1] === "object"
      ) {
        cache.set(row[0], row[1]);
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("[lyrics] cache load failed:", err.message);
    }
  }
}

function persistCache() {
  if (!CACHE_FILE) return;
  try {
    writeFileAtomic(CACHE_FILE, JSON.stringify([...cache.entries()]));
  } catch (err) {
    console.error("[lyrics] cache save failed:", err.message);
  }
}

loadPersistentCache();

export class LyricsUnavailableError extends Error {
  constructor(retryAfterMs = PROVIDER_BACKOFF_MS) {
    super("Lyrics service is temporarily busy.");
    this.name = "LyricsUnavailableError";
    this.retryAfterMs = Math.max(1_000, Number(retryAfterMs) || 0);
  }
}

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
  const ttl = hit.value?.found ? FOUND_CACHE_TTL_MS : MISS_CACHE_TTL_MS;
  if (Date.now() - hit.at > ttl) {
    cache.delete(key);
    persistCache();
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
  persistCache();
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

async function lrclibFetch(urlPath, deadline) {
  const remainingMs = Math.max(1, deadline - Date.now());
  const res = await fetch(`${LRCLIB_BASE}${urlPath}`, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(remainingMs),
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
  const pending = inFlight.get(key);
  if (pending) return pending;
  if (Date.now() < providerBackoffUntil) {
    throw new LyricsUnavailableError(providerBackoffUntil - Date.now());
  }

  const request = (async () => {
    const deadline = Date.now() + LOOKUP_BUDGET_MS;
    let record = null;

    if (duration != null && duration > 0 && album) {
      const params = new URLSearchParams({
        track_name: title,
        artist_name: artist,
        album_name: album,
        duration: String(Math.round(duration)),
      });
      try {
        record = await lrclibFetch(`/api/get?${params}`, deadline);
      } catch (err) {
        console.error("[lyrics] get failed:", err.message);
      }
    }

    // Search when /get missed synced lyrics. Both attempts share one deadline,
    // so an overloaded provider cannot make the overlay wait twice.
    if (!record || !record.syncedLyrics) {
      const params = new URLSearchParams({
        track_name: title,
        artist_name: artist,
      });
      if (album) params.set("album_name", album);
      try {
        const results = await lrclibFetch(`/api/search?${params}`, deadline);
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
        if (record) {
          console.error("[lyrics] search failed:", err.message);
        } else {
          providerBackoffUntil = Date.now() + PROVIDER_BACKOFF_MS;
          console.error("[lyrics] search failed:", err.message);
          throw new LyricsUnavailableError();
        }
      }
    }

    providerBackoffUntil = 0;
    const out = normalizeRecord(record);
    writeCache(key, out);
    return out;
  })();
  inFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (inFlight.get(key) === request) {
      inFlight.delete(key);
    }
  }
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
