// Spotify Web API access.
//
// Two token types are used:
//  - Client Credentials (app-level, no login): powers guest SEARCH. Guests
//    never authenticate and never touch your account.
//  - Authorization Code (one-time host login): powers reading YOUR playlists
//    (public, private, and collaborative). The host connects once; we store a
//    refresh token server-side and mint access tokens from it as needed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import { getSpotifyAppCredentials } from "./spotify-app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const AUTH_URL = "https://accounts.spotify.com/authorize";
const SEARCH_URL = "https://api.spotify.com/v1/search";
const API_BASE = "https://api.spotify.com/v1";

// Scopes needed to list the host's playlists, including private/collaborative.
const USER_SCOPES = "playlist-read-private playlist-read-collaborative";

let cachedToken = null;
let tokenExpiresAt = 0;

// User (Authorization Code) token state.
let userAccessToken = null;
let userTokenExpiresAt = 0;

const TOKEN_STORE = path.join(__dirname, "..", "data", "spotify-tokens.json");

// --- Rate-limit guard -------------------------------------------------------
// Spotify throttles with HTTP 429 + a Retry-After header. Without backoff the
// app keeps hammering during the cooldown, which Spotify punishes by extending
// it - so a single 429 snowballs. We keep one "don't call until" timestamp and
// short-circuit every data request while it's in effect.
let rateLimitedUntil = 0;

export function spotifyCooldownMs() {
  return Math.max(0, rateLimitedUntil - Date.now());
}

// Wrapper for Spotify Web API *data* requests (not token calls): refuse to call
// during a cooldown, and on a 429 set the cooldown from Retry-After (default
// 30s) before throwing so callers fail fast instead of piling on more requests.
async function spotifyApiFetch(url, opts) {
  loadDiskCache(); // make sure a persisted cooldown from a prior run is honored
  const wait = spotifyCooldownMs();
  if (wait > 0) {
    throw new Error(`Spotify is rate-limited; retry in ${Math.ceil(wait / 1000)}s`);
  }
  const res = await fetch(url, opts);
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after"));
    const backoff = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 30_000;
    rateLimitedUntil = Date.now() + backoff;
    persistDiskCache(); // survive restarts so we don't poke Spotify mid-timeout
    throw new Error(
      `Spotify rate limited (429); backing off ${Math.ceil(backoff / 1000)}s`
    );
  }
  return res;
}

// Throttle the library sweep (playlist + track pagination) so a cold warm or a
// forced re-warm can't fire ~one request per page back-to-back and trip
// Spotify's rate limit. Only the bulk pagination below awaits this gap;
// interactive calls (guest search, single-track lookups) are NOT throttled, so
// the UI stays snappy. ~5 req/s sits comfortably under Spotify's limits, and the
// swept result is cached to disk for 6h, so a full sweep is rare.
const SWEEP_GAP_MS = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function redirectUri() {
  return getSpotifyAppCredentials().redirectUri;
}

function readStoredTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_STORE, "utf8"));
  } catch {
    return {};
  }
}

function saveStoredTokens(tokens) {
  writeFileAtomic(TOKEN_STORE, JSON.stringify(tokens, null, 2));
}

// The refresh token can come from the environment (handy for Docker) or from
// the on-disk store written after the one-time login.
function getRefreshToken() {
  const fromEnv = process.env.SPOTIFY_REFRESH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return readStoredTokens().refresh_token || null;
}

export function isUserConnected() {
  return !!getRefreshToken();
}

