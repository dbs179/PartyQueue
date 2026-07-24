// Rolling memory of recently heard / queued songs.
//
// Two different concerns share this store:
//   1) HISTORY_CAP (1500) — how many songs we keep on disk for the Memory UI
//      and long-term recall. Always remember up to this many.
//   2) songMemory (Settings) — how many of the *newest* entries Random treats
//      as "too recent to replay". Passed as recentTrackIds(songMemory).
//
// Fed by Random / Never-Ending / Discover adds, guest search-adds, actual
// now-playing transitions, and skips (which also cool down that artist briefly).
//
// Stores an ordered list of { id, artist, name } entries (oldest first) backed
// by a JSON file in data/. The tail also powers the per-artist budget window.
// Oldest entries age out once HISTORY_CAP is hit.
//
// Honors PARTYQUEUE_HISTORY_FILE / PARTYQUEUE_COOLDOWN_FILE for tests.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import { sanitizeDisplayName } from "./display-name.js";
import { primaryArtist } from "./sampler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE =
  process.env.PARTYQUEUE_HISTORY_FILE ||
  path.join(__dirname, "..", "data", "play-history.json");
const COOLDOWN_FILE =
  process.env.PARTYQUEUE_COOLDOWN_FILE ||
  path.join(__dirname, "..", "data", "skip-cooldowns.json");

// How many songs we retain for Memory / history (independent of Random's
// songMemory anti-repeat window).
export const HISTORY_CAP = 1500;

/** How a song entered memory — shown as badges in the Memory UI. */
export const HISTORY_SOURCES = new Set([
  "searched",
  "filler",
  "discovered",
  "mood",
]);

function normalizeSource(value) {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  // Legacy: older builds stored "skipped" as source — migrate to a flag.
  if (s === "skipped") return null;
  return HISTORY_SOURCES.has(s) ? s : null;
}

function normalizeSkipped(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.skipped === true) return true;
  return String(entry.source || "").toLowerCase() === "skipped";
}

// Default: after a skip, avoid that artist for this many subsequent auto-picks.
export const DEFAULT_SKIP_ARTIST_COOLDOWN = 8;

// In-memory mirrors so hot paths (sampling) don't hit disk.
let cache = null;
let cooldownCache = null; // { [normArtist]: remainingPicks }

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    cache = Array.isArray(raw)
      ? raw
          .filter((e) => e && typeof e.id === "string" && e.id)
          .map((e) => ({
            id: e.id,
            artist: typeof e.artist === "string" ? e.artist : "",
            name: typeof e.name === "string" ? e.name : "",
            source: normalizeSource(e.source),
            skipped: normalizeSkipped(e),
            requestedBy: sanitizeDisplayName(e.requestedBy),
          }))
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

function persistNow() {
  try {
    const out = (cache ?? []).map((e) => {
      const row = { id: e.id, artist: e.artist, name: e.name ?? "" };
      if (e.source) row.source = e.source;
      if (e.skipped) row.skipped = true;
      if (e.requestedBy) row.requestedBy = e.requestedBy;
      return row;
    });
    writeFileAtomic(HISTORY_FILE, JSON.stringify(out));
  } catch (err) {
    console.error("[history] save failed:", err.message);
  }
}

// Debounce disk writes (mirrors genre-cache): bursty adds only flush once.
let persistTimer = null;
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 1000);
}

function flushPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (cache === null) return false;
  persistNow();
  return true;
}

/** Flush pending history writes (tests / shutdown). */
export function flushHistoryPersist() {
  return flushPersist();
}

function loadCooldowns() {
  if (cooldownCache) return cooldownCache;
  try {
    const raw = JSON.parse(fs.readFileSync(COOLDOWN_FILE, "utf8"));
    const artists =
      raw && typeof raw === "object" && raw.artists && typeof raw.artists === "object"
        ? raw.artists
        : raw && typeof raw === "object"
          ? raw
          : {};
    cooldownCache = {};
    for (const [k, v] of Object.entries(artists)) {
      const n = Number(v);
      const artist = primaryArtist(k);
      if (!artist || !Number.isFinite(n) || n <= 0) continue;
      cooldownCache[artist] = Math.max(cooldownCache[artist] ?? 0, Math.floor(n));
    }
  } catch {
    cooldownCache = {};
  }
  return cooldownCache;
}

function persistCooldowns() {
  try {
    writeFileAtomic(
      COOLDOWN_FILE,
      JSON.stringify({ artists: cooldownCache ?? {} }, null, 2)
    );
  } catch (err) {
    console.error("[cooldown] save failed:", err.message);
  }
}

/**
 * Track IDs from history. With no limit (or invalid), returns the full store.
 * With a positive limit, returns only the newest `limit` IDs — used by Random
 * so Settings → songMemory stays the anti-repeat window while HISTORY_CAP
 * keeps a longer Memory list.
 */
export function recentTrackIds(limit) {
  const list = load();
  if (limit == null || !Number.isFinite(Number(limit)) || Number(limit) <= 0) {
    return new Set(list.map((e) => e.id));
  }
  const n = Math.floor(Number(limit));
  return new Set(list.slice(Math.max(0, list.length - n)).map((e) => e.id));
}

