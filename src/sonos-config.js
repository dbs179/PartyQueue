// Sonos connection settings (speaker IP + room name) for Settings → Connections.
//
// Save writes to .env (gitignored) and updates process.env so the running
// server picks them up immediately. data/sonos.json is a fallback when .env
// isn't available. Host/room are not secrets — status returns the values.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import { upsertEnvKeys } from "./env-file.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_FILE = path.join(__dirname, "..", "data", "sonos.json");

const HOST_MAX = 64;
const ROOM_MAX = 80;
const REGION_MAX = 32;

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeStore(data) {
  writeFileAtomic(STORE_FILE, JSON.stringify(data, null, 2));
}

export function cleanSonosHost(value) {
  if (typeof value !== "string") return null;
  const t = value.trim().slice(0, HOST_MAX);
  if (!t) return null;
  // IPv4
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(t)) {
    const parts = t.split(".").map(Number);
    if (parts.every((n) => n >= 0 && n <= 255)) return t;
    return null;
  }
  // Simple hostname (e.g. sonos-kitchen.local)
  if (/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,61}[a-zA-Z0-9])?$/.test(t)) return t;
  return null;
}

export function cleanSonosRoom(value) {
  if (typeof value !== "string") return null;
  const t = value.trim().slice(0, ROOM_MAX);
  return t || null;
}

export function cleanSonosRegion(value) {
  if (typeof value !== "string") return null;
  const t = value.trim().slice(0, REGION_MAX);
  if (!t) return null;
  const lower = t.toLowerCase();
  if (lower === "eu" || lower === "europe") return "EU";
  if (
    lower === "northamerica" ||
    lower === "north america" ||
    lower === "na" ||
    lower === "us"
  ) {
    return "NorthAmerica";
  }
  // Allow the canonical spellings through unchanged.
  if (t === "NorthAmerica" || t === "EU") return t;
  return null;
}

function applyRuntimeEnv({ host, room, region }) {
  if (host) process.env.SONOS_HOST = host;
  else delete process.env.SONOS_HOST;
  if (room) process.env.SONOS_ROOM = room;
  else delete process.env.SONOS_ROOM;
  if (region) process.env.SONOS_REGION = region;
}

export function getSonosConnectionSettings() {
  const stored = readStore();
  const host =
    cleanSonosHost(process.env.SONOS_HOST) || cleanSonosHost(stored.host) || "";
  const room =
    cleanSonosRoom(process.env.SONOS_ROOM) || cleanSonosRoom(stored.room) || "";
  const region =
    cleanSonosRegion(process.env.SONOS_REGION) ||
    cleanSonosRegion(stored.region) ||
    "NorthAmerica";
  return { host, room, region };
}

export function getSonosHost() {
  return getSonosConnectionSettings().host || "";
}

export function getSonosRoom() {
  return getSonosConnectionSettings().room || "";
}

export function getSonosConnectionStatus() {
  const { host, room, region } = getSonosConnectionSettings();
  return {
    host,
    room,
    region,
    hostSet: !!host,
    roomSet: !!room,
    // Discovery mode when host is blank (SSDP); pin recommended across VLANs.
    discoveryMode: host ? "host" : "ssdp",
  };
}

export function setSonosConnectionSettings(partial = {}) {
  const current = getSonosConnectionSettings();
  let host = current.host || null;
  let room = current.room || null;
  let region = current.region || "NorthAmerica";

  if (partial.clearHost) host = null;
  else if (partial.host !== undefined) {
    const cleaned = cleanSonosHost(partial.host);
    if (partial.host === "" || partial.host == null) host = null;
    else if (cleaned) host = cleaned;
    else if (String(partial.host || "").trim()) {
      throw new Error("Speaker IP / hostname looks invalid.");
    }
  }

  if (partial.clearRoom) room = null;
  else if (partial.room !== undefined) {
    const cleaned = cleanSonosRoom(partial.room);
    if (partial.room === "" || partial.room == null) room = null;
    else if (cleaned) room = cleaned;
  }

  if (partial.region !== undefined) {
    const cleaned = cleanSonosRegion(partial.region);
    if (cleaned) region = cleaned;
    else if (String(partial.region || "").trim()) {
      throw new Error('Region must be "NorthAmerica" or "EU".');
    }
  }

  applyRuntimeEnv({ host, room, region });
  upsertEnvKeys({
    SONOS_HOST: host || null,
    SONOS_ROOM: room || null,
    SONOS_REGION: region || null,
  });

  const next = {};
  if (host) next.host = host;
  if (room) next.room = room;
  if (region) next.region = region;
  writeStore(next);

  return getSonosConnectionStatus();
}

export function clearSonosConnectionSettings() {
  const region =
    cleanSonosRegion(process.env.SONOS_REGION) ||
    cleanSonosRegion(readStore().region) ||
    "NorthAmerica";
  applyRuntimeEnv({ host: null, room: null, region });
  upsertEnvKeys({
    SONOS_HOST: null,
    SONOS_ROOM: null,
  });
  writeStore({ region });
  return getSonosConnectionStatus();
}

/** Probe Sonos after applying current settings (resets the cached manager). */
export async function testSonosConnection() {
  const { resetSonosManager, listRooms } = await import("./sonos.js");
  resetSonosManager();
  try {
    const rooms = await listRooms();
    const names = (rooms || []).map((r) => r.name).filter(Boolean);
    if (!names.length) {
      return {
        ok: false,
        error:
          "No Sonos rooms found. Pin a speaker IP if discovery fails across VLANs/VPNs.",
      };
    }
    const { host, room, discoveryMode } = getSonosConnectionStatus();
    const mode =
      discoveryMode === "host" ? `via ${host}` : "via network discovery";
    const roomNote = room ? ` (prefer room “${room}”)` : "";
    return {
      ok: true,
      message: `Found ${names.length} room(s) ${mode}${roomNote}: ${names.slice(0, 6).join(", ")}${names.length > 6 ? "…" : ""}`,
      rooms: names,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message || "Could not reach Sonos.",
    };
  }
}
