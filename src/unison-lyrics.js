// Focused fallback adapter for Unison (https://unison.boidu.dev).
// Unison's catalog includes enhanced LRC and TTML. PartyQueue consumes line
// timestamps, so this adapter accepts LRC-like and plain text payloads.

const UNISON_BASE = "https://unison.boidu.dev";
const UNISON_CALL_MS = 2_500;
export const UNISON_ATTRIBUTION = {
  text: "Lyrics from Unison",
  url: "https://unisonlyrics.org",
};

const LRC_FORMATS = new Set([
  "lrc",
  "enhanced",
  "enhanced_lrc",
  "enhanced-lrc",
  "linesync",
  "line",
]);
const PLAIN_FORMATS = new Set(["plain", "text", "txt", "unsynced"]);

export class UnisonUnavailableError extends Error {
  constructor(message = "Unison is temporarily unavailable.") {
    super(message);
    this.name = "UnisonUnavailableError";
  }
}

function normalized(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ");
}

function looksLikeLrc(value) {
  return /^\s*\[\d{1,3}:\d{2}/m.test(String(value || ""));
}

function formatKind(format, lyrics = "") {
  const key = String(format || "").toLowerCase();
  if (LRC_FORMATS.has(key) || looksLikeLrc(lyrics)) return "lrc";
  if (PLAIN_FORMATS.has(key) || key === "") return "plain";
  // Unknown formats: still accept if the body looks like timed LRC.
  return looksLikeLrc(lyrics) ? "lrc" : null;
}

function scoreHit(hit, { title, artist, album, duration }) {
  if (!hit || typeof hit !== "object") return -Infinity;
  const kind = formatKind(hit.format, hit.lyrics);
  if (!kind) return -Infinity;

  let score = kind === "lrc" ? 100 : 40;
  if (normalized(hit.song) === normalized(title)) score += 50;
  if (normalized(hit.artist) === normalized(artist)) score += 50;
  const queryAlbum = normalized(album);
  const hitAlbum = normalized(hit.album);
  if (queryAlbum && hitAlbum) {
    if (hitAlbum === queryAlbum) score += 24;
    else if (hitAlbum.includes(queryAlbum) || queryAlbum.includes(hitAlbum)) {
      score += 16;
    }
  }
  if (duration != null && Number.isFinite(Number(hit.duration))) {
    score += Math.max(0, 30 - Math.abs(Number(hit.duration) - duration) * 3);
  }
  score += Math.max(0, Number(hit.effectiveScore) || 0);
  return score;
}

function pickHit(rows, query) {
  if (!Array.isArray(rows)) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const row of rows) {
    const score = scoreHit(row, query);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}

function cleanEnhancedLrc(value) {
  return String(value || "")
    .split(/\r?\n/)
    .filter((line) => !/^\[(?:ar|al|ti|au|by|offset|length|re|ve):/i.test(line))
    .map((line) =>
      line
        .replace(
          /\[(\d{1,3}:\d{2}):(\d{1,3})\]/g,
          (_all, time, fraction) => `[${time}.${fraction}]`
        )
        .replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, "")
    )
    .join("\n")
    .trim();
}

function lrcToPlain(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^(?:\[\d+:\d+(?:[.:]\d+)?])+\s*/, "")
        .replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, "")
        .trim()
    )
    .filter(Boolean)
    .join("\n");
}

function normalizeRecord(record, fallback = null) {
  const lyrics = String(record?.lyrics || "");
  if (!lyrics) return { found: false };

  const format = String(record.format || fallback?.format || "").toLowerCase();
  const kind = formatKind(format, lyrics);
  if (!kind) return { found: false };

  const common = {
    found: true,
    instrumental: false,
    trackName: record.song || fallback?.song || null,
    artistName: record.artist || fallback?.artist || null,
    duration: Number.isFinite(Number(record.duration ?? fallback?.duration))
      ? Number(record.duration ?? fallback?.duration)
      : null,
    provider: "unison",
    attribution: UNISON_ATTRIBUTION,
  };

  if (kind === "lrc") {
    const syncedLyrics = cleanEnhancedLrc(lyrics);
    if (!looksLikeLrc(syncedLyrics)) return { found: false };
    return {
      ...common,
      plainLyrics: lrcToPlain(lyrics),
      syncedLyrics,
      syncKind: "line",
    };
  }

  return {
    ...common,
    plainLyrics: lyrics.trim(),
    syncedLyrics: "",
    syncKind: "plain",
  };
}

/**
 * @returns {Promise<{ data: any, notFound?: boolean }>}
 */
async function unisonFetch(path, deadline, userAgent) {
  const remainingMs = Math.max(
    1,
    Math.min(UNISON_CALL_MS, deadline - Date.now())
  );
  if (deadline - Date.now() <= 0) {
    throw new UnisonUnavailableError("Unison lookup timed out.");
  }
  let response;
  try {
    response = await fetch(`${UNISON_BASE}${path}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": userAgent,
      },
      signal: AbortSignal.timeout(remainingMs),
    });
  } catch (error) {
    throw new UnisonUnavailableError(error.message);
  }
  if (response.status === 404) {
    return { data: null, notFound: true };
  }
  if (!response.ok) {
    throw new UnisonUnavailableError(`Unison ${response.status}`);
  }
  const payload = await response.json();
  if (!payload || payload.success === false) {
    throw new UnisonUnavailableError("Unison returned an invalid response.");
  }
  return { data: payload.data, notFound: false };
}

/**
 * @param {{ title: string, artist: string, album?: string, duration?: number|null }} query
 * @param {{ deadline: number, userAgent: string }} options
 */
export async function lookupUnisonLyrics(query, { deadline, userAgent }) {
  const params = new URLSearchParams({
    song: query.title,
    artist: query.artist,
  });
  if (query.album) params.set("album", query.album);
  if (query.duration != null && Number.isFinite(query.duration) && query.duration > 0) {
    params.set("duration", String(Math.round(query.duration)));
  }

  // Direct match first (one round trip per Unison docs).
  const direct = await unisonFetch(`/lyrics?${params}`, deadline, userAgent);
  if (!direct.notFound && direct.data) {
    const normalized = normalizeRecord(direct.data);
    if (normalized.found) return normalized;
  }

  const search = await unisonFetch(`/lyrics/search?${params}`, deadline, userAgent);
  if (search.notFound) return { found: false };
  const rows = Array.isArray(search.data) ? search.data : [];
  if (!rows.length) return { found: false };

  const hit = pickHit(rows, query);
  if (!hit || hit.id == null) return { found: false };

  // Some search hits already include lyrics; prefer that when present.
  if (hit.lyrics) {
    const fromHit = normalizeRecord(hit);
    if (fromHit.found) return fromHit;
  }

  const byId = await unisonFetch(
    `/lyrics/${encodeURIComponent(hit.id)}`,
    deadline,
    userAgent
  );
  if (byId.notFound || !byId.data) return { found: false };
  return normalizeRecord(byId.data, hit);
}
