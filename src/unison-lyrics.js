// Focused fallback adapter for Unison (https://unisonlyrics.org).
// Unison's catalog includes enhanced LRC and TTML. PartyQueue consumes line
// timestamps, so this adapter intentionally accepts LRC and plain text only.

const UNISON_BASE = "https://unison.boidu.dev";
export const UNISON_ATTRIBUTION = {
  text: "Lyrics from Unison",
  url: "https://unisonlyrics.org",
};

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

function scoreHit(hit, { title, artist, duration }) {
  if (!hit || typeof hit !== "object") return -Infinity;
  const format = String(hit.format || "").toLowerCase();
  if (!["lrc", "plain", "text", "txt", "unsynced"].includes(format)) {
    return -Infinity;
  }

  let score = format === "lrc" ? 100 : 40;
  if (normalized(hit.song) === normalized(title)) score += 50;
  if (normalized(hit.artist) === normalized(artist)) score += 50;
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
    .map((line) => line.replace(/<\d+:\d+(?:\.\d+)?>/g, ""))
    .join("\n")
    .trim();
}

function lrcToPlain(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^(?:\[\d+:\d+(?:[.:]\d+)?])+\s*/, "")
        .replace(/<\d+:\d+(?:\.\d+)?>/g, "")
        .trim()
    )
    .filter(Boolean)
    .join("\n");
}

async function unisonFetch(path, deadline, userAgent) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new UnisonUnavailableError("Unison lookup timed out.");
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
  if (!response.ok) {
    throw new UnisonUnavailableError(`Unison ${response.status}`);
  }
  const payload = await response.json();
  if (!payload || payload.success === false) {
    throw new UnisonUnavailableError("Unison returned an invalid response.");
  }
  return payload.data;
}

/**
 * @param {{ title: string, artist: string, duration?: number|null }} query
 * @param {{ deadline: number, userAgent: string }} options
 */
export async function lookupUnisonLyrics(query, { deadline, userAgent }) {
  const params = new URLSearchParams({
    song: query.title,
    artist: query.artist,
  });
  const rows = await unisonFetch(`/lyrics/search?${params}`, deadline, userAgent);
  const hit = pickHit(rows, query);
  if (!hit || hit.id == null) return { found: false };

  const record = await unisonFetch(
    `/lyrics/${encodeURIComponent(hit.id)}`,
    deadline,
    userAgent
  );
  const lyrics = String(record?.lyrics || "");
  if (!lyrics) return { found: false };

  const format = String(record.format || hit.format || "").toLowerCase();
  const common = {
    found: true,
    instrumental: false,
    trackName: record.song || hit.song || null,
    artistName: record.artist || hit.artist || null,
    provider: "unison",
    attribution: UNISON_ATTRIBUTION,
  };
  if (format === "lrc") {
    const syncedLyrics = cleanEnhancedLrc(lyrics);
    if (!/^\s*\[\d+:\d+/m.test(syncedLyrics)) return { found: false };
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
