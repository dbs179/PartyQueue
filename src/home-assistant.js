// Home Assistant credentials for DJ voice announcements (Phase 0+).
//
// Save writes to .env (gitignored) and updates process.env so the running
// server picks them up immediately. data/home-assistant.json is a fallback
// when .env isn't available. The token is never returned to the browser —
// only whether one is set, plus a safe URL.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import { upsertEnvKeys } from "./env-file.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_FILE = path.join(__dirname, "..", "data", "home-assistant.json");

const URL_MAX = 300;
const TOKEN_MAX = 500;

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

function ipv4ToInt(ip) {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function inCidrV4(ip, base, prefix) {
  const n = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (n == null || b == null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (n & mask) === (b & mask);
}

/** Loopback / RFC1918 only — blocks public + link-local/metadata IPs. */
export function isPrivateOrLoopbackIp(hostname) {
  const bare = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const kind = net.isIP(bare);
  if (kind === 4) {
    if (inCidrV4(bare, "127.0.0.0", 8)) return true;
    if (inCidrV4(bare, "10.0.0.0", 8)) return true;
    if (inCidrV4(bare, "172.16.0.0", 12)) return true;
    if (inCidrV4(bare, "192.168.0.0", 16)) return true;
    return false;
  }
  if (kind === 6) {
    if (bare === "::1") return true;
    // Unique local addresses fc00::/7
    const first = bare.split(":")[0];
    const n = Number.parseInt(first, 16);
    if (Number.isFinite(n) && (n & 0xfe00) === 0xfc00) return true;
    return false;
  }
  return false;
}

function allowPublicHaHosts() {
  return /^(1|true|yes)$/i.test(String(process.env.HA_ALLOW_PUBLIC_URL || "").trim());
}

/**
 * Hostnames the server may call with the HA long-lived token.
 * Private LAN / mDNS by default; Nabu Casa HTTPS; or any HTTPS when
 * HA_ALLOW_PUBLIC_URL=1.
 */
export function isAllowedHaTarget(parsedUrl) {
  if (!parsedUrl || (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")) {
    return false;
  }
  // Reject embedded credentials (token-in-URL style SSRF bait).
  if (parsedUrl.username || parsedUrl.password) return false;

  const hostname = String(parsedUrl.hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!hostname) return false;

  if (net.isIP(hostname)) {
    return isPrivateOrLoopbackIp(hostname);
  }

  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (!hostname.includes(".")) return true; // single-label LAN name
  if (hostname.endsWith(".local")) return true; // mDNS

  // Remote HA (Nabu Casa) — HTTPS only.
  if (parsedUrl.protocol === "https:" && hostname.endsWith(".ui.nabu.casa")) {
    return true;
  }
  if (parsedUrl.protocol === "https:" && allowPublicHaHosts()) {
    return true;
  }
  return false;
}

export function cleanHaUrl(value) {
  if (typeof value !== "string") return null;
  const t = value.trim().replace(/\/+$/, "").slice(0, URL_MAX);
  if (!t) return null;
  let parsed;
  try {
    parsed = new URL(t);
  } catch {
    return null;
  }
  if (!isAllowedHaTarget(parsed)) return null;
  return t;
}

function cleanToken(value) {
  if (typeof value !== "string") return null;
  const t = value.trim().slice(0, TOKEN_MAX);
  return t || null;
}

function applyRuntimeEnv({ url, token }) {
  if (url) process.env.HA_URL = url;
  else delete process.env.HA_URL;
  if (token) process.env.HA_TOKEN = token;
  else delete process.env.HA_TOKEN;
}

// Effective credentials: process.env (from .env / Save) then Settings JSON fallback.
export function getHaCredentials() {
  const stored = readStore();
  const url =
    cleanHaUrl(process.env.HA_URL) || cleanHaUrl(stored.url);
  const token =
    cleanToken(process.env.HA_TOKEN) || cleanToken(stored.token);
  return { url, token };
}

export function isHaConfigured() {
  const { url, token } = getHaCredentials();
  return !!(url && token);
}

// Safe status for the Settings UI — never includes the token value.
export function getHaStatus() {
  const { url, token } = getHaCredentials();
  return {
    configured: !!(url && token),
    url: url || "",
    tokenSet: !!token,
  };
}

// Persist URL/token to .env + process.env (and a JSON fallback).
// Empty/missing token keeps the existing token so the password field can stay
// masked after save. Pass clearToken: true to remove the token.
// Changing the URL requires a newly supplied token so a LAN client can't point
// HA at an attacker host and exfiltrate the long-lived token.
export function setHaSettings(partial = {}) {
  const current = getHaCredentials();
  let url = current.url;
  if (partial.url !== undefined) {
    const raw = partial.url;
    if (typeof raw === "string" && raw.trim() && !cleanHaUrl(raw)) {
      throw new Error(
        "Home Assistant URL must be a private LAN address, .local name, localhost, or an allowed remote HA host (Nabu Casa / HA_ALLOW_PUBLIC_URL)."
      );
    }
    url = cleanHaUrl(raw);
  }
  let token = current.token;
  const urlChanged =
    partial.url !== undefined &&
    !!url &&
    url !== cleanHaUrl(current.url);

  if (partial.clearToken) {
    token = null;
  } else if (partial.token !== undefined) {
    const cleaned = cleanToken(partial.token);
    if (cleaned) token = cleaned;
    // blank → leave existing token alone (unless URL is changing — see below)
  }

  if (urlChanged) {
    const supplied = cleanToken(partial.token);
    if (!supplied) {
      throw new Error(
        "Changing the Home Assistant URL requires entering the long-lived token again."
      );
    }
    token = supplied;
  }

  applyRuntimeEnv({ url, token });
  upsertEnvKeys({
    HA_URL: url || null,
    HA_TOKEN: token || null,
  });

  const next = {};
  if (url) next.url = url;
  if (token) next.token = token;
  writeStore(next);

  return getHaStatus();
}

export function clearHaSettings() {
  applyRuntimeEnv({ url: null, token: null });
  upsertEnvKeys({ HA_URL: null, HA_TOKEN: null });
  writeStore({});
  return getHaStatus();
}

// Probe HA with GET /api/ using the configured long-lived token.
export async function testHaConnection() {
  const { url, token } = getHaCredentials();
  if (!url || !token) {
    return { ok: false, error: "Set a Home Assistant URL and long-lived token first." };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${url}/api/`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Home Assistant rejected the token (unauthorized)." };
    }
    if (!res.ok) {
      return { ok: false, error: `Home Assistant returned HTTP ${res.status}.` };
    }
    let message = "Connected";
    try {
      const body = await res.json();
      if (body?.message) message = String(body.message);
    } catch {
      /* ignore non-JSON */
    }
    return { ok: true, message };
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ok: false, error: "Timed out reaching Home Assistant." };
    }
    return { ok: false, error: err.message || "Could not reach Home Assistant." };
  } finally {
    clearTimeout(timer);
  }
}
