// Guest-safe party-wide flags: toggles, Vibe mix selection, Closing Time /
// Party's Over. Owned here (not Now Playing) so settings changes publish on
// mutate instead of riding every 1.5s track poll.

import { createLogger } from "./logger.js";
import { admitSseClient } from "./http/sse-limits.js";
import { createSnapshotMonitor } from "./now-playing-stream.js";
import {
  getAutoFillState,
  getClosingTimeAt,
  getLastPartyRecap,
} from "./autofill.js";
import {
  getBrandingSettings,
  getContentSettings,
  getDiscoverySettings,
  getRotationSettings,
} from "./settings.js";
import { isPartyOver } from "./party-rituals.js";

/**
 * Assemble the public party snapshot (no Sonos, no host secrets).
 * Sync — all sources are in-memory / local settings reads.
 */
export function readPartySettingsSnapshot() {
  const fill = getAutoFillState();
  const rotation = getRotationSettings();
  const content = getContentSettings();
  return {
    neverEnding: !!fill.enabled,
    mixGenres: fill.genres,
    mixMood: fill.mood,
    discoverEnabled: !!getDiscoverySettings().discoverEnabled,
    showQueueGenre: !!getBrandingSettings().showQueueGenre,
    randomMoodEnabled: !!rotation.randomMoodEnabled,
    randomDecadeEnabled: !!rotation.randomDecadeEnabled,
    filterExplicit: !!content.filterExplicit,
    kidsLock: !!content.kidsLock,
    requestsPaused: !!content.requestsPaused,
    partyOver: !!isPartyOver(),
    hostControlsOnly: !!content.hostControlsOnly,
    closingTimeAt: getClosingTimeAt(),
    partyRecap: getLastPartyRecap(),
  };
}

/** Compact fingerprint — order-stable, ignores stream metadata. */
export function partySettingsSignature(snapshot = null) {
  if (!snapshot || typeof snapshot !== "object") return "";
  const genres = Array.isArray(snapshot.mixGenres)
    ? [...snapshot.mixGenres].map(String).sort().join(",")
    : snapshot.mixGenres == null
      ? ""
      : String(snapshot.mixGenres);
  const recap = snapshot.partyRecap;
  const recapKey =
    recap && typeof recap === "object"
      ? JSON.stringify(recap)
      : recap == null
        ? ""
        : String(recap);
  return [
    snapshot.neverEnding ? 1 : 0,
    genres,
    snapshot.mixMood ?? "",
    snapshot.discoverEnabled ? 1 : 0,
    snapshot.showQueueGenre ? 1 : 0,
    snapshot.randomMoodEnabled ? 1 : 0,
    snapshot.randomDecadeEnabled ? 1 : 0,
    snapshot.filterExplicit ? 1 : 0,
    snapshot.kidsLock ? 1 : 0,
    snapshot.requestsPaused ? 1 : 0,
    snapshot.partyOver ? 1 : 0,
    snapshot.hostControlsOnly ? 1 : 0,
    snapshot.closingTimeAt ?? "",
    recapKey,
  ].join("\x1f");
}

const partyStreamClients = new Map();

function writePartyStreamEvent(res, eventName, payload, id = null) {
  if (res.writableEnded || res.destroyed) return;
  if (id != null) res.write(`id: ${id}\n`);
  if (eventName) res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastPartyStatus(health) {
  for (const res of partyStreamClients.keys()) {
    writePartyStreamEvent(res, "party-status", health);
  }
}

export const partySettingsMonitor = createSnapshotMonitor({
  monitorName: "party",
  readSnapshot: () => readPartySettingsSnapshot(),
  signatureFor: partySettingsSignature,
  // Long idle poll as a safety net; mutations call nudgePartySettingsStream().
  intervalMs: 15_000,
  errorIntervalMs: 15_000,
  failureThreshold: 2,
  onStatusChange: broadcastPartyStatus,
  logger: createLogger("party-stream"),
});

function removePartyStreamClient(res) {
  const client = partyStreamClients.get(res);
  if (!client) return;
  partyStreamClients.delete(res);
  clearInterval(client.heartbeat);
  client.unsubscribe();
}

export function nudgePartySettingsStream() {
  partySettingsMonitor.nudge();
}

export function closePartySettingsStreams() {
  for (const res of [...partyStreamClients.keys()]) {
    removePartyStreamClient(res);
    try {
      res.end();
    } catch {
      /* socket already closed */
    }
  }
}

export function registerPartySettingsRoutes(
  app,
  { monitor = partySettingsMonitor } = {}
) {
  app.get("/api/party", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(readPartySettingsSnapshot());
  });

  app.get("/api/party/stream", (req, res) => {
    const ip = admitSseClient(partyStreamClients, req, res);
    if (ip == null) return;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write("retry: 5000\n\n");

    const unsubscribe = monitor.subscribe((snapshot) => {
      writePartyStreamEvent(res, null, snapshot, snapshot.streamSequence);
    });
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
    }, 15_000);
    heartbeat.unref?.();
    partyStreamClients.set(res, { unsubscribe, heartbeat, ip });
    writePartyStreamEvent(res, "party-status", monitor.health);

    const cleanup = () => removePartyStreamClient(res);
    req.once("close", cleanup);
    res.once("error", cleanup);
  });
}
