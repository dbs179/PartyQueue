// Genre intelligence via Last.fm artist tags.
//
// Spotify's own artist genres proved both sparse and wildly inaccurate for this
// library (Johnny Cash tagged "metal", Skrillex "alternative metal", etc.), so
// we instead read community tags from Last.fm's `artist.getTopTags` and map the
// messy long-tail of tags ("outlaw country", "nu metal", "g-funk", ...) into a
// small set of broad, useful buckets the host can toggle on/off.
//
// Lookups are cached to disk (data/genre-cache.json) so we hit Last.fm at most
// once per artist, and a background warm resolves the whole playlist pool after
// startup. Without a Last.fm API key (Settings or LASTFM_API_KEY) everything is
// simply "Other" (the feature degrades gracefully rather than breaking random).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlaylistPool } from "./spotify.js";
import { writeFileAtomic } from "./atomic-write.js";
import { getLastfmApiKey } from "./lastfm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE =
  process.env.PARTYQUEUE_GENRE_CACHE_FILE ||
  path.join(__dirname, "..", "data", "genre-cache.json");
const LASTFM_URL = "https://ws.audioscrobbler.com/2.0/";

// The canonical, host-facing genre buckets. "other" is the catch-all for
// artists that don't resolve to any known bucket (or aren't tagged yet).
export const GENRE_BUCKETS = [
  { id: "rock", label: "Rock" },
  { id: "metal", label: "Metal" },
  { id: "country", label: "Country" },
  { id: "hiphop", label: "Hip-Hop/Rap" },
  { id: "electronic", label: "Electronic" },
  { id: "pop", label: "Pop" },
  { id: "folk", label: "Folk" },
  { id: "punk", label: "Punk" },
  { id: "soul", label: "Soul/R&B/Funk" },
  { id: "jazz", label: "Jazz" },
  { id: "blues", label: "Blues" },
  { id: "classical", label: "Classical" },
  { id: "soundtrack", label: "Soundtrack/Score" },
  { id: "oldies", label: "Oldies" },
  { id: "kids", label: "Kids" },
  { id: "other", label: "Other" },
];

// Bump when the tag->bucket rules below change. Cached artists that still have
// their raw tags are re-mapped locally (free); artists stuck in "Other" under an
// older mapping are re-fetched once to try the new buckets.
const MAPPING_VERSION = 2;

const BUCKET_IDS = new Set(GENRE_BUCKETS.map((b) => b.id));

// How many of an artist's top tags we consider, and the minimum Last.fm
// popularity (0-100) a tag needs to count. Top tags are the most-agreed-on, so
// a handful is plenty and avoids noisy long-tail tags ("seen live", "favorite").
const TOP_TAGS = 6;
const MIN_TAG_COUNT = 10;

// Throttle Last.fm calls. Their terms ask for <= ~5 req/sec; we stay well under.
const REQ_GAP_MS = 250;

// Map a single Last.fm tag string to zero or more buckets. A tag can land in
// several buckets on purpose ("rap metal" -> metal + hiphop). Order does not
// matter since we union, but specific styles are matched before generic ones.
function tagToBuckets(tag) {
  const t = ` ${String(tag).toLowerCase()} `;
  const out = [];
  const has = (re) => re.test(t);

  if (has(/metal|metalcore|deathcore|djent|grindcore|thrash|groove metal/)) out.push("metal");
  if (has(/punk|emo|hardcore|screamo|pop punk/)) out.push("punk");
  if (has(/country|outlaw|red dirt|americana|honky|nashville/)) out.push("country");
  if (has(/hip.?hop|\brap\b|trap|hyphy|drill|grime|crunk|gangsta/)) out.push("hiphop");
  if (has(/edm|dubstep|electro|house|techno|trance|\bdnb\b|drum and bass|electronic|\bdance\b|synthwave/)) out.push("electronic");
  if (has(/folk|singer-songwriter|acoustic|indie folk|bluegrass/)) out.push("folk");
  if (has(/rock|grunge|alternative|post-grunge|hard rock|classic rock|indie rock|punk rock/)) out.push("rock");
  if (has(/\bpop\b|synthpop|electropop|dance pop|power pop/)) out.push("pop");
  if (has(/soul|funk|disco|motown|rhythm and blues|\brnb\b|r&b|neo-soul|new jack swing/)) out.push("soul");
  if (has(/jazz|swing|big band|bebop|ragtime|dixieland/)) out.push("jazz");
  if (has(/blues|delta blues|chicago blues/)) out.push("blues");
  if (has(/classical|orchestral|orchestra|opera|symphony|baroque|romantic era|chamber music|choral/)) out.push("classical");
  if (has(/soundtrack|film score|\bscore\b|\bost\b|film music|movie|composer|musical|cinematic/)) out.push("soundtrack");
  if (has(/oldies|doo.?wop|\b50s\b|1950s|\b60s\b|rock and roll|rock 'n' roll|rockabilly/)) out.push("oldies");
  if (has(/\bkids\b|children|childrens|nursery|disney|cartoon|\bbaby\b|lullab|toddler/)) out.push("kids");

  return out.filter((b) => BUCKET_IDS.has(b));
}

