// Guest suggestion box: party people leave ideas for the host; the host reviews
// them on a Memory-style page and can check them off when implemented.
//
// Backed by a bounded JSON file in data/ (Docker volume). Honors
// PARTYQUEUE_SUGGESTIONS_FILE for tests.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import { sanitizeDisplayName } from "./display-name.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUGGESTIONS_FILE =
  process.env.PARTYQUEUE_SUGGESTIONS_FILE ||
  path.join(__dirname, "..", "data", "suggestions.json");

const MAX = 800;
export const SUGGESTION_TEXT_MAX = 280;
export const SUGGESTION_TEXT_MIN = 3;

let cache = null;

export function sanitizeSuggestionText(value) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, SUGGESTION_TEXT_MAX);
  return cleaned.length >= SUGGESTION_TEXT_MIN ? cleaned : null;
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(SUGGESTIONS_FILE, "utf8"));
    cache = Array.isArray(raw)
      ? raw
          .filter((e) => e && typeof e.id === "string" && e.id)
          .map((e) => {
            const text = sanitizeSuggestionText(e.text) || String(e.text || "").slice(0, SUGGESTION_TEXT_MAX);
            const row = {
              id: e.id,
              text: text || "",
              ts: Number(e.ts) || 0,
              done: !!e.done,
              doneAt: e.doneAt != null ? Number(e.doneAt) || null : null,
              requestedBy: sanitizeDisplayName(e.requestedBy),
            };
            return row;
          })
          .filter((e) => e.text)
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

function persist() {
  try {
    const out = (cache ?? []).map((e) => {
      const row = {
        id: e.id,
        text: e.text,
        ts: e.ts,
        done: !!e.done,
      };
      if (e.requestedBy) row.requestedBy = e.requestedBy;
      if (e.done && e.doneAt) row.doneAt = e.doneAt;
      return row;
    });
    writeFileAtomic(SUGGESTIONS_FILE, JSON.stringify(out));
  } catch (err) {
    console.error("[suggestions] save failed:", err.message);
  }
}

/** Append a guest suggestion. Returns the stored row or null if invalid. */
export function addSuggestion({ text, requestedBy } = {}, ts = Date.now()) {
  const cleaned = sanitizeSuggestionText(text);
  if (!cleaned) return null;
  const by = sanitizeDisplayName(requestedBy);
  const list = load();
  const row = {
    id: crypto.randomUUID(),
    text: cleaned,
    ts: Number(ts) || Date.now(),
    done: false,
    doneAt: null,
  };
  if (by) row.requestedBy = by;
  list.push(row);
  while (list.length > MAX) list.shift();
  cache = list;
  persist();
  return { ...row };
}

/** Newest first (open items first within same done-state is host preference). */
export function getSuggestions({ includeDone = true } = {}) {
  let list = load().slice();
  if (!includeDone) list = list.filter((e) => !e.done);
  return list.sort((a, b) => {
    // Open items before done, then newest first.
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    return (b.ts || 0) - (a.ts || 0);
  });
}

export function setSuggestionDone(id, done = true, at = Date.now()) {
  if (typeof id !== "string" || !id) return null;
  const list = load();
  const row = list.find((e) => e.id === id);
  if (!row) return null;
  row.done = !!done;
  row.doneAt = row.done ? Number(at) || Date.now() : null;
  persist();
  return { ...row };
}

export function clearSuggestions() {
  cache = [];
  try {
    fs.rmSync(SUGGESTIONS_FILE, { force: true });
  } catch {
    /* nothing to remove */
  }
}

export function suggestionCounts() {
  const list = load();
  let open = 0;
  let done = 0;
  for (const e of list) {
    if (e.done) done++;
    else open++;
  }
  return { open, done, total: list.length };
}
