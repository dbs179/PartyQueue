import { createLogger } from "./logger.js";
import { admitSseClient } from "./http/sse-limits.js";
import { createNowPlayingMonitor } from "./now-playing-stream.js";
import { dominantBucket, getGenreFlowState } from "./genre-flow.js";
import { bucketsForArtistSync, GENRE_BUCKETS } from "./genres.js";
import { getReactions } from "./reactions.js";
import { noteReactionPlayTrack } from "./reaction-play.js";
import { originSnapshot } from "./queue-origin.js";
import { spotifyTrackId } from "./sampler.js";
import {
  createNowPlayingTransitionTracker,
  TRANSITION_CONFIRM_MS,
} from "./now-playing-transition.js";
import {
  getNowPlaying,
  getNowPlayingFresh,
  getQueueList,
  onSonosSnapshotsInvalidated,
} from "./sonos.js";

const GENRE_LABEL_BY_ID = new Map(GENRE_BUCKETS.map((b) => [b.id, b.label]));

function labelForLane(lane) {
  if (!lane) return null;
  return GENRE_LABEL_BY_ID.get(lane) || String(lane);
}

/**
 * Shape a queue-list row (or equivalent) for resolveDisplayGenre.
 * Used while a DJ announce/silence pad is current so Genre stays on the
 * set the DJ is about to introduce.
 */
export function shapeUpcomingForGenreDisplay(tracks) {
  const next = (Array.isArray(tracks) ? tracks : []).find(
    (t) => t && !t.djVoice && t.uri && (t.title || t.artist)
  );
  if (!next) return null;
  const id = spotifyTrackId(next.uri);
  const meta = id ? originSnapshot().get(id) : null;
  const source =
    meta?.source ||
    (next.searched
      ? "searched"
      : next.discovered
        ? "discovered"
        : next.moodPick
          ? "mood"
          : typeof next.origin === "string"
            ? next.origin
            : null);
  return {
    uri: next.uri,
    title: next.title || null,
    artist: next.artist || null,
    origin: source,
    genreLane: meta?.genreLane || next.genreLane || null,
  };
}

/**
 * First non-DJ upcoming queue track via the coalesced queue snapshot.
 * Prefer an attached `upcomingForGenre` from getNowPlaying (silence pads
 * already fetched GetQueue for the companion TTS URI).
 */
export async function upcomingTrackForGenreDisplay() {
  try {
    return shapeUpcomingForGenreDisplay(await getQueueList());
  } catch {
    return null;
  }
}

/**
 * What the Now Playing "Genre:" header should show for this track.
 * - Playlist filler / era mood → that track's set lane (enqueue lane, else latest)
 * - Songs Like (discovered) → artist's strongest mapped genre when known, so an
 *   off-lane Discover (Bieber in a metal set) does not inherit the set label;
 *   falls back to set lane only when the artist has no buckets
 * - Guest requests → that artist's mapped genre
 * - DJ announce / silence → upcoming song's genre (what the DJ is introducing)
 * - Idle / unknown → hidden (do not keep a stale set lane)
 */
