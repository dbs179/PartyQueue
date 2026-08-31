// Lyrics lookup: LRClib (synced primary) → Unison → lyrics.ovh plain.
// Cached so party phones share one fetch. 503 only when zero providers respond.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import {
  lookupUnisonLyrics,
  UnisonUnavailableError,
} from "./unison-lyrics.js";
import { lookupOvhLyrics, OvhUnavailableError } from "./ovh-lyrics.js";
import {
  artistCreditVariants,
  titleLookupVariants,
} from "./lyrics-variants.js";

const LRCLIB_BASE = "https://lrclib.net";
const FOUND_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_CACHE_TTL_MS = 30 * 60 * 1000;
/** Duration-blind picks stay sticky for one URI — keep them brief. */
const PROVISIONAL_CACHE_TTL_MS = 20_000;
const CACHE_MAX = 200;
const CACHE_VERSION = "l2";
/** Synced LRC farther than this from the playing length is the wrong mix. */
const SYNC_DURATION_SLACK_SEC = 6;
const LOOKUP_BUDGET_MS = 10_000;
const LRCLIB_CALL_MS = 2_500;
/** Keep enough budget for lyrics.ovh artist-variant fallbacks. */
const OVH_RESERVE_MS = 3_500;
const PROVIDER_BACKOFF_MS = 10_000;
const PERSIST_DEBOUNCE_MS = 250;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE =
  process.env.PARTYQUEUE_LYRICS_CACHE_FILE ||
  (process.env.NODE_ENV === "production"
    ? path.join(__dirname, "..", "data", "lyrics-cache.json")
    : "");
let appVersion = "0";
try {
  appVersion = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
  ).version;
} catch {
  /* keep default */
}

const USER_AGENT = `PartyQueue/${appVersion}`;

/** @type {Map<string, { at: number, value: object }>} */
const cache = new Map();
/** @type {Map<string, Promise<object>>} */
const inFlight = new Map();
let lrclibBackoffUntil = 0;
let unisonBackoffUntil = 0;
let ovhBackoffUntil = 0;
let persistTimer = null;

function loadPersistentCache() {
  if (!CACHE_FILE) return;
  try {
    const rows = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (
        Array.isArray(row) &&
        row.length === 2 &&
        typeof row[0] === "string" &&
        row[1] &&
        typeof row[1] === "object"
      ) {
        cache.set(row[0], row[1]);
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("[lyrics] cache load failed:", err.message);
    }
  }
}

function persistCacheNow() {
  if (!CACHE_FILE) return;
  try {
    writeFileAtomic(CACHE_FILE, JSON.stringify([...cache.entries()]));
  } catch (err) {
    console.error("[lyrics] cache save failed:", err.message);
  }
}

function persistCache() {
  if (!CACHE_FILE || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistCacheNow();
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
}

/** Flush a pending debounced cache write (shutdown / tests). */
export function flushLyricsPersist() {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  persistCacheNow();
}

loadPersistentCache();

export class LyricsUnavailableError extends Error {
  constructor(retryAfterMs = PROVIDER_BACKOFF_MS) {
    super("Lyrics service is temporarily busy.");
    this.name = "LyricsUnavailableError";
    this.retryAfterMs = Math.max(1_000, Number(retryAfterMs) || 0);
  }
}

function playingDuration(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const n = Number(value);
  return n > 0 ? n : null;
}

function cacheKey({ title, artist, album, duration, uri }) {
  const id = String(uri || "").trim().toLowerCase();
  // One Spotify/Sonos id = one lyrics payload. Including duration used to
  // fetch a second LRC mid-song when TrackDuration arrived late, which
  // swapped karaoke timing (Amigo the Devil — The Dreamer).
  if (id) return `${CACHE_VERSION}:${id}`;
  const d =
    playingDuration(duration) != null ? Math.round(playingDuration(duration)) : "";
  return [
    CACHE_VERSION,
    String(title || "").trim().toLowerCase(),
    String(artist || "").trim().toLowerCase(),
    String(album || "").trim().toLowerCase(),
    d,
  ].join("|");
}

export function normalizeLrc(value) {
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
        .trimEnd()
    )
    .join("\n")
    .trim();
}

