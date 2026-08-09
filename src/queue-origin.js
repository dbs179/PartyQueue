// Tracks how each queued song got there, so the queue can prioritize real
// requests and the UI can badge songs:
//
//   "searched"   - a guest searched and added it (priority; inserted ahead of
//                  filler). Shown with a "Requested" badge (+ display name).
//   "filler"     - added by the Random buttons or the Never-Ending Queue (sinks
//                  to the bottom of the queue).
//   "discovered" - a "Songs Like" discovery (also filler for ordering, but shown
//                  with its own "Songs Like" badge).
//   "mood"       - an era Mood chart hit pulled from outside the library
//                  (filler for ordering; badged with the era).
//
// Sonos has nowhere to stash this, so we keep a small, bounded, JSON-backed
// list in data/queue-origin.json.
//
// Searched rows may appear MULTIPLE times for the same Spotify track id so
// Maria / Dave / Owen can each have a live copy of Nine Ball with its own
// dedication. Filler / discovered / mood stay one row per track id.
//
// Party Stats dedications live in requests.json (one event per add) and are
// not cleared when a live instance is consumed.
//
// Honors PARTYQUEUE_ORIGIN_FILE to point the store elsewhere (used by tests).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { writeFileAtomic } from "./atomic-write.js";
import { sanitizeDedication, sanitizeDisplayName } from "./display-name.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_FILE =
  process.env.PARTYQUEUE_ORIGIN_FILE ||
  path.join(__dirname, "..", "data", "queue-origin.json");
const LEGACY_DISCOVERED_FILE = path.join(__dirname, "..", "data", "discovered.json");

// Cap so the map can't grow without bound; far more than any queue holds.
const MAX = 1000;
const VALID = new Set(["searched", "filler", "discovered", "mood"]);

const SET_SOURCES = new Set(["filler", "discovered", "mood"]);

let entries = null; // [{ key, id, source, requestedBy?, requestedByUser?, dedication?, mood?, genreLane? }]
/** @type {Map<string, object>|null} */
let indexById = null;
/** @type {Map<string, object[]>|null} */
let searchedById = null;

function newInstanceKey() {
  return randomBytes(8).toString("hex");
}

function rowMeta(e) {
  return {
    key: e.key || null,
    source: e.source,
    requestedBy: e.requestedBy || null,
    requestedByUser: e.requestedByUser || null,
    dedication: e.dedication || null,
    mood: e.mood || null,
    genreLane: e.genreLane || null,
    setRequest: !!e.setRequest,
  };
}

function buildIndex() {
  indexById = new Map();
  searchedById = new Map();
  for (const e of entries) {
    indexById.set(e.id, rowMeta(e));
    if (e.source === "searched") {
      const list = searchedById.get(e.id) || [];
      list.push(rowMeta(e));
      searchedById.set(e.id, list);
    }
  }
}

function cleanGenreLane(value) {
  return typeof value === "string" && value ? value : null;
}

function load() {
  if (entries) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    entries = Array.isArray(raw)
      ? raw
          .filter((e) => e && typeof e.id === "string" && VALID.has(e.source))
          .map((e) => ({
            key: typeof e.key === "string" && e.key ? e.key : newInstanceKey(),
            id: e.id,
            source: e.source,
            requestedBy: sanitizeDisplayName(e.requestedBy),
            requestedByUser: sanitizeDisplayName(e.requestedByUser),
            dedication: sanitizeDedication(e.dedication),
            mood: typeof e.mood === "string" && e.mood ? e.mood : null,
            genreLane: cleanGenreLane(e.genreLane),
            setRequest: !!e.setRequest,
          }))
      : null;
  } catch {
    entries = null;
  }

  // One-time migration: seed from the legacy discovered-only store so existing
  // discovery badges survive the upgrade.
  if (!entries) {
    entries = [];
    try {
      const old = JSON.parse(fs.readFileSync(LEGACY_DISCOVERED_FILE, "utf8"));
      if (Array.isArray(old)) {
        for (const id of old) {
          if (typeof id === "string" && id) {
            entries.push({
              key: newInstanceKey(),
              id,
              source: "discovered",
              requestedBy: null,
              requestedByUser: null,
              dedication: null,
            });
          }
        }
      }
    } catch {
      /* no legacy file; start empty */
    }
    if (entries.length) persist();
  }

  buildIndex();
}

function persistNow() {
  try {
    const out = (entries ?? []).map((e) => {
      const row = { key: e.key, id: e.id, source: e.source };
      if (e.requestedBy) row.requestedBy = e.requestedBy;
      if (e.requestedByUser) row.requestedByUser = e.requestedByUser;
      if (e.dedication) row.dedication = e.dedication;
      if (e.mood) row.mood = e.mood;
      if (e.genreLane) row.genreLane = e.genreLane;
      if (e.setRequest) row.setRequest = true;
      return row;
    });
    writeFileAtomic(STORE_FILE, JSON.stringify(out));
  } catch (err) {
    console.error("[queue-origin] save failed:", err.message);
  }
}