export function resolveDisplayGenre(
  np,
  {
    setLane = null,
    bucketsFor = bucketsForArtistSync,
    upcomingForGenre = null,
  } = {}
) {
  if (!np) {
    return { mixGenreLane: null, mixGenreLabel: null };
  }
  // While the DJ (or silence pad) is up, show the next song's set lane —
  // not blank, and not the previous track.
  if (np.djVoice || np.djSilence) {
    if (upcomingForGenre) {
      const fromNext = resolveDisplayGenre(upcomingForGenre, {
        setLane,
        bucketsFor,
      });
      if (fromNext.mixGenreLane) return fromNext;
    }
    const label = labelForLane(setLane);
    return {
      mixGenreLane: label ? setLane : null,
      mixGenreLabel: label,
    };
  }
  const hasTrack = !!(np.uri && (np.title || np.artist));
  if (!hasTrack) {
    return { mixGenreLane: null, mixGenreLabel: null };
  }

  const origin = typeof np.origin === "string" ? np.origin : null;
  const trackLane =
    typeof np.genreLane === "string" && np.genreLane ? np.genreLane : null;

  // Crowd special sets are not genre-laned.
  if (
    np.reactionSet === "loved" ||
    np.reactionSet === "hated" ||
    np.reactionSet === "requested"
  ) {
    return { mixGenreLane: null, mixGenreLabel: null };
  }

  // Discover: prefer the artist's strongest tag-mapped bucket (array order from
  // tagsToBuckets), not set-lane inheritance or dominantBucket's metal-first bias.
  if (origin === "discovered") {
    const buckets =
      typeof bucketsFor === "function" ? bucketsFor(np.artist) || [] : [];
    const artistLane = buckets.find((b) => b && b !== "other") || null;
    if (artistLane) {
      const label = labelForLane(artistLane);
      return {
        mixGenreLane: label ? artistLane : null,
        mixGenreLabel: label,
      };
    }
    const lane = trackLane || setLane;
    const label = labelForLane(lane);
    return {
      mixGenreLane: label ? lane : null,
      mixGenreLabel: label,
    };
  }

  if (origin === "filler" || origin === "mood") {
    const lane = trackLane || setLane;
    const label = labelForLane(lane);
    return {
      mixGenreLane: label ? lane : null,
      mixGenreLabel: label,
    };
  }
  if (origin === "searched") {
    const buckets =
      typeof bucketsFor === "function" ? bucketsFor(np.artist) || [] : [];
    const lane = dominantBucket(buckets);
    if (!lane || lane === "other") {
      return { mixGenreLane: null, mixGenreLabel: null };
    }
    return { mixGenreLane: lane, mixGenreLabel: labelForLane(lane) };
  }

  // Untracked queue rows (no origin yet) still get an artist-mapped genre.
  // Do not inherit setLane here — that would revive a stale lane on idle.
  const buckets =
    typeof bucketsFor === "function" ? bucketsFor(np.artist) || [] : [];
  const artistLane = dominantBucket(buckets);
  if (artistLane && artistLane !== "other") {
    return {
      mixGenreLane: artistLane,
      mixGenreLabel: labelForLane(artistLane),
    };
  }
  return { mixGenreLane: null, mixGenreLabel: null };
}
export async function enrichNowPlaying(np) {
  const trackId = spotifyTrackId(np?.uri);
  const setLane = getGenreFlowState().lastLane;
  // Silence pads attach upcomingForGenre from the companion GetQueue; reuse it
  // so we do not issue a second queue snapshot on every NP enrich tick.
  let upcomingForGenre = null;
  if (np?.djVoice || np?.djSilence) {
    upcomingForGenre =
      np.upcomingForGenre || (await upcomingTrackForGenreDisplay());
  }
  const { mixGenreLane, mixGenreLabel } = resolveDisplayGenre(np, {
    setLane,
    upcomingForGenre,
  });
  const { upcomingForGenre: _upcomingHint, ...publicNp } = np || {};
  // Party-wide toggles / Vibe selection / Closing Time live on /api/party.
  // NP enrich stays track-scoped: Genre header + reactions for this play.
  const playId = trackId
    ? noteReactionPlayTrack(trackId, Date.now(), np?.positionSec)
    : "";
  return {
    ...publicNp,
    mixGenreLane,
    mixGenreLabel,
    reactionPlayId: playId || undefined,
    reactions: trackId ? getReactions(trackId, "", playId) : getReactions(""),
  };
}

export function addPositionAge(np, sentAt = Date.now()) {
  const observedAt = Number(np?.positionObservedAt);
  if (
    !np ||
    !Number.isFinite(observedAt) ||
    observedAt <= 0 ||
    observedAt > sentAt
  ) {
    return np;
  }
  return {
    ...np,
    positionAgeSec: (sentAt - observedAt) / 1000,
  };
}

