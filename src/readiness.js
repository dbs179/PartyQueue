// Process / party readiness probes for /api/ready and deploy verification.
//
// Layers:
// - ready: process can serve the UI and persist to data/ (Docker/orchestrator)
// - partyReady: Spotify is configured and Sonos is reachable or a host is set
//   (deploy smoke / "can we run a party night?")

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Default persistent data directory (overridable for tests / custom mounts). */
export function defaultDataDir() {
  return (
    process.env.PARTYQUEUE_DATA_DIR || path.join(__dirname, "..", "data")
  );
}

/**
 * True when we can create/write/delete a probe file under dataDir.
 * @param {string} [dataDir]
 * @returns {boolean}
 */
export function probeDataWritable(dataDir = defaultDataDir()) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(
      dataDir,
      `.ready-probe-${process.pid}-${Date.now()}`
    );
    fs.writeFileSync(probe, "ok", "utf8");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string|null|undefined} status
 * @returns {"connecting"|"connected"|"disconnected"|"unknown"}
 */
export function normalizeSonosStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s === "connecting" || s === "connected" || s === "disconnected") {
    return s;
  }
  return "unknown";
}

/**
 * Sonos control path is usable when currently up/coming up, or when a speaker
 * IP is configured so rediscovery has somewhere to aim.
 * @param {string} sonosStatus
 * @param {boolean} sonosHostConfigured
 */
export function sonosControlOk(sonosStatus, sonosHostConfigured) {
  const status = normalizeSonosStatus(sonosStatus);
  return (
    status === "connected" ||
    status === "connecting" ||
    !!sonosHostConfigured
  );
}

/**
 * @param {{
 *   version: string,
 *   listening: boolean,
 *   shuttingDown: boolean,
 *   dataWritable: boolean,
 *   spotifyConfigured: boolean,
 *   sonosStatus?: string|null,
 *   sonosHostConfigured?: boolean,
 * }} input
 */
export function evaluateReadiness(input) {
  const listening = !!input.listening;
  const shuttingDown = !!input.shuttingDown;
  const dataWritable = !!input.dataWritable;
  const spotifyConfigured = !!input.spotifyConfigured;
  const sonos = normalizeSonosStatus(input.sonosStatus);
  const sonosHostConfigured = !!input.sonosHostConfigured;
  const sonosOk = sonosControlOk(sonos, sonosHostConfigured);

  const ready = listening && !shuttingDown && dataWritable;
  const partyReady = ready && spotifyConfigured && sonosOk;

  return {
    ready,
    partyReady,
    version: String(input.version || ""),
    checks: {
      listening,
      shuttingDown,
      dataWritable,
      spotifyConfigured,
      sonos,
      sonosHostConfigured,
      sonosOk,
    },
  };
}
