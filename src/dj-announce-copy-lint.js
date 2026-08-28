/**
 * Analyze DJ announce scripts without TTS or playback.
 * Catches glued outros, slogan labels, quote marks, filler, and repeats.
 */

import { DJ_SET_DESCRIPTORS, DJ_SHARED_OUTROS } from "./dj-phrase-bank.js";

export const ANNOUNCE_SLOGAN_LABELS = Object.freeze([
  "start-to-finish",
  "front-porch",
  "story-first",
  "floor-ready",
  "convertible-weather",
  "celebration-mode",
  "hands-in-the-air",
  "dance-floor-first",
  "volume-first",
  "adrenaline-first",
  ...DJ_SET_DESCRIPTORS.map((entry) => entry.text).filter((text) =>
    String(text).includes("-")
  ),
]);

const FILLER_PATTERNS = Object.freeze([
  { id: "get-ready", re: /\bget ready\b/i },
  { id: "trust-me", re: /\btrust me\b/i },
  { id: "party-magic", re: /\bparty magic\b/i },
  { id: "party-people", re: /\bparty people\b/i },
]);

const GLUE_FRAGMENT = /\b(?:waiting for|gonna be a|let the momentum|it's gonna be a|its gonna be a)\s+[A-Z]/;

const BORING_NGRAMS = new Set([
  "five tracks",
  "this set",
  "coming up",
  "on deck",
  "starting with",
  "back to the",
  "the music",
  "this one",
  "the queue",
  "the booth",
]);

const GENRE_WORD =
  /\b(?:rock|pop|country|rap|metal|disco|edm|folk|jazz|soul|punk|blues|hip[- ]hop)\b/gi;

function normalizeSpace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function outroTexts() {
  return DJ_SHARED_OUTROS.map((entry) => normalizeSpace(entry.text)).filter(
    (text) => text.length >= 12
  );
}

function sloganLabels() {
  return [...new Set(ANNOUNCE_SLOGAN_LABELS)].sort((a, b) => b.length - a.length);
}

/** True when a scripted outro is jammed onto an unfinished middle. */
export function findGluedOutro(script) {
  const s = normalizeSpace(script);
  if (!s) return null;
  for (const outro of outroTexts()) {
    if (!s.endsWith(outro)) continue;
    const before = s.slice(0, s.length - outro.length).trimEnd();
    if (before && !/[.!?…]$/.test(before)) return outro;
  }
  if (GLUE_FRAGMENT.test(s)) {
    return (s.match(GLUE_FRAGMENT) || [null])[0];
  }
  return null;
}

export function lintAnnounceScript(script) {
  const text = normalizeSpace(script);
  const issues = [];
  if (!text) {
    issues.push({ id: "empty", severity: "fail", detail: "empty script" });
    return issues;
  }

  const glued = findGluedOutro(text);
  if (glued) {
    issues.push({
      id: "glued-outro",
      severity: "fail",
      detail: glued,
    });
  }

  if (/["\u201c\u201d]/.test(text)) {
    issues.push({
      id: "quotes",
      severity: "fail",
      detail: "quotation marks around spoken copy",
    });
  }

  for (const label of sloganLabels()) {
    const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (re.test(text)) {
      issues.push({
        id: "slogan",
        severity: "fail",
        detail: label,
      });
    }
  }

  for (const filler of FILLER_PATTERNS) {
    if (filler.re.test(text)) {
      issues.push({
        id: filler.id,
        severity: "fail",
        detail: filler.id.replace("-", " "),
      });
    }
  }

  const genres = text.match(GENRE_WORD) || [];
  const uniqueGenres = [...new Set(genres.map((g) => g.toLowerCase()))];
  if (uniqueGenres.length >= 2) {
    issues.push({
      id: "genre-list",
      severity: "warn",
      detail: uniqueGenres.join(", "),
    });
  }

  return issues;
}

function sentences(script) {
  return normalizeSpace(script)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function fiveGrams(script) {
  const words = normalizeSpace(script)
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const grams = [];
  for (let i = 0; i + 5 <= words.length; i++) {
    const gram = words.slice(i, i + 5).join(" ");
    const boring = [...BORING_NGRAMS].some((b) => gram.includes(b));
    if (!boring) grams.push(gram);
  }
  return grams;
}

export function lintAnnounceBatch(scripts) {
  const lines = (Array.isArray(scripts) ? scripts : []).map((s) =>
    normalizeSpace(s)
  );
  const perScript = lines.map((script, index) => ({
    index,
    script,
    issues: lintAnnounceScript(script),
  }));

  const repeats = [];
  const seenExact = new Map();
  const seenOpeners = new Map();
  const seenClosers = new Map();
  const gramHits = new Map();

  for (const row of perScript) {
    const key = row.script.toLowerCase();
    if (seenExact.has(key)) {
      repeats.push({
        id: "duplicate-script",
        severity: "fail",
        detail: `announce ${seenExact.get(key) + 1} and ${row.index + 1}`,
      });
    } else {
      seenExact.set(key, row.index);
    }

    const bits = sentences(row.script);
    const opener = (bits[0] || "").toLowerCase();
    const closer = (bits[bits.length - 1] || "").toLowerCase();
    if (opener) {
      if (seenOpeners.has(opener)) {
        repeats.push({
          id: "repeat-intro",
          severity: "fail",
          detail: `announce ${seenOpeners.get(opener) + 1} and ${row.index + 1}: ${bits[0]}`,
        });
      } else {
        seenOpeners.set(opener, row.index);
      }
    }
    if (closer && bits.length > 1) {
      if (seenClosers.has(closer)) {
        repeats.push({
          id: "repeat-outro",
          severity: "fail",
          detail: `announce ${seenClosers.get(closer) + 1} and ${row.index + 1}: ${bits[bits.length - 1]}`,
        });
      } else {
        seenClosers.set(closer, row.index);
      }
    }

    for (const gram of fiveGrams(row.script)) {
      const hits = gramHits.get(gram) || [];
      hits.push(row.index);
      gramHits.set(gram, hits);
    }
  }

  for (const [gram, hits] of gramHits) {
    const unique = [...new Set(hits)];
    if (unique.length < 2) continue;
    repeats.push({
      id: "repeat-phrase",
      severity: "warn",
      detail: `"${gram}" in announces ${unique.map((i) => i + 1).join(", ")}`,
    });
  }

  const failCount = [...perScript.flatMap((r) => r.issues), ...repeats].filter(
    (issue) => issue.severity === "fail"
  ).length;
  const warnCount = [...perScript.flatMap((r) => r.issues), ...repeats].filter(
    (issue) => issue.severity === "warn"
  ).length;

  return { perScript, repeats, failCount, warnCount };
}
