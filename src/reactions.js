// Now Playing reactions — persist until the host resets them.
// Mood reactions: one active kind per guest per track (toggle / switch).
// Mic is separate (karaoke list) and does not count against that limit.
// Each vote stores a display name (`by`) for Stats attribution.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import { sanitizeDisplayName } from "./display-name.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_FILE =
  process.env.PARTYQUEUE_REACTIONS_FILE ||
  path.join(__dirname, "..", "data", "reactions.json");

/** Stable order for API payloads + UI. */
export const REACTION_KINDS = [
  "up",
  "down",
  "heart",
  "fire",
  "laugh",
  "vomit",
  "party",
  "mic",
];

/** Mood reactions — mutually exclusive per guest (mic excluded). */
export const MOOD_REACTION_KINDS = REACTION_KINDS.filter((k) => k !== "mic");
const KINDS = new Set(REACTION_KINDS);
const MOOD_KINDS = new Set(MOOD_REACTION_KINDS);
const GUEST_ID_MAX = 64;
const GUEST_LABEL = "Guest";

/** @type {{ byTrack: Record<string, object> }|null} */
let cache = null;

function emptyCounts() {
  /** @type {Record<string, number>} */
  const row = {};
  for (const k of REACTION_KINDS) row[k] = 0;
  return row;
}

function cleanMeta(value, max = 200) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

function cleanGuestId(value) {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, GUEST_ID_MAX);
  return cleaned.length >= 8 ? cleaned : "";
}

function cleanBy(value) {
  return sanitizeDisplayName(value) || "";
}

function labelBy(value) {
  return cleanBy(value) || GUEST_LABEL;
}

/** Normalize mood vote: legacy string kind → { kind, by }. */
function readMoodVote(raw) {
  if (typeof raw === "string" && MOOD_KINDS.has(raw)) {
    return { kind: raw, by: "" };
  }
  if (raw && typeof raw === "object") {
    const kind = String(raw.kind || "").toLowerCase();
    if (!MOOD_KINDS.has(kind)) return null;
    return { kind, by: cleanBy(raw.by) };
  }
  return null;
}

/** Normalize mic vote: legacy true → { by, at }. */
function readMicVote(raw) {
  if (raw === true) return { by: "", at: 0 };
  if (raw && typeof raw === "object") {
    return {
      by: cleanBy(raw.by),
      at: Number(raw.at) || 0,
    };
  }
  return null;
}

function countsFromRow(row) {
  const counts = emptyCounts();
  const votes = row?.votes && typeof row.votes === "object" ? row.votes : {};
  for (const raw of Object.values(votes)) {
    const vote = readMoodVote(raw);
    if (vote) counts[vote.kind] += 1;
  }
  const micVotes =
    row?.micVotes && typeof row.micVotes === "object" ? row.micVotes : {};
  let mic = 0;
  for (const raw of Object.values(micVotes)) {
    if (readMicVote(raw)) mic += 1;
  }
  counts.mic = mic;
  return counts;
}

function moodKindForGuest(row, guest) {
  if (!guest || !row?.votes) return null;
  const vote = readMoodVote(row.votes[guest]);
  return vote?.kind || null;
}

function hasMicForGuest(row, guest) {
  if (!guest || !row?.micVotes) return false;
  return !!readMicVote(row.micVotes[guest]);
}

function uniqueLabels(names) {
  const seen = new Set();
  const out = [];
  for (const n of names) {
    const label = labelBy(n);
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

function ensureRow(trackId) {
  load();
  let row = cache.byTrack[trackId];
  if (!row || typeof row !== "object") {
    row = { votes: {}, micVotes: {} };
  } else if (!row.votes || typeof row.votes !== "object") {
    // Legacy anonymous tallies can't be attributed — start clean for voting.
    row = {
      votes: {},
      micVotes: {},
      name: cleanMeta(row.name) || undefined,
      artist: cleanMeta(row.artist) || undefined,
      micAt: row.micAt,
    };
  }
  if (!row.micVotes || typeof row.micVotes !== "object") row.micVotes = {};
  cache.byTrack[trackId] = row;
  return row;
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    cache = {
      byTrack:
        raw?.byTrack && typeof raw.byTrack === "object" ? raw.byTrack : {},
    };
  } catch {
    cache = { byTrack: {} };
  }
  return cache;
}

function persist() {
  try {
    writeFileAtomic(STORE_FILE, JSON.stringify(cache));
  } catch (err) {
    console.error("[reactions] save failed:", err.message);
  }
}

// Reaction taps arrive in bursts (a chorus drop gets a dozen in a second);
// coalesce them into one disk write like the lyrics cache does.
const PERSIST_DEBOUNCE_MS = 250;
let persistTimer = null;

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persist();
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
}

