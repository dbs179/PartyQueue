// Tertiary plain-text fallback via lyrics.ovh (no API key).

import { artistLookupVariants } from "./lyrics-variants.js";

const OVH_BASE = "https://api.lyrics.ovh/v1";

export class OvhUnavailableError extends Error {
  constructor(message = "lyrics.ovh is temporarily unavailable.") {
    super(message);
    this.name = "OvhUnavailableError";
  }
}

function encodeSegment(value) {
  return encodeURIComponent(String(value || "").trim()).replace(/%2F/gi, "/");
}

async function fetchOvhLyrics(title, artist, { deadline, userAgent }) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new OvhUnavailableError("lyrics.ovh lookup timed out.");

  const url = `${OVH_BASE}/${encodeSegment(artist)}/${encodeSegment(title)}`;
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": userAgent,
      },
      signal: AbortSignal.timeout(remainingMs),
    });
  } catch (error) {
    throw new OvhUnavailableError(error.message);
  }

  if (response.status === 404) return { found: false };
  if (!response.ok) {
    throw new OvhUnavailableError(`lyrics.ovh ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new OvhUnavailableError("lyrics.ovh returned invalid JSON.");
  }

  // lyrics.ovh returns 200 with { error: "No lyrics found" } for some misses.
  if (payload?.error && !payload?.lyrics) return { found: false };

  const plain = String(payload?.lyrics || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!plain) return { found: false };

  return {
    found: true,
    instrumental: false,
    plainLyrics: plain,
    syncedLyrics: "",
    provider: "lyrics.ovh",
    syncKind: "plain",
    trackName: title,
    artistName: artist,
  };
}

/**
 * @param {{ title: string, artist: string }} query
 * @param {{ deadline: number, userAgent?: string }} options
 */
export async function lookupOvhLyrics(query, { deadline, userAgent = "PartyQueue" }) {
  const title = String(query.title || "").trim();
  const artist = String(query.artist || "").trim();
  if (!title || !artist) return { found: false };

  const variants = artistLookupVariants(artist);
  let sawMiss = false;
  let lastUnavailable = null;

  for (const artistVariant of variants) {
    if (Date.now() >= deadline) break;
    try {
      const result = await fetchOvhLyrics(title, artistVariant, {
        deadline,
        userAgent,
      });
      if (result.found) return result;
      sawMiss = true;
    } catch (error) {
      if (!(error instanceof OvhUnavailableError)) throw error;
      lastUnavailable = error;
      // Hard failures (timeouts / 5xx) usually mean the service is down.
      if (!sawMiss) throw error;
    }
  }

  if (!sawMiss && lastUnavailable) throw lastUnavailable;
  return { found: false };
}