// Reduce an artist's top tags to the set of buckets they belong to.
function tagsToBuckets(tags) {
  const buckets = new Set();
  for (const { name, count } of tags) {
    if (count != null && count < MIN_TAG_COUNT) continue;
    for (const b of tagToBuckets(name)) buckets.add(b);
  }
  return [...buckets];
}

// Normalize an artist name for cache keys (case/space-insensitive).
function normName(name) {
  return (name || "").trim().toLowerCase();
}

// ---- Disk-backed cache: { normalizedArtist: { buckets:[], at:ts } } ----
let cache = null;

function loadCache() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    cache = raw && typeof raw === "object" ? raw : {};
  } catch {
    cache = {};
  }
  return cache;
}

let saveTimer = null;
export function flushGenrePersist() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (cache === null) return false;
  writeFileAtomic(CACHE_FILE, JSON.stringify(cache));
  return true;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    try {
      flushGenrePersist();
    } catch (err) {
      console.error("[genres] cache save failed:", err.message);
    }
  }, 1000);
}

function apiKey() {
  return getLastfmApiKey();
}

export function isGenreDataEnabled() {
  return !!apiKey();
}

// The buckets known for an artist RIGHT NOW (from cache), without any network
// call. Unknown/unresolved artists return [] and are treated as "other" by
// callers. Used on the hot path (random sampling) so picks stay instant. If the
// mapping changed since this entry was built and we still have its raw tags, we
// re-derive the buckets locally (no network) and update the entry in place.
export function bucketsForArtistSync(artist) {
  const entry = loadCache()[normName(artist)];
  if (!entry) return [];
  if (entry.tags && (entry.v ?? 1) < MAPPING_VERSION) {
    entry.buckets = tagsToBuckets(entry.tags);
    entry.v = MAPPING_VERSION;
    scheduleSave();
  }
  return entry.buckets ?? [];
}

// Whether an artist should be (re)fetched from Last.fm: not cached at all, or
// still in "Other" under an older mapping (give the new buckets a chance). Once
// re-fetched at the current mapping version, a still-empty result is left alone.
function needsFetch(name) {
  const entry = loadCache()[normName(name)];
  if (!entry) return true;
  if ((entry.v ?? 1) < MAPPING_VERSION && (!entry.buckets || entry.buckets.length === 0)) {
    return true;
  }
  return false;
}