export function getAuthorizeUrl(state) {
  const { clientId } = getCredentials();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: USER_SCOPES,
    redirect_uri: redirectUri(),
    state,
    show_dialog: "false",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

// Exchange the one-time auth code for tokens and persist the refresh token.
export async function exchangeCodeForTokens(code) {
  const { clientId, clientSecret } = getCredentials();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
    }).toString(),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Spotify token exchange failed (${res.status}): ${detail}`);
  }

  const data = await res.json();
  if (data.refresh_token) {
    saveStoredTokens({
      refresh_token: data.refresh_token,
      scope: data.scope,
      obtained_at: new Date().toISOString(),
    });
  }
  userAccessToken = data.access_token;
  userTokenExpiresAt = Date.now() + data.expires_in * 1000;
}

// Get a valid user access token, refreshing from the stored refresh token.
// Concurrent callers share one in-flight refresh so Spotify can't rotate the
// refresh token out from under a sibling request.
let userRefreshInFlight = null;

async function getUserAccessToken() {
  if (userAccessToken && Date.now() < userTokenExpiresAt - 60_000) {
    return userAccessToken;
  }
  if (userRefreshInFlight) return userRefreshInFlight;

  userRefreshInFlight = (async () => {
    // Re-check after waiting — another caller may have finished the refresh.
    if (userAccessToken && Date.now() < userTokenExpiresAt - 60_000) {
      return userAccessToken;
    }

    const refreshToken = getRefreshToken();
    if (!refreshToken) {
      throw new Error("Spotify account not connected. Visit /auth/login first.");
    }

    const { clientId, clientSecret } = getCredentials();
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Spotify token refresh failed (${res.status}): ${detail}`);
    }

    const data = await res.json();
    userAccessToken = data.access_token;
    userTokenExpiresAt = Date.now() + data.expires_in * 1000;
    // Spotify occasionally rotates the refresh token; persist it (and keep
    // process.env in sync when the host uses SPOTIFY_REFRESH_TOKEN).
    if (data.refresh_token) {
      const stored = readStoredTokens();
      saveStoredTokens({ ...stored, refresh_token: data.refresh_token });
      if (process.env.SPOTIFY_REFRESH_TOKEN) {
        process.env.SPOTIFY_REFRESH_TOKEN = data.refresh_token;
      }
    }
    return userAccessToken;
  })().finally(() => {
    userRefreshInFlight = null;
  });

  return userRefreshInFlight;
}

// List the host's playlists (owned + followed, incl. private/collaborative).
export async function listMyPlaylists(max = 200) {
  const token = await getUserAccessToken();
  const out = [];
  let url = `${API_BASE}/me/playlists?limit=50`;

  while (url && out.length < max) {
    await sleep(SWEEP_GAP_MS); // throttle the sweep to stay under Spotify's rate limit
    const res = await spotifyApiFetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Spotify playlists failed (${res.status}): ${detail}`);
    }
    const data = await res.json();
    for (const p of data.items ?? []) {
      if (!p) continue;
      out.push({
        id: p.id,
        uri: p.uri, // spotify:playlist:<id>
        name: p.name,
        image: pickImage(p.images),
        trackCount: p.tracks?.total ?? 0,
        owner: p.owner?.display_name ?? "",
      });
    }
    url = data.next;
  }

  return out.slice(0, max);
}

// Fetch every playable spotify:track URI from one playlist (100 per page).
// Skips local files, podcast episodes, and unavailable items.
export async function getPlaylistTracks(playlistId) {
  const token = await getUserAccessToken();
  const out = [];
  const fields = encodeURIComponent(
    "items(track(uri,name,is_local,type,explicit,artists(name))),next"
  );
  let url = `${API_BASE}/playlists/${playlistId}/tracks?limit=100&fields=${fields}`;

  while (url) {
    await sleep(SWEEP_GAP_MS); // throttle the sweep to stay under Spotify's rate limit
    const res = await spotifyApiFetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Spotify playlist tracks failed (${res.status}): ${detail}`);
    }
    const data = await res.json();
    for (const item of data.items ?? []) {
      const t = item?.track;
      if (!t || t.is_local || t.type !== "track") continue;
      if (typeof t.uri === "string" && t.uri.startsWith("spotify:track:")) {
        out.push({
          uri: t.uri,
          name: t.name ?? "",
          artist: t.artists?.[0]?.name ?? "",
          explicit: !!t.explicit,
        });
      }
    }
    url = data.next;
  }
  return out;
}

// Cached pool of the host's playlists, each with its own list of tracks:
//   [{ id, name, tracks: [{ uri, name, artist }] }, ...]
// Keeping tracks grouped per playlist lets the random picker pull one song from
// each playlist; the artist lets it avoid back-to-back same-artist picks.
// Building it is expensive (one Spotify request per ~100 tracks), so we warm it
// at startup and keep it for 6 hours. If it's cold/expired when "random" is
// clicked, buildPlaylistPool rebuilds it lazily. A single unreadable playlist is
// skipped rather than failing the whole pool.
const POOL_TTL_MS = 6 * 60 * 60_000;
const PLAYLISTS_TTL_MS = 6 * 60 * 60_000;
let playlistPoolCache = { playlists: [], builtAt: 0 };
let poolInFlight = null;

