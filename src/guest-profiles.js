// Host-editable notes about party guests (display names). The DJ's AI remixes
// a few notes into a fresh blurb for request shout-outs. Optional birthday
// (month/day) triggers a happy-birthday line when it matches today.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import { sanitizeDisplayName } from "./display-name.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_FILE =
  process.env.PARTYQUEUE_GUESTS_FILE ||
  path.join(__dirname, "..", "data", "guest-profiles.json");

export const GUEST_NOTE_MAX = 120;
export const GUEST_NOTES_MAX_COUNT = 40;
// Spoken as "birthday {role}" in DJ shout-outs / UI (e.g. birthday badass).
export const BIRTHDAY_ROLES = [
  "boy",
  "girl",
  "star",
  "badass",
  "legend",
  "boss",
  "queen",
  "king",
  "champ",
  "beast",
];

let cache = null; // { [name]: { notes: string[], birthday, birthdayRole, updatedAt } }

function freshInstallProfiles() {
  return {
    "Sample Guest": {
      notes: [
        "Enjoys upbeat sing-alongs.",
        "Likes a friendly shout-out when their request plays.",
      ],
      birthday: null,
      birthdayRole: null,
      updatedAt: Date.now(),
    },
  };
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    cache = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch (err) {
    cache = err?.code === "ENOENT" ? freshInstallProfiles() : {};
    if (err?.code === "ENOENT") persist();
  }
  let dirty = false;
  for (const key of Object.keys(cache)) {
    const entry = cache[key];
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.notes === "string") {
      entry.notes = splitLegacyNotes(entry.notes);
      dirty = true;
    } else if (Array.isArray(entry.notes)) {
      const expanded = expandPackedNotes(entry.notes);
      if (
        expanded.length !== entry.notes.length ||
        expanded.some((n, i) => n !== entry.notes[i])
      ) {
        entry.notes = expanded;
        dirty = true;
      }
    } else {
      entry.notes = [];
      dirty = true;
    }
    const bday = normalizeBirthday(entry.birthday);
    if (bday !== (entry.birthday || null)) {
      entry.birthday = bday;
      dirty = true;
    }
    // If no structured birthday, try to pull one from notes (e.g. "Birthday is July 17th").
    if (!entry.birthday) {
      const inferred = inferBirthdayFromNotes(entry.notes);
      if (inferred) {
        entry.birthday = inferred;
        dirty = true;
      }
    }
    const role = normalizeBirthdayRole(entry.birthdayRole);
    if (role !== (entry.birthdayRole || null)) {
      entry.birthdayRole = role;
      dirty = true;
    }
  }
  if (dirty) persist();
  return cache;
}

function persist() {
  try {
    writeFileAtomic(STORE_FILE, JSON.stringify(cache ?? {}, null, 2));
  } catch (err) {
    console.error("[guests] save failed:", err.message);
  }
}

/** Split an old single blob into note lines when possible. */
function splitLegacyNotes(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  let parts = text
    .split(/\n+|;\s+| · /)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 1 && /[.!?]\s+\S/.test(parts[0])) {
    parts = parts[0]
      .split(/(?<=[.!?])\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
  }
  return parts
    .map((p) => sanitizeGuestNote(p))
    .filter(Boolean)
    .slice(0, GUEST_NOTES_MAX_COUNT);
}

function expandPackedNotes(notes) {
  const list = Array.isArray(notes) ? notes : [];
  if (list.length !== 1) {
    return list
      .map(sanitizeGuestNote)
      .filter(Boolean)
      .slice(0, GUEST_NOTES_MAX_COUNT);
  }
  const expanded = splitLegacyNotes(list[0]);
  return expanded.length > 1
    ? expanded
    : [sanitizeGuestNote(list[0])].filter(Boolean);
}

export function sanitizeGuestNote(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, GUEST_NOTE_MAX);
}

function normalizeNotesList(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map(sanitizeGuestNote)
      .filter(Boolean)
      .slice(0, GUEST_NOTES_MAX_COUNT);
  }
  if (typeof raw === "string") return splitLegacyNotes(raw);
  return [];
}

const MONTHS = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

