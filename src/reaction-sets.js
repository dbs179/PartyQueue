// Most Loved / Most Hated automatic sets for Random / Never-Ending.
// Pool = reaction-qualified tracks (threshold 10), uniform random pick.
// Genre / lane / playlists ignored. Party-played memory clears on New party.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import {
  listTopLikedTracks,
  listMostHatedTracks,
} from "./reactions.js";
import { getRandomnessSettings } from "./settings.js";
import { primaryArtist } from "./sampler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_FILE =
  process.env.PARTYQUEUE_REACTION_SET_MEMORY_FILE ||
  path.join(__dirname, "..", "data", "reaction-set-memory.json");

export const REACTION_SET_THRESHOLD = 10;
export const REACTION_SET_KINDS = new Set(["loved", "hated"]);

/** @type {{ lovedPlayedIds: string[], hatedPlayedIds: string[] }|null} */
let memory = null;
let setsSinceLoved = 0;
let setsSinceHated = 0;

function emptyMemory() {
  return { lovedPlayedIds: [], hatedPlayedIds: [] };
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
  return new Set(kind === "hated" ? m.hatedPlayedIds : m.lovedPlayedIds);
}

/**
 * Tracks that clear the threshold and are not in this flavor's party memory.
 * @param {"loved"|"hated"} kind
 * @param {{ threshold?: number, limit?: number }} [opts]
 */
export function eligibleReactionSetTracks(kind, opts = {}) {
  if (!REACTION_SET_KINDS.has(kind)) return [];
  const threshold = Math.max(
    1,
    Math.floor(Number(opts.threshold) || REACTION_SET_THRESHOLD)
  );
  const limit = Math.max(1, Math.min(200, Math.floor(Number(opts.limit) || 100)));
  const ranked =
    kind === "hated" ? listMostHatedTracks(limit) : listTopLikedTracks(limit);
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
 * @param {"loved"|"hated"} kind
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
  const key = kind === "hated" ? "hatedPlayedIds" : "lovedPlayedIds";
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

/**
 * After a Random/Never-Ending batch finishes enqueue.
 * @param {{ kind?: "loved"|"hated"|null }} [opts]
 */
export function noteReactionSetBuilt({ kind = null } = {}) {
  if (kind === "loved") {
    setsSinceLoved = 0;
    setsSinceHated += 1;
    return;
  }
  if (kind === "hated") {
    setsSinceHated = 0;
    setsSinceLoved += 1;
    return;
  }
  setsSinceLoved += 1;
  setsSinceHated += 1;
}

export function resetReactionSetCountersForTests() {
  setsSinceLoved = 0;
  setsSinceHated = 0;
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
 * @param {"loved"|"hated"} kind
 * @param {object} [settings]
 * @param {number} [setsSince]
 */
export function reactionSetDue(kind, settings = null, setsSince = null) {
  if (!REACTION_SET_KINDS.has(kind)) return false;
  const cfg = settings || getRandomnessSettings();
  const enabled =
    kind === "hated"
      ? !!cfg.hatedReactionSetEnabled
      : !!cfg.lovedReactionSetEnabled;
  if (!enabled) return false;
  const every = Math.max(
    1,
    Math.floor(
      Number(
        kind === "hated"
          ? cfg.hatedReactionSetEveryN
          : cfg.lovedReactionSetEveryN
      ) || 6
    )
  );
  const since =
    setsSince != null
      ? Math.max(0, Math.floor(Number(setsSince) || 0))
      : kind === "hated"
        ? setsSinceHated
        : setsSinceLoved;
  return since >= every;
}

/**
 * Pick which reaction set (if any) should build this plan.
 * Loved wins when both due; Hated stays due for a later build.
 * @param {number} setSize
 * @param {object} [settings]
 */
export function selectReactionSetKind(setSize = 5, settings = null) {
  const cfg = settings || getRandomnessSettings();
  if (
    reactionSetDue("loved", cfg) &&
    reactionSetPoolReady("loved", setSize)
  ) {
    return "loved";
  }
  if (
    reactionSetDue("hated", cfg) &&
    reactionSetPoolReady("hated", setSize)
  ) {
    return "hated";
  }
  return null;
}

export function cleanReactionSetKind(value) {
  const s = String(value || "").trim().toLowerCase();
  return REACTION_SET_KINDS.has(s) ? s : null;
}