// The full remembered history, newest first, for display. Each entry is
// { id, artist, name }; `name` may be "" for songs recorded before titles were
// stored (the caller can backfill those from Spotify).
export function getHistory() {
  return load()
    .map((e) => ({
      id: e.id,
      artist: e.artist,
      name: e.name ?? "",
      source: e.source || null,
      skipped: !!e.skipped,
      requestedBy: e.requestedBy || null,
    }))
    .reverse();
}

// Most recent `n` history entries (oldest→newest within the slice), for mood
// continuity: soft-prefer tracks that share genre tags with these artists.
export function recentEntries(n = 3) {
  const list = load();
  const take = Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
  return list.slice(Math.max(0, list.length - take)).map((e) => ({
    id: e.id,
    artist: e.artist,
    name: e.name ?? "",
    source: e.source || null,
    skipped: !!e.skipped,
    requestedBy: e.requestedBy || null,
  }));
}

// Plays per (normalized) artist within the last `window` entries. Feeds the
// per-artist budget in the sampler.
export function artistCountsInWindow(window) {
  const list = load();
  const slice =
    window > 0 ? list.slice(Math.max(0, list.length - window)) : list.slice();
  const counts = new Map();
  for (const e of slice) {
    const artist = primaryArtist(e.artist);
    if (!artist) continue;
    counts.set(artist, (counts.get(artist) ?? 0) + 1);
  }
  return counts;
}

// Artists currently on a skip cooldown (normalized name → remaining picks).
export function artistCooldowns() {
  return new Map(Object.entries(loadCooldowns()));
}

// Append freshly-played songs (most-recent last). Existing IDs move to the end
// (they just played again, so the clock resets on them). Trims to HISTORY_CAP
// by default (or an explicit maxSize for tests).
export function recordPlayed(entries, maxSize = HISTORY_CAP) {
  const clean = (entries || []).filter(
    (e) => e && typeof e.id === "string" && e.id,
  );
  if (clean.length === 0) return;

  const list = load();
  for (const e of clean) {
    const idx = list.findIndex((x) => x.id === e.id);
    const prev = idx !== -1 ? list[idx] : null;
    if (idx !== -1) list.splice(idx, 1);
    const nextSource = normalizeSource(e.source) || prev?.source || null;
    const nextSkipped =
      e.skipped === true ? true : e.skipped === false ? false : !!prev?.skipped;
    const incomingBy = sanitizeDisplayName(e.requestedBy);
    const nextRequestedBy =
      nextSource === "searched"
        ? incomingBy || prev?.requestedBy || null
        : null;
    list.push({
      id: e.id,
      artist: typeof e.artist === "string" ? e.artist : "",
      name: typeof e.name === "string" ? e.name : "",
      source: nextSource,
      skipped: nextSkipped,
      requestedBy: nextRequestedBy,
    });
  }

  const cap =
    Number.isFinite(maxSize) && maxSize > 0 ? Math.floor(maxSize) : HISTORY_CAP;
  while (list.length > cap) list.shift();

  cache = list;
  persist();
}

// Guest skipped the current song: remember it in history AND cool down that
// artist for the next `artistCooldown` auto-picks so the DJ doesn't immediately
// lean on the same artist again.
export function recordSkip(
  entry,
  maxSize = HISTORY_CAP,
  artistCooldown = DEFAULT_SKIP_ARTIST_COOLDOWN
) {
  if (!entry || typeof entry.id !== "string" || !entry.id) return;
  // Keep the original how-it-was-added source (Songs Like / Random / Requested)
  // and add a separate skipped flag so Memory can show both badges.
  recordPlayed(
    [
      {
        id: entry.id,
        artist: entry.artist,
        name: entry.name,
        source: normalizeSource(entry.source),
        skipped: true,
      },
    ],
    maxSize
  );
  const artist = primaryArtist(entry.artist);
  if (!artist) return;
  const cool = loadCooldowns();
  const n =
    Number.isFinite(artistCooldown) && artistCooldown > 0
      ? Math.floor(artistCooldown)
      : DEFAULT_SKIP_ARTIST_COOLDOWN;
  cool[artist] = Math.max(cool[artist] ?? 0, n);
  cooldownCache = cool;
  persistCooldowns();
}

// After the DJ adds `n` songs, tick down skip cooldowns so they eventually expire.
export function tickArtistCooldowns(n = 1) {
  const steps = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (steps <= 0) return;
  const cool = loadCooldowns();
  let changed = false;
  for (const artist of Object.keys(cool)) {
    const next = (cool[artist] ?? 0) - steps;
    if (next <= 0) {
      delete cool[artist];
      changed = true;
    } else if (next !== cool[artist]) {
      cool[artist] = next;
      changed = true;
    }
  }
  if (changed) {
    cooldownCache = cool;
    persistCooldowns();
  }
}

// Forget everything (e.g. host wants a clean shuffle).
export function clearHistory() {
  cache = [];
  cooldownCache = {};
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    fs.rmSync(HISTORY_FILE, { force: true });
  } catch {
    /* nothing to remove */
  }
  try {
    fs.rmSync(COOLDOWN_FILE, { force: true });
  } catch {
    /* nothing to remove */
  }
}