/** Flush a pending debounced write (shutdown / tests). */
export function flushReactionsPersist() {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  persist();
}

// The store keeps one row per reacted track until a host reset; a long
// multi-party stretch without resets would grow it forever. Past the cap,
// drop the least recently reacted tracks (with slack so the sort is rare).
const TRACK_CAP = 3000;
const TRACK_CAP_SLACK = 150;

function pruneIfOverCap(keepId) {
  const ids = Object.keys(cache.byTrack);
  if (ids.length <= TRACK_CAP + TRACK_CAP_SLACK) return;
  const lastActive = (row) =>
    Math.max(Number(row?.moodAt) || 0, Number(row?.micAt) || 0);
  const oldestFirst = ids.sort(
    (a, b) => lastActive(cache.byTrack[a]) - lastActive(cache.byTrack[b])
  );
  for (const id of oldestFirst) {
    if (Object.keys(cache.byTrack).length <= TRACK_CAP) break;
    if (id === keepId) continue;
    delete cache.byTrack[id];
  }
}

function snapshot(trackId, guestId = "") {
  const guest = cleanGuestId(guestId);
  if (!trackId) {
    return { ...emptyCounts(), mine: null, micMine: false };
  }
  load();
  const row = cache.byTrack[trackId];
  const counts = row ? countsFromRow(row) : emptyCounts();
  const mine = moodKindForGuest(row, guest);
  const micMine = hasMicForGuest(row, guest);
  return { ...counts, mine, micMine };
}

export function getReactions(trackId, guestId = "") {
  return snapshot(trackId, guestId);
}

/**
 * Set / toggle a reaction for one guest on a track.
 * Mood kinds: one active at a time (tap again to clear, tap another to switch).
 * Mic: independent toggle for the Karaoke list.
 * meta.by — display name for Stats attribution.
 */
export function setReaction(trackId, kind, guestId, meta = {}) {
  if (!trackId || typeof trackId !== "string") {
    return { ok: false, error: "Missing track." };
  }
  const guest = cleanGuestId(guestId);
  if (!guest) {
    return { ok: false, error: "Missing guest id." };
  }
  const k = String(kind || "").toLowerCase();
  if (!KINDS.has(k)) {
    return { ok: false, error: "Unknown reaction." };
  }

  load();
  const row = ensureRow(trackId);

  const name = cleanMeta(meta.name) || cleanMeta(row.name);
  const artist = cleanMeta(meta.artist) || cleanMeta(row.artist);
  if (name) row.name = name;
  if (artist) row.artist = artist;
  const by = cleanBy(meta.by);

  if (k === "mic") {
    if (readMicVote(row.micVotes[guest])) {
      delete row.micVotes[guest];
    } else {
      const now = Date.now();
      row.micVotes[guest] = { by, at: now };
      row.micAt = now;
    }
  } else {
    const prev = readMoodVote(row.votes[guest]);
    if (prev?.kind === k) {
      delete row.votes[guest];
    } else {
      row.votes[guest] = { kind: k, by };
      row.moodAt = Date.now();
    }
  }

  cache.byTrack[trackId] = row;
  pruneIfOverCap(trackId);
  schedulePersist();
  return { ok: true, ...snapshot(trackId, guest) };
}

