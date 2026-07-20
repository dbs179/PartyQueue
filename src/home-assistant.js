// Home Assistant credentials for DJ voice announcements (Phase 0+).
//
// Save writes to .env (gitignored) and updates process.env so the running
// server picks them up immediately. data/home-assistant.json is a fallback
// when .env isn't available. The token is never returned to the browser —
// only whether one is set, plus a safe URL.

import fs from "node:fs";
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
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
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
  let url =
    partial.url !== undefined ? cleanHaUrl(partial.url) : current.url;
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
