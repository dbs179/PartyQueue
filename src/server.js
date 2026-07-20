import "./load-env.js"; // load .env before any module reads process.env
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { upsertEnvKeys } from "./env-file.js";
import {
  exchangeCodeForTokens,
  getAuthorizeUrl,
  isUserConnected,
  getTracksByIds,
  getPlaylists,
  searchTracks,
  warmTrackPool,
  rewarmCaches,
  spotifyCooldownMs,
  getPoolWarmedAt,
} from "./spotify.js";
import {
  getAutoFillState,
  getClosingTimeAt,
  getLastPartyRecap,
  initAutoFill,
  markClosingTime,
  nudgeAutoFill,
  setAutoFill,
  savePickerSelection,
  stopAutoFillMonitor,
} from "./autofill.js";
import {
  initQueueMaintenance,
  stopQueueMaintenance,
} from "./queue-maintenance.js";
import {
  isEndOfNightTrack,
  shouldAnnouncePartyRecap,
} from "./closing-time.js";
import { buildPartyRecap } from "./party-recap.js";
import { shouldShoutOnSearch, announceRequestShout } from "./dj-shout.js";
import {
  listGuestProfiles,
  addGuestNote,
  removeGuestNote,
  deleteGuestProfile,
  setGuestBirthday,
  renameGuestProfile,
} from "./guest-profiles.js";
import QRCode from "qrcode";
import {
  GENRE_BUCKETS,
  genreCounts,
  eligiblePoolSize,
  flushGenrePersist,
  isGenreDataEnabled,
  stopGenreWarm,
  warmGenresFromPool,
} from "./genres.js";
import {
  RANDOMNESS_DEFAULTS,
  DISCOVERY_DEFAULTS,
  CONTENT_DEFAULTS,
  BRANDING_DEFAULTS,
  NEVER_ENDING_DEFAULT,
  getRandomnessSettings,
  setRandomnessSettings,
  getDiscoverySettings,
  setDiscoverySettings,
  getContentSettings,
  setContentSettings,
  getBrandingSettings,
  setBrandingSettings,
  getDjVoiceSettings,
  setDjVoiceSettings,
  setSonosTargetRoom,
  DJ_VOICE_DEFAULTS,
} from "./settings.js";
import {
  announceFreshSet,
  announceSetBatch,
  announcePartyRecap,
  isDjVoiceReady,
  previewTtsVoice,
  getPublicBaseUrl,
} from "./dj-voice.js";
import {
  getHaStatus,
  setHaSettings,
  clearHaSettings,
  testHaConnection,
} from "./home-assistant.js";
import {
  isHostPinConfigured,
  hostPinStatus,
  verifyHostPin,
  setHostPin,
  clearHostPin,
  createHostSession,
  setHostSessionCookie,
  clearHostSessionCookie,
  extractHostToken,
  isValidHostToken,
  requireHost,
  requireHostPage,
} from "./host-auth.js";
import {
  getSpotifyAppStatus,
  setSpotifyAppSettings,
  clearSpotifyAppSettings,
  testSpotifyAppConnection,
} from "./spotify-app.js";
import {
  getLastfmStatus,
  setLastfmSettings,
  clearLastfmSettings,
  testLastfmConnection,
} from "./lastfm.js";
import {
  getSonosConnectionStatus,
  setSonosConnectionSettings,
  clearSonosConnectionSettings,
  testSonosConnection,
} from "./sonos-config.js";
import {
  listBanners,
  saveBanner,
  deleteBanner,
  bannerExists,
  bannerPath,
  seedStarterBanners,
} from "./banners.js";
import {
  listDjIcons,
  saveDjIcon,
  deleteDjIcon,
  djIconExists,
  seedStarterDjIcons,
} from "./dj-icon.js";
import {
  clearHistory,
  flushHistoryPersist,
  getHistory,
} from "./play-history.js";
import {
  originOf,
  requestedByOf,
  requestedByUserOf,
  setDedication,
} from "./queue-origin.js";
import {
  resolveGuestIdentity,
  sanitizeDedication,
  sanitizeDisplayName,
} from "./display-name.js";
import {
  recordRequest,
  getRequests,
  summarizeRequests,
  topRequesters,
  clearRequests,
  setRequestDedication,
  listDedications,
} from "./request-log.js";
import {
  getReactions,
  setReaction,
  listKaraokeTracks,
  listReactedTracks,
  listTopLikedTracks,
  listPartyMusicTracks,
  listMostHatedTracks,
  clearMoodReactions,
  clearKaraokeReactions,
} from "./reactions.js";
import {
  setRequestsPaused,
  setKidsLock,
  getRitualState,
} from "./party-rituals.js";
import {
  clearDjNightMemory,
  forgetBirthdayShout,
} from "./dj-night-memory.js";
import { softRateLimit } from "./rate-limit.js";
import {
  addSuggestion,
  getSuggestions,
  setSuggestionDone,
  clearSuggestions,
  suggestionCounts,
  SUGGESTION_TEXT_MAX,
} from "./suggestion-box.js";
import { spotifyTrackId } from "./sampler.js";
import { lookupLyrics } from "./lyrics.js";
import {
  addPlaylistToQueue,
  addRandomFromPlaylists,
  addTrackToQueue,
  clearQueue,
  getNowPlaying,
  getQueueList,
  groupAll,
  isKnownSonosHost,
  joinSpeakerToTarget,
  leaveSpeakerGroup,
  listGroups,
  listRooms,
  selectGroup,
  shouldClearQueueForRandomDj,
  randomDjAnnouncePlan,
  ungroupAll,
  next,
  pause,
  play,
  previous,
  removeQueueTrack,
  reorderQueueTrack,
  toggleMute,
  toggleShuffle,
  volumeDown,
  volumeUp,
  getGroupVolume,
  resetSonosManager,
} from "./sonos.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

// Party Stats / social strip: rolling "tonight" window (hours).
const STATS_WINDOW_HOURS = 12;

// Read once at boot so the UI can show which build is running.
let VERSION = "";
try {
  VERSION = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
  ).version;
} catch {
  /* version stays blank if package.json can't be read */
}

// Block cross-site state-changing requests (CSRF / DNS-rebinding against this
// LAN service). A malicious site the host happens to visit could otherwise have
// their browser silently POST to e.g. /api/queue/clear. Browsers attach an
// Origin header on cross-origin requests; if it's present and its host doesn't
// match the Host we're served on, refuse. Same-origin app calls (the phones)
// always match. Requests with no Origin (curl, top-level navigations, the
// Spotify OAuth GET callback, non-browser clients) are left alone since they
// aren't the browser-driven cross-site vector this guards against.
app.use((req, res, next) => {
  if (req.method !== "POST" && req.method !== "DELETE") return next();
  const origin = req.get("origin");
  if (!origin) return next();
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return res.status(403).json({ error: "Bad origin." });
  }
  if (originHost !== req.headers.host) {
    return res.status(403).json({ error: "Cross-origin request blocked." });
  }
  next();
});

// Default JSON parser for normal API calls. Banner / DJ-icon upload routes
// carry a base64 image, so they opt into a larger limit below; skip them here
// so the default 100 KB cap doesn't reject a real image before the route.
const jsonParser = express.json();
app.use((req, res, next) => {
  if (
    req.method === "POST" &&
    (req.path === "/api/banners" || req.path === "/api/dj-icon")
  ) {
    return next();
  }
  return jsonParser(req, res, next);
});
// Inject saved branding JSON into index.html. The page has no default title /
// subtitle / banner src — an inline script applies this (or localStorage) before
// first paint so restart doesn't flash stock defaults.
const INDEX_HTML_PATH = path.join(__dirname, "..", "public", "index.html");
function sendBrandedIndex(_req, res) {
  try {
    const { eventName, subtitle, heroBanner, showVersion } =
      getBrandingSettings();
    const brandJson = JSON.stringify({
      eventName,
      subtitle: subtitle ?? "",
      heroBanner: heroBanner || null,
      version: VERSION || "",
      showVersion: !!showVersion,
    }).replace(/</g, "\\u003c");
    let html = fs.readFileSync(INDEX_HTML_PATH, "utf8");
    html = html.replaceAll("__PQ_BRAND_JSON__", brandJson);
    res.setHeader("Cache-Control", "no-cache");
    res.type("html").send(html);
  } catch (err) {
    console.error("[index] brand inject failed:", err.message);
    // Still avoid a syntax error if the placeholder wasn't replaced.
    try {
      let html = fs.readFileSync(INDEX_HTML_PATH, "utf8");
      html = html.replaceAll("__PQ_BRAND_JSON__", "null");
      res.setHeader("Cache-Control", "no-cache");
      return res.type("html").send(html);
    } catch {
      res.sendFile(INDEX_HTML_PATH);
    }
  }
}
app.get(["/", "/index.html"], sendBrandedIndex);