// Cached list of the host's playlists for the UI dropdown. Refreshes at most
// once per PLAYLISTS_TTL_MS (or when forced via re-warm), so opening the app or
// tabbing back doesn't re-hit Spotify each time. In-flight dedupe collapses
// concurrent callers (e.g. the page firing /playlists and /genres at once).
let playlistsCache = { items: [], builtAt: 0 };
let playlistsInFlight = null;

// Persist the caches (playlist list, track pool) AND the rate-limit cooldown to
// disk, so a server restart reuses fresh data instead of re-sweeping the whole
// library every time - critical for fast iteration. A persisted cooldown also
// means a restart during a Spotify timeout won't poke the API at all.
const SPOTIFY_CACHE_FILE = path.join(__dirname, "..", "data", "spotify-cache.json");
let diskLoaded = false;

function loadDiskCache() {
  if (diskLoaded) return;
  diskLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(SPOTIFY_CACHE_FILE, "utf8"));
    if (Array.isArray(raw.playlists)) {
      playlistsCache = { items: raw.playlists, builtAt: Number(raw.playlistsBuiltAt) || 0 };
    }
    if (Array.isArray(raw.pool)) {
      playlistPoolCache = { playlists: raw.pool, builtAt: Number(raw.poolBuiltAt) || 0 };
    }
    const until = Number(raw.rateLimitedUntil) || 0;
    if (until > Date.now()) rateLimitedUntil = until; // honor an unexpired cooldown
  } catch {
    /* no cache yet - first run */
  }
}

function persistDiskCache() {
  try {
    writeFileAtomic(
      SPOTIFY_CACHE_FILE,
      JSON.stringify({
        playlists: playlistsCache.items,
        playlistsBuiltAt: playlistsCache.builtAt,
        pool: playlistPoolCache.playlists,
        poolBuiltAt: playlistPoolCache.builtAt,
        rateLimitedUntil,
      })
    );
  } catch (err) {
    console.error("[spotify-cache] save failed:", err.message);
  }
}

export async function getPlaylists({ force = false } = {}) {
  loadDiskCache();
  const fresh = Date.now() - playlistsCache.builtAt < PLAYLISTS_TTL_MS;
  if (!force && playlistsCache.items.length && fresh) return playlistsCache.items;
  if (playlistsInFlight) return playlistsInFlight;
  playlistsInFlight = (async () => {
    try {
      const items = await listMyPlaylists();
      playlistsCache = { items, builtAt: Date.now() };
      persistDiskCache();
      return items;
    } finally {
      playlistsInFlight = null;
    }
  })();
  return playlistsInFlight;
}

export async function buildPlaylistPool({ force = false } = {}) {
  loadDiskCache();
  const fresh = Date.now() - playlistPoolCache.builtAt < POOL_TTL_MS;
  if (!force && playlistPoolCache.playlists.length && fresh) {
    return playlistPoolCache.playlists;
  }
  if (poolInFlight) return poolInFlight;
  poolInFlight = (async () => {
    try {
      const playlists = await getPlaylists({ force });
      const result = [];
      for (const pl of playlists) {
        try {
          const tracks = await getPlaylistTracks(pl.id);
          if (tracks.length) result.push({ id: pl.id, name: pl.name, tracks });
        } catch (err) {
          console.error(`[pool] skipped playlist "${pl.name}":`, err.message);
        }
      }
      // If we got throttled partway, don't trust this partial pool for the full
      // TTL - mark it stale so it rebuilds once the cooldown clears.
      playlistPoolCache = {
        playlists: result,
        builtAt: spotifyCooldownMs() > 0 ? 0 : Date.now(),
      };
      persistDiskCache();
      return playlistPoolCache.playlists;
    } finally {
      poolInFlight = null;
    }
  })();
  return poolInFlight;
}

// Timestamp (ms since epoch) of the last successful track-pool warm, or 0 if it
// has never been warmed. Reads the disk cache so a fresh restart still reports
// the persisted warm time. Used by the Settings UI.
export function getPoolWarmedAt() {
  loadDiskCache();
  return playlistPoolCache.builtAt || 0;
}

// Drop all cached Spotify reads so the next access rebuilds from scratch.
export function clearSpotifyCaches() {
  playlistsCache = { items: [], builtAt: 0 };
  playlistPoolCache = { playlists: [], builtAt: 0 };
  persistDiskCache();
}