/** @deprecated use setReaction — kept for older call sites/tests */
export function addReaction(trackId, kind, meta = {}) {
  const guest =
    cleanGuestId(meta.guestId) ||
    cleanGuestId(meta.guest) ||
    `legacy-${kind}-${trackId}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return setReaction(trackId, kind, guest, meta);
}

/**
 * Karaoke shortlist — tracks guests tagged with the mic reaction.
 * Sorted by mic count (then most recent). Includes `by` display names.
 */
export function listKaraokeTracks(limit = 50) {
  load();
  const n = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
  return Object.entries(cache.byTrack)
    .map(([id, raw]) => {
      const micVotes =
        raw?.micVotes && typeof raw.micVotes === "object" ? raw.micVotes : {};
      const names = [];
      let latest = Number(raw?.micAt) || 0;
      for (const vote of Object.values(micVotes)) {
        const mic = readMicVote(vote);
        if (!mic) continue;
        names.push(mic.by);
        if (mic.at > latest) latest = mic.at;
      }
      if (!names.length) return null;
      return {
        id,
        name: cleanMeta(raw?.name),
        artist: cleanMeta(raw?.artist),
        count: names.length,
        by: uniqueLabels(names),
        ts: latest,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.count - a.count || b.ts - a.ts)
    .slice(0, n);
}

/** Thumbs up + heart + fire. */
export const LIKED_REACTION_KINDS = ["up", "heart", "fire"];
/** Party emoji only. */
export const PARTY_REACTION_KINDS = ["party"];
/** Thumbs down + vomit. */
export const HATED_REACTION_KINDS = ["down", "vomit"];

/**
 * Rank tracks by a set of mood reaction kinds.
 * Each entry: { id, name, artist, count, by, reactions: [{ kind, by }], ts }
 */
export function listTracksByMoodKinds(kinds, limit = 50) {
  const want = (Array.isArray(kinds) ? kinds : [])
    .map((k) => String(k || "").toLowerCase())
    .filter((k) => MOOD_KINDS.has(k));
  if (!want.length) return [];
  const wantSet = new Set(want);

  load();
  const n = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
  return Object.entries(cache.byTrack)
    .map(([id, raw]) => {
      const votes =
        raw?.votes && typeof raw.votes === "object" ? raw.votes : {};
      /** @type {Record<string, string[]>} */
      const byKind = {};
      for (const k of want) byKind[k] = [];
      const names = [];
      let total = 0;
      for (const voteRaw of Object.values(votes)) {
        const vote = readMoodVote(voteRaw);
        if (!vote || !wantSet.has(vote.kind)) continue;
        byKind[vote.kind].push(vote.by);
        names.push(vote.by);
        total += 1;
      }
      if (!total) return null;
      const reactions = want
        .filter((kind) => byKind[kind].length)
        .map((kind) => ({
          kind,
          by: uniqueLabels(byKind[kind]),
        }));
      return {
        id,
        name: cleanMeta(raw?.name),
        artist: cleanMeta(raw?.artist),
        count: total,
        by: uniqueLabels(names),
        reactions,
        ts: Number(raw?.moodAt) || 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.count - a.count || b.ts - a.ts)
    .slice(0, n);
}

export function listTopLikedTracks(limit = 50) {
  return listTracksByMoodKinds(LIKED_REACTION_KINDS, limit);
}

export function listPartyMusicTracks(limit = 50) {
  return listTracksByMoodKinds(PARTY_REACTION_KINDS, limit);
}

export function listMostHatedTracks(limit = 50) {
  return listTracksByMoodKinds(HATED_REACTION_KINDS, limit);
}

/**
 * Tracks with mood reactions, for Stats attribution.
 * Each entry: { id, name, artist, count, reactions: [{ kind, by }], ts }
 */
export function listReactedTracks(limit = 50) {
  return listTracksByMoodKinds(MOOD_REACTION_KINDS, limit);
}

function trackHasAny(row) {
  const votes = row?.votes && typeof row.votes === "object" ? row.votes : {};
  const mic =
    row?.micVotes && typeof row.micVotes === "object" ? row.micVotes : {};
  for (const raw of Object.values(votes)) {
    if (readMoodVote(raw)) return true;
  }
  for (const raw of Object.values(mic)) {
    if (readMicVote(raw)) return true;
  }
  return false;
}

/** Wipe mood reactions only (keeps Karaoke mic tags). */
export function clearMoodReactions() {
  load();
  for (const [id, row] of Object.entries(cache.byTrack)) {
    if (!row || typeof row !== "object") {
      delete cache.byTrack[id];
      continue;
    }
    row.votes = {};
    delete row.moodAt;
    if (!trackHasAny(row)) delete cache.byTrack[id];
    else cache.byTrack[id] = row;
  }
  persist();
}

/** Wipe Karaoke mic tags only (keeps mood reactions). */
export function clearKaraokeReactions() {
  load();
  for (const [id, row] of Object.entries(cache.byTrack)) {
    if (!row || typeof row !== "object") {
      delete cache.byTrack[id];
      continue;
    }
    row.micVotes = {};
    delete row.micAt;
    if (!trackHasAny(row)) delete cache.byTrack[id];
    else cache.byTrack[id] = row;
  }
  persist();
}

/** Wipe all reactions + karaoke mic tags (tests / full wipe). */
export function clearReactions() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  cache = { byTrack: {} };
  try {
    fs.rmSync(STORE_FILE, { force: true });
  } catch {
    /* ignore */
  }
  persist();
}

/** Test helper — next read reloads from disk. */
export function resetCacheForTests() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  cache = null;
}