// Serve the UI with "no-cache" so browsers always revalidate against the
// server (cheap 304s via ETag when unchanged). Without this, a cached app.js /
// styles.css from a previous build can linger after an update and cause stale
// behavior, which is hard to diagnose. Assets still get conditional caching.
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    index: false, // branded / and /index.html are handled above
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  })
);
// Host-uploaded hero banners live under data/ (persisted by the Docker volume).
app.use("/banners", express.static(path.join(__dirname, "..", "data", "banners")));
// Stable URL for the active hero so the first paint isn't the built-in default
// while /api/settings is still loading (avoids Default → selected flash).
app.get("/banner", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  const name = getBrandingSettings().heroBanner;
  if (name && bannerExists(name)) {
    const file = bannerPath(name);
    if (file) return res.sendFile(file);
  }
  return res.sendFile(path.join(__dirname, "..", "public", "hero.png"));
});
// Custom DJ Voice icons (gallery under data/dj-icons/; default is flat starter).
app.use(
  "/dj-icon",
  express.static(path.join(__dirname, "..", "data", "dj-icons"), {
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  })
);
// DJ Voice MP3 clips — Sonos speakers fetch these directly over the LAN.
app.use(
  "/media/tts",
  express.static(path.join(__dirname, "..", "data", "tts"), {
    fallthrough: false,
    setHeaders(res) {
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
    },
  })
);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    // Boolean only — never secrets. Helps first-run nudges on fresh installs.
    spotifyConfigured: !!getSpotifyAppStatus().configured,
  });
});