// Does a track's artist fall into at least one enabled bucket? Unresolved/empty
// artists are treated as "other". `enabled` is a Set of bucket ids.
export function artistMatchesGenres(artist, enabled) {
  let buckets = bucketsForArtistSync(artist);
  if (!buckets.length) buckets = ["other"];
  for (const b of buckets) if (enabled.has(b)) return true;
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve one artist from Last.fm and cache the result. Never throws; on any
// failure it caches an empty bucket list so we don't hammer a bad name.
async function resolveArtist(artist) {
  const key = apiKey();
  const name = (artist || "").trim();
  if (!name) return [];

  const params = new URLSearchParams({
    method: "artist.gettoptags",
    artist: name,
    api_key: key,
    autocorrect: "1",
    format: "json",
  });

  let buckets = [];
  try {
    const res = await fetch(`${LASTFM_URL}?${params.toString()}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      const tags = (data?.toptags?.tag ?? [])
        .slice(0, TOP_TAGS)
        .map((t) => ({ name: t.name, count: Number(t.count) }));
      buckets = tagsToBuckets(tags);
      // Persist the raw tags so future mapping changes re-derive for free.
      loadCache()[normName(name)] = {
        buckets,
        tags,
        at: Date.now(),
        v: MAPPING_VERSION,
      };
      scheduleSave();
      return buckets;
    }
  } catch (err) {
    console.error(`[genres] lookup failed for "${name}":`, err.message);
  }

  // No tags returned (or request failed): record an empty result at the current
  // mapping version so we don't keep re-fetching a genuinely untagged artist.
  loadCache()[normName(name)] = { buckets, tags: [], at: Date.now(), v: MAPPING_VERSION };
  scheduleSave();
  return buckets;
}

// Resolve one artist's buckets, fetching from Last.fm if not already cached.
// Used by the discovery pipeline to genre-filter brand-new artists that aren't
// in the playlist pool. Cheap after the first call (cached to disk).
export async function bucketsForArtist(artist) {
  const name = (artist || "").trim();
  if (!name) return [];
  if (!needsFetch(name)) return bucketsForArtistSync(name);
  if (!apiKey()) return [];
  return resolveArtist(name);
}

let warming = false;
let warmingStopped = false;

/** Stop a background warm loop before process shutdown. */
export function stopGenreWarm() {
  warmingStopped = true;
}

// Resolve any not-yet-cached artists from a list, throttled. Safe to call
// repeatedly; already-cached artists are skipped, so it only pays for new ones.
export async function warmArtists(artistNames) {
  if (!apiKey()) return; // no key -> everything stays "other"
  if (warming) return;
  warming = true;
  try {
    const todo = [
      ...new Set(
        (artistNames || [])
          .map((n) => (n || "").trim())
          .filter(Boolean)
          .filter((n) => needsFetch(n))
      ),
    ];
    if (!todo.length) return;
    console.log(`[genres] warming ${todo.length} artist(s) from Last.fm...`);
    for (const name of todo) {
      if (warmingStopped) break;
      await resolveArtist(name);
      if (warmingStopped) break;
      await sleep(REQ_GAP_MS);
    }
    console.log(warmingStopped ? "[genres] warm stopped" : "[genres] warm complete");
  } finally {
    warming = false;
  }
}

// Collect every artist in the host's playlist pool and warm their genres.
// Runs in the background after startup (and is re-callable when the pool grows).
export async function warmGenresFromPool() {
  if (!apiKey()) {
    console.log("[genres] no Last.fm API key set; genre filtering treats all songs as 'Other'.");
    return;
  }
  try {
    const playlists = await buildPlaylistPool();
    const artists = [];
    for (const pl of playlists) {
      for (const t of pl.tracks || []) artists.push(t.artist);
    }
    await warmArtists(artists);
  } catch (err) {
    console.error("[genres] pool warm failed:", err.message);
  }
}

// Track counts per bucket across the current pool, for the UI. A track counts
// toward every bucket its artist maps to (or "other" if unresolved/unmapped).
// When `playlistIds` is provided, only those playlists are counted so the chip
// numbers match the host's Random selection.
export async function genreCounts({ playlistIds = null } = {}) {
  let playlists = [];
  try {
    playlists = await buildPlaylistPool();
  } catch {
    playlists = [];
  }
  if (Array.isArray(playlistIds)) {
    const allow = new Set(playlistIds);
    playlists = playlists.filter((p) => allow.has(p.id));
  }
  const counts = Object.fromEntries(GENRE_BUCKETS.map((b) => [b.id, 0]));
  // Dedupe by track id so a song in multiple selected playlists isn't counted
  // twice on every chip (matches eligiblePoolSize).
  const seen = new Set();
  for (const pl of playlists) {
    for (const t of pl.tracks || []) {
      const id = (t.uri || "").match(/spotify:track:([A-Za-z0-9]+)/)?.[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let buckets = bucketsForArtistSync(t.artist);
      if (!buckets.length) buckets = ["other"];
      for (const b of buckets) counts[b] = (counts[b] ?? 0) + 1;
    }
  }
  return counts;
}

// How many unique tracks Random would draw from given the current playlist +
// genre filters. Used by the UI to warn when the pool is too small for the
// song-memory / anti-repeat settings. Dedupes by Spotify track id.
export async function eligiblePoolSize({ playlistIds = null, genres = null } = {}) {
  let playlists = [];
  try {
    playlists = await buildPlaylistPool();
  } catch {
    return { tracks: 0, playlists: 0 };
  }
  let usable = playlists.filter((p) => (p.tracks || []).length > 0);
  if (Array.isArray(playlistIds)) {
    const allow = new Set(playlistIds);
    usable = usable.filter((p) => allow.has(p.id));
  }
  const enabled =
    Array.isArray(genres) && genres.length ? new Set(genres) : null;
  const ids = new Set();
  for (const pl of usable) {
    for (const t of pl.tracks || []) {
      const id = (t.uri || "").match(/spotify:track:([A-Za-z0-9]+)/)?.[1];
      if (!id) continue;
      if (enabled) {
        let buckets = bucketsForArtistSync(t.artist);
        if (!buckets.length) buckets = ["other"];
        if (!buckets.some((b) => enabled.has(b))) continue;
      }
      ids.add(id);
    }
  }
  return { tracks: ids.size, playlists: usable.length };
}