const nowPlayingReadCounters = { regular: 0, fresh: 0 };
const transitionTracker = createNowPlayingTransitionTracker();

export async function readNowPlayingPayload({ fresh = false } = {}) {
  nowPlayingReadCounters[fresh ? "fresh" : "regular"] += 1;
  const read = fresh ? getNowPlayingFresh : getNowPlaying;
  return addPositionAge(await enrichNowPlaying(await read()));
}

const nowPlayingStreamClients = new Map();
let monitorFreshReadsPending = 0;
let transitionConfirmTimer = null;

/** Apply shared transition state so HTTP and SSE agree on metadataPending. */
export async function readNowPlayingWithTransition({ fresh = false } = {}) {
  const snapshot = await readNowPlayingPayload({ fresh });
  const previous = nowPlayingMonitor?.latest;
  return transitionTracker.resolve(previous, snapshot);
}

async function readNowPlayingMonitorPayload() {
  const fresh = monitorFreshReadsPending > 0;
  if (fresh) monitorFreshReadsPending -= 1;
  const resolved = await readNowPlayingWithTransition({ fresh });
  if (fresh && !resolved.metadataPending && transitionConfirmTimer) {
    clearTimeout(transitionConfirmTimer);
    transitionConfirmTimer = null;
  }
  return resolved;
}

