import { createLogger } from "./logger.js";
import { admitSseClient } from "./http/sse-limits.js";
import { createSnapshotMonitor } from "./now-playing-stream.js";
import {
  getQueueList,
  onSonosSnapshotsInvalidated,
} from "./sonos.js";

export function queueSignature(snapshot = null) {
  const tracks = Array.isArray(snapshot?.tracks) ? snapshot.tracks : [];
  return JSON.stringify(tracks);
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

const unsubscribeSonosStreamNudge = onSonosSnapshotsInvalidated(() => {
  queueMonitor.nudge();
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