// Optional helper: see which rooms PartyQueue can see (useful for setup).
app.get("/api/rooms", async (_req, res) => {
  try {
    res.json({ rooms: await listRooms() });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// Current Sonos zone groups for the target picker (which group's queue to use).
app.get("/api/groups", async (_req, res) => {
  try {
    res.json(await listGroups());
  } catch (err) {
    console.error("[groups]", err.message);
    res.status(503).json({ error: err.message });
  }
});

app.post("/api/groups/select", async (req, res) => {
  const { room } = req.body ?? {};
  if (!room) {
    return res.status(400).json({ error: "Missing room." });
  }
  try {
    res.json({ ok: true, ...(await selectGroup(String(room))) });
  } catch (err) {
    console.error("[groups/select]", err.message);
    res.status(400).json({ error: err.message || "Could not select group." });
  }
});

app.get("/api/search", async (req, res) => {
  const query = req.query.q;
  if (!query || !String(query).trim()) {
    return res.json({ tracks: [] });
  }
  try {
    let tracks = await searchTracks(String(query), 20);
    // Hide explicit results when the host's content filter is on.
    if (getContentSettings().filterExplicit) {
      tracks = tracks.filter((t) => !t.explicit);
    }
    res.json({ tracks });
  } catch (err) {
    console.error("[search]", err.message);
    res.status(502).json({ error: "Spotify search failed. Check your credentials." });
  }
});

// Keep guest requests open while blunting accidental double-taps and queue floods.
const queueBurstLimit = softRateLimit({
  windowMs: 10_000,
  max: 3,
  message: "Easy on the requests — wait a few seconds and try again.",
});
const queueSustainedLimit = softRateLimit({
  windowMs: 5 * 60_000,
  max: 20,
  message: "Request limit reached — try again in a few minutes.",
});

app.post("/api/queue", queueBurstLimit, queueSustainedLimit, async (req, res) => {
  const { uri, name, artist, force, requestedBy, requestedByUser, dedication } =
    req.body ?? {};
  if (!uri) {
    return res.status(400).json({ error: "Missing track uri." });
  }
  if (getContentSettings().requestsPaused) {
    return res.status(403).json({ error: "Requests are paused right now." });
  }
  const { user, badge, alias } = resolveGuestIdentity({
    requestedBy,
    requestedByUser,
  });
  if (!user) {
    return res.status(400).json({ error: "Enter your name before adding a song." });
  }
  const note = sanitizeDedication(dedication);
  try {
    const result = await addTrackToQueue(uri, {
      name,
      artist,
      force: !!force,
      requestedBy: badge,
      requestedByUser: user,
      dedication: note,
    });

    // Log the guest request (a real search-and-add) for the Party Stats panel.
    // Stats key on User; optional alias is audit-only.
    const reqId = spotifyTrackId(uri);
    if (reqId) {
      recordRequest({
        id: reqId,
        name,
        artist,
        requestedBy: user,
        alias: alias && alias !== user ? alias : null,
        dedication: note,
      });
    }

    // House ritual: hand-adding the End of Night song signals last call. We
    // announce it to everyone (via the Now Playing poll) and, if the
    // Never-Ending Queue is on, switch it off so the night plays out and ends.
    // Optional Party Summary TTS is inserted immediately before that song.
    let closingTime = false;
    let partyRecap = null;
    if (isEndOfNightTrack({ uri, name, artist })) {
      if (getAutoFillState().enabled) setAutoFill(false);
      partyRecap = buildPartyRecap();
      markClosingTime(partyRecap);
      closingTime = true;
      const pos = Number(result.absoluteQueuePosition ?? result.queuePosition);
      if (
        shouldAnnouncePartyRecap() &&
        isDjVoiceReady() &&
        Number.isFinite(pos) &&
        pos >= 1
      ) {
        void announcePartyRecap(partyRecap, { queuePosition: pos }).catch(
          (err) => console.error("[queue] party recap announce:", err.message)
        );
      }
    } else if (
      shouldShoutOnSearch({
        force: !!result.queueWasEmpty,
        requestedBy: user,
      })
    ) {
      // Mood Pulse: occasional DJ shout on search adds. Empty queue always
      // shouts when enabled (and starts playback from the TTS clip).
      // Speak/key off User (real name), never the queue alias.
      const pos = Number(result.absoluteQueuePosition ?? result.queuePosition);
      const startPlayback = !!(result.queueWasEmpty || result.deferredStart);
      if (Number.isFinite(pos) && pos >= 1) {
        if (startPlayback) {
          // Await empty/idle shouts so we can fall back to playing the song if
          // TTS/HA fails — otherwise the queue stays STOPPED forever.
          try {
            const voice = await announceRequestShout({
              name,
              artist,
              requestedBy: user,
              dedication: note,
              uri,
              trackId: reqId,
              queuePosition: pos,
              startPlayback: true,
            });
            if (!voice?.ok && !voice?.skipped) {
              await play({ trackNumber: 1 });
            }
          } catch (err) {
            console.error("[queue] request shout:", err.message);
            try {
              await play({ trackNumber: 1 });
            } catch (playErr) {
              console.error("[queue] shout fallback play:", playErr.message);
            }
          }
        } else {
          // Mid-set request: await TTS insert so the playhead can't race past
          // the shout (song is often next-up after promote-ahead-of-filler).
          // Script re-reads dedicationOf at write time so a toast Dedicate can
          // still land while TTS is generating.
          try {
            await announceRequestShout({
              name,
              artist,
              requestedBy: user,
              dedication: note,
              uri,
              trackId: reqId,
              queuePosition: pos,
              startPlayback: false,
            });
          } catch (err) {
            console.error("[queue] request shout:", err.message);
          }
        }
      }
    } else if (result.deferredStart && !result.started) {
      // Shout was deferred-start but didn't fire (DJ not ready, etc.) — play song.
      void play({ trackNumber: 1 }).catch((err) =>
        console.error("[queue] deferred start failed:", err.message)
      );
    }

    res.json({
      ok: true,
      ...result,
      closingTime,
      closingTimeAt: closingTime ? getClosingTimeAt() : 0,
      partyRecap,
    });
  } catch (err) {
    console.error("[queue]", err.message);
    res.status(502).json({ error: err.message || "Could not add to Sonos queue." });
  }
});

// Optional post-Add dedication (toast chip). Guest-accessible; only updates
// searched origins. If a mid-queue shout pad is still upcoming, supersede it
// so the DJ can say “goes out to …”.
app.post("/api/queue/dedication", async (req, res) => {
  const { uri, dedication, name, artist } = req.body ?? {};
  const id = spotifyTrackId(uri);
  if (!id) {
    return res.status(400).json({ error: "Missing track uri." });
  }
  const updated = setDedication(id, dedication);
  if (!updated.ok) {
    return res.status(400).json({ error: updated.error });
  }

  const forWho = updated.dedication;
  // Keep the request-log wall in sync with toast Dedicate.
  setRequestDedication(id, forWho);

  if (forWho && isDjVoiceReady() && name) {
    const by = requestedByUserOf(id) || requestedByOf(id);
    try {
      const { findUpcomingTrackPosition } = await import("./sonos.js");
      const pos = await findUpcomingTrackPosition({ name, artist });
      if (pos != null && pos >= 1) {
        void announceRequestShout({
          name,
          artist,
          requestedBy: by,
          dedication: forWho,
          uri,
          trackId: id,
          queuePosition: pos,
          startPlayback: false,
        }).catch((err) =>
          console.error("[queue] dedication shout refresh:", err.message)
        );
      }
    } catch (err) {
      console.warn("[queue] dedication shout refresh skipped:", err.message);
    }
  }

  res.json({ ok: true, dedication: forWho });
});

app.post("/api/queue/playlist", queueBurstLimit, queueSustainedLimit, async (req, res) => {
  const { uri } = req.body ?? {};
  if (!uri) {
    return res.status(400).json({ error: "Missing playlist uri." });
  }
  try {
    const result = await addPlaylistToQueue(uri);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[queue/playlist]", err.message);
    res.status(502).json({ error: err.message || "Could not add playlist to Sonos queue." });
  }
});

// Clamp the requested count to a sane whole number (1..100), defaulting to 50.
function parseCount(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(100, n);
}

const destructiveLimit = softRateLimit({
  windowMs: 2500,
  max: 2,
  message: "Slow down — try again in a moment.",
});
const transportLimit = softRateLimit({
  windowMs: 800,
  max: 4,
  message: "Easy on the controls — try again in a moment.",
});

app.post("/api/queue/random", destructiveLimit, async (req, res) => {
  if (!isUserConnected()) {
    return res.status(400).json({ error: "Connect your Spotify account first." });
  }
  const { playlistIds, count, genres } = req.body ?? {};
  const ids = Array.isArray(playlistIds) ? playlistIds : null;
  const genreIds = Array.isArray(genres) ? genres : null;
  const { discoverEnabled, similarCount } = getDiscoverySettings();
  const { filterExplicit } = getContentSettings();
  const djReady = isDjVoiceReady();
  try {
    // Empty-queue + DJ: clear (no-op wipe + Stop) so the playhead resets before
    // a fresh-set announce owns position 1. Never clear when anything is already
    // queued — guest requests must survive Random (older logic cleared on any
    // !isPlaying / !playingFromQueue, which wiped requests during DJ pauses).
    let clearForDj = false;
    if (djReady) {
      try {
        const { getQueueStatus } = await import("./sonos.js");
        const status = await getQueueStatus();
        clearForDj = shouldClearQueueForRandomDj(status);
        if (!clearForDj && status.total > 0) {
          console.log(
            `[queue/random] skip DJ clear — queue has ${status.total} track(s)` +
              ` (playing=${!!status.isPlaying}, fromQueue=${!!status.playingFromQueue})`
          );
        }
      } catch {
        clearForDj = false;
      }
    }

    if (djReady && clearForDj) {
      try {
        console.log("[queue/random] clearing empty queue for DJ fresh-set start");
        const { clearQueue } = await import("./sonos.js");
        await clearQueue();
      } catch (err) {
        console.error("[queue/random] DJ clear failed:", err.message);
      }
    }

    const result = await addRandomFromPlaylists(parseCount(count), ids, genreIds, {
      similarCount: discoverEnabled ? similarCount : 0,
      filterExplicit,
      deferAutoStart: djReady,
    });

    // Fresh idle Random: set announce at #1 + Play. Mid-party Random: set
    // announce immediately before the new batch (under guest requests) — never
    // only when deferredStart (that skipped announce while music was playing).
    let announced = false;
    const plan = randomDjAnnouncePlan({
      djReady,
      added: result.added,
      queueTotalBefore: result.queueTotalBefore,
      clearForDj,
      deferredStart: result.deferredStart,
      firstAppendPosition: result.firstAppendPosition,
    });
    if (plan.action === "fresh_set") {
      try {
        const voice = await announceFreshSet(result);
        announced = !!voice?.ok;
        if (voice?.ok) {
          result.started = true;
        } else {
          await play({ trackNumber: 1 });
          result.started = true;
        }
      } catch (err) {
        console.error("[queue/random] DJ announce failed:", err.message);
        try {
          await play({ trackNumber: 1 });
          result.started = true;
        } catch (playErr) {
          console.error("[queue/random] fallback play failed:", playErr.message);
        }
      }
    } else if (plan.action === "before_batch") {
      try {
        const voice = await announceSetBatch(result, {
          queuePosition: plan.queuePosition,
          startPlayback: false,
          event: "session_refill",
        });
        announced = !!voice?.ok;
        if (plan.resumePlay) {
          // Leftover queue was STOPPED — resume without seeking to the
          // bottom announce (guest requests at the front stay first).
          await play();
          result.started = true;
        }
      } catch (err) {
        console.error("[queue/random] mid-queue set announce failed:", err.message);
        if (plan.resumePlay) {
          try {
            await play();
            result.started = true;
          } catch (playErr) {
            console.error("[queue/random] resume play failed:", playErr.message);
          }
        }
      }
    }

    res.json({
      ok: true,
      ...result,
      announced,
    });
  } catch (err) {
    console.error("[queue/random]", err.message);
    res.status(502).json({ error: err.message || "Could not add random songs." });
  }
});

// Available genre buckets plus how many pool songs fall in each, for the UI's
// genre toggles. `enabled` reports whether a Last.fm key is configured (when
// off, every song is "Other" and filtering is effectively a no-op).
// Optional `?playlistIds=a,b,c` scopes chip counts to the host's selection.
app.get("/api/genres", async (req, res) => {
  try {
    const raw = req.query?.playlistIds;
    const playlistIds =
      typeof raw === "string" && raw.trim()
        ? raw.split(",").map((s) => s.trim()).filter(Boolean)
        : null;
    res.json({
      enabled: isGenreDataEnabled(),
      buckets: GENRE_BUCKETS,
      counts: await genreCounts({ playlistIds }),
    });
  } catch (err) {
    console.error("[genres]", err.message);
    res.status(500).json({ error: err.message || "Could not load genres." });
  }
});

// How many unique tracks Random would draw from with the given filters. Powers
// the pool-size hint under the genre chips. Also returns per-genre counts for
// the same playlist scope so chip numbers stay in sync with the selection.
app.post("/api/pool-size", async (req, res) => {
  try {
    const { playlistIds, genres } = req.body ?? {};
    const ids = Array.isArray(playlistIds) ? playlistIds : null;
    const size = await eligiblePoolSize({
      playlistIds: ids,
      genres: Array.isArray(genres) ? genres : null,
    });
    const counts = await genreCounts({ playlistIds: ids });
    const { songMemory } = getRandomnessSettings();
    res.json({
      ok: true,
      ...size,
      counts,
      songMemory,
      // Soft warning thresholds: under memory size, or under ~10x a typical
      // Random-25 batch, repeats / relaxation become likely.
      warn: size.tracks > 0 && (size.tracks < songMemory || size.tracks < 250),
    });
  } catch (err) {
    console.error("[pool-size]", err.message);
    res.status(500).json({ error: err.message || "Could not measure pool size." });
  }
});

// "Never-Ending Queue": auto-tops up the queue with random songs when it runs
// low. State is server-side so it works with no browser open.
app.get("/api/autofill", (_req, res) => {
  res.json(getAutoFillState());
});

app.post("/api/autofill", (req, res) => {
  try {
    const { enabled, playlistIds, genres } = req.body ?? {};
    if (enabled && !isUserConnected()) {
      return res.status(400).json({ error: "Connect your Spotify account first." });
    }
    const ids = Array.isArray(playlistIds) ? playlistIds : undefined;
    const genreIds = Array.isArray(genres) ? genres : undefined;
    res.json({ ok: true, ...setAutoFill(!!enabled, ids, genreIds) });
  } catch (err) {
    console.error("[autofill]", err.message);
    res.status(500).json({ error: err.message || "Could not save Never-Ending setting." });
  }
});

// Persist playlist + genre selection for Random / Never-Ending even when the
// monitor is off, so every phone and the server share one host selection.
app.post("/api/selection", (req, res) => {
  try {
    const { playlistIds, genres } = req.body ?? {};
    const ids = Array.isArray(playlistIds) ? playlistIds : undefined;
    const genreIds = Array.isArray(genres) ? genres : undefined;
    res.json({ ok: true, ...savePickerSelection(ids, genreIds) });
  } catch (err) {
    console.error("[selection]", err.message);
    res.status(500).json({ error: err.message || "Could not save selection." });
  }
});

// Randomness knobs (song memory + per-artist budget) for the random picker.
// Also returns the defaults so the UI can offer a "reset to defaults" action.
function publicContentSettings() {
  const { kidsLockSnapshot: _snap, ...rest } = getContentSettings();
  return rest;
}

app.get("/api/settings", requireHost, (_req, res) => {
  res.json({
    ...getRandomnessSettings(),
    ...getDiscoverySettings(),
    ...publicContentSettings(),
    ...getDjVoiceSettings(),
    ...getBrandingSettings(),
    ...getRitualState(),
    defaults: {
      ...RANDOMNESS_DEFAULTS,
      ...DISCOVERY_DEFAULTS,
      ...CONTENT_DEFAULTS,
      ...DJ_VOICE_DEFAULTS,
      ...BRANDING_DEFAULTS,
      neverEnding: NEVER_ENDING_DEFAULT,
    },
  });
});

app.post("/api/settings", requireHost, (req, res) => {
  try {
    const body = { ...(req.body ?? {}) };
    // Rituals apply side effects (Kids mood / subtle DJ); don't treat them as
    // plain content booleans.
    if (body.kidsLock != null) {
      setKidsLock(!!body.kidsLock);
      delete body.kidsLock;
    }
    if (body.requestsPaused != null) {
      setRequestsPaused(!!body.requestsPaused);
      delete body.requestsPaused;
    }
    delete body.kidsLockSnapshot;
    setRandomnessSettings(body);
    setDiscoverySettings(body);
    setContentSettings(body);
    setDjVoiceSettings(body);
    setBrandingSettings(body);
    res.json({
      ok: true,
      ...getRandomnessSettings(),
      ...getDiscoverySettings(),
      ...publicContentSettings(),
      ...getDjVoiceSettings(),
      ...getBrandingSettings(),
      ...getRitualState(),
      defaults: {
        ...RANDOMNESS_DEFAULTS,
        ...DISCOVERY_DEFAULTS,
        ...CONTENT_DEFAULTS,
        ...DJ_VOICE_DEFAULTS,
        ...BRANDING_DEFAULTS,
        neverEnding: NEVER_ENDING_DEFAULT,
      },
    });
  } catch (err) {
    console.error("[settings]", err.message);
    res.status(400).json({ error: err.message || "Could not save settings." });
  }
});

// Hero banners: list stored banners + the active one, upload a new one, pick an
// existing one, or delete. The active banner is tracked in branding settings
// (`heroBanner`); null means the built-in public/hero.png.
app.get("/api/banners", requireHost, (_req, res) => {
  res.json({
    active: getBrandingSettings().heroBanner,
    defaultUrl: "/hero.png",
    banners: listBanners(),
  });
});

// Larger JSON limit only here, since banners arrive as base64 data URLs.
app.post("/api/banners", requireHost, express.json({ limit: "12mb" }), (req, res) => {
  try {
    const name = saveBanner(req.body?.image);
    setBrandingSettings({ heroBanner: name }); // newly uploaded becomes active
    res.json({ ok: true, active: name, banners: listBanners() });
  } catch (err) {
    console.error("[banners] upload:", err.message);
    res.status(400).json({ error: err.message || "Could not save banner." });
  }
});

app.post("/api/banners/select", requireHost, (req, res) => {
  const name = req.body?.name ?? null;
  if (name !== null && !bannerExists(name)) {
    return res.status(404).json({ error: "Banner not found." });
  }
  setBrandingSettings({ heroBanner: name }); // null reverts to the built-in hero
  res.json({ ok: true, active: name, banners: listBanners() });
});

app.delete("/api/banners/:name", requireHost, (req, res) => {
  try {
    const { name } = req.params;
    const existed = deleteBanner(name);
    // If we just removed the active banner, fall back to the built-in default.
    if (existed && getBrandingSettings().heroBanner === name) {
      setBrandingSettings({ heroBanner: null });
    }
    res.json({
      ok: true,
      active: getBrandingSettings().heroBanner,
      banners: listBanners(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not delete banner." });
  }
});

// Preview the selected (or requested) HA TTS voice in the browser.
app.post("/api/dj-voice/preview", requireHost, async (req, res) => {
  try {
    const result = await previewTtsVoice(
      req.body?.voice ?? null,
      req.body?.speed ?? null,
      req.body?.provider ?? null
    );
    res.json(result);
  } catch (err) {
    console.error("[dj-voice] preview failed:", err.message);
    res.status(400).json({
      error: err.message || "Could not preview that voice.",
    });
  }
});

// DJ Voice icons: list + active, upload (newest becomes active), select, delete.
app.get("/api/dj-icon", requireHost, (_req, res) => {
  const dj = getDjVoiceSettings();
  res.json({
    ok: true,
    active: dj.djIcon,
    djIcon: dj.djIcon,
    djIconUrl: dj.djIconUrl,
    defaultUrl: "/dj-icons/flat.png",
    icons: listDjIcons(),
  });
});

app.post("/api/dj-icon", requireHost, express.json({ limit: "4mb" }), (req, res) => {
  try {
    const name = saveDjIcon(req.body?.image);
    const dj = setDjVoiceSettings({ djIcon: name });
    res.json({
      ok: true,
      active: dj.djIcon,
      djIcon: dj.djIcon,
      djIconUrl: dj.djIconUrl,
      icons: listDjIcons(),
    });
  } catch (err) {
    console.error("[dj-icon] upload:", err.message);
    res.status(400).json({ error: err.message || "Could not save DJ icon." });
  }
});

app.post("/api/dj-icon/select", requireHost, (req, res) => {
  const name = req.body?.name ?? null;
  if (name !== null && !djIconExists(name)) {
    return res.status(404).json({ error: "DJ icon not found." });
  }
  const dj = setDjVoiceSettings({ djIcon: name }); // null = bundled default
  res.json({
    ok: true,
    active: dj.djIcon,
    djIcon: dj.djIcon,
    djIconUrl: dj.djIconUrl,
    icons: listDjIcons(),
  });
});

app.delete("/api/dj-icon/:name", requireHost, (req, res) => {
  try {
    const { name } = req.params;
    const existed = deleteDjIcon(name);
    if (existed && getDjVoiceSettings().djIcon === name) {
      setDjVoiceSettings({ djIcon: null });
    }
    const dj = getDjVoiceSettings();
    res.json({
      ok: true,
      active: dj.djIcon,
      djIcon: dj.djIcon,
      djIconUrl: dj.djIconUrl,
      icons: listDjIcons(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not delete DJ icon." });
  }
});

// The recently-played "memory" that powers repeat-avoidance, newest first.
// Entries store a title when available; older ones are backfilled from Spotify
// (title + album art) best-effort so the list always reads nicely.
app.get("/api/history", requireHost, async (_req, res) => {
  try {
    const entries = getHistory();
    const needLookup = entries.filter((e) => !e.name).map((e) => e.id);

    let info = new Map();
    if (needLookup.length) {
      try {
        info = await getTracksByIds(needLookup);
      } catch (err) {
        console.error("[history] track lookup failed:", err.message);
      }
    }

    const tracks = entries.map((e) => {
      const extra = info.get(e.id);
      // Prefer history stamp; fall back to live queue-origin (helps recover
      // Songs Like / Random after a skip that used to overwrite source).
      const source = e.source || originOf(e.id) || null;
      const requestedBy =
        e.requestedBy ||
        (source === "searched" ? requestedByOf(e.id) : null) ||
        null;
      return {
        id: e.id,
        title: e.name || extra?.title || "",
        artist: e.artist || extra?.artist || "",
        image: extra?.image ?? null,
        source,
        skipped: !!e.skipped,
        requestedBy: source === "searched" ? requestedBy : null,
      };
    });

    res.json({ count: tracks.length, tracks });
  } catch (err) {
    console.error("[history]", err.message);
    res.status(500).json({ error: err.message || "Could not load memory." });
  }
});

// Party Stats: most-requested songs/artists/requesters from guest search-and-adds,
// for both "tonight" (a rolling window) and all-time. Lazy-loaded by the UI panel.
app.get("/api/stats", async (_req, res) => {
  try {
    const events = getRequests();
    const sinceTonight = Date.now() - STATS_WINDOW_HOURS * 60 * 60_000;
    const tonight = summarizeRequests(events, sinceTonight);
    const allTime = summarizeRequests(events, 0);
    const karaoke = listKaraokeTracks(50);
    const reacted = listReactedTracks(50);
    const topLiked = listTopLikedTracks(50);
    const partyMusic = listPartyMusicTracks(50);
    const mostHated = listMostHatedTracks(50);
    const reactionLists = [
      karaoke,
      reacted,
      topLiked,
      partyMusic,
      mostHated,
    ];
    // Fill missing titles from Spotify when taps didn't send meta.
    const needIds = [
      ...new Set(
        reactionLists.flat().filter((k) => !k.name).map((k) => k.id)
      ),
    ];
    if (needIds.length) {
      try {
        const map = await getTracksByIds(needIds);
        for (const row of reactionLists.flat()) {
          if (row.name) continue;
          const info = map.get(row.id);
          if (info) {
            row.name = info.title || "";
            row.artist = info.artist || "";
          }
        }
      } catch (err) {
        console.warn("[stats] reaction title lookup:", err.message);
      }
    }
    res.json({
      windowHours: STATS_WINDOW_HOURS,
      karaoke,
      reacted,
      topLiked,
      partyMusic,
      mostHated,
      tonight: {
        ...tonight,
        topRequesters: topRequesters(events, sinceTonight),
        dedications: listDedications(sinceTonight, 40),
      },
      allTime: {
        ...allTime,
        topRequesters: topRequesters(events, 0),
        dedications: listDedications(0, 40),
      },
    });
  } catch (err) {
    console.error("[stats]", err.message);
    res.status(500).json({ error: err.message || "Could not load stats." });
  }
});

const reactionLimit = softRateLimit({
  windowMs: 1500,
  max: 8,
  message: "Easy on the reactions — try again in a moment.",
});

// Now Playing reactions (mood = one per guest; mic = karaoke, separate).
app.get("/api/reactions", (req, res) => {
  const id =
    typeof req.query?.id === "string"
      ? req.query.id
      : typeof req.query?.trackId === "string"
        ? req.query.trackId
        : "";
  const guestId =
    typeof req.query?.guestId === "string"
      ? req.query.guestId
      : typeof req.query?.guest === "string"
        ? req.query.guest
        : "";
  res.json(getReactions(id, guestId));
});

app.post("/api/reactions", reactionLimit, (req, res) => {
  const id =
    typeof req.body?.id === "string"
      ? req.body.id
      : typeof req.body?.trackId === "string"
        ? req.body.trackId
        : "";
  const kind = req.body?.kind;
  const guestId = req.body?.guestId ?? req.body?.guest;
  const result = setReaction(id, kind, guestId, {
    name: req.body?.name,
    artist: req.body?.artist,
    by: req.body?.by ?? req.body?.requestedBy,
  });
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

// Forget the recently-played history so the picker starts fresh.
app.post("/api/settings/clear-history", requireHost, (_req, res) => {
  try {
    clearHistory();
    res.json({ ok: true });
  } catch (err) {
    console.error("[settings/clear-history]", err.message);
    res.status(500).json({ error: err.message || "Could not clear history." });
  }
});

// Forget all guest request stats (top songs/artists/requesters, dedications).
// DJ shout memory is separate — use /api/settings/clear-dj-memory.
app.post("/api/settings/clear-stats", requireHost, (_req, res) => {
  try {
    clearRequests();
    res.json({ ok: true });
  } catch (err) {
    console.error("[settings/clear-stats]", err.message);
    res.status(500).json({ error: err.message || "Could not clear stats." });
  }
});

// Forget DJ night memory only (first-shout + birthday-once + used blurbs).
app.post("/api/settings/clear-dj-memory", requireHost, (_req, res) => {
  try {
    clearDjNightMemory();
    res.json({ ok: true });
  } catch (err) {
    console.error("[settings/clear-dj-memory]", err.message);
    res.status(500).json({ error: err.message || "Could not clear DJ memory." });
  }
});

// Forget Now Playing mood reactions (keeps Karaoke mic list).
app.post("/api/settings/clear-reactions", requireHost, (_req, res) => {
  try {
    clearMoodReactions();
    res.json({ ok: true });
  } catch (err) {
    console.error("[settings/clear-reactions]", err.message);
    res.status(500).json({
      error: err.message || "Could not clear reactions.",
    });
  }
});

// Forget Karaoke mic tags only (keeps mood reactions).
app.post("/api/settings/clear-karaoke", requireHost, (_req, res) => {
  try {
    clearKaraokeReactions();
    res.json({ ok: true });
  } catch (err) {
    console.error("[settings/clear-karaoke]", err.message);
    res.status(500).json({
      error: err.message || "Could not clear Karaoke list.",
    });
  }
});

// ---- Suggestion box --------------------------------------------------------
const SUGGEST_COOLDOWN_MS = 30_000;
const suggestLastByIp = new Map(); // ip -> last submit ts

function suggestClientKey(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

app.get("/api/suggestions", (_req, res) => {
  try {
    const includeDone = String(_req.query.includeDone || "1") !== "0";
    res.json({
      suggestions: getSuggestions({ includeDone }),
      counts: suggestionCounts(),
      textMax: SUGGESTION_TEXT_MAX,
    });
  } catch (err) {
    console.error("[suggestions]", err.message);
    res.status(500).json({ error: err.message || "Could not load suggestions." });
  }
});

app.post("/api/suggestions", (req, res) => {
  try {
    const key = suggestClientKey(req);
    const now = Date.now();
    const last = suggestLastByIp.get(key) || 0;
    if (now - last < SUGGEST_COOLDOWN_MS) {
      return res.status(429).json({
        error: "Please wait a few seconds before sending another suggestion.",
        retryMs: SUGGEST_COOLDOWN_MS - (now - last),
      });
    }
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const { user } = resolveGuestIdentity({
      requestedBy: req.body?.requestedBy,
      requestedByUser: req.body?.requestedByUser,
    });
    if (!user) {
      return res.status(400).json({ error: "Enter your name before sending a suggestion." });
    }
    // Suggestions are host-facing — stamp the stable User, not the queue alias.
    const row = addSuggestion({ text, requestedBy: user });
    if (!row) {
      return res.status(400).json({
        error: `Suggestion must be at least 3 characters (max ${SUGGESTION_TEXT_MAX}).`,
      });
    }
    suggestLastByIp.set(key, now);
    res.json({ ok: true, suggestion: row, counts: suggestionCounts() });
  } catch (err) {
    console.error("[suggestions/add]", err.message);
    res.status(500).json({ error: err.message || "Could not save suggestion." });
  }
});

app.post("/api/suggestions/:id/done", requireHost, (req, res) => {
  try {
    const done = req.body?.done !== false && req.body?.done !== "false";
    const row = setSuggestionDone(req.params.id, !!done);
    if (!row) return res.status(404).json({ error: "Suggestion not found." });
    res.json({ ok: true, suggestion: row, counts: suggestionCounts() });
  } catch (err) {
    console.error("[suggestions/done]", err.message);
    res.status(500).json({ error: err.message || "Could not update suggestion." });
  }
});

app.post("/api/settings/clear-suggestions", requireHost, (_req, res) => {
  try {
    clearSuggestions();
    res.json({ ok: true });
  } catch (err) {
    console.error("[settings/clear-suggestions]", err.message);
    res.status(500).json({ error: err.message || "Could not clear suggestions." });
  }
});

// ---- Host PIN gate ---------------------------------------------------------
// Optional SETTINGS_PIN: UI gates DJ Booth; when set, requireHost also protects
// host APIs (settings, credentials, resets, restart, guest admin, uploads).
// Party controls (transport, volume, Random, clear queue, Mix) stay open on the
// LAN. Leave PIN blank and requireHost is a no-op. PIN is never sent to clients.
const PIN_MAX_FAILS = 5; // failures before a short lockout kicks in
const PIN_LOCK_MS = 30_000;
const pinAttempts = new Map(); // client key -> { fails, lockUntil }

function pinClientKey(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

// Whether a host PIN is configured (file hash and/or SETTINGS_PIN env).
app.get("/api/settings/pin-required", (_req, res) => {
  res.json(hostPinStatus());
});

// Verify a candidate PIN. Lockout blunts LAN brute force. On success issues a
// host session (HttpOnly cookie + token for X-PartyQueue-Host).
app.post("/api/settings/verify-pin", (req, res) => {
  if (!isHostPinConfigured()) return res.json({ ok: true, token: null });

  const key = pinClientKey(req);
  const now = Date.now();
  const rec = pinAttempts.get(key) || { fails: 0, lockUntil: 0 };

  if (rec.lockUntil > now) {
    return res
      .status(429)
      .json({ ok: false, error: "Too many attempts.", retryMs: rec.lockUntil - now });
  }

  const candidate = typeof req.body?.pin === "string" ? req.body.pin : "";
  if (candidate && verifyHostPin(candidate)) {
    pinAttempts.delete(key);
    const token = createHostSession();
    setHostSessionCookie(res, token);
    return res.json({ ok: true, token });
  }

  rec.fails += 1;
  if (rec.fails >= PIN_MAX_FAILS) {
    rec.lockUntil = now + PIN_LOCK_MS;
    rec.fails = 0;
  }
  pinAttempts.set(key, rec);
  return res.status(401).json({ ok: false, error: "Incorrect PIN." });
});

// Set or change host PIN (stored hashed in data/host-pin.json).
// First-time set: open on LAN. Change: current PIN or valid host session.
app.post("/api/settings/pin", (req, res) => {
  const nextPin = typeof req.body?.pin === "string" ? req.body.pin : "";
  const currentPin =
    typeof req.body?.currentPin === "string" ? req.body.currentPin : "";

  if (isHostPinConfigured()) {
    const token = extractHostToken(req);
    const sessionOk = isValidHostToken(token);
    const currentOk = currentPin && verifyHostPin(currentPin);
    if (!sessionOk && !currentOk) {
      return res.status(401).json({
        ok: false,
        error: "Enter your current PIN to change it.",
        pinRequired: true,
      });
    }
  }

  const result = setHostPin(nextPin);
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error });
  }
  // Prefer the hashed file PIN — drop plain SETTINGS_PIN from .env if present.
  try {
    upsertEnvKeys({ SETTINGS_PIN: null });
    delete process.env.SETTINGS_PIN;
  } catch (err) {
    console.warn("[settings/pin] could not clear SETTINGS_PIN from .env:", err.message);
  }
  const token = createHostSession();
  setHostSessionCookie(res, token);
  res.json({ ok: true, ...hostPinStatus(), token });
});

// Clear file-based PIN. Env SETTINGS_PIN must be removed from .env separately.
app.delete("/api/settings/pin", (req, res) => {
  if (!isHostPinConfigured()) {
    return res.json({ ok: true, ...hostPinStatus() });
  }
  const token = extractHostToken(req);
  const sessionOk = isValidHostToken(token);
  const currentPin =
    typeof req.body?.currentPin === "string" ? req.body.currentPin : "";
  const currentOk = currentPin && verifyHostPin(currentPin);
  if (!sessionOk && !currentOk) {
    return res.status(401).json({
      ok: false,
      error: "Unlock with your PIN first, or send currentPin.",
      pinRequired: true,
    });
  }
  const result = clearHostPin();
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error, ...hostPinStatus() });
  }
  clearHostSessionCookie(res);
  res.json({ ok: true, ...hostPinStatus() });
});

app.get("/api/nowplaying", async (_req, res) => {
  try {
    // Piggyback the Never-Ending state (keeps every guest's toggle in sync) and
    // the last-call timestamp (lets every guest announce "Closing Time" once).
    const np = await getNowPlaying();
    const trackId = spotifyTrackId(np?.uri);
    res.json({
      ...np,
      neverEnding: getAutoFillState().enabled,
      requestsPaused: getContentSettings().requestsPaused,
      closingTimeAt: getClosingTimeAt(),
      partyRecap: getLastPartyRecap(),
      reactions: trackId ? getReactions(trackId) : getReactions(""),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Combined poll: now-playing + queue in one request per phone.
app.get("/api/state", async (_req, res) => {
  try {
    const [np, tracks] = await Promise.all([getNowPlaying(), getQueueList()]);
    const trackId = spotifyTrackId(np?.uri);
    res.json({
      ...np,
      neverEnding: getAutoFillState().enabled,
      requestsPaused: getContentSettings().requestsPaused,
      closingTimeAt: getClosingTimeAt(),
      partyRecap: getLastPartyRecap(),
      reactions: trackId ? getReactions(trackId) : getReactions(""),
      tracks,
    });
  } catch (err) {
    res.status(502).json({ error: err.message || "Could not load party state." });
  }
});

// Join Code: public LAN URL + QR SVG so guests can scan into the queue app.
app.get("/api/join", async (_req, res) => {
  try {
    const url = getPublicBaseUrl();
    const qrSvg = await QRCode.toString(url, {
      type: "svg",
      margin: 1,
      width: 280,
      errorCorrectionLevel: "M",
    });
    res.json({ url, qrSvg });
  } catch (err) {
    console.error("[join]", err.message);
    res.status(503).json({
      error:
        err.message ||
        "Could not build join URL. Set PUBLIC_BASE_URL=http://<this-pc-ip>:8088",
    });
  }
});

// Booth status: resolved Sonos-reachable base URL (silence bridge + Join).
app.get("/api/media-base", (_req, res) => {
  try {
    res.json({ url: getPublicBaseUrl() });
  } catch (err) {
    res.status(503).json({
      error:
        err.message ||
        "Could not resolve media URL. Set PUBLIC_BASE_URL=http://<this-host-ip>:8088",
    });
  }
});

// Host-editable guest notes for DJ shout-outs (Settings → Users).
app.get("/api/guests", requireHost, (_req, res) => {
  res.json({ guests: listGuestProfiles() });
});

app.post("/api/guests", requireHost, (req, res) => {
  const name = req.body?.name;
  const hasBirthday =
    Object.prototype.hasOwnProperty.call(req.body ?? {}, "birthday") ||
    Object.prototype.hasOwnProperty.call(req.body ?? {}, "birthdayRole");
  const note =
    req.body?.note ?? (typeof req.body?.notes === "string" ? req.body.notes : null);

  // Birthday-only update (no new note required).
  if (hasBirthday && (note == null || String(note).trim() === "")) {
    const saved = setGuestBirthday(name, req.body?.birthday, req.body?.birthdayRole);
    if (!saved) {
      return res.status(400).json({ error: "Enter a guest name." });
    }
    return res.json({ ok: true, guest: saved, guests: listGuestProfiles() });
  }

  const saved = addGuestNote(name, note);
  if (!saved) {
    return res
      .status(400)
      .json({ error: "Enter a guest name and a short note." });
  }
  // Optional birthday fields can ride along with a new note.
  if (hasBirthday) {
    setGuestBirthday(name, req.body?.birthday, req.body?.birthdayRole);
  }
  if (saved.full) {
    return res.status(400).json({
      error: "That user already has the maximum number of notes.",
      guest: saved,
      guests: listGuestProfiles(),
    });
  }
  res.json({ ok: true, guest: saved, guests: listGuestProfiles() });
});

app.delete("/api/guests/:name/notes/:index", requireHost, (req, res) => {
  const removed = removeGuestNote(
    decodeURIComponent(req.params.name || ""),
    req.params.index
  );
  if (!removed) {
    return res.status(404).json({ error: "Note not found." });
  }
  res.json({ ok: true, guest: removed, guests: listGuestProfiles() });
});

app.delete("/api/guests/:name", requireHost, (req, res) => {
  const ok = deleteGuestProfile(decodeURIComponent(req.params.name || ""));
  if (!ok) {
    return res.status(404).json({ error: "Guest not found." });
  }
  res.json({ ok: true, guests: listGuestProfiles() });
});

// Rename a Users profile (and rewrite that name inside guest notes).
app.post("/api/guests/rename", requireHost, (req, res) => {
  const from = req.body?.from ?? req.body?.name;
  const to = req.body?.to ?? req.body?.newName;
  const result = renameGuestProfile(from, to);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  res.json({ ok: true, guest: result.guest, guests: listGuestProfiles() });
});

// Reset tonight's birthday / first-shout flags for one guest (keeps blurbs).
app.post("/api/guests/:name/forget-birthday-shout", requireHost, (req, res) => {
  const name = decodeURIComponent(req.params.name || "");
  const ok = forgetBirthdayShout(name);
  if (!ok) {
    return res.status(400).json({ error: "Enter a guest name." });
  }
  res.json({ ok: true, name: sanitizeDisplayName(name), guests: listGuestProfiles() });
});

// Lyrics via LRClib (title/artist/album/duration). Cached server-side so guest
// phones share one lookup per track.
app.get("/api/lyrics", async (req, res) => {
  const title = String(req.query.title || "").trim();
  const artist = String(req.query.artist || "").trim();
  if (!title || !artist) {
    return res.status(400).json({ error: "Missing title or artist." });
  }
  const album = String(req.query.album || "").trim();
  const durationRaw = req.query.duration;
  const duration =
    durationRaw != null && String(durationRaw).trim() !== ""
      ? Number(durationRaw)
      : null;
  try {
    res.json(
      await lookupLyrics({
        title,
        artist,
        album,
        duration: Number.isFinite(duration) ? duration : null,
      })
    );
  } catch (err) {
    console.error("[lyrics]", err.message);
    res.status(502).json({ error: err.message || "Could not fetch lyrics." });
  }
});

app.get("/api/queue/list", async (_req, res) => {
  try {
    res.json({ tracks: await getQueueList() });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/queue/remove", destructiveLimit, async (req, res) => {
  const { uri, position } = req.body ?? {};
  if (!uri) return res.status(400).json({ error: "Missing track uri." });
  try {
    res.json({ ok: true, ...(await removeQueueTrack({ uri, position })) });
  } catch (err) {
    console.error("[queue/remove]", err.message);
    res.status(502).json({ error: err.message || "Could not remove the song." });
  }
});

app.post("/api/queue/reorder", destructiveLimit, async (req, res) => {
  const { uri, fromPosition, beforeUri, beforePosition } = req.body ?? {};
  if (!uri) return res.status(400).json({ error: "Missing track uri." });
  try {
    res.json({
      ok: true,
      ...(await reorderQueueTrack({ uri, fromPosition, beforeUri, beforePosition })),
    });
  } catch (err) {
    console.error("[queue/reorder]", err.message);
    res.status(502).json({ error: err.message || "Could not move the song." });
  }
});

// Proxy album art from the Sonos speakers (port 1400) to avoid exposing
// speaker IPs to clients and to work across subnets.
// Small in-memory cache of album-art bytes, keyed by the upstream URL. Art is
// immutable per URL, so once one client (or a poll) fetches a track's cover we
// serve it instantly to everyone and stop re-hitting the (slow) Sonos speaker.
// Capped so it can't grow without bound (~a few MB at most).
const artCache = new Map();
const ART_CACHE_MAX = 80;

/** Pull a Spotify track id out of a (possibly multi-encoded) Sonos getaa URL. */
function trackIdFromArtUrl(u) {
  let s = String(u || "");
  for (let i = 0; i < 4; i++) {
    const id = spotifyTrackId(s);
    if (id) return id;
    try {
      const next = decodeURIComponent(s);
      if (next === s) break;
      s = next;
    } catch {
      break;
    }
  }
  return null;
}

function sendCachedArt(res, key, hit) {
  artCache.delete(key);
  artCache.set(key, hit);
  res.set("Content-Type", hit.type);
  res.set("Cache-Control", "public, max-age=86400, immutable");
  return res.send(hit.body);
}

function putArtCache(key, hit) {
  artCache.set(key, hit);
  if (artCache.size > ART_CACHE_MAX) {
    artCache.delete(artCache.keys().next().value);
  }
}

/** Fetch + cache album art bytes from a Spotify CDN image URL. */
async function fetchSpotifyArtBytes(trackId) {
  if (!trackId) return null;
  const info = (await getTracksByIds([trackId])).get(trackId);
  const imageUrl = info?.image;
  if (!imageUrl) return null;
  const upstream = await fetch(imageUrl, {
    signal: AbortSignal.timeout(5000),
  });
  if (!upstream.ok) return null;
  const type = upstream.headers.get("content-type") || "image/jpeg";
  const body = Buffer.from(await upstream.arrayBuffer());
  if (!body.length) return null;
  return { body, type };
}

app.get("/api/albumart", async (req, res) => {
  const u = req.query.u;
  if (!u) return res.status(400).end();
  const key = String(u);

  const hit = artCache.get(key);
  if (hit) return sendCachedArt(res, key, hit);

  // Sonos /getaa often hangs when Spotify art is slow/unavailable on the
  // speaker. Prefer Spotify CDN when we can parse a track id from the URL.
  const trackId = trackIdFromArtUrl(key);
  if (trackId) {
    try {
      const art = await fetchSpotifyArtBytes(trackId);
      if (art) {
        putArtCache(key, art);
        return sendCachedArt(res, key, art);
      }
    } catch (err) {
      console.warn("[albumart] Spotify fallback failed:", err.message);
    }
  }

  try {
    const target = new URL(key);
    const allowed =
      target.port === "1400" && (await isKnownSonosHost(target.hostname));
    if (!allowed) return res.status(403).end();

    // Keep Sonos short — a hung getaa used to blank every cover for 5s+.
    const upstream = await fetch(target.toString(), {
      signal: AbortSignal.timeout(2500),
    });
    if (!upstream.ok) return res.status(502).end();

    const type = upstream.headers.get("content-type") || "image/jpeg";
    const body = Buffer.from(await upstream.arrayBuffer());
    const art = { body, type };
    putArtCache(key, art);
    return sendCachedArt(res, key, art);
  } catch {
    res.status(502).end();
  }
});

// Transport / volume / clear / random are open to the party (Controls is not
// PIN-gated). Rate limits still blunt spam; Clear Queue keeps a double confirm in the UI.
app.post("/api/play", transportLimit, async (_req, res) => {
  try {
    res.json({ ok: true, ...(await play()) });
  } catch (err) {
    console.error("[play]", err.message);
    res.status(502).json({ error: err.message || "Could not start playback." });
  }
});

app.post("/api/pause", transportLimit, async (_req, res) => {
  try {
    res.json({ ok: true, ...(await pause()) });
  } catch (err) {
    console.error("[pause]", err.message);
    res.status(502).json({ error: err.message || "Could not pause playback." });
  }
});

app.post("/api/next", transportLimit, async (_req, res) => {
  try {
    const result = await next();
    // Never-Ending can lag behind rapid skips; re-check queue depth soon.
    nudgeAutoFill();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[next]", err.message);
    res.status(502).json({ error: err.message || "Could not skip track." });
  }
});

app.post("/api/previous", transportLimit, async (_req, res) => {
  try {
    res.json({ ok: true, ...(await previous()) });
  } catch (err) {
    console.error("[previous]", err.message);
    res.status(502).json({ error: err.message || "Could not go to previous track." });
  }
});

app.post("/api/mute", transportLimit, async (_req, res) => {
  try {
    res.json({ ok: true, ...(await toggleMute()) });
  } catch (err) {
    console.error("[mute]", err.message);
    res.status(502).json({ error: err.message || "Could not toggle mute." });
  }
});

app.post("/api/shuffle", transportLimit, async (_req, res) => {
  try {
    res.json({ ok: true, ...(await toggleShuffle()) });
  } catch (err) {
    console.error("[shuffle]", err.message);
    res.status(502).json({ error: err.message || "Could not toggle shuffle." });
  }
});

// Clamp an optional ?step to a sane whole number (1..100), defaulting to 1.
function parseStep(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(100, n);
}

app.post("/api/volume/up", transportLimit, async (req, res) => {
  try {
    res.json({ ok: true, ...(await volumeUp(parseStep(req.query.step))) });
  } catch (err) {
    console.error("[volume/up]", err.message);
    res.status(502).json({ error: err.message || "Could not change volume." });
  }
});

app.post("/api/volume/down", transportLimit, async (req, res) => {
  try {
    res.json({ ok: true, ...(await volumeDown(parseStep(req.query.step))) });
  } catch (err) {
    console.error("[volume/down]", err.message);
    res.status(502).json({ error: err.message || "Could not change volume." });
  }
});

// Read current target-group volume (max across members) — used for DJ boost monitoring.
app.get("/api/volume", async (_req, res) => {
  try {
    const volume = await getGroupVolume();
    res.json({ ok: true, volume });
  } catch (err) {
    console.error("[volume]", err.message);
    res.status(502).json({ error: err.message || "Could not read volume." });
  }
});

app.post("/api/group-all", destructiveLimit, async (_req, res) => {
  try {
    res.json({ ok: true, ...(await groupAll()) });
  } catch (err) {
    console.error("[group-all]", err.message);
    res.status(502).json({ error: err.message || "Could not group speakers." });
  }
});

app.post("/api/groups/join", destructiveLimit, async (req, res) => {
  try {
    const room = req.body?.room;
    res.json({ ok: true, ...(await joinSpeakerToTarget(room)) });
  } catch (err) {
    console.error("[groups/join]", err.message);
    res.status(400).json({ error: err.message || "Could not join speaker." });
  }
});

app.post("/api/groups/leave", destructiveLimit, async (req, res) => {
  try {
    const room = req.body?.room;
    res.json({ ok: true, ...(await leaveSpeakerGroup(room)) });
  } catch (err) {
    console.error("[groups/leave]", err.message);
    res.status(400).json({ error: err.message || "Could not ungroup speaker." });
  }
});

app.post("/api/groups/ungroup-all", destructiveLimit, async (_req, res) => {
  try {
    res.json({ ok: true, ...(await ungroupAll()) });
  } catch (err) {
    console.error("[groups/ungroup-all]", err.message);
    res.status(502).json({ error: err.message || "Could not ungroup speakers." });
  }
});

app.post("/api/queue/clear", destructiveLimit, async (_req, res) => {
  try {
    const result = await clearQueue();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[clear]", err.message);
    res.status(502).json({ error: err.message || "Could not clear the Sonos queue." });
  }
});

// ---- Spotify account connection (one-time host login) ----
// Pending OAuth states for CSRF protection, with a short TTL.
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60_000;

app.get("/api/auth/status", (_req, res) => {
  res.json({ connected: isUserConnected() });
});

app.get("/auth/login", requireHostPage, (_req, res) => {
  const state = crypto.randomUUID();
  pendingStates.set(state, Date.now());
  res.redirect(getAuthorizeUrl(state));
});

app.get("/auth/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.status(400).send(`Spotify authorization failed: ${error}`);
  }
  const issuedAt = state && pendingStates.get(String(state));
  if (!issuedAt || Date.now() - issuedAt > STATE_TTL_MS) {
    return res.status(400).send("Invalid or expired login state. Try again.");
  }
  pendingStates.delete(String(state));

  try {
    await exchangeCodeForTokens(String(code));
    res.send(
      "<!doctype html><meta charset='utf-8'><title>Connected</title>" +
        "<body style='font-family:sans-serif;background:#0f0f17;color:#f5f5fa;" +
        "display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>" +
        "<div style='text-align:center'><h1>Spotify connected ✅</h1>" +
        "<p>You can close this tab and return to PartyQueue.</p></div></body>"
    );
  } catch (err) {
    console.error("[auth/callback]", err.message);
    res.status(502).send(`Could not connect Spotify: ${err.message}`);
  }
});

app.get("/api/playlists", async (_req, res) => {
  if (!isUserConnected()) {
    return res.status(200).json({ connected: false, playlists: [] });
  }
  try {
    const playlists = await getPlaylists();
    res.json({ connected: true, playlists });
  } catch (err) {
    console.error("[playlists]", err.message);
    res.status(502).json({ error: err.message || "Could not load playlists." });
  }
});

// Lightweight Spotify status for the Settings indicator. Reads only local state
// (no Spotify calls), so it's safe to poll even during a rate-limit cooldown.
app.get("/api/spotify/status", (_req, res) => {
  const cooldownMs = spotifyCooldownMs();
  res.json({
    connected: isUserConnected(),
    rateLimited: cooldownMs > 0,
    cooldownMs,
    cooldownSeconds: Math.ceil(cooldownMs / 1000),
    poolWarmedAt: getPoolWarmedAt(),
  });
});

// Spotify Developer app credentials. Status never includes the client secret;
// POST saves to data/spotify-app.json (env can override).
app.get("/api/spotify/app/status", requireHost, (_req, res) => {
  res.json(getSpotifyAppStatus());
});

app.post("/api/spotify/app", requireHost, (req, res) => {
  try {
    const body = req.body ?? {};
    const status = setSpotifyAppSettings({
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      redirectUri: body.redirectUri,
      market: body.market,
      clearSecret: !!body.clearSecret,
    });
    res.json({ ok: true, ...status });
  } catch (err) {
    console.error("[spotify/app]", err.message);
    res.status(400).json({ error: err.message || "Could not save Spotify app settings." });
  }
});

app.post("/api/spotify/app/clear", requireHost, (_req, res) => {
  res.json({ ok: true, ...clearSpotifyAppSettings() });
});

app.post("/api/spotify/app/test", requireHost, async (_req, res) => {
  try {
    const result = await testSpotifyAppConnection();
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error("[spotify/app/test]", err.message);
    res.status(502).json({ ok: false, error: err.message || "Could not reach Spotify." });
  }
});

// Sonos speaker IP + room (Settings → Connections). Helps when SSDP discovery
// fails across VLANs/VPNs. Saves to data/sonos.json + .env.
app.get("/api/sonos/connection", requireHost, (_req, res) => {
  res.json(getSonosConnectionStatus());
});

app.post("/api/sonos/connection", requireHost, (req, res) => {
  try {
    const body = req.body ?? {};
    const status = setSonosConnectionSettings({
      host: body.host,
      room: body.room,
      region: body.region,
      clearHost: !!body.clearHost,
      clearRoom: !!body.clearRoom,
    });
    // Keep the in-app Sonos Group picker aligned with the Connections room.
    if (body.room !== undefined) {
      setSonosTargetRoom(status.room || null);
    }
    resetSonosManager();
    res.json({ ok: true, ...status });
  } catch (err) {
    console.error("[sonos/connection]", err.message);
    res.status(400).json({ error: err.message || "Could not save Sonos settings." });
  }
});

app.post("/api/sonos/connection/clear", requireHost, (_req, res) => {
  const status = clearSonosConnectionSettings();
  setSonosTargetRoom(null);
  resetSonosManager();
  res.json({ ok: true, ...status });
});

app.post("/api/sonos/connection/test", requireHost, async (_req, res) => {
  try {
    const result = await testSonosConnection();
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error("[sonos/connection/test]", err.message);
    res
      .status(502)
      .json({ ok: false, error: err.message || "Could not reach Sonos." });
  }
});

// Last.fm API key for genre tagging + Discover Similar. Status never includes
// the key; POST saves to data/lastfm.json (env can override).
app.get("/api/lastfm/status", requireHost, (_req, res) => {
  res.json(getLastfmStatus());
});

app.post("/api/lastfm", requireHost, (req, res) => {
  try {
    const body = req.body ?? {};
    const status = setLastfmSettings({
      apiKey: body.apiKey,
      clearKey: !!body.clearKey,
    });
    res.json({ ok: true, ...status });
  } catch (err) {
    console.error("[lastfm]", err.message);
    res.status(400).json({ error: err.message || "Could not save Last.fm settings." });
  }
});

app.post("/api/lastfm/clear", requireHost, (_req, res) => {
  res.json({ ok: true, ...clearLastfmSettings() });
});

app.post("/api/lastfm/test", requireHost, async (_req, res) => {
  try {
    const result = await testLastfmConnection();
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error("[lastfm/test]", err.message);
    res.status(502).json({ ok: false, error: err.message || "Could not reach Last.fm." });
  }
});

// Home Assistant credentials for DJ voice announcements. Status never includes
// the token; POST saves URL/token to data/home-assistant.json (env can override).
app.get("/api/homeassistant/status", requireHost, (_req, res) => {
  res.json(getHaStatus());
});

app.post("/api/homeassistant", requireHost, (req, res) => {
  try {
    const body = req.body ?? {};
    const status = setHaSettings({
      url: body.url,
      token: body.token,
      clearToken: !!body.clearToken,
    });
    res.json({ ok: true, ...status });
  } catch (err) {
    console.error("[homeassistant]", err.message);
    res.status(400).json({ error: err.message || "Could not save Home Assistant settings." });
  }
});

app.post("/api/homeassistant/clear", requireHost, (_req, res) => {
  res.json({ ok: true, ...clearHaSettings() });
});

app.post("/api/homeassistant/test", requireHost, async (_req, res) => {
  try {
    const result = await testHaConnection();
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error("[homeassistant/test]", err.message);
    res.status(502).json({ ok: false, error: err.message || "Could not reach Home Assistant." });
  }
});

// Host-triggered re-warm of the cached playlist list + track pool + genre tags.
// Use this after adding/removing playlists rather than refetching on every load.
app.post("/api/cache/refresh", requireHost, async (_req, res) => {
  if (!isUserConnected()) {
    return res.status(400).json({ error: "Connect your Spotify account first." });
  }
  try {
    const summary = await rewarmCaches();
    // Refresh Last.fm genre tags from the freshly-built pool (best effort).
    warmGenresFromPool().catch((err) =>
      console.error("[cache/refresh] genre warm failed:", err.message)
    );
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error("[cache/refresh]", err.message);
    const cooldown = Math.ceil(spotifyCooldownMs() / 1000);
    res.status(502).json({
      error: cooldown
        ? `Spotify is rate-limited. Try again in about ${cooldown}s.`
        : err.message || "Could not refresh the cache.",
    });
  }
});

const SHUTDOWN_TIMEOUT_MS = 5_000;
let httpServer = null;
let shuttingDown = false;

function flushShutdownStores() {
  for (const [name, flush] of [
    ["history", flushHistoryPersist],
    ["genres", flushGenrePersist],
  ]) {
    try {
      flush();
    } catch (err) {
      console.error(`[shutdown] ${name} flush failed:`, err.message);
    }
  }
}

async function shutdownAndExit(reason, { restart = false } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${reason}`);

  const forceExit = setTimeout(() => {
    console.error("[shutdown] timed out; forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  stopGenreWarm();
  const pendingShutdown = [
    stopAutoFillMonitor(),
    stopQueueMaintenance(),
  ];

  if (httpServer?.listening) {
    pendingShutdown.push(
      new Promise((resolve) => {
        httpServer.close((err) => {
          if (err) console.error("[shutdown] server close failed:", err.message);
          resolve();
        });
        httpServer.closeIdleConnections?.();
      })
    );
  }

  await Promise.allSettled(pendingShutdown);
  flushShutdownStores();

  if (restart) {
    try {
      const inDocker = fs.existsSync("/.dockerenv");
      if (!inDocker) {
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "ignore",
          cwd: process.cwd(),
          env: process.env,
          windowsHide: true,
        });
        child.unref();
        console.log(`[restart] spawned pid ${child.pid}`);
      } else {
        console.log("[restart] exiting for Docker restart policy");
      }
    } catch (err) {
      console.error("[restart] spawn failed:", err.message);
    }
  }

  clearTimeout(forceExit);
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    void shutdownAndExit(signal);
  });
}

// Host restart from Options. Docker (restart: unless-stopped) just exits;
// bare Windows/macOS respawns the same node argv after a clean shutdown.
app.post("/api/restart", requireHost, destructiveLimit, (_req, res) => {
  res.json({ ok: true, restarting: true });
  setTimeout(() => {
    void shutdownAndExit("host restart", { restart: true });
  }, 400);
});

httpServer = app.listen(PORT, () => {
  console.log(`PartyQueue running on http://0.0.0.0:${PORT}`);
  // Seed bundled DJ icons + hero banners into data/ (add missing only).
  seedStarterDjIcons();
  seedStarterBanners();
  import("./dj-voice.js")
    .then(({ getPublicBaseUrl, ensureSilenceBridge, ensureSilenceRamp }) => {
      console.log(`[dj-voice] Sonos media base ${getPublicBaseUrl()}`);
      try {
        const bridge = ensureSilenceBridge();
        const ramp = ensureSilenceRamp();
        console.log(`[dj-voice] silence restore ready → ${bridge.publicUrl}`);
        console.log(`[dj-voice] silence ramp ready → ${ramp.publicUrl}`);
      } catch (err) {
        console.warn(`[dj-voice] silence pads not ready: ${err.message}`);
      }
    })
    .catch((err) => {
      console.warn(`[dj-voice] PUBLIC_BASE_URL not ready: ${err.message}`);
    });
  // Warm the random-songs pool in the background so the first click is instant,
  // then warm Last.fm genre tags for every artist in that pool.
  warmTrackPool().then(() => warmGenresFromPool());
  // Resume the never-ending-queue monitor if it was left on.
  initAutoFill();
  // Keep the queue lean by trimming already-played songs as the night goes.
  initQueueMaintenance();
});
