import { createLogger } from "./logger.js";
import { admitSseClient } from "./http/sse-limits.js";
import { createSnapshotMonitor } from "./now-playing-stream.js";
import {
  getQueueList,
  onSonosSnapshotsInvalidated,
} from "./sonos.js";

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
  if (!tracks.length) return "0";
  return `${tracks.length}\x1e${tracks.map(trackSignature).join("\x1e")}`;
}

export async function readQueuePayload() {
  return { tracks: await getQueueList() };
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

export const queueMonitor = createSnapshotMonitor({
  monitorName: "queue",
  readSnapshot: readQueuePayload,
  signatureFor: queueSignature,
  intervalMs: 3000,
  errorIntervalMs: 5000,
  failureThreshold: 2,
  onStatusChange: broadcastQueueStatus,
  logger: createLogger("queue-stream"),
});

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

function removeQueueStreamClient(res) {
  const client = queueStreamClients.get(res);
  if (!client) return;
  queueStreamClients.delete(res);
  clearInterval(client.heartbeat);
  client.unsubscribe();
}

export function closeQueueStreams() {
  unsubscribeSonosStreamNudge();
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

