// Guest request log: every song a guest searches-and-adds (a real request, as
// opposed to Random / Never-Ending / discovery "filler") is appended here with a
// timestamp. Powers the Party Stats panel ("most requested tonight / all-time").
//
// Backed by a bounded JSON file in data/ (rides the Docker volume, survives
// restarts), mirroring play-history.js / queue-origin.js.
//
// Honors PARTYQUEUE_REQUESTS_FILE to point the store elsewhere (used by tests).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import { sanitizeDisplayName, sanitizeDedication } from "./display-name.js";
import { invalidatePartyStatsCache } from "./party-stats.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REQUESTS_FILE =
  process.env.PARTYQUEUE_REQUESTS_FILE ||
  path.join(__dirname, "..", "data", "requests.json");

// Plenty for a long party night; oldest events age out beyond this.
const MAX = 2000;

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(REQUESTS_FILE, "utf8"));
    cache = Array.isArray(raw)
      ? raw
          .filter((e) => e && typeof e.id === "string" && e.id)
          .map((e) => {
            const row = {
              id: e.id,
              name: typeof e.name === "string" ? e.name : "",
              artist: typeof e.artist === "string" ? e.artist : "",
              ts: Number(e.ts) || 0,
              // Canonical User for Party Stats / recap (not the queue badge alias).
              requestedBy: sanitizeDisplayName(e.requestedBy),
              alias: sanitizeDisplayName(e.alias),
              dedication: sanitizeDedication(e.dedication),
            };
            if (e.kind === "setRequest" || e.kind === "setTrack") {
              row.kind = e.kind;
            }
            return row;
          })
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

function persistNow() {
  try {
    const out = (cache ?? []).map((e) => {
      const row = {
        id: e.id,
        name: e.name,
        artist: e.artist,
        ts: e.ts,
      };
      if (e.requestedBy) row.requestedBy = e.requestedBy;
      if (e.alias) row.alias = e.alias;
      if (e.dedication) row.dedication = e.dedication;
      if (e.kind === "setRequest" || e.kind === "setTrack") row.kind = e.kind;
      return row;
    });
    writeFileAtomic(REQUESTS_FILE, JSON.stringify(out));
  } catch (err) {
    console.error("[requests] save failed:", err.message);
  }
}

// Debounce disk writes (mirrors play-history): bursty guest adds flush once.
let persistTimer = null;
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 1000);
  persistTimer.unref?.();
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

/** Flush pending request-log writes (tests / shutdown). */
export function flushRequestsPersist() {
  return flushPersist();
}

function cancelPersistTimer() {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
}

/**
 * Append one guest request. `requestedBy` must be the stable User (stats key).
 * Optional `alias` is audit-only and ignored by topRequesters.
 * `ts` is injectable for tests; defaults to now.
 */
export function recordRequest(
  { id, name, artist, requestedBy, alias, dedication, kind } = {},
  ts = Date.now()
) {
  if (typeof id !== "string" || !id) return;
  const list = load();
  const by = sanitizeDisplayName(requestedBy);
  const aliasClean = sanitizeDisplayName(alias);
  const ded = sanitizeDedication(dedication);
  const row = {
    id,
    name: typeof name === "string" ? name : "",
    artist: typeof artist === "string" ? artist : "",
    ts: Number(ts) || Date.now(),
  };
  if (by) row.requestedBy = by;
  // Only keep alias when it differs from the User (saves noise).
  if (aliasClean && aliasClean !== by) row.alias = aliasClean;
  if (ded) row.dedication = ded;
  if (kind === "setRequest" || kind === "setTrack") row.kind = kind;
  list.push(row);
  while (list.length > MAX) list.shift();
  cache = list;
  persist();
  invalidatePartyStatsCache();
}

/**
 * Ledger one Set Request (fairness) plus optional per-track stats rows.
 * The setRequest row is what set-request fairness counts; setTrack rows feed
 * Party Stats without consuming song-request rolling quota.
 */
