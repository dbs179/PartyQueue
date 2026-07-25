// Per-guest DJ memory for one party night: first-shout guarantee, birthday
// wished once, anti-repeat blurbs / recent scripts, and DJ Voice taglines.
//
// Night = rolling 12h window (same as Party Stats / Closing Time recap).
// Backed by data/dj-night-memory.json (Docker volume). Override path with
// PARTYQUEUE_DJ_MEMORY_FILE for tests.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import { sanitizeDisplayName } from "./display-name.js";
import { isGuestBirthdayToday } from "./guest-profiles.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE =
  process.env.PARTYQUEUE_DJ_MEMORY_FILE ||
  path.join(__dirname, "..", "data", "dj-night-memory.json");

export const NIGHT_WINDOW_HOURS = 12;
const MAX_RECENT_SCRIPTS = 5;
const MAX_USED_NOTES = 40;
// Sized for the 100-line intro/outro/descriptor banks plus asides: a full
// night of announces must fit without evicting reservations mid-window.
const MAX_GLOBAL_PHRASE_USES = 600;
const MAX_GLOBAL_ANNOUNCE_SCRIPTS = 20;
const MAX_TAGLINE_CLIPS = 120;

let cache = null;

function windowMs() {
  return NIGHT_WINDOW_HOURS * 60 * 60_000;
}

function nightStart(now = Date.now()) {
  return Number(now) - windowMs();
}

function emptyStore() {
  return {
    guests: {},
    global: {
      phraseUses: [],
      recentAnnounceScripts: [],
      taglineClips: [],
    },
  };
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    const guests =
      raw && typeof raw === "object" && raw.guests && typeof raw.guests === "object"
        ? raw.guests
        : {};
    cache = emptyStore();
    for (const [name, entry] of Object.entries(guests)) {
      const key = sanitizeDisplayName(name);
      if (!key || !entry || typeof entry !== "object") continue;
      cache.guests[key] = normalizeEntry(entry);
    }
    cache.global = normalizeGlobal(raw?.global);
  } catch {
    cache = emptyStore();
  }
  return cache;
}

function normalizeEntry(entry) {
  const usedNotes = Array.isArray(entry.usedNotes)
    ? entry.usedNotes
        .filter((u) => u && typeof u.text === "string" && u.text.trim())
        .map((u) => ({
          text: String(u.text).trim(),
          ts: Number(u.ts) || 0,
        }))
        .slice(-MAX_USED_NOTES)
    : [];
  const recentScripts = Array.isArray(entry.recentScripts)
    ? entry.recentScripts
        .filter((u) => u && typeof u.text === "string" && u.text.trim())
        .map((u) => ({
          text: String(u.text).trim(),
          ts: Number(u.ts) || 0,
        }))
        .slice(-MAX_RECENT_SCRIPTS)
    : [];
  return {
    firstShoutAt: Number(entry.firstShoutAt) || 0,
    birthdayShoutedAt: Number(entry.birthdayShoutedAt) || 0,
    usedNotes,
    recentScripts,
  };
}

function normalizeGlobal(global) {
  const phraseUses = Array.isArray(global?.phraseUses)
    ? global.phraseUses
        .filter(
          (item) =>
            item &&
            typeof item.category === "string" &&
            item.category.trim() &&
            typeof item.id === "string" &&
            item.id.trim()
        )
        .map((item) => ({
          category: String(item.category).trim(),
          id: String(item.id).trim(),
          ts: Number(item.ts) || 0,
        }))
        .slice(-MAX_GLOBAL_PHRASE_USES)
    : [];
  const recentAnnounceScripts = Array.isArray(global?.recentAnnounceScripts)
    ? global.recentAnnounceScripts
        .filter((item) => item && typeof item.text === "string" && item.text.trim())
        .map((item) => ({
          text: String(item.text).trim(),
          ts: Number(item.ts) || 0,
        }))
        .slice(-MAX_GLOBAL_ANNOUNCE_SCRIPTS)
    : [];
  const taglineClips = Array.isArray(global?.taglineClips)
    ? global.taglineClips
        .filter(
          (item) =>
            item &&
            typeof item.uri === "string" &&
            item.uri.trim() &&
            typeof item.text === "string" &&
            item.text.trim()
        )
        .map((item) => ({
          uri: String(item.uri).trim(),
          text: String(item.text).trim(),
          ts: Number(item.ts) || 0,
        }))
        .slice(-MAX_TAGLINE_CLIPS)
    : [];
  return { phraseUses, recentAnnounceScripts, taglineClips };
}