// Debounce disk writes (mirrors play-history): Random/refill bursts flush once.
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
  if (entries === null) return false;
  persistNow();
  return true;
}

/** Flush pending origin writes (tests / shutdown). */
export function flushOriginPersist() {
  return flushPersist();
}

function trimEntries() {
  while (entries.length > MAX) {
    entries.shift();
  }
  buildIndex();
}

function removeAllForId(id) {
  entries = entries.filter((e) => e.id !== id);
}

/**
 * Record the source for one or more track IDs.
 * @param {string[]} ids
 * @param {string} source
 * @param {{ requestedBy?: string|null, requestedByUser?: string|null, dedication?: string|null, mood?: string|null, genreLane?: string|null, appendInstance?: boolean, setRequest?: boolean }} [opts]
 */
export function markOrigin(ids, source, opts = {}) {
  if (!VALID.has(source)) return;
  const clean = (ids || []).filter((x) => typeof x === "string" && x);
  if (!clean.length) return;
  const requestedBy =
    source === "searched" ? sanitizeDisplayName(opts.requestedBy) : null;
  const requestedByUser =
    source === "searched" ? sanitizeDisplayName(opts.requestedByUser) : null;
  const hasDedicationOpt = Object.prototype.hasOwnProperty.call(
    opts,
    "dedication"
  );
  const dedication = hasDedicationOpt
    ? sanitizeDedication(opts.dedication)
    : null;
  const mood =
    source === "mood" && typeof opts.mood === "string" && opts.mood
      ? opts.mood
      : null;
  const genreLaneOpt = cleanGenreLane(opts.genreLane);
  const appendInstance = source === "searched" && !!opts.appendInstance;
  const setRequest = source === "searched" && !!opts.setRequest;
  load();
  for (const id of clean) {
    const prevSearched = (searchedById?.get(id) || []).slice();
    const prevRollup = indexById?.get(id) || null;

    if (appendInstance) {
      // Keep existing searched copies; add another live instance.
    } else {
      removeAllForId(id);
    }

    const by =
      requestedBy ||
      (source === "searched"
        ? prevRollup?.requestedBy || prevSearched[0]?.requestedBy || null
        : null);
    const byUser =
      requestedByUser ||
      (source === "searched"
        ? prevRollup?.requestedByUser ||
          prevSearched[0]?.requestedByUser ||
          null
        : null);
    const ded =
      source === "searched"
        ? hasDedicationOpt
          ? dedication
          : appendInstance
            ? null
            : prevSearched[0]?.dedication || null
        : null;
    const genreLane = SET_SOURCES.has(source)
      ? genreLaneOpt || prevRollup?.genreLane || null
      : null;

    entries.push({
      key: newInstanceKey(),
      id,
      source,
      requestedBy: by,
      requestedByUser: byUser,
      dedication: ded,
      mood,
      genreLane,
      setRequest,
    });
  }
  trimEntries();
  persist();
}

export function originOf(id) {
  if (!id) return null;
  load();
  if ((searchedById.get(id) || []).length) return "searched";
  return indexById.get(id)?.source ?? null;
}

export function requestedByOf(id) {
  if (!id) return null;
  load();
  const inst = searchedById.get(id);
  if (inst?.length) return inst[0].requestedBy || null;
  return indexById.get(id)?.requestedBy ?? null;
}

export function requestedByUserOf(id) {
  if (!id) return null;
  load();
  const inst = searchedById.get(id);
  if (inst?.length) {
    return inst[0].requestedByUser || inst[0].requestedBy || null;
  }
  const meta = indexById.get(id);
  if (!meta) return null;
  return meta.requestedByUser || meta.requestedBy || null;
}

export function dedicationOf(id) {
  if (!id) return null;
  load();
  const inst = searchedById.get(id);
  if (inst?.length) return inst[0].dedication || null;
  return indexById.get(id)?.dedication ?? null;
}

/** Live searched instances for a track id, oldest (next-up) first. */
export function searchedInstancesOf(id) {
  if (!id) return [];
  load();
  return (searchedById.get(id) || []).map((m) => ({ ...m }));
}

/**
 * Meta for the Nth live copy of a track in queue order (0 = next / now playing).
 * Falls back to the non-searched rollup when no searched instances remain.
 */