export function recordSetRequest(
  {
    artistId,
    artist,
    requestedBy,
    alias,
    tracks = [],
  } = {},
  ts = Date.now()
) {
  const id = String(artistId || "").trim();
  if (!id) return;
  const when = Number(ts) || Date.now();
  recordRequest(
    {
      id: `set:${id}`,
      name: "Set Request",
      artist: typeof artist === "string" ? artist : "",
      requestedBy,
      alias,
      kind: "setRequest",
    },
    when
  );
  for (const t of Array.isArray(tracks) ? tracks : []) {
    const trackId = typeof t?.id === "string" ? t.id : "";
    if (!trackId) continue;
    recordRequest(
      {
        id: trackId,
        name: typeof t.name === "string" ? t.name : "",
        artist: typeof t.artist === "string" ? t.artist : artist || "",
        requestedBy,
        alias,
        kind: "setTrack",
      },
      when
    );
  }
}

/** Attach / update dedication on the newest matching request for this track. */
export function setRequestDedication(id, dedication) {
  if (!id) return false;
  const list = load();
  const ded = sanitizeDedication(dedication);
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].id === id) {
      if (ded) list[i].dedication = ded;
      else delete list[i].dedication;
      cache = list;
      persist();
      invalidatePartyStatsCache();
      return true;
    }
  }
  return false;
}

/** Tonight's dedications, newest first. */
export function listDedications(sinceTs = 0, limit = 40) {
  const n = Math.max(1, Math.min(100, Math.floor(Number(limit) || 40)));
  return load()
    .filter(
      (e) =>
        e &&
        e.dedication &&
        (Number(e.ts) || 0) >= sinceTs
    )
    .slice(-n)
    .reverse()
    .map((e) => ({
      id: e.id,
      name: e.name || "",
      artist: e.artist || "",
      dedication: e.dedication,
      requestedBy: e.requestedBy || null,
      ts: e.ts,
    }));
}

// All stored request events, oldest first.
export function getRequests() {
  return load().slice();
}

// Forget all requests.
export function clearRequests() {
  cancelPersistTimer();
  cache = [];
  try {
    fs.rmSync(REQUESTS_FILE, { force: true });
  } catch {
    /* nothing to remove */
  }
  invalidatePartyStatsCache();
}

function normArtist(name) {
  return (name || "").trim().toLowerCase();
}

// Pure: aggregate request events into headline stats. Only events at or after
// `sinceTs` are counted (pass 0 for all-time). Exported for unit testing.
//   { total, topSongs: [{ id, name, artist, count }],
//             topArtists: [{ artist, count }] }
export function summarizeRequests(events, sinceTs = 0, limit = 5) {
  const list = (Array.isArray(events) ? events : []).filter(
    (e) =>
      e &&
      (Number(e.ts) || 0) >= sinceTs &&
      // Ledger-only Set Request rows are not songs.
      e.kind !== "setRequest"
  );

  const songs = new Map(); // id -> { id, name, artist, count }
  const artists = new Map(); // normalized primary artist -> { artist, count }

  for (const e of list) {
    const song = songs.get(e.id);
    if (song) song.count++;
    else songs.set(e.id, { id: e.id, name: e.name || "", artist: e.artist || "", count: 1 });

    const primary = (e.artist || "").split(",")[0].trim();
    const key = normArtist(primary);
    if (key) {
      const a = artists.get(key);
      if (a) a.count++;
      else artists.set(key, { artist: primary, count: 1 });
    }
  }

  const byCount = (a, b) => b.count - a.count;
  return {
    total: list.length,
    topSongs: [...songs.values()].sort(byCount).slice(0, limit),
    topArtists: [...artists.values()].sort(byCount).slice(0, limit),
  };
}

/**
 * Top guest requesters by count (display name). Empty names are skipped.
 * @param {Array} events
 * @param {number} [sinceTs]
 * @param {number} [limit]
 */
export function topRequesters(events, sinceTs = 0, limit = 5) {
  const list = (Array.isArray(events) ? events : []).filter(
    (e) =>
      e &&
      (Number(e.ts) || 0) >= sinceTs &&
      e.requestedBy &&
      // Count the set once (not once per track) for requester leaderboards.
      e.kind !== "setTrack"
  );
  const map = new Map(); // name -> count
  for (const e of list) {
    const name = e.requestedBy;
    map.set(name, (map.get(name) || 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Most recent guest requests, newest first (for the live ticker). */
export function recentRequests(limit = 8) {
  const list = load();
  const n = Math.max(0, Math.min(50, Math.floor(Number(limit) || 8)));
  return list
    .slice(-n)
    .reverse()
    .map((e) => ({
      id: e.id,
      name: e.name,
      artist: e.artist,
      ts: e.ts,
      requestedBy: e.requestedBy || null,
    }));
}
