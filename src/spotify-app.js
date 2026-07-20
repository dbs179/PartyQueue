// Spotify Developer app credentials (Client ID / Secret) for Settings.
//
// Save writes to .env (gitignored) and updates process.env so the running
// server picks them up immediately. data/spotify-app.json is a fallback when
// .env isn't available (e.g. some Docker setups). Secrets are never returned
// to the browser — only whether they are set, plus safe fields.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import { upsertEnvKeys } from "./env-file.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_FILE = path.join(__dirname, "..", "data", "spotify-app.json");

const ID_MAX = 128;
const SECRET_MAX = 128;
const URI_MAX = 300;
const MARKET_MAX = 8;

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

function cleanId(value) {
  if (typeof value !== "string") return null;
  const t = value.trim().slice(0, ID_MAX);
  return t || null;
}

function cleanSecret(value) {
  if (typeof value !== "string") return null;
  const t = value.trim().slice(0, SECRET_MAX);
  return t || null;
}

export function cleanRedirectUri(value) {
  if (typeof value !== "string") return null;
  const t = value.trim().slice(0, URI_MAX);
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

export function cleanMarket(value) {
  if (typeof value !== "string") return null;
  const t = value.trim().toUpperCase().slice(0, MARKET_MAX);
  if (!/^[A-Z]{2}$/.test(t)) return null;
  return t;
}

function applyRuntimeEnv({ clientId, clientSecret, redirectUri, market }) {
  if (clientId) process.env.SPOTIFY_CLIENT_ID = clientId;
  else delete process.env.SPOTIFY_CLIENT_ID;
  if (clientSecret) process.env.SPOTIFY_CLIENT_SECRET = clientSecret;
  else delete process.env.SPOTIFY_CLIENT_SECRET;
  if (redirectUri) process.env.SPOTIFY_REDIRECT_URI = redirectUri;
  else delete process.env.SPOTIFY_REDIRECT_URI;
  if (market) process.env.SPOTIFY_MARKET = market;
  else delete process.env.SPOTIFY_MARKET;
}

// Effective credentials: process.env (from .env / Save) then Settings JSON fallback.
export function getSpotifyAppCredentials() {
  const stored = readStore();
  const clientId =
    cleanId(process.env.SPOTIFY_CLIENT_ID) || cleanId(stored.clientId);
  const clientSecret =
    cleanSecret(process.env.SPOTIFY_CLIENT_SECRET) ||
    cleanSecret(stored.clientSecret);
  const redirectUri =
    cleanRedirectUri(process.env.SPOTIFY_REDIRECT_URI) ||
    cleanRedirectUri(stored.redirectUri) ||
    `http://127.0.0.1:${process.env.PORT || 8080}/auth/callback`;
  const market =
    cleanMarket(process.env.SPOTIFY_MARKET) ||
    cleanMarket(stored.market) ||
    "US";
  return { clientId, clientSecret, redirectUri, market };
}

export function isSpotifyAppConfigured() {
  const { clientId, clientSecret } = getSpotifyAppCredentials();
  return !!(clientId && clientSecret);
}

// Safe status for the Settings UI — never includes the secret value.
export function getSpotifyAppStatus() {
  const { clientId, clientSecret, redirectUri, market } =
    getSpotifyAppCredentials();
  return {
    configured: !!(clientId && clientSecret),
    clientId: clientId || "",
    clientSecretSet: !!clientSecret,
    redirectUri: redirectUri || "",
    market: market || "US",
  };
}

// Persist app credentials to .env + process.env (and a JSON fallback).
// Empty/missing secret keeps the existing secret so the password field can
// stay blank after save. Pass clearSecret: true to remove the secret.
export function setSpotifyAppSettings(partial = {}) {
  const current = getSpotifyAppCredentials();
  let clientId =
    partial.clientId !== undefined
      ? cleanId(partial.clientId)
      : current.clientId;
  let clientSecret = current.clientSecret;
  if (partial.clearSecret) {
    clientSecret = null;
  } else if (partial.clientSecret !== undefined) {
    const cleaned = cleanSecret(partial.clientSecret);
    if (cleaned) clientSecret = cleaned;
  }
  let redirectUri =
    partial.redirectUri !== undefined
      ? cleanRedirectUri(partial.redirectUri)
      : current.redirectUri;
  let market =
    partial.market !== undefined
      ? cleanMarket(partial.market) || "US"
      : current.market;

  // Default redirect when clearing to empty.
  if (partial.redirectUri !== undefined && !redirectUri) {
    redirectUri = `http://127.0.0.1:${process.env.PORT || 8080}/auth/callback`;
  }

  applyRuntimeEnv({ clientId, clientSecret, redirectUri, market });

  upsertEnvKeys({
    SPOTIFY_CLIENT_ID: clientId || null,
    SPOTIFY_CLIENT_SECRET: clientSecret || null,
    SPOTIFY_REDIRECT_URI: redirectUri || null,
    SPOTIFY_MARKET: market || null,
  });

  const next = {};
  if (clientId) next.clientId = clientId;
  if (clientSecret) next.clientSecret = clientSecret;
  if (redirectUri) next.redirectUri = redirectUri;
  if (market) next.market = market;
  writeStore(next);

  return getSpotifyAppStatus();
}

export function clearSpotifyAppSettings() {
  applyRuntimeEnv({
    clientId: null,
    clientSecret: null,
    redirectUri: null,
    market: null,
  });
  upsertEnvKeys({
    SPOTIFY_CLIENT_ID: null,
    SPOTIFY_CLIENT_SECRET: null,
    SPOTIFY_REDIRECT_URI: null,
    SPOTIFY_MARKET: null,
  });
  writeStore({});
  return getSpotifyAppStatus();
}

// Probe Spotify with a client-credentials token request.
export async function testSpotifyAppConnection() {
  const { clientId, clientSecret } = getSpotifyAppCredentials();
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      error: "Set a Spotify Client ID and Client Secret first.",
    };
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error: "Spotify rejected the Client ID or Client Secret.",
      };
    }
    if (!res.ok) {
      return { ok: false, error: `Spotify returned HTTP ${res.status}.` };
    }
    return { ok: true, message: "Spotify app credentials work" };
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ok: false, error: "Timed out reaching Spotify." };
    }
    return {
      ok: false,
      error: err.message || "Could not reach Spotify.",
    };
  } finally {
    clearTimeout(timer);
  }
}
