import { createLogger } from "./logger.js";
import { createNowPlayingMonitor } from "./now-playing-stream.js";
import { getAutoFillState, getClosingTimeAt, getLastPartyRecap } from "./autofill.js";
import { getContentSettings } from "./settings.js";
import { getReactions } from "./reactions.js";
import { spotifyTrackId } from "./sampler.js";
import {
  getNowPlaying,
  getQueueList,
  onSonosSnapshotsInvalidated,
} from "./sonos.js";

export function enrichNowPlaying(np) {
  const trackId = spotifyTrackId(np?.uri);
  return {
    ...np,
    neverEnding: getAutoFillState().enabled,
    requestsPaused: getContentSettings().requestsPaused,
    hostControlsOnly: getContentSettings().hostControlsOnly,
    closingTimeAt: getClosingTimeAt(),
    partyRecap: getLastPartyRecap(),
    reactions: trackId ? getReactions(trackId) : getReactions(""),
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

export async function readNowPlayingPayload() {
  return addPositionAge(enrichNowPlaying(await getNowPlaying()));
}

const nowPlayingStreamClients = new Map();

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
  readSnapshot: readNowPlayingPayload,
  intervalMs: 1500,
  errorIntervalMs: 3000,
  failureThreshold: 2,
  onStatusChange: broadcastNowPlayingStatus,
  logger: createLogger("now-playing-stream"),
});

const unsubscribeSonosStreamNudge = onSonosSnapshotsInvalidated(() => {
  nowPlayingMonitor.nudge();
});

export function nudgeNowPlayingStream() {
  nowPlayingMonitor.nudge();
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
      res.json(await readNowPlayingPayload());
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get("/api/nowplaying/stream", (req, res) => {
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
    nowPlayingStreamClients.set(res, { unsubscribe, heartbeat });
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
        ...enrichNowPlaying(np),
        tracks,
      });
    } catch (err) {
      res.status(502).json({ error: err.message || "Could not load party state." });
    }
  });
}