function lrcToPlain(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) =>
      line.replace(/^(?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+\s*/, "").trim()
    )
    .filter(Boolean)
    .join("\n");
}

function readCache(key, { duration } = {}) {
  const hit = cache.get(key);
  if (!hit) return null;
  const ttl = Number.isFinite(hit.ttlMs)
    ? hit.ttlMs
    : hit.value?.found
      ? FOUND_CACHE_TTL_MS
      : MISS_CACHE_TTL_MS;
  if (Date.now() - hit.at > ttl) {
    cache.delete(key);
    persistCache();
    return null;
  }
  // A duration-blind pick cached the wrong mix (Maps / Folsom). Re-score
  // once TrackDuration is known instead of keeping it for 24h.
  if (hit.value?.provisional && playingDuration(duration) != null) {
    cache.delete(key);
    persistCache();
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function writeCache(key, value, ttlMs) {
  const existing = cache.get(key);
  if (
    existing?.value?.found &&
    !existing.value?.provisional &&
    value?.provisional
  ) {
    return;
  }
  if (cache.has(key)) cache.delete(key);
  const entry = { at: Date.now(), value };
  if (Number.isFinite(ttlMs) && ttlMs > 0) entry.ttlMs = ttlMs;
  cache.set(key, entry);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  persistCache();
}

function publicLyricsPayload(value) {
  if (!value || typeof value !== "object") return value;
  const { provisional: _p, duration: _d, ...rest } = value;
  return rest;
}

function normalizeRecord(rec, provider = "lrclib") {
  if (!rec || typeof rec !== "object") {
    return { found: false };
  }
  const synced =
    typeof rec.syncedLyrics === "string" ? normalizeLrc(rec.syncedLyrics) : "";
  const plain =
    typeof rec.plainLyrics === "string" && rec.plainLyrics.trim()
      ? rec.plainLyrics.trim()
      : lrcToPlain(synced);
  const instrumental = !!rec.instrumental;
  if (instrumental && !plain && !synced) {
    return {
      found: true,
      instrumental: true,
      plainLyrics: "",
      syncedLyrics: "",
      provider,
      syncKind: "instrumental",
    };
  }
  if (!plain && !synced) return { found: false };
  return {
    found: true,
    instrumental: false,
    plainLyrics: plain,
    syncedLyrics: synced,
    trackName: rec.trackName || null,
    artistName: rec.artistName || null,
    duration: Number.isFinite(Number(rec.duration)) ? Number(rec.duration) : null,
    provider,
    syncKind: synced ? "line" : "plain",
  };
}

async function lrclibFetch(urlPath, deadline) {
  const remainingMs = Math.max(1, Math.min(LRCLIB_CALL_MS, deadline - Date.now()));
  if (deadline - Date.now() <= 0) {
    throw new Error("LRClib lookup timed out.");
  }
  const res = await fetch(`${LRCLIB_BASE}${urlPath}`, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(remainingMs),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`LRClib ${res.status}`);
  }
  return res.json();
}

function parseLrcTimestamp(token) {
  const match = String(token).match(/^(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?$/);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  if (seconds >= 60) return null;
  const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
  return minutes * 60 + seconds + fraction;
}

/** First/last timed line in an LRC body, for karaoke duration fit. */
export function lrcTimestampSpan(syncedLyrics) {
  let first = Infinity;
  let last = -Infinity;
  for (const row of String(syncedLyrics || "").split(/\r?\n/)) {
    for (const tag of row.matchAll(/\[(\d{1,3}:\d{2}(?:[.:]\d{1,3})?)\]/g)) {
      const t = parseLrcTimestamp(tag[1]);
      if (t == null) continue;
      if (t < first) first = t;
      if (t > last) last = t;
    }
  }
  if (!Number.isFinite(first) || last < 0) return null;
  return { first, last };
}

function foldedText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function albumMatchScore(hitAlbum, queryAlbum) {
  const hit = foldedText(hitAlbum);
  const query = foldedText(queryAlbum);
  if (!hit || !query) return 0;
  if (hit === query) return 24;
  if (hit.includes(query) || query.includes(hit)) return 16;
  return 0;
}

function medianNumber(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clusterConsensusFirst(firsts, radius = 4) {
  if (firsts.length < 2) return null;
  let bestCenter = null;
  let bestCount = 0;
  for (const center of firsts) {
    const members = firsts.filter((t) => Math.abs(t - center) <= radius);
    if (
      members.length > bestCount ||
      (members.length === bestCount &&
        bestCenter != null &&
        center < bestCenter)
    ) {
      bestCount = members.length;
      bestCenter = medianNumber(members);
    }
  }
  if (bestCount >= 2) return bestCenter;
  // Two singleton families (Deluxe Maps 0:59 vs 0:29): prefer the earlier
  // vocal. Wrong mixes usually pad intro, they rarely skip it.
  return Math.min(...firsts);
}

/** Ignore junk labels like duration: 2 on a 3-minute LRC. */
function trustedLabeledDuration(record, span) {
  const labeled = Number(record?.duration);
  if (!Number.isFinite(labeled) || labeled < 30) return null;
  const rounded = Math.round(labeled);
  if (span && Math.abs(span.last - rounded) > 60) return null;
  return rounded;
}

function syncedFitsDuration(record, duration) {
  const target = playingDuration(duration);
  if (target == null) return true;
  if (!record?.syncedLyrics) return true;
  const rounded = Math.round(target);
  const span = lrcTimestampSpan(record.syncedLyrics);
  const labeled = trustedLabeledDuration(record, span);
  if (labeled != null && Math.abs(labeled - rounded) > SYNC_DURATION_SLACK_SEC) {
    return false;
  }
  if (span && span.last - rounded > 8) return false;
  return true;
}

/**
 * Drop karaoke timestamps when they belong to another mix, keeping plain text.
 * Folsom Prison Blues on "I Walk the Line" is 156s; community LRCs are ~170s.
 */
export function fitLyricsToDuration(result, duration) {
  const target = playingDuration(duration);
  if (!result?.found || !result.syncedLyrics || target == null) return result;
  const rounded = Math.round(target);
  const span = lrcTimestampSpan(result.syncedLyrics);
  const labeled = trustedLabeledDuration(result, span);
  const labeledOff =
    labeled != null && Math.abs(labeled - rounded) > SYNC_DURATION_SLACK_SEC;
  const overrun = span ? span.last - rounded : 0;
  if (!labeledOff && overrun <= 8) return result;
  return {
    ...result,
    syncedLyrics: "",
    syncKind: result.plainLyrics ? "plain" : result.syncKind,
  };
}

export function pickBestSearchHit(results, duration, album) {
  if (!Array.isArray(results) || !results.length) return null;
  const pool = results.filter(
    (r) => r && (r.plainLyrics || r.syncedLyrics || r.instrumental)
  );
  if (!pool.length) return results[0] || null;

  const target = playingDuration(duration);
  const targetSec = target != null ? Math.round(target) : null;
  const firsts = pool
    .map((r) => (r.syncedLyrics ? lrcTimestampSpan(r.syncedLyrics)?.first : null))
    .filter((n) => n != null);
  const consensusFirst = clusterConsensusFirst(firsts);

  let best = null;
  let bestScore = -Infinity;
  for (const r of pool) {
    let score = 0;
    const span = r.syncedLyrics ? lrcTimestampSpan(r.syncedLyrics) : null;
    const labeled = trustedLabeledDuration(r, span);
    const durationOk = syncedFitsDuration(r, targetSec);

    if (r.syncedLyrics) {
      // Duration-mismatched karaoke is worse than unsynced lyrics of the
      // playing cut (Johnny Cash "I Walk the Line" vs the 170s studio LRC).
      // Untrusted labels (duration: 2 on a 3-minute file) don't count as a fit.
      if (targetSec == null) score += 100;
      else if (durationOk && labeled != null) score += 100;
      else score += 40;
    } else if (r.plainLyrics) {
      score += 40;
    }
    if (r.instrumental) score += 5;
    if (targetSec != null && labeled != null) {
      const delta = Math.abs(labeled - targetSec);
      score += Math.max(0, 40 - delta * 4);
    }
    score += albumMatchScore(r.albumName, album);
    // Community LRCs for the "same" song often belong to another mix.
    // Prefer timestamps that fit the playing length over a closer duration
    // label with lines that run past the end (karaoke looks "way off").
    if (targetSec != null && span) {
      const overrun = span.last - targetSec;
      if (overrun > 3) {
        score -= Math.min(90, Math.round((overrun - 3) * 6));
      }
    }
    // Yeah Yeah Yeahs Maps: Deluxe search returns a 259s file first (vocals
    // at 0:59) beside many 3:40 files (vocals at 0:29). Duration-blind picks
    // used to take search order and karaoke ran half a minute late.
    if (span && consensusFirst != null && firsts.length >= 2) {
      const drift = Math.abs(span.first - consensusFirst);
      if (drift <= 4) score += 20;
      else if (drift > 12) score -= 50;
    }
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

function isRicherLrclibHit(candidate, current) {
  if (!candidate) return false;
  if (!current) return true;
  if (candidate.syncedLyrics && !current.syncedLyrics) return true;
  if (
    !current.plainLyrics &&
    !current.syncedLyrics &&
    (candidate.plainLyrics || candidate.syncedLyrics || candidate.instrumental)
  ) {
    return true;
  }
  return false;
}

/**
 * Search-first LRClib lookup so a hung /api/get cannot burn the whole budget.
 * Tries primary-artist credit variants when the featuring-tagged search only
 * yields plain lyrics (Forgot About Dre / "Dr. Dre feat. Eminem").
 * @returns {Promise<{ result: object, responded: boolean }>}
 */
async function lookupLrclib(query, deadline) {
  const { title, artist, album, duration } = query;
  let record = null;
  let sawSuccess = false;
  let sawError = false;

  // Original first, then stripped guest credits. Cap extra searches so a
  // long variant list can't eat the whole lyrics budget.
  const artists = artistCreditVariants(artist).slice(0, 3);
  for (const artistName of artists) {
    if (Date.now() >= deadline) break;
    if (record?.syncedLyrics) break;

    const searchParams = new URLSearchParams({
      track_name: title,
      artist_name: artistName,
    });
    // Album is a scoring signal, not a search filter. Filtering Deluxe Maps
    // put a 259s/0:59-vocal file first; duration-blind karaoke followed it.
    try {
      const results = await lrclibFetch(`/api/search?${searchParams}`, deadline);
      sawSuccess = true;
      const hit = pickBestSearchHit(results, duration, album);
      if (isRicherLrclibHit(hit, record)) {
        record = hit;
      }
    } catch (err) {
      sawError = true;
      console.error("[lyrics] LRClib search failed:", err.message);
    }
  }

  const wantExact =
    playingDuration(duration) != null &&
    album &&
    Date.now() < deadline &&
    (!record || !record.syncedLyrics || !syncedFitsDuration(record, duration));
  if (wantExact) {
    // Exact get uses the best artist form we already preferred (primary when
    // a featuring credit was stripped during search).
    const exactArtist =
      (record?.artistName && String(record.artistName).trim()) ||
      artists[artists.length - 1] ||
      artist;
    const params = new URLSearchParams({
      track_name: title,
      artist_name: exactArtist,
      album_name: album,
      duration: String(Math.round(duration)),
    });
    try {
      const exact = await lrclibFetch(`/api/get?${params}`, deadline);
      sawSuccess = true;
      record =
        pickBestSearchHit([record, exact].filter(Boolean), duration, album) ||
        record;
    } catch (err) {
      sawError = true;
      console.error("[lyrics] LRClib get failed:", err.message);
    }
  }

  return {
    result: normalizeRecord(record),
    responded: sawSuccess,
    unavailable: sawError && !sawSuccess,
  };
}

function preferenceScore(result) {
  if (!result?.found) return -1;
  if (result.instrumental) return 45;
  if (result.syncedLyrics) {
    return result.provider === "lrclib" ? 100 : 90;
  }
  if (result.plainLyrics) {
    if (result.provider === "lrclib") return 40;
    if (result.provider === "unison") return 35;
    return 20;
  }
  return 0;
}

function pickPreferred(...results) {
  let best = null;
  let bestScore = -1;
  for (const result of results) {
    const score = preferenceScore(result);
    if (score > bestScore) {
      best = result;
      bestScore = score;
    }
  }
  return bestScore >= 0 ? best : { found: false };
}

function retryDelay(...deadlines) {
  const now = Date.now();
  const delays = deadlines
    .filter((value) => value > now)
    .map((value) => value - now);
  return delays.length ? Math.min(...delays) : PROVIDER_BACKOFF_MS;
}

export async function lookupLyrics(q = {}) {
  const title = String(q.title || "").trim();
  const artist = String(q.artist || "").trim();
  if (!title || !artist) {
    return { found: false, error: "Missing title or artist." };
  }
  const album = String(q.album || "").trim();
  const duration = playingDuration(q.duration);
  const uri = String(q.uri || "").trim();
  const query = { title, artist, album, duration, uri };

  const key = cacheKey(query);
  const cached = readCache(key, { duration });
  if (cached) return { ...publicLyricsPayload(cached), cached: true };
  const pending = inFlight.get(key);
  if (
    pending &&
    (duration == null || pending.hasDuration)
  ) {
    return pending.promise;
  }

  const request = { hasDuration: duration != null, promise: null };
  request.promise = (async () => {
    const startedAt = Date.now();
    const deadline = startedAt + LOOKUP_BUDGET_MS;
    const primaryDeadline = Math.max(
      startedAt + 1_000,
      deadline - OVH_RESERVE_MS
    );
    let lrclibResult = { found: false };
    let unisonResult = { found: false };
    let ovhResult = { found: false };
    let lrclibResponded = false;
    let unisonResponded = false;
    let ovhResponded = false;

    const jobs = [];

    if (startedAt >= lrclibBackoffUntil) {
      jobs.push(
        lookupLrclib(query, primaryDeadline).then((primary) => {
          lrclibResult = primary.result;
          lrclibResponded = primary.responded;
          if (primary.unavailable) {
            lrclibBackoffUntil = Date.now() + PROVIDER_BACKOFF_MS;
          } else if (primary.responded) {
            lrclibBackoffUntil = 0;
          }
        })
      );
    }

    if (startedAt >= unisonBackoffUntil) {
      jobs.push(
        lookupUnisonLyrics(query, {
          deadline: primaryDeadline,
          userAgent: USER_AGENT,
        })
          .then((result) => {
            unisonResult = result;
            unisonResponded = true;
            unisonBackoffUntil = 0;
          })
          .catch((err) => {
            if (!(err instanceof UnisonUnavailableError)) throw err;
            unisonBackoffUntil = Date.now() + PROVIDER_BACKOFF_MS;
            console.error("[lyrics] Unison failed:", err.message);
          })
      );
    }

    if (jobs.length) await Promise.all(jobs);

    let out = fitLyricsToDuration(
      pickPreferred(lrclibResult, unisonResult),
      duration
    );
    const needsPlainFallback =
      !out.found || (!out.syncedLyrics && !out.instrumental && !out.plainLyrics);

    if (
      needsPlainFallback &&
      Date.now() >= ovhBackoffUntil &&
      Date.now() < deadline
    ) {
      try {
        ovhResult = await lookupOvhLyrics(query, {
          deadline,
          userAgent: USER_AGENT,
        });
        ovhResponded = true;
        ovhBackoffUntil = 0;
        out = fitLyricsToDuration(pickPreferred(out, ovhResult), duration);
      } catch (err) {
        if (!(err instanceof OvhUnavailableError)) throw err;
        ovhBackoffUntil = Date.now() + PROVIDER_BACKOFF_MS;
        console.error("[lyrics] lyrics.ovh failed:", err.message);
      }
    }

    // Spotify decorates titles ("Peaches - Remastered") that every provider
    // indexes under the plain name — LRClib's search returns zero rows for
    // the suffixed form. Retry the whole chain with cleaned titles before
    // reporting a miss. Guarded by skipTitleVariants so the retry can't recurse.
    if (!out.found && !q.skipTitleVariants) {
      for (const variant of titleLookupVariants(title).slice(1)) {
        try {
          const fallback = await lookupLyrics({
            title: variant,
            artist,
            album,
            duration,
            skipTitleVariants: true,
          });
          if (fallback?.found) {
            const { cached: _c, ...clean } = fallback;
            const stored =
              duration == null ? { ...clean, provisional: true } : clean;
            writeCache(
              key,
              stored,
              duration == null ? PROVISIONAL_CACHE_TTL_MS : undefined
            );
            return publicLyricsPayload(clean);
          }
        } catch {
          // Providers are struggling; surface the original miss handling.
          break;
        }
      }
    }

    const anyResponded = lrclibResponded || unisonResponded || ovhResponded;
    // Prefer telling guests LRClib was unreachable when only backups answered.
    const degraded = !lrclibResponded && (unisonResponded || ovhResponded);

    if (out.found) {
      const payload = degraded ? { ...out, degraded: true } : out;
      const stored =
        duration == null ? { ...payload, provisional: true } : payload;
      writeCache(
        key,
        stored,
        duration == null ? PROVISIONAL_CACHE_TTL_MS : undefined
      );
      return publicLyricsPayload(payload);
    }

    if (anyResponded) {
      const miss = {
        found: false,
        ...(degraded ? { degraded: true } : {}),
      };
      // Degraded misses often clear when LRClib recovers or a punctuation
      // variant hits a backup — don't pin guests to a 30-minute empty overlay.
      if (!degraded) writeCache(key, miss);
      return miss;
    }

    throw new LyricsUnavailableError(
      retryDelay(lrclibBackoffUntil, unisonBackoffUntil, ovhBackoffUntil)
    );
  })();
  inFlight.set(key, request);
  try {
    return await request.promise;
  } finally {
    if (inFlight.get(key) === request) {
      inFlight.delete(key);
    }
  }
}

/** Fire-and-forget cache warm so overlay opens hit providers less often. */
export function warmLyrics(q = {}) {
  const title = String(q.title || "").trim();
  const artist = String(q.artist || "").trim();
  if (!title || !artist) return;
  const album = String(q.album || "").trim();
  const duration = playingDuration(q.duration);
  if (duration == null) return;
  const uri = String(q.uri || "").trim();
  const key = cacheKey({ title, artist, album, duration, uri });
  if (readCache(key, { duration })) return;
  lookupLyrics({ title, artist, album, duration, uri }).catch((err) => {
    // Warm must never poison interactive lookups; provider backoffs already apply.
    console.error("[lyrics] warm failed:", err.message);
  });
}

/** Reset module state for isolated unit tests. */
export function resetLyricsStateForTests() {
  cache.clear();
  inFlight.clear();
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  lrclibBackoffUntil = 0;
  unisonBackoffUntil = 0;
  ovhBackoffUntil = 0;
}
