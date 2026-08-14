// Most Loved / Most Hated / Most Requested automatic sets for Random /
// Never-Ending. Pool = qualified tracks (Loved/Hated: 5+ reactions;
// Requested: 5+ guest requests), uniform random pick. Genre / lane /
// playlists ignored. Party-played memory clears on New party.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import {
  listTopLikedTracks,
  listMostHatedTracks,
} from "./reactions.js";
import { listMostRequestedTracks } from "./request-log.js";
import { getRandomnessSettings } from "./settings.js";
import { primaryArtist } from "./sampler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_FILE =
  process.env.PARTYQUEUE_REACTION_SET_MEMORY_FILE ||
  path.join(__dirname, "..", "data", "reaction-set-memory.json");

export const REACTION_SET_THRESHOLD = 5;
export const REQUEST_SET_THRESHOLD = 5;
export const REACTION_SET_KINDS = new Set(["loved", "hated", "requested"]);

const MEMORY_KEYS = {
  loved: "lovedPlayedIds",
  hated: "hatedPlayedIds",
  requested: "requestedPlayedIds",
};

const ENABLED_KEYS = {
  loved: "lovedReactionSetEnabled",
  hated: "hatedReactionSetEnabled",
  requested: "requestedReactionSetEnabled",
};

/** @type {{ lovedPlayedIds: string[], hatedPlayedIds: string[], requestedPlayedIds: string[] }|null} */
let memory = null;
let setsSinceLoved = 0;
let setsSinceHated = 0;
let setsSinceRequested = 0;

function emptyMemory() {
  return { lovedPlayedIds: [], hatedPlayedIds: [], requestedPlayedIds: [] };
}

function loadMemory() {
  if (memory) return memory;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    memory = {
      lovedPlayedIds: Array.isArray(raw?.lovedPlayedIds)
        ? raw.lovedPlayedIds.filter((id) => typeof id === "string" && id)
        : [],
      hatedPlayedIds: Array.isArray(raw?.hatedPlayedIds)
        ? raw.hatedPlayedIds.filter((id) => typeof id === "string" && id)
        : [],
      requestedPlayedIds: Array.isArray(raw?.requestedPlayedIds)
        ? raw.requestedPlayedIds.filter((id) => typeof id === "string" && id)
        : [],
    };
  } catch {
    memory = emptyMemory();
  }
  return memory;
}

function persistMemory() {
  try {
    writeFileAtomic(STORE_FILE, JSON.stringify(loadMemory()));
  } catch (err) {
    console.error("[reaction-sets] save failed:", err.message);
  }
}

function playedSet(kind) {
  const m = loadMemory();
  const key = MEMORY_KEYS[kind];
  return new Set(key ? m[key] : []);
}

function thresholdFor(kind, override) {
  if (override != null) {
    return Math.max(1, Math.floor(Number(override) || 1));
  }
  return kind === "requested" ? REQUEST_SET_THRESHOLD : REACTION_SET_THRESHOLD;
}

function rankedTracks(kind, limit) {
  if (kind === "hated") return listMostHatedTracks(limit);
  if (kind === "requested") return listMostRequestedTracks(limit);
  return listTopLikedTracks(limit);
}

function setsSinceFor(kind) {
  if (kind === "hated") return setsSinceHated;
  if (kind === "requested") return setsSinceRequested;
  return setsSinceLoved;
}

function specialSetEveryN(cfg) {
  return Math.max(
    1,
    Math.floor(
      Number(
        cfg.specialSetEveryN ??
          cfg.lovedReactionSetEveryN ??
          cfg.hatedReactionSetEveryN ??
          cfg.sameArtistBatchEveryN
      ) || 5
    )
  );
}

function kindEnabled(kind, cfg) {
  const key = ENABLED_KEYS[kind];
  return key ? !!cfg[key] : false;
}

/**
 * Tracks that clear the threshold and are not in this flavor's party memory.
 * @param {"loved"|"hated"|"requested"} kind
 * @param {{ threshold?: number, limit?: number }} [opts]
 */
export function eligibleReactionSetTracks(kind, opts = {}) {
  if (!REACTION_SET_KINDS.has(kind)) return [];
  const threshold = thresholdFor(kind, opts.threshold);
  const limit = Math.max(1, Math.min(200, Math.floor(Number(opts.limit) || 100)));
  const ranked = rankedTracks(kind, limit);
  const played = playedSet(kind);
  return ranked
    .filter((t) => t && typeof t.id === "string" && t.id)
    .filter((t) => (Number(t.count) || 0) >= threshold)
    .filter((t) => !played.has(t.id))
    .map((t) => ({
      id: t.id,
      uri: `spotify:track:${t.id}`,
      name: t.name || "",
      artist: t.artist || "",
      count: Number(t.count) || 0,
    }));
}

export function reactionSetPoolReady(kind, setSize = 5) {
  const n = Math.max(1, Math.floor(Number(setSize) || 5));
  return eligibleReactionSetTracks(kind).length >= n;
}

