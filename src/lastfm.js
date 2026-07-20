// Last.fm API key for genre tagging + Discover Similar (Settings).
//
// Save writes to .env (gitignored) and updates process.env so the running
// server picks them up immediately. data/lastfm.json is a fallback when
// .env isn't available. The key is never returned to the browser — only
// whether one is set.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import { upsertEnvKeys } from "./env-file.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_FILE = path.join(__dirname, "..", "data", "lastfm.json");

const KEY_MAX = 128;

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

function cleanKey(value) {
  if (typeof value !== "string") return null;
  const t = value.trim().slice(0, KEY_MAX);
  return t || null;
}

function applyRuntimeEnv(apiKey) {
  if (apiKey) process.env.LASTFM_API_KEY = apiKey;
  else delete process.env.LASTFM_API_KEY;
}

export function getLastfmApiKey() {
  return (
    cleanKey(process.env.LASTFM_API_KEY) || cleanKey(readStore().apiKey) || ""
  );
}

export function isLastfmConfigured() {
  return !!getLastfmApiKey();
}

// Safe status for the Settings UI — never includes the key value.
export function getLastfmStatus() {
  const key = getLastfmApiKey();
  return {
    configured: !!key,
    apiKeySet: !!key,
  };
}

// Persist API key to .env + process.env (and a JSON fallback).
// Empty/missing key keeps the existing key so the password field can stay
// blank / masked after save. Pass clearKey: true to remove it.
export function setLastfmSettings(partial = {}) {
  let apiKey = getLastfmApiKey() || null;
  if (partial.clearKey) {
    apiKey = null;
  } else if (partial.apiKey !== undefined) {
    const cleaned = cleanKey(partial.apiKey);
    if (cleaned) apiKey = cleaned;
    // blank → leave existing apiKey alone
  }

  applyRuntimeEnv(apiKey);
  upsertEnvKeys({ LASTFM_API_KEY: apiKey || null });

  const next = {};
  if (apiKey) next.apiKey = apiKey;
  writeStore(next);

  return getLastfmStatus();
}

export function clearLastfmSettings() {
  applyRuntimeEnv(null);
  upsertEnvKeys({ LASTFM_API_KEY: null });
  writeStore({});
  return getLastfmStatus();
}

// Probe Last.fm with a lightweight chart call.
export async function testLastfmConnection() {
  const key = getLastfmApiKey();
  if (!key) {
    return { ok: false, error: "Set a Last.fm API key first." };
  }
  const params = new URLSearchParams({
    method: "chart.getTopArtists",
    api_key: key,
    format: "json",
    limit: "1",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(
      `https://ws.audioscrobbler.com/2.0/?${params.toString()}`,
      { signal: controller.signal }
    );
    if (!res.ok) {
      return { ok: false, error: `Last.fm returned HTTP ${res.status}.` };
    }
    const body = await res.json().catch(() => ({}));
    if (body?.error) {
      return {
        ok: false,
        error: body.message || `Last.fm error ${body.error}.`,
      };
    }
    return { ok: true, message: "Last.fm API key works" };
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ok: false, error: "Timed out reaching Last.fm." };
    }
    return {
      ok: false,
      error: err.message || "Could not reach Last.fm.",
    };
  } finally {
    clearTimeout(timer);
  }
}