function persist() {
  try {
    writeFileAtomic(MEMORY_FILE, JSON.stringify(cache ?? emptyStore(), null, 2));
  } catch (err) {
    console.error("[dj-night-memory] save failed:", err.message);
  }
}

function pruneGuest(entry, since) {
  if (!entry) return null;
  const firstShoutAt =
    entry.firstShoutAt && entry.firstShoutAt >= since ? entry.firstShoutAt : 0;
  const birthdayShoutedAt =
    entry.birthdayShoutedAt && entry.birthdayShoutedAt >= since
      ? entry.birthdayShoutedAt
      : 0;
  const usedNotes = (entry.usedNotes || []).filter((u) => u.ts >= since);
  const recentScripts = (entry.recentScripts || []).filter((u) => u.ts >= since);
  if (
    !firstShoutAt &&
    !birthdayShoutedAt &&
    !usedNotes.length &&
    !recentScripts.length
  ) {
    return null;
  }
  return {
    firstShoutAt,
    birthdayShoutedAt,
    usedNotes: usedNotes.slice(-MAX_USED_NOTES),
    recentScripts: recentScripts.slice(-MAX_RECENT_SCRIPTS),
  };
}

function pruneStore(now = Date.now()) {
  const store = load();
  const since = nightStart(now);
  const next = emptyStore();
  for (const [name, entry] of Object.entries(store.guests || {})) {
    const kept = pruneGuest(entry, since);
    if (kept) next.guests[name] = kept;
  }
  next.global = {
    phraseUses: (store.global?.phraseUses || [])
      .filter((item) => item.ts >= since)
      .slice(-MAX_GLOBAL_PHRASE_USES),
    recentAnnounceScripts: (store.global?.recentAnnounceScripts || [])
      .filter((item) => item.ts >= since)
      .slice(-MAX_GLOBAL_ANNOUNCE_SCRIPTS),
    taglineClips: (store.global?.taglineClips || [])
      .filter((item) => item.ts >= since)
      .slice(-MAX_TAGLINE_CLIPS),
  };
  cache = next;
  return cache;
}

function guestKey(name) {
  return sanitizeDisplayName(name);
}

function getOrCreateGuest(name) {
  const key = guestKey(name);
  if (!key) return { key: null, entry: null };
  const store = pruneStore();
  if (!store.guests[key]) {
    store.guests[key] = {
      firstShoutAt: 0,
      birthdayShoutedAt: 0,
      usedNotes: [],
      recentScripts: [],
    };
  }
  return { key, entry: store.guests[key] };
}