// Host-triggered "re-warm": clear the cooldown + caches and rebuild the playlist
// list and track pool now. Returns a small summary for the UI. Throws if Spotify
// is unreachable so the caller can surface the error.
export async function rewarmCaches() {
  rateLimitedUntil = 0; // the host explicitly asked; allow an immediate attempt
  clearSpotifyCaches();
  const playlists = await getPlaylists({ force: true });
  const pool = await buildPlaylistPool({ force: true });
  const tracks = pool.reduce((n, p) => n + (p.tracks?.length || 0), 0);
  return { playlists: playlists.length, poolPlaylists: pool.length, tracks };
}

// Build the pool in the background (used at startup) so the first "random" click
// is instant. No-ops when no Spotify account is connected; never throws.
export async function warmTrackPool() {
  if (!isUserConnected()) return;
  try {
    // Not forced: reuse the disk-persisted pool when it's still fresh, so a
    // restart (common during development) doesn't re-sweep the whole library.
    const playlists = await buildPlaylistPool();
    const total = playlists.reduce((n, p) => n + p.tracks.length, 0);
    console.log(
      `[pool] warmed: ${total} tracks across ${playlists.length} playlists`
    );
  } catch (err) {
    console.error("[pool] warm failed:", err.message);
  }
}

function getCredentials() {
  const { clientId, clientSecret } = getSpotifyAppCredentials();
  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing Spotify Client ID / Client Secret. Set them in Settings → Spotify (or SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in .env)."
    );
  }
  return { clientId, clientSecret };
}

let clientCredentialsInFlight = null;

async function getAccessToken() {
  // Reuse the token until it is about to expire (60s safety margin).
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }
  if (clientCredentialsInFlight) return clientCredentialsInFlight;

  clientCredentialsInFlight = (async () => {
    if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
      return cachedToken;
    }

    const { clientId, clientSecret } = getCredentials();
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Spotify auth failed (${res.status}): ${detail}`);
    }

    const data = await res.json();
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return cachedToken;
  })().finally(() => {
    clientCredentialsInFlight = null;
  });

  return clientCredentialsInFlight;
}

// Short-lived cache of guest search results. At a party many people type the
// same popular queries; without this, each debounced keystroke-batch is a fresh
// Spotify call. Results are effectively static over a minute, so we cache them
// briefly (keyed by market + limit + normalized query) and serve repeats from
// memory - fewer Spotify calls and snappier results. Bounded (LRU) + TTL'd so
// it can't grow without bound. The host's explicit filter is applied by the
// caller on top of this, so it's safe to cache the unfiltered result.
const SEARCH_CACHE_TTL_MS = 60_000;
const SEARCH_CACHE_MAX = 200;
const searchCache = new Map(); // key -> { at, tracks }

export async function searchTracks(query, limit = 20) {
  if (!query || !query.trim()) return [];

  const market = getSpotifyAppCredentials().market;
  const key = `${market}|${limit}|${query.trim().toLowerCase()}`;

  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key); // refresh LRU position
    searchCache.set(key, hit);
    return hit.tracks;
  }

  const token = await getAccessToken();

  const params = new URLSearchParams({
    q: query,
    type: "track",
    limit: String(limit),
    market,
  });

  const res = await spotifyApiFetch(`${SEARCH_URL}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Spotify search failed (${res.status}): ${detail}`);
  }

  const data = await res.json();
  const items = data.tracks?.items ?? [];

  const tracks = items.map((t) => ({
    uri: t.uri, // e.g. "spotify:track:0GjEhVFGZW8afUYGChlsLT"
    name: t.name,
    artists: t.artists.map((a) => a.name).join(", "),
    album: t.album?.name ?? "",
    durationMs: t.duration_ms,
    image: pickImage(t.album?.images),
    explicit: !!t.explicit,
  }));

  searchCache.set(key, { at: Date.now(), tracks });
  if (searchCache.size > SEARCH_CACHE_MAX) {
    searchCache.delete(searchCache.keys().next().value); // evict oldest
  }
  return tracks;
}

// Resolve Spotify track IDs to { title, artist, image } using the app-level
// token (no login). Used to backfill display info for memory entries recorded
// before titles were stored. Results are cached in memory (track metadata is
// immutable), and looked up in batches of 50 (the API max). Unknown/invalid IDs
// are simply omitted from the returned map. Never throws for partial failures.
const trackInfoCache = new Map();

export async function getTracksByIds(ids) {
  const out = new Map();
  const want = [...new Set((ids || []).filter((id) => typeof id === "string" && id))];

  const missing = [];
  for (const id of want) {
    if (trackInfoCache.has(id)) out.set(id, trackInfoCache.get(id));
    else missing.push(id);
  }
  if (missing.length === 0) return out;

  const token = await getAccessToken();

  // No market filter: this is a display-only backfill, and passing a market
  // makes Spotify return null for tracks not playable there, dropping titles
  // we could otherwise show. Omitting it resolves metadata for any valid id.
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50);
    const params = new URLSearchParams({ ids: batch.join(",") });
    let res;
    try {
      res = await spotifyApiFetch(`${API_BASE}/tracks?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      console.error(`[tracks] lookup skipped: ${err.message}`);
      break; // rate-limited (or transient); stop instead of hammering
    }
    if (!res.ok) {
      console.error(`[tracks] lookup failed (${res.status})`);
      continue; // best effort: skip this batch, keep whatever we have
    }
    const data = await res.json();
    for (const t of data.tracks ?? []) {
      if (!t || !t.id) continue;
      const info = {
        title: t.name ?? "",
        artist: t.artists?.map((a) => a.name).join(", ") ?? "",
        image: pickImage(t.album?.images),
      };
      trackInfoCache.set(t.id, info);
      out.set(t.id, info);
    }
  }

  return out;
}

