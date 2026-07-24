// Optional host PIN → short-lived session for admin APIs.
// Preferred: hashed PIN in data/host-pin.json (set from Settings).
// Fallback: SETTINGS_PIN in .env (plain) for Docker/bootstrap.
// When neither is set, requireHost is a no-op.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIN_FILE =
  process.env.PARTYQUEUE_HOST_PIN_FILE ||
  path.join(__dirname, "..", "data", "host-pin.json");
const BOOTSTRAP_FILE =
  process.env.PARTYQUEUE_HOST_BOOTSTRAP_FILE ||
  path.join(__dirname, "..", "data", "host-bootstrap-code.json");

const COOKIE_NAME = "pq_host";
const HEADER_NAME = "x-partyqueue-host";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // one party night
const PIN_MIN = 4;
const PIN_MAX = 32;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const BOOTSTRAP_TTL_MS = 2 * 60 * 60 * 1000;

/** @type {Map<string, { expiresAt: number }>} */
const sessions = new Map();

/** @type {{ salt: string, hash: string, algo: string }|null|undefined} */
let pinCache = undefined;
let bootstrapCode = "";
let bootstrapExpiresAt = 0;

function readPinFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(PIN_FILE, "utf8"));
    if (
      raw &&
      typeof raw.salt === "string" &&
      typeof raw.hash === "string" &&
      raw.salt &&
      raw.hash
    ) {
      return {
        salt: raw.salt,
        hash: raw.hash,
        algo: typeof raw.algo === "string" ? raw.algo : "scrypt",
      };
    }
  } catch {
    /* missing / invalid */
  }
  return null;
}

function loadPinRecord() {
  if (pinCache === undefined) pinCache = readPinFile();
  return pinCache;
}

function bustPinCache() {
  pinCache = undefined;
}

export function cleanPin(value) {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (cleaned.length < PIN_MIN || cleaned.length > PIN_MAX) return "";
  return cleaned;
}

function envPin() {
  return (process.env.SETTINGS_PIN || "").trim();
}

/** @returns {'file'|'env'|null} */
export function hostPinSource() {
  if (loadPinRecord()) return "file";
  if (envPin()) return "env";
  return null;
}

export function isHostPinConfigured() {
  return hostPinSource() != null;
}

export function ensureHostBootstrapCode() {
  if (isHostPinConfigured()) return "";
  if (bootstrapCode && Date.now() > bootstrapExpiresAt) {
    clearHostBootstrapCode();
  }
  if (!bootstrapCode) {
    bootstrapCode = String(crypto.randomInt(100000, 1000000));
    bootstrapExpiresAt = Date.now() + BOOTSTRAP_TTL_MS;
    writeFileAtomic(
      BOOTSTRAP_FILE,
      JSON.stringify(
        {
          code: bootstrapCode,
          expiresAt: bootstrapExpiresAt,
        },
        null,
        2
      )
    );
    try {
      fs.chmodSync(BOOTSTRAP_FILE, 0o600);
    } catch {
      /* Windows and some mounted filesystems do not support POSIX modes. */
    }
  }
  return bootstrapCode;
}