function writeNowPlayingStreamEvent(res, eventName, payload, id = null) {
  if (res.writableEnded || res.destroyed) return;
  if (id != null) res.write(`id: ${id}\n`);
  if (eventName) res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastNowPlayingStatus(health) {
  for (const res of nowPlayingStreamClients.keys()) {
    writeNowPlayingStreamEvent(res, "sonos-status", health);
  }
}

export const nowPlayingMonitor = createNowPlayingMonitor({
  readSnapshot: readNowPlayingMonitorPayload,
  intervalMs: 1500,
  errorIntervalMs: 3000,
  failureThreshold: 2,
  onStatusChange: broadcastNowPlayingStatus,
  logger: createLogger("now-playing-stream"),
});

/** Re-read after Play / Random settles (HA and Node-RED do not refresh the tab). */
export const NOW_PLAYING_MUTATION_FOLLOWUP_MS = [400, 1600];
let nowPlayingFollowupTimers = [];

function writeNowPlayingChangedEvent() {
  const payload = { at: Date.now() };
  for (const res of nowPlayingStreamClients.keys()) {
    writeNowPlayingStreamEvent(res, "nowplaying-changed", payload);
  }
}

function clearNowPlayingFollowupNudges() {
  for (const timer of nowPlayingFollowupTimers) clearTimeout(timer);
  nowPlayingFollowupTimers = [];
}

function scheduleNowPlayingFollowupNudges() {
  clearNowPlayingFollowupNudges();
  nowPlayingFollowupTimers = NOW_PLAYING_MUTATION_FOLLOWUP_MS.map((ms) => {
    const timer = setTimeout(() => {
      getNowPlaying.bust();
      nowPlayingMonitor.nudge();
    }, ms);
    timer.unref?.();
    return timer;
  });
}

export function broadcastNowPlayingMutation() {
  writeNowPlayingChangedEvent();
  nowPlayingMonitor.nudge();
  scheduleNowPlayingFollowupNudges();
}

const unsubscribeSonosStreamNudge = onSonosSnapshotsInvalidated(() => {
  broadcastNowPlayingMutation();
});

export function nudgeNowPlayingStream() {
  nowPlayingMonitor.nudge();
}

/**
 * Host next/previous: record the pre-command identity and schedule bounded
 * fresh reads. Does not mark metadataPending until Sonos advances the index
 * while still reporting the old media fields.
 */
export function nudgeNowPlayingTransition(previousSnapshot = null) {
  const current = previousSnapshot || nowPlayingMonitor.latest;
  transitionTracker.nudge(current);
  monitorFreshReadsPending = Math.max(monitorFreshReadsPending, 1);
  nowPlayingMonitor.nudge();
  if (transitionConfirmTimer) clearTimeout(transitionConfirmTimer);
  transitionConfirmTimer = setTimeout(() => {
    transitionConfirmTimer = null;
    monitorFreshReadsPending = Math.max(monitorFreshReadsPending, 1);
    nowPlayingMonitor.nudge();
  }, TRANSITION_CONFIRM_MS);
  transitionConfirmTimer.unref?.();
}

export function nowPlayingDiagnostics() {
  const transition = transitionTracker.diagnostics();
  return {
    subscribers: nowPlayingMonitor.subscriberCount,
    lastSuccessAt: nowPlayingMonitor.health.lastSuccessAt || 0,
    reads: { ...nowPlayingReadCounters },
    transitionFreshReadsPending: monitorFreshReadsPending,
    pendingAgeMs: transition.pendingAgeMs,
    lastClearReason: transition.lastClearReason,
    expectedFrom: transition.expectedFrom,
    pendingStale: transition.pendingStale,
  };
}

function removeNowPlayingStreamClient(res) {
  const client = nowPlayingStreamClients.get(res);
  if (!client) return;
  nowPlayingStreamClients.delete(res);
  clearInterval(client.heartbeat);
  client.unsubscribe();
}

export function closeNowPlayingStreams() {
  unsubscribeSonosStreamNudge();
  clearNowPlayingFollowupNudges();
  if (transitionConfirmTimer) {
    clearTimeout(transitionConfirmTimer);
    transitionConfirmTimer = null;
  }
  transitionTracker.reset();
  for (const res of [...nowPlayingStreamClients.keys()]) {
    removeNowPlayingStreamClient(res);
    try {
      res.end();
    } catch {
      /* socket already closed */
    }
  }
}

let stateDeprecationLogged = false;

/** Register Now Playing HTTP + deprecated /api/state compatibility route. */
export function registerNowPlayingRoutes(app) {
  app.get("/api/nowplaying", async (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      // Same transition-aware payload as SSE so fallback polling cannot diverge.
      res.json(await readNowPlayingWithTransition());
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get("/api/nowplaying/stream", (req, res) => {
    const ip = admitSseClient(nowPlayingStreamClients, req, res);
    if (ip == null) return;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write("retry: 3000\n\n");

    const unsubscribe = nowPlayingMonitor.subscribe((snapshot) => {
      writeNowPlayingStreamEvent(
        res,
        null,
        snapshot,
        snapshot.streamSequence
      );
    });
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
    }, 15_000);
    heartbeat.unref?.();
    nowPlayingStreamClients.set(res, { unsubscribe, heartbeat, ip });
    writeNowPlayingStreamEvent(
      res,
      "sonos-status",
      nowPlayingMonitor.health
    );

    const cleanup = () => removeNowPlayingStreamClient(res);
    req.once("close", cleanup);
    res.once("error", cleanup);
  });

  // Deprecated compatibility poll. Prefer /api/nowplaying + /api/queue/list.
  // No in-repo client uses this; kept for one release with Deprecation headers.
  app.get("/api/state", async (_req, res) => {
    try {
      if (!stateDeprecationLogged) {
        stateDeprecationLogged = true;
        console.warn(
          "[server] GET /api/state is deprecated; use /api/nowplaying and /api/queue/list"
        );
      }
      res.setHeader("Deprecation", "true");
      res.setHeader(
        "Warning",
        '299 - "/api/state is deprecated; use /api/nowplaying and /api/queue/list"'
      );
      const [np, tracks] = await Promise.all([getNowPlaying(), getQueueList()]);
      res.json({
        ...(await enrichNowPlaying(np)),
        tracks,
      });
    } catch (err) {
      res.status(502).json({ error: err.message || "Could not load party state." });
    }
  });
}
