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
// Sonos has nowhere to stash this, so we keep a small, bounded, JSON-backed map
// of Spotify track IDs -> { source, requestedBy?, requestedByUser?, dedication?,
// mood? } (data/queue-origin.json).
//
// `mood` = the decade pack id ("80s", "90s", …) the track was added under, so
// badges keep saying "80's Hit" even after the host switches decades.
//
// `requestedBy` = badge text (alias, or User when alias blank).
// `requestedByUser` = stable User for shouts/stats (optional; old rows omit it).
//
// Honors PARTYQUEUE_ORIGIN_FILE to point the store elsewhere (used by tests).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

let entries = null; // [{ id, source, requestedBy?, requestedByUser?, dedication?, mood? }]
/** @type {Map<string, { source: string, requestedBy: string|null, requestedByUser: string|null, dedication: string|null, mood: string|null }>|null} */
let index = null;

function buildIndex() {
  index = new Map();
  for (const e of entries) {
    index.set(e.id, {
      source: e.source,
      requestedBy: e.requestedBy || null,
      requestedByUser: e.requestedByUser || null,
      dedication: e.dedication || null,
      mood: e.mood || null,
    });
  }
}

function load() {
  if (entries) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    entries = Array.isArray(raw)
      ? raw
          .filter((e) => e && typeof e.id === "string" && VALID.has(e.source))
          .map((e) => ({
            id: e.id,
            source: e.source,
            requestedBy: sanitizeDisplayName(e.requestedBy),
            requestedByUser: sanitizeDisplayName(e.requestedByUser),
            dedication: sanitizeDedication(e.dedication),
            mood: typeof e.mood === "string" && e.mood ? e.mood : null,
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

function persist() {
  try {
    const out = (entries ?? []).map((e) => {
      const row = { id: e.id, source: e.source };
      if (e.requestedBy) row.requestedBy = e.requestedBy;
      if (e.requestedByUser) row.requestedByUser = e.requestedByUser;
      if (e.dedication) row.dedication = e.dedication;
      if (e.mood) row.mood = e.mood;
      return row;
    });
    writeFileAtomic(STORE_FILE, JSON.stringify(out));
  } catch (err) {
    console.error("[queue-origin] save failed:", err.message);
  }
}

/**
 * Record the source for one or more track IDs (most-recent wins).
 * @param {string[]} ids
 * @param {string} source
 * @param {{ requestedBy?: string|null, requestedByUser?: string|null, dedication?: string|null, mood?: string|null }} [opts]
 */
export function markOrigin(ids, source, opts = {}) {
  if (!VALID.has(source)) return;
  const clean = (ids || []).filter((x) => typeof x === "string" && x);
  if (!clean.length) return;
  const requestedBy =
    source === "searched" ? sanitizeDisplayName(opts.requestedBy) : null;
  const requestedByUser =
    source === "searched" ? sanitizeDisplayName(opts.requestedByUser) : null;
  const dedication =
    source === "searched" ? sanitizeDedication(opts.dedication) : null;
  const mood =
    source === "mood" && typeof opts.mood === "string" && opts.mood
      ? opts.mood
      : null;
  load();
  for (const id of clean) {
    const at = entries.findIndex((e) => e.id === id);
    const prev = at !== -1 ? entries[at] : null;
    if (at !== -1) entries.splice(at, 1);
    const by =
      requestedBy ||
      (source === "searched" ? prev?.requestedBy || null : null);
    const byUser =
      requestedByUser ||
      (source === "searched" ? prev?.requestedByUser || null : null);
    const ded =
      dedication ||
      (source === "searched" ? prev?.dedication || null : null);
    entries.push({
      id,
      source,
      requestedBy: by,
      requestedByUser: byUser,
      dedication: ded,
      mood,
    });
    index.set(id, {
      source,
      requestedBy: by,
      requestedByUser: byUser,
      dedication: ded,
      mood,
    });
  }
  while (entries.length > MAX) {
    const removed = entries.shift();
    if (removed) index.delete(removed.id);
  }
  persist();
}

export function originOf(id) {
  if (!id) return null;
  load();
  return index.get(id)?.source ?? null;
}

export function requestedByOf(id) {
  if (!id) return null;
  load();
  return index.get(id)?.requestedBy ?? null;
}

export function requestedByUserOf(id) {
  if (!id) return null;
  load();
  const meta = index.get(id);
  if (!meta) return null;
  return meta.requestedByUser || meta.requestedBy || null;
}

export function dedicationOf(id) {
  if (!id) return null;
  load();
  return index.get(id)?.dedication ?? null;
}

/**
 * Set or clear dedication on an existing searched origin.
 * @returns {{ ok: true, dedication: string|null } | { ok: false, error: string }}
 */
export function setDedication(id, dedication) {
  if (!id || typeof id !== "string") {
    return { ok: false, error: "Missing track id." };
  }
  load();
  const at = entries.findIndex((e) => e.id === id);
  if (at === -1) {
    return { ok: false, error: "Track is not a guest request." };
  }
  const row = entries[at];
  if (row.source !== "searched") {
    return { ok: false, error: "Only searched requests can have dedications." };
  }
  const ded = sanitizeDedication(dedication);
  row.dedication = ded;
  index.set(id, {
    source: row.source,
    requestedBy: row.requestedBy || null,
    requestedByUser: row.requestedByUser || null,
    dedication: ded,
  });
  persist();
  return { ok: true, dedication: ded };
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

// Snapshot: id -> { source, requestedBy, requestedByUser, dedication, mood }.
export function originSnapshot() {
  load();
  return new Map(index);
}