export function verifyHostBootstrapCode(candidate) {
  if (isHostPinConfigured() || !bootstrapCode) return false;
  if (Date.now() > bootstrapExpiresAt) {
    clearHostBootstrapCode();
    return false;
  }
  const cleaned = String(candidate || "").trim();
  const actual = Buffer.from(cleaned);
  const expected = Buffer.from(bootstrapCode);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export function clearHostBootstrapCode() {
  bootstrapCode = "";
  bootstrapExpiresAt = 0;
  try {
    fs.rmSync(BOOTSTRAP_FILE, { force: true });
  } catch {
    /* best-effort cleanup */
  }
}

export function hostBootstrapFileName() {
  return path.basename(BOOTSTRAP_FILE);
}

/** @deprecated use verifyHostPin — kept for older call sites */
export function getConfiguredPin() {
  return hostPinSource() ? "****" : "";
}

function scryptHash(pin, saltBuf) {
  return crypto.scryptSync(pin, saltBuf, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

export function verifyHostPin(candidate) {
  const pin = cleanPin(candidate);
  if (!pin) return false;

  const rec = loadPinRecord();
  if (rec) {
    try {
      const salt = Buffer.from(rec.salt, "base64");
      const expected = Buffer.from(rec.hash, "base64");
      const actual = scryptHash(pin, salt);
      if (expected.length !== actual.length) return false;
      return crypto.timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }

  const fromEnv = envPin();
  if (!fromEnv) return false;
  const a = Buffer.from(pin);
  const b = Buffer.from(fromEnv);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Persist a new host PIN (hashed). Revokes all sessions.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function setHostPin(newPin) {
  const pin = cleanPin(newPin);
  if (!pin) {
    return {
      ok: false,
      error: `PIN must be ${PIN_MIN}–${PIN_MAX} characters.`,
    };
  }
  const salt = crypto.randomBytes(16);
  const hash = scryptHash(pin, salt);
  const payload = {
    algo: "scrypt",
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
    updatedAt: Date.now(),
  };
  try {
    writeFileAtomic(PIN_FILE, JSON.stringify(payload, null, 2));
  } catch (err) {
    return { ok: false, error: err.message || "Could not save PIN." };
  }
  bustPinCache();
  revokeAllHostSessions();
  clearHostBootstrapCode();
  return { ok: true };
}

/**
 * Remove the file-based PIN. Env SETTINGS_PIN (if set) still applies.
 * @returns {{ ok: true, envStillSet?: boolean } | { ok: false, error: string }}
 */
export function clearHostPin() {
  const hadFile = !!loadPinRecord();
  try {
    fs.rmSync(PIN_FILE, { force: true });
  } catch (err) {
    return { ok: false, error: err.message || "Could not clear PIN." };
  }
  bustPinCache();
  revokeAllHostSessions();
  const envStillSet = !!envPin();
  if (!hadFile && envStillSet) {
    return {
      ok: false,
      error:
        "PIN is set via SETTINGS_PIN in .env — remove or blank that value to clear it.",
      envStillSet: true,
    };
  }
  return { ok: true, envStillSet };
}

export function hostPinStatus() {
  const source = hostPinSource();
  if (!source) ensureHostBootstrapCode();
  return {
    required: source != null,
    source,
    bootstrapRequired: source == null,
    bootstrapExpiresAt: source == null ? bootstrapExpiresAt : 0,
    /** True when a file PIN can be cleared from the UI (env-only needs .env edit). */
    removable: source === "file",
  };
}

export function hostSessionTtlSec() {
  return Math.floor(SESSION_TTL_MS / 1000);
}

export function createHostSession() {
  pruneExpiredSessions();
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export function revokeHostSession(token) {
  if (token) sessions.delete(String(token));
}

export function revokeAllHostSessions() {
  sessions.clear();
}

export function isValidHostToken(token) {
  if (!token) return false;
  const rec = sessions.get(String(token));
  if (!rec) return false;
  if (Date.now() > rec.expiresAt) {
    sessions.delete(String(token));
    return false;
  }
  return true;
}

/** @param {import("express").Request} req */
export function extractHostToken(req) {
  const hdr = String(req.get?.(HEADER_NAME) || "").trim();
  if (hdr) return hdr;

  const auth = String(req.get?.("authorization") || "");
  const bearer = /^Bearer\s+(\S+)/i.exec(auth);
  if (bearer) return bearer[1].trim();

  const cookieHeader = String(req.headers?.cookie || "");
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${COOKIE_NAME}=`)) continue;
    try {
      return decodeURIComponent(trimmed.slice(COOKIE_NAME.length + 1));
    } catch {
      return trimmed.slice(COOKIE_NAME.length + 1);
    }
  }
  return "";
}

/**
 * @param {import("express").Response} res
 * @param {string} token
 * @param {import("express").Request} [req] adds Secure when serving over TLS
 */
export function setHostSessionCookie(res, token, req = null) {
  const maxAge = hostSessionTtlSec();
  const secure =
    !!req &&
    (req.secure || String(req.get?.("x-forwarded-proto") || "") === "https");
  res.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; ` +
      `Max-Age=${maxAge}${secure ? "; Secure" : ""}`
  );
}

/** @param {import("express").Response} res */
export function clearHostSessionCookie(res) {
  res.append(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  );
}

/**
 * Express middleware: when a PIN is configured, require a valid host session
 * (cookie, X-PartyQueue-Host, or Authorization Bearer).
 */
export function requireHost(req, res, next) {
  if (!isHostPinConfigured()) return next();
  const token = extractHostToken(req);
  if (isValidHostToken(token)) return next();
  return res.status(401).json({
    ok: false,
    error: "Host PIN required.",
    pinRequired: true,
  });
}

/**
 * Strict variant for credential writes, restarts, and destructive resets:
 * when no PIN is configured these stay locked (instead of open) until the
 * host claims the booth with the bootstrap setup code and creates a PIN.
 */
export function requireHostStrict(req, res, next) {
  if (isHostPinConfigured()) return requireHost(req, res, next);
  ensureHostBootstrapCode();
  return res.status(401).json({
    ok: false,
    error:
      "Set a host PIN first — enter the setup code from " +
      `data/${hostBootstrapFileName()} under Settings → Security.`,
    pinRequired: true,
    bootstrapRequired: true,
  });
}

/**
 * Like requireHost, but browser navigations (OAuth login) get a short HTML page
 * instead of JSON.
 */
export function requireHostPage(req, res, next) {
  if (!isHostPinConfigured()) return next();
  const token = extractHostToken(req);
  if (isValidHostToken(token)) return next();
  const wantsHtml = String(req.get?.("accept") || "").includes("text/html");
  if (wantsHtml) {
    return res
      .status(401)
      .type("html")
      .send(
        "<!doctype html><meta charset='utf-8'><title>PIN required</title>" +
          "<body style='font-family:system-ui,sans-serif;background:#111;color:#eee;" +
          "display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>" +
          "<div style='text-align:center;max-width:28rem;padding:1.5rem'>" +
          "<h1>Host PIN required</h1>" +
          "<p>Unlock Settings with your PIN, then connect Spotify again.</p>" +
          "<p><a href='/' style='color:#9cf'>Back to PartyQueue</a></p>" +
          "</div></body>"
      );
  }
  return res.status(401).json({
    ok: false,
    error: "Host PIN required.",
    pinRequired: true,
  });
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [token, rec] of sessions) {
    if (now > rec.expiresAt) sessions.delete(token);
  }
}

/** Test helper — clear in-memory sessions. */
export function _resetHostSessionsForTests() {
  sessions.clear();
}

/** Test helper — drop cached PIN record. */
export function _bustHostPinCacheForTests() {
  bustPinCache();
}

/** Test helper — inspect/reset the short-lived first-run bootstrap code. */
export function _hostBootstrapCodeForTests() {
  return ensureHostBootstrapCode();
}

export function _resetHostBootstrapForTests() {
  clearHostBootstrapCode();
}