function normNote(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function candidatePhrase(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const id = String(candidate.id || "").trim();
  const text = String(candidate.text || "").trim();
  return id && text ? candidate : null;
}

/**
 * Select and synchronously reserve a global DJ phrase. Unused phrases win;
 * after exhaustion, the least-recently used phrase returns.
 */
export function reserveDjPhrase(
  category,
  candidates,
  { salt = 0, now = Date.now() } = {}
) {
  const key = String(category || "").trim();
  const bank = (Array.isArray(candidates) ? candidates : [])
    .map(candidatePhrase)
    .filter(Boolean);
  if (!key || !bank.length) return null;

  const ts = Number(now) || Date.now();
  const store = pruneStore(ts);
  const usage = new Map();
  for (const item of store.global.phraseUses) {
    if (item.category !== key) continue;
    const previous = usage.get(item.id);
    if (previous == null || item.ts > previous) usage.set(item.id, item.ts);
  }

  const unused = bank.filter((item) => !usage.has(item.id));
  let selected;
  if (unused.length) {
    const index = Math.abs(Math.floor(Number(salt) || 0)) % unused.length;
    selected = unused[index];
  } else {
    selected = [...bank].sort(
      (a, b) => (usage.get(a.id) || 0) - (usage.get(b.id) || 0)
    )[0];
  }

  store.global.phraseUses.push({ category: key, id: selected.id, ts });
  while (store.global.phraseUses.length > MAX_GLOBAL_PHRASE_USES) {
    store.global.phraseUses.shift();
  }
  persist();
  return selected;
}

export function getRecentDjPhraseIds(category, limit = 50, now = Date.now()) {
  const key = String(category || "").trim();
  if (!key) return [];
  const store = pruneStore(now);
  const n = Math.max(0, Math.min(MAX_GLOBAL_PHRASE_USES, Number(limit) || 50));
  return store.global.phraseUses
    .filter((item) => item.category === key)
    .slice(-n)
    .map((item) => item.id);
}

function hashUri(uri) {
  let h = 0;
  const key = String(uri || "");
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Pick a DJ Now Playing / queue tagline for a clip URL. Same clip keeps the
 * same line for the night (no poll flicker); new clips prefer unused lines
 * from `pack` until the pack is exhausted, then the least-recently used.
 * @param {string|null|undefined} uri
 * @param {string[]} pack
 * @returns {string}
 */
export function reserveClipTagline(uri, pack, { now = Date.now() } = {}) {
  const lines = (Array.isArray(pack) ? pack : [])
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  if (!lines.length) return "Live from the Booth";

  const uriKey = String(uri || "").trim() || "__empty__";
  const ts = Number(now) || Date.now();
  const store = pruneStore(ts);
  const clips = store.global.taglineClips || [];

  const existing = clips.find((item) => item.uri === uriKey);
  if (existing && lines.includes(existing.text)) {
    return existing.text;
  }

  const lastUsed = new Map();
  for (const item of clips) {
    if (!item?.text) continue;
    const previous = lastUsed.get(item.text);
    if (previous == null || item.ts > previous) {
      lastUsed.set(item.text, item.ts);
    }
  }

  const unused = lines.filter((line) => !lastUsed.has(line));
  let selected;
  if (unused.length) {
    selected = unused[hashUri(uriKey) % unused.length];
  } else {
    selected = [...lines].sort(
      (a, b) => (lastUsed.get(a) || 0) - (lastUsed.get(b) || 0)
    )[0];
  }

  clips.push({ uri: uriKey, text: selected, ts });
  while (clips.length > MAX_TAGLINE_CLIPS) clips.shift();
  store.global.taglineClips = clips;
  persist();
  return selected;
}

export function rememberDjAnnounceScript(script, now = Date.now()) {
  const text = String(script || "").trim();
  if (!text) return;
  const ts = Number(now) || Date.now();
  const store = pruneStore(ts);
  store.global.recentAnnounceScripts.push({ text, ts });
  while (
    store.global.recentAnnounceScripts.length > MAX_GLOBAL_ANNOUNCE_SCRIPTS
  ) {
    store.global.recentAnnounceScripts.shift();
  }
  persist();
}

export function getRecentDjAnnounceScripts(limit = 5, now = Date.now()) {
  const store = pruneStore(now);
  const n = Math.max(
    0,
    Math.min(MAX_GLOBAL_ANNOUNCE_SCRIPTS, Math.floor(Number(limit) || 5))
  );
  return store.global.recentAnnounceScripts
    .slice(-n)
    .map((item) => item.text);
}

/** True when this named guest has not yet received a request shout tonight. */
export function isFirstShoutTonight(name, now = Date.now()) {
  const key = guestKey(name);
  if (!key) return false;
  const store = pruneStore(now);
  const entry = store.guests[key];
  const at = Number(entry?.firstShoutAt) || 0;
  return at < nightStart(now);
}

/**
 * Calendar birthday today and not yet wished in tonight's window.
 */
export function shouldBirthdayShout(name, now = Date.now()) {
  const key = guestKey(name);
  if (!key) return false;
  if (!isGuestBirthdayToday(key, new Date(now))) return false;
  const store = pruneStore(now);
  const entry = store.guests[key];
  const at = Number(entry?.birthdayShoutedAt) || 0;
  return at < nightStart(now);
}

/**
 * Prefer unused notes; when exhausted, reuse oldest-used first.
 * @param {string} name
 * @param {string[]} candidates
 * @param {number} [limit]
 */
export function pickFreshNotes(name, candidates, limit = 2) {
  const list = (Array.isArray(candidates) ? candidates : []).filter(
    (n) => typeof n === "string" && n.trim()
  );
  if (!list.length) return [];
  const n = Math.max(1, Math.min(list.length, Math.floor(Number(limit) || 2)));
  const key = guestKey(name);
  const store = key ? pruneStore() : emptyStore();
  const entry = key ? store.guests[key] : null;
  const usedTs = new Map();
  for (const u of entry?.usedNotes || []) {
    const k = normNote(u.text);
    if (!k) continue;
    const prev = usedTs.get(k);
    if (prev == null || u.ts < prev) usedTs.set(k, u.ts);
  }

  const unused = list.filter((c) => !usedTs.has(normNote(c)));
  if (unused.length >= n) {
    return shuffle(unused).slice(0, n);
  }

  const usedSorted = list
    .filter((c) => usedTs.has(normNote(c)))
    .sort(
      (a, b) => (usedTs.get(normNote(a)) || 0) - (usedTs.get(normNote(b)) || 0)
    );

  const picked = [...shuffle(unused)];
  const seen = new Set(picked.map(normNote));
  for (const c of usedSorted) {
    if (picked.length >= n) break;
    const k = normNote(c);
    if (seen.has(k)) continue;
    seen.add(k);
    picked.push(c);
  }
  return picked.slice(0, n);
}

/** Recent shout scripts for a guest (newest last), within the night window. */
export function getRecentScripts(name, limit = 3) {
  const key = guestKey(name);
  if (!key) return [];
  const store = pruneStore();
  const entry = store.guests[key];
  const n = Math.max(0, Math.min(MAX_RECENT_SCRIPTS, Math.floor(Number(limit) || 3)));
  const list = entry?.recentScripts || [];
  return list.slice(-n).map((u) => u.text);
}

/**
 * Record a completed request-shout script (marks first shout + optional birthday).
 * @param {{ name?: string, notes?: string[], script?: string, birthday?: boolean }} opts
 */
export function rememberShout({
  name,
  notes,
  script,
  birthday = false,
} = {}, now = Date.now()) {
  const { key, entry } = getOrCreateGuest(name);
  if (!key || !entry) return;
  const ts = Number(now) || Date.now();
  if (!entry.firstShoutAt || entry.firstShoutAt < nightStart(ts)) {
    entry.firstShoutAt = ts;
  }
  if (birthday) {
    entry.birthdayShoutedAt = ts;
  }
  const noteList = Array.isArray(notes) ? notes : [];
  for (const text of noteList) {
    const cleaned = String(text || "").trim();
    if (!cleaned) continue;
    entry.usedNotes.push({ text: cleaned, ts });
  }
  while (entry.usedNotes.length > MAX_USED_NOTES) entry.usedNotes.shift();

  const line = String(script || "").trim();
  if (line) {
    entry.recentScripts.push({ text: line, ts });
    while (entry.recentScripts.length > MAX_RECENT_SCRIPTS) {
      entry.recentScripts.shift();
    }
  }
  persist();
}

/** @deprecated prefer rememberShout — kept for explicit birthday marking in tests */
export function markBirthdayShouted(name, now = Date.now()) {
  rememberShout({ name, birthday: true }, now);
}

/**
 * Forget tonight's birthday + first-shout flags for one guest so the next
 * request can get a forced shout with a birthday wish again (testing / host reset).
 * Keeps used blurbs / recent scripts so anti-repeat still applies.
 * @returns {boolean} false if name is empty/invalid
 */
export function forgetBirthdayShout(name) {
  const key = guestKey(name);
  if (!key) return false;
  const store = pruneStore();
  const entry = store.guests[key];
  if (!entry) return true;
  entry.birthdayShoutedAt = 0;
  entry.firstShoutAt = 0;
  const kept = pruneGuest(entry, nightStart());
  if (kept) store.guests[key] = kept;
  else delete store.guests[key];
  persist();
  return true;
}

export function clearDjNightMemory() {
  cache = emptyStore();
  try {
    fs.rmSync(MEMORY_FILE, { force: true });
  } catch {
    /* nothing to remove */
  }
}

/** Test helper for reloading a fixture from disk. */
export function resetDjNightMemoryCacheForTests() {
  cache = null;
}