/**
 * Uniform random sample without replacement. Equal weight once threshold met.
 * Prefers unique primary artists; returns null if fewer than `size` can be filled.
 * @param {"loved"|"hated"|"requested"} kind
 * @param {number} size
 * @param {{ random?: () => number, allowSameArtist?: boolean, excludeIds?: Iterable<string> }} [opts]
 */
export function pickReactionSetTracks(kind, size, opts = {}) {
  const want = Math.max(1, Math.floor(Number(size) || 5));
  const random = typeof opts.random === "function" ? opts.random : Math.random;
  const allowSameArtist = !!opts.allowSameArtist;
  const exclude = new Set(
    [...(opts.excludeIds || [])].filter((id) => typeof id === "string" && id)
  );
  const pool = eligibleReactionSetTracks(kind).filter((t) => !exclude.has(t.id));
  if (pool.length < want) return null;

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }

  const out = [];
  const seenArtists = new Set();
  for (const t of pool) {
    if (out.length >= want) break;
    const a = primaryArtist(t.artist);
    if (!allowSameArtist && a && seenArtists.has(a)) continue;
    if (a) seenArtists.add(a);
    out.push(t);
  }
  if (out.length < want) return null;
  return out.slice(0, want);
}

export function noteReactionSetPlayed(kind, ids) {
  if (!REACTION_SET_KINDS.has(kind)) return;
  const clean = (ids || []).filter((id) => typeof id === "string" && id);
  if (!clean.length) return;
  const m = loadMemory();
  const key = MEMORY_KEYS[kind];
  if (!key) return;
  const seen = new Set(m[key]);
  for (const id of clean) seen.add(id);
  m[key] = [...seen];
  persistMemory();
}

export function clearReactionSetMemory() {
  memory = emptyMemory();
  try {
    if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
  } catch {
    /* ignore */
  }
}

export function getSetsSinceLovedReactionSet() {
  return setsSinceLoved;
}

export function getSetsSinceHatedReactionSet() {
  return setsSinceHated;
}

export function getSetsSinceRequestedReactionSet() {
  return setsSinceRequested;
}

/**
 * After a Random/Never-Ending batch finishes enqueue.
 * @param {{ kind?: "loved"|"hated"|"requested"|null }} [opts]
 */
export function noteReactionSetBuilt({ kind = null } = {}) {
  if (kind === "loved") {
    setsSinceLoved = 0;
    setsSinceHated += 1;
    setsSinceRequested += 1;
    return;
  }
  if (kind === "hated") {
    setsSinceHated = 0;
    setsSinceLoved += 1;
    setsSinceRequested += 1;
    return;
  }
  if (kind === "requested") {
    setsSinceRequested = 0;
    setsSinceLoved += 1;
    setsSinceHated += 1;
    return;
  }
  setsSinceLoved += 1;
  setsSinceHated += 1;
  setsSinceRequested += 1;
}

export function resetReactionSetCountersForTests() {
  setsSinceLoved = 0;
  setsSinceHated = 0;
  setsSinceRequested = 0;
}

export function resetReactionSetMemoryForTests() {
  memory = emptyMemory();
  try {
    if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
  } catch {
    /* ignore */
  }
}

/**
 * @param {"loved"|"hated"|"requested"} kind
 * @param {object} [settings]
 * @param {number} [setsSince]
 */
export function reactionSetDue(kind, settings = null, setsSince = null) {
  if (!REACTION_SET_KINDS.has(kind)) return false;
  const cfg = settings || getRandomnessSettings();
  if (!kindEnabled(kind, cfg)) return false;
  const every = specialSetEveryN(cfg);
  const since =
    setsSince != null
      ? Math.max(0, Math.floor(Number(setsSince) || 0))
      : setsSinceFor(kind);
  return since >= every;
}

/**
 * Sets remaining before this reaction set is due. Null when the toggle is off.
 * @param {"loved"|"hated"|"requested"} kind
 * @param {object} [settings]
 * @param {number} [setsSince]
 */
export function reactionSetSetsUntil(kind, settings = null, setsSince = null) {
  if (!REACTION_SET_KINDS.has(kind)) return null;
  const cfg = settings || getRandomnessSettings();
  if (!kindEnabled(kind, cfg)) return null;
  const every = specialSetEveryN(cfg);
  const since =
    setsSince != null
      ? Math.max(0, Math.floor(Number(setsSince) || 0))
      : setsSinceFor(kind);
  return Math.max(0, every - Math.max(0, Math.floor(Number(since) || 0)));
}

/**
 * Pick which reaction set (if any) should build this plan.
 * Loved wins when several are due; others stay due for a later build.
 * @param {number} setSize
 * @param {object} [settings]
 */
export function selectReactionSetKind(setSize = 5, settings = null) {
  const cfg = settings || getRandomnessSettings();
  for (const kind of ["loved", "hated", "requested"]) {
    if (reactionSetDue(kind, cfg) && reactionSetPoolReady(kind, setSize)) {
      return kind;
    }
  }
  return null;
}

export function cleanReactionSetKind(value) {
  const s = String(value || "").trim().toLowerCase();
  return REACTION_SET_KINDS.has(s) ? s : null;
}