// Find a playable Spotify track for an "artist + title" pair (used to resolve
// Last.fm similar-song suggestions into real Sonos-addable URIs). Returns
// { uri, id, name, artist } for the best confident match, or null. Uses the
// app-level token (no login) and verifies the result loosely matches the query
// so we don't enqueue an unrelated song. Results are cached per query.
const findTrackCache = new Map();
const FIND_TRACK_CACHE_MAX = 500;

function setFindTrackCache(key, value) {
  if (findTrackCache.has(key)) findTrackCache.delete(key); // refresh insertion order
  findTrackCache.set(key, value);
  while (findTrackCache.size > FIND_TRACK_CACHE_MAX) {
    const oldest = findTrackCache.keys().next().value;
    findTrackCache.delete(oldest);
  }
}

function normalizeLoose(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ") // drop "(feat. ...)", "[remastered]"
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function findTrackUri(artist, title) {
  const a = (artist || "").trim();
  const t = (title || "").trim();
  if (!a || !t) return null;

  const cacheKey = `${a.toLowerCase()}|||${t.toLowerCase()}`;
  if (findTrackCache.has(cacheKey)) return findTrackCache.get(cacheKey);

  const token = await getAccessToken();
  const market = getSpotifyAppCredentials().market;
  const params = new URLSearchParams({
    q: `track:${t} artist:${a}`,
    type: "track",
    limit: "5",
    market,
  });

  let result = null;
  // Only cache definitive outcomes (hit or confirmed miss). Transient failures
  // (429 / network) must not poison discovery for the cache lifetime.
  let cacheable = false;
  try {
    const res = await spotifyApiFetch(`${SEARCH_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      const items = data.tracks?.items ?? [];
      const wantA = normalizeLoose(a);
      const wantT = normalizeLoose(t);
      const match = items.find((it) => {
        const gotT = normalizeLoose(it.name);
        const gotA = (it.artists || []).map((x) => normalizeLoose(x.name));
        const titleOk = gotT === wantT || gotT.includes(wantT) || wantT.includes(gotT);
        const artistOk = gotA.some((x) => x === wantA || x.includes(wantA) || wantA.includes(x));
        return titleOk && artistOk;
      });
      if (match) {
        result = {
          uri: match.uri,
          id: match.id,
          name: match.name,
          artist: match.artists?.map((x) => x.name).join(", ") ?? a,
          explicit: !!match.explicit,
        };
      }
      cacheable = true;
    }
  } catch (err) {
    console.error(`[find] search failed for "${a} - ${t}":`, err.message);
  }

  if (cacheable) setFindTrackCache(cacheKey, result);
  return result;
}

function pickImage(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  // Spotify returns largest first. Prefer ~300px (NP + search); else largest.
  const mid = images.find(
    (im) => (im?.width ?? 0) >= 200 && (im?.width ?? 0) <= 400
  );
  return mid?.url ?? images[0]?.url ?? images[images.length - 1]?.url ?? null;
}
