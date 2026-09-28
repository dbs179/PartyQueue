import { createLogger } from "./logger.js";
import { admitSseClient, pruneDeadSseClients } from "./http/sse-limits.js";
import { createSnapshotMonitor } from "./now-playing-stream.js";
import { onNowPlayingSnapshot } from "./now-playing-http.js";
import {
  getQueueList,
  onSonosSnapshotsInvalidated,
} from "./sonos.js";
import { readQueueForDisplay } from "./queue-view.js";

/**
 * Compact fingerprint of queue rows that matter to the UI (order, identity,
 * badges, DJ pads, genre pills, cover prefetch). Avoids JSON.stringify of the
 * full track objects every monitor tick.
 */
function trackSignature(track) {
  if (!track || typeof track !== "object") return "";
  const lanes = Array.isArray(track.genreLanes)
    ? track.genreLanes.join(",")
    : "";
  const labels = Array.isArray(track.genreLabels)
    ? track.genreLabels.join(",")
    : "";
  return [
    track.position ?? "",
    track.itemId ?? "",
    track.uri ?? "",
    track.title ?? "",
    track.artist ?? "",
    track.album ?? "",
    track.albumArt ?? "",
    track.origin ?? "",
    track.searched ? 1 : 0,
    track.discovered ? 1 : 0,
    track.moodPick ? 1 : 0,
    track.mood ?? "",
    track.requestedBy ?? "",
    track.requestedByUser ?? "",
    track.dedication ?? "",
    // Outbox flags. A failed add keeps the same title and requester, so without
    // these the stream treats "Adding…" and "Retry" as the same snapshot.
    track.pending ? 1 : 0,
    track.failed ? 1 : 0,
    track.pendingId ?? "",
    track.djVoice ? 1 : 0,
    track.fromPlaylist ? 1 : 0,
    track.genreLane ?? "",
    track.genreLabel ?? "",
    lanes,
    labels,
  ].join("\x1f");
}

export function queueSignature(snapshot = null) {
  const tracks = Array.isArray(snapshot?.tracks) ? snapshot.tracks : [];
  // Losing (or regaining) the live Sonos read is a visible state change even
  // when the rows are identical, so it has to move the signature.
  const stale = snapshot?.stale ? "s" : "f";
  if (!tracks.length) return `0\x1e${stale}`;
  return `${tracks.length}\x1e${stale}\x1e${tracks.map(trackSignature).join("\x1e")}`;
}

// Must build the same payload as GET /api/queue/list. The stream is what
// actually repaints the UI, so if it omitted pending rows a guest's song would
// appear on a REST poll and vanish on the next push.
export async function readQueuePayload() {
  return readQueueForDisplay(getQueueList);
}

const queueStreamClients = new Map();

function writeQueueStreamEvent(res, eventName, payload, id = null) {
  if (res.writableEnded || res.destroyed) return;
  if (id != null) res.write(`id: ${id}\n`);
  if (eventName) res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastQueueStatus(health) {
  for (const res of queueStreamClients.keys()) {
    writeQueueStreamEvent(res, "queue-status", health);
  }
}

/** Backstop only. Mutations and track changes are what actually refresh. */
export const QUEUE_SAFETY_INTERVAL_MS = 60_000;

export function queueTrackChangeKey(np) {
  if (!np) return "";
  const uri = String(np.uri || "");
  if (!uri) return "";
  return `${uri}\x1f${np.queueTrack ?? ""}`;
}

export function createQueueTrackChangeWatcher(nudge) {
  let lastKey = "";
  return function onNowPlaying(np) {
    const key = queueTrackChangeKey(np);
    if (!key || key === lastKey) return false;
    lastKey = key;
    nudge?.();
    return true;
  };
}

export const queueMonitor = createSnapshotMonitor({
  monitorName: "queue",
  readSnapshot: readQueuePayload,
  signatureFor: queueSignature,
  intervalMs: QUEUE_SAFETY_INTERVAL_MS,
  errorIntervalMs: 5000,
  intervalFor: () => QUEUE_SAFETY_INTERVAL_MS,
  failureThreshold: 2,
  onStatusChange: broadcastQueueStatus,
  logger: createLogger("queue-stream"),
});

const noteNowPlayingForQueue = createQueueTrackChangeWatcher(() => {
  queueMonitor.nudge();
});
const unsubscribeNowPlayingTrack = onNowPlayingSnapshot(noteNowPlayingForQueue);

/** Re-read after Sonos Browse catches up (Clear → Random from Node-RED / HA). */
export const QUEUE_MUTATION_FOLLOWUP_MS = [400, 1600];
let queueFollowupTimers = [];

function writeQueueChangedEvent() {
  const payload = { at: Date.now() };
  for (const res of queueStreamClients.keys()) {
    writeQueueStreamEvent(res, "queue-changed", payload);
  }
}

function clearQueueFollowupNudges() {
  for (const timer of queueFollowupTimers) clearTimeout(timer);
  queueFollowupTimers = [];
}

function scheduleQueueFollowupNudges() {
  clearQueueFollowupNudges();
  queueFollowupTimers = QUEUE_MUTATION_FOLLOWUP_MS.map((ms) => {
    const timer = setTimeout(() => {
      // Bust again so a stale immediate GetQueue cannot occupy the 3s cache
      // and hide the tracks Node-RED just enqueued.
      getQueueList.bust();
      queueMonitor.nudge();
    }, ms);
    timer.unref?.();
    return timer;
  });
}

/** Tell every open PC/phone view a behind-the-scenes queue write landed. */
export function broadcastQueueMutation() {
  writeQueueChangedEvent();
  queueMonitor.nudge();
  scheduleQueueFollowupNudges();
}

const unsubscribeSonosStreamNudge = onSonosSnapshotsInvalidated(() => {
  broadcastQueueMutation();
});

export function queueStreamClientCount() {
  return queueStreamClients.size;
}

function removeQueueStreamClient(res) {
  const client = queueStreamClients.get(res);
  if (!client) return;
  queueStreamClients.delete(res);
  clearInterval(client.heartbeat);
  client.unsubscribe();
}

export function closeQueueStreams() {
  unsubscribeSonosStreamNudge();
  unsubscribeNowPlayingTrack();
  clearQueueFollowupNudges();
  for (const res of [...queueStreamClients.keys()]) {
    removeQueueStreamClient(res);
    try {
      res.end();
    } catch {
      /* socket already closed */
    }
  }
}

export function registerQueueStreamRoutes(app, { monitor = queueMonitor } = {}) {
  app.get("/api/queue/stream", (req, res) => {
    pruneDeadSseClients(queueStreamClients, removeQueueStreamClient);
    const ip = admitSseClient(queueStreamClients, req, res);
    if (ip == null) return;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write("retry: 3000\n\n");

    const unsubscribe = monitor.subscribe((snapshot) => {
      writeQueueStreamEvent(
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
    queueStreamClients.set(res, { unsubscribe, heartbeat, ip });
    writeQueueStreamEvent(res, "queue-status", monitor.health);

    const cleanup = () => removeQueueStreamClient(res);
    req.once("close", cleanup);
    res.once("error", cleanup);
  });
}