/** @returns {string|null} MM-DD */
export function normalizeBirthday(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object" && value.month != null && value.day != null) {
    const m = Math.floor(Number(value.month));
    const d = Math.floor(Number(value.day));
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    return null;
  }
  const s = String(value).trim();
  let m = s.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-]\d{2,4})?$/);
  if (m) {
    const month = Math.floor(Number(m[1]));
    const day = Math.floor(Number(m[2]));
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  // ISO date YYYY-MM-DD from <input type="date">
  m = s.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (m) {
    const month = Math.floor(Number(m[1]));
    const day = Math.floor(Number(m[2]));
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  return null;
}

export function normalizeBirthdayRole(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  if (BIRTHDAY_ROLES.includes(v)) return v;
  return null;
}

function inferBirthdayFromNotes(notes) {
  for (const note of normalizeNotesList(notes)) {
    const lower = note.toLowerCase();
    if (!/birthday|bday|b-day/.test(lower)) continue;
    const named = lower.match(
      /(?:birthday|bday|b-day)\s+(?:is\s+|on\s+)?([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?/
    );
    if (named && MONTHS[named[1]]) {
      return normalizeBirthday({ month: MONTHS[named[1]], day: Number(named[2]) });
    }
    const numeric = lower.match(
      /(?:birthday|bday|b-day)\s+(?:is\s+|on\s+)?(\d{1,2})[/-](\d{1,2})/
    );
    if (numeric) {
      return normalizeBirthday({ month: Number(numeric[1]), day: Number(numeric[2]) });
    }
  }
  return null;
}

/** Case-insensitive profile key resolve. */
export function findGuestKey(name) {
  const key = sanitizeDisplayName(name);
  if (!key) return null;
  const store = load();
  if (store[key]) return key;
  const lower = key.toLowerCase();
  return (
    Object.keys(store).find((k) => k.toLowerCase() === lower) || null
  );
}

function ensureEntry(key) {
  const store = load();
  if (!store[key]) {
    store[key] = {
      notes: [],
      birthday: null,
      birthdayRole: null,
      updatedAt: Date.now(),
    };
  }
  if (!Array.isArray(store[key].notes)) store[key].notes = [];
  return store[key];
}

function toPublic(name, entry) {
  return {
    name,
    notes: normalizeNotesList(entry?.notes),
    birthday: normalizeBirthday(entry?.birthday),
    birthdayRole: normalizeBirthdayRole(entry?.birthdayRole) || "star",
    updatedAt: Number(entry?.updatedAt) || 0,
  };
}

/** Sorted list of guest profiles for the Settings UI. */
export function listGuestProfiles() {
  const store = load();
  return Object.keys(store)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((name) => toPublic(name, store[name]));
}

export function getGuestProfile(name) {
  const key = findGuestKey(name);
  if (!key) return null;
  return toPublic(key, load()[key]);
}

/** All notes for a guest (empty array if unknown). */
export function getGuestNotesList(name) {
  return getGuestProfile(name)?.notes || [];
}

/**
 * Pick 1–2 notes at random for template fallbacks.
 * @returns {string[]}
 */
export function pickGuestNotes(name, max = 2) {
  const all = getGuestNotesList(name);
  if (!all.length) return [];
  const limit = Math.max(1, Math.min(2, Math.floor(Number(max) || 2)));
  if (all.length === 1) return [all[0]];
  const take = all.length >= 2 && Math.random() < 0.45 ? Math.min(2, limit) : 1;
  return shuffleNotes(all).slice(0, take);
}

/**
 * Sample up to `limit` notes as AI source material (shuffled).
 * @returns {string[]}
 */
export function sampleGuestNotes(name, limit = 5) {
  const all = getGuestNotesList(name);
  if (!all.length) return [];
  const n = Math.max(1, Math.min(all.length, Math.floor(Number(limit) || 5)));
  return shuffleNotes(all).slice(0, n);
}

function shuffleNotes(list) {
  const shuffled = [...list];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/** @deprecated use getGuestNotesList / pickGuestNotes */
export function getGuestNotes(name) {
  return getGuestNotesList(name).join(" ");
}

/**
 * True when the guest's birthday (month/day) matches `now` in local time.
 */
export function isGuestBirthdayToday(name, now = new Date()) {
  const profile = getGuestProfile(name);
  const bday = profile?.birthday;
  if (!bday) return false;
  const [mm, dd] = bday.split("-").map(Number);
  return (
    Number(now.getMonth()) + 1 === mm && Number(now.getDate()) === dd
  );
}

export function birthdayShoutLabel(name) {
  const role = normalizeBirthdayRole(getGuestProfile(name)?.birthdayRole) || "star";
  return `birthday ${role}`;
}

/**
 * Make sure a guest shows up in the Users list. Called when someone queues a
 * song under a new name; creates an empty profile (no notes, no birthday)
 * unless one already exists (case-insensitive).
 * @returns {boolean} true when a new profile was created
 */
export function ensureGuestProfile(name) {
  const key = sanitizeDisplayName(name);
  if (!key) return false;
  if (findGuestKey(key)) return false;
  const store = load();
  ensureEntry(key);
  cache = store;
  persist();
  return true;
}

/**
 * Append one note for a guest (creates the profile if needed).
 * @returns {{ name: string, notes: string[], birthday?: string|null, birthdayRole?: string }|null}
 */
export function addGuestNote(name, note) {
  const key = sanitizeDisplayName(name);
  if (!key) return null;
  const existingKey = findGuestKey(key) || key;
  const cleaned = sanitizeGuestNote(note);
  if (!cleaned) return null;
  const store = load();
  const entry = ensureEntry(existingKey);
  const existing = normalizeNotesList(entry.notes);
  if (existing.length >= GUEST_NOTES_MAX_COUNT) {
    return { ...toPublic(existingKey, entry), full: true };
  }
  if (existing.some((n) => n.toLowerCase() === cleaned.toLowerCase())) {
    entry.updatedAt = Date.now();
    cache = store;
    persist();
    return toPublic(existingKey, entry);
  }
  entry.notes = [...existing, cleaned];
  entry.updatedAt = Date.now();
  // Re-infer birthday from notes if still unset.
  if (!entry.birthday) {
    entry.birthday = inferBirthdayFromNotes(entry.notes);
  }
  cache = store;
  persist();
  return toPublic(existingKey, entry);
}

/**
 * Set or clear birthday (+ optional boy/girl/star role).
 * Creates the profile if needed.
 */
export function setGuestBirthday(name, birthday, birthdayRole) {
  const key = sanitizeDisplayName(name);
  if (!key) return null;
  const existingKey = findGuestKey(key) || key;
  const store = load();
  const entry = ensureEntry(existingKey);
  if (birthday !== undefined) {
    entry.birthday = normalizeBirthday(birthday);
  }
  if (birthdayRole !== undefined) {
    entry.birthdayRole = normalizeBirthdayRole(birthdayRole);
  }
  entry.updatedAt = Date.now();
  // Drop empty profiles with no notes and no birthday.
  if (!normalizeNotesList(entry.notes).length && !entry.birthday) {
    delete store[existingKey];
    cache = store;
    persist();
    return { name: existingKey, notes: [], birthday: null, birthdayRole: "star" };
  }
  cache = store;
  persist();
  return toPublic(existingKey, entry);
}

/**
 * Replace all notes for a guest. Empty list deletes notes (keeps birthday).
 */
export function setGuestProfile(name, notes) {
  const key = sanitizeDisplayName(name);
  if (!key) return null;
  const existingKey = findGuestKey(key) || key;
  const cleaned = normalizeNotesList(notes);
  const store = load();
  const entry = ensureEntry(existingKey);
  entry.notes = cleaned;
  entry.updatedAt = Date.now();
  if (!cleaned.length && !entry.birthday) {
    delete store[existingKey];
    cache = store;
    persist();
    return { name: existingKey, notes: [], birthday: null, birthdayRole: "star" };
  }
  cache = store;
  persist();
  return toPublic(existingKey, entry);
}

export function removeGuestNote(name, index) {
  const key = findGuestKey(name);
  if (!key) return null;
  const store = load();
  const entry = store[key];
  if (!entry) return null;
  const existing = normalizeNotesList(entry.notes);
  const i = Math.floor(Number(index));
  if (!Number.isFinite(i) || i < 0 || i >= existing.length) return null;
  existing.splice(i, 1);
  entry.notes = existing;
  entry.updatedAt = Date.now();
  if (!existing.length && !entry.birthday) {
    delete store[key];
    cache = store;
    persist();
    return { name: key, notes: [], birthday: null, birthdayRole: "star" };
  }
  cache = store;
  persist();
  return toPublic(key, entry);
}

export function deleteGuestProfile(name) {
  const key = findGuestKey(name);
  if (!key) return false;
  const store = load();
  if (!(key in store)) return false;
  delete store[key];
  cache = store;
  persist();
  return true;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rename a guest profile key. Rewrites that name inside notes across profiles
 * so DJ blurbs stay consistent. Does not merge into an existing different name.
 * @returns {{ ok: true, guest: object } | { ok: false, error: string }}
 */
export function renameGuestProfile(fromName, toName) {
  const from = findGuestKey(fromName);
  const to = sanitizeDisplayName(toName);
  if (!from) return { ok: false, error: "Guest not found." };
  if (!to) return { ok: false, error: "Enter a new name." };
  if (from.toLowerCase() === to.toLowerCase() && from !== to) {
    // Case-only rename (e.g. alex → Alex): rewrite key.
  } else if (from === to) {
    return { ok: true, guest: getGuestProfile(from) };
  }

  const store = load();
  const destExisting = findGuestKey(to);
  if (destExisting && destExisting !== from) {
    return {
      ok: false,
      error: `"${destExisting}" already exists. Remove or merge manually.`,
    };
  }

  const entry = store[from];
  if (!entry) return { ok: false, error: "Guest not found." };
  delete store[from];

  const re = new RegExp(`\\b${escapeRegExp(from)}\\b`, "gi");
  entry.notes = normalizeNotesList(entry.notes).map((n) => n.replace(re, to));
  entry.updatedAt = Date.now();
  store[to] = entry;

  for (const [key, other] of Object.entries(store)) {
    if (key === to) continue;
    const notes = normalizeNotesList(other.notes);
    let changed = false;
    const next = notes.map((n) => {
      const replaced = n.replace(re, to);
      if (replaced !== n) changed = true;
      return replaced;
    });
    if (changed) {
      other.notes = next;
      other.updatedAt = Date.now();
    }
  }

  cache = store;
  persist();
  return { ok: true, guest: toPublic(to, entry) };
}