export function originMetaForOccurrence(id, occurrenceIndex = 0) {
  if (!id) return null;
  load();
  const inst = searchedById.get(id) || [];
  if (inst.length) {
    const i = Math.max(0, Math.floor(Number(occurrenceIndex) || 0));
    return inst[Math.min(i, inst.length - 1)] || null;
  }
  const rollup = indexById.get(id);
  return rollup || null;
}

/** Decade pack id ("80s", "90s", …) an era-mood track was added under, or null. */
export function moodOf(id) {
  if (!id) return null;
  load();
  return indexById.get(id)?.mood ?? null;
}

/** Set lane id ("pop", "folk", …) a filler/discovered/mood track was added under. */
export function genreLaneOf(id) {
  if (!id) return null;
  load();
  return indexById.get(id)?.genreLane ?? null;
}

/**
 * Set or clear dedication on the newest searched instance of a track
 * (toast Dedicate right after Add).
 * @returns {{ ok: true, dedication: string|null } | { ok: false, error: string }}
 */
export function setDedication(id, dedication) {
  if (!id || typeof id !== "string") {
    return { ok: false, error: "Missing track id." };
  }
  load();
  let at = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].id === id && entries[i].source === "searched") {
      at = i;
      break;
    }
  }
  if (at === -1) {
    return { ok: false, error: "Track is not a guest request." };
  }
  const row = entries[at];
  const ded = sanitizeDedication(dedication);
  row.dedication = ded;
  buildIndex();
  persist();
  return { ok: true, dedication: ded };
}

/**
 * Drop the oldest live searched instance for this track after it leaves Now
 * Playing (or is skipped). Stats keep dedications in requests.json.
 */
export function clearConsumedDedication(id) {
  if (!id || typeof id !== "string") return;
  load();
  const at = entries.findIndex(
    (e) => e.id === id && e.source === "searched"
  );
  if (at === -1) return;
  // Consume the whole instance so the next copy keeps its own dedication.
  entries.splice(at, 1);
  buildIndex();
  persist();
}

/**
 * Pure: advance the "last heard music track" pointer used to consume searched
 * origins after a song leaves Now Playing.
 *
 * Important: do NOT clear when playback moves onto DJ announce pads. Empty-
 * queue shouts often register the first Set Request / request as heard, then
 * pad playback used to wipe Requested + Genre before the song resumed.
 *
 * @param {string|null} prevHeardId
 * @param {{
 *   playingFromQueue?: boolean,
 *   uri?: string|null,
 *   djClip?: boolean,
 *   silenceBridge?: boolean,
 *   trackId?: string|null,
 * }} [ctx]
 * @returns {{ lastHeardTrackId: string|null, clearId: string|null, heardId: string|null }}
 */
export function advanceHeardTrack(prevHeardId, ctx = {}) {
  const playingFromQueue = !!ctx.playingFromQueue;
  const uri = ctx.uri || null;
  const djClip = !!ctx.djClip;
  const silenceBridge = !!ctx.silenceBridge;
  const trackId =
    typeof ctx.trackId === "string" && ctx.trackId ? ctx.trackId : null;
  const prev =
    typeof prevHeardId === "string" && prevHeardId ? prevHeardId : null;

  if (playingFromQueue && uri && !djClip && !silenceBridge) {
    if (trackId && trackId !== prev) {
      return {
        lastHeardTrackId: trackId,
        clearId: prev,
        heardId: trackId,
      };
    }
    return { lastHeardTrackId: prev, clearId: null, heardId: null };
  }

  // DJ ramp / TTS / restore: keep the pointer, do not consume the song under
  // the announce (it often resumes as the same track id).
  if (djClip || silenceBridge) {
    return { lastHeardTrackId: prev, clearId: null, heardId: null };
  }

  // Left the queue source or went idle — consume.
  if (prev && (!playingFromQueue || !uri)) {
    return { lastHeardTrackId: null, clearId: prev, heardId: null };
  }

  return { lastHeardTrackId: prev, clearId: null, heardId: null };
}

// Filler = anything that should sink below real requests (random/never-ending
// picks, discoveries, and era mood hits).
export function isFiller(id) {
  const s = originOf(id);
  return s === "filler" || s === "discovered" || s === "mood";
}

export function isSearched(id) {
  return originOf(id) === "searched";
}

export function isDiscovered(id) {
  return originOf(id) === "discovered";
}

// Snapshot: id -> rollup meta (last write / first searched for badges).
export function originSnapshot() {
  load();
  const out = new Map();
  for (const [id, meta] of indexById) {
    const inst = searchedById.get(id);
    if (inst?.length) {
      out.set(id, {
        ...inst[0],
        source: "searched",
        instanceCount: inst.length,
      });
    } else {
      out.set(id, { ...meta, instanceCount: 0 });
    }
  }
  return out;
}
