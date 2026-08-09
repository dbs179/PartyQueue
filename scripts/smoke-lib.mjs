/**
 * Shared helpers for live PartyQueue smoke scripts.
 * Host PIN: set PQ_HOST_PIN (or SETTINGS_PIN) when SETTINGS_PIN is enabled.
 */
export const BASE = process.env.PQ_BASE || "http://127.0.0.1:8088";

let hostToken = process.env.PQ_HOST_TOKEN || "";
let hostCookie = process.env.PQ_HOST_COOKIE || "";

function requestOrigin() {
  try {
    return new URL(BASE).origin;
  } catch {
    return "";
  }
}

export async function api(method, pathName, body, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = {};
    const m = String(method || "").toUpperCase();
    if (m === "POST" || m === "DELETE" || m === "PUT" || m === "PATCH") {
      const origin = requestOrigin();
      if (origin) headers.Origin = origin;
    }
    if (body) headers["Content-Type"] = "application/json";
    if (hostToken) headers["X-PartyQueue-Host"] = hostToken;
    if (hostCookie) headers.Cookie = hostCookie;
    const res = await fetch(`${BASE}${pathName}`, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) hostCookie = setCookie.split(";", 1)[0];
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(
        `${method} ${pathName} → ${res.status}: ${String(text).slice(0, 200)}`
      );
      err.status = res.status;
      err.json = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

/** Unlock host APIs when a PIN is configured. No-op if PIN is blank/unset. */
export async function ensureHostAuth() {
  const pin = (process.env.PQ_HOST_PIN || process.env.SETTINGS_PIN || "").trim();
  if (!pin) return false;
  await api("POST", "/api/settings/verify-pin", { pin });
  return !!(hostCookie || hostToken);
}

export async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

export async function vol() {
  return Number((await api("GET", "/api/volume")).volume);
}

export async function np() {
  return api("GET", "/api/nowplaying");
}

export async function queueList() {
  return api("GET", "/api/queue/list");
}

export function near(a, b, tol = 2) {
  return Math.abs(Number(a) - Number(b)) <= tol;
}

export async function nudgeVolumeTo(target) {
  let v = await vol();
  let guard = 0;
  while (Math.abs(v - target) > 0 && guard++ < 60) {
    const step = Math.min(5, Math.abs(target - v));
    await api("POST", `/api/volume/${v < target ? "up" : "down"}?step=${step}`);
    await sleep(280);
    v = await vol();
  }
  return v;
}

export async function searchTrack(q) {
  const j = await api("GET", `/api/search?q=${encodeURIComponent(q)}`);
  const list = Array.isArray(j) ? j : j.results || j.tracks || [];
  const t = list[0];
  if (!t?.uri) {
    throw new Error(`No search hit for ${q}: ${JSON.stringify(j).slice(0, 180)}`);
  }
  return {
    uri: t.uri,
    name: t.name || t.title,
    artist: t.artist || t.artists || "Unknown",
  };
}

export function isAnnouncePadTrack(t) {
  const uri = String(t?.uri || t?.TrackUri || "");
  const title = String(t?.title || t?.Title || "");
  return (
    /silence-ramp-|\/media\/tts\/|tts_proxy/i.test(uri) ||
    /PartyQueue (Silence Bridge|Volume Ramp)|DJ /i.test(title)
  );
}

/** Upcoming tracks from GET /api/queue/list (array or { tracks }). */
export function queueTracks(queueJson) {
  if (Array.isArray(queueJson)) return queueJson;
  if (Array.isArray(queueJson?.tracks)) return queueJson.tracks;
  return [];
}

/**
 * Count upcoming DJ TTS rows in the guest queue list.
 * Note: silence ramps are hidden from /api/queue/list, so we count TTS clips.
 */
export function countUpcomingDjClips(queueJson) {
  return queueTracks(queueJson).filter(
    (t) =>
      t?.djVoice ||
      (/tts_proxy|\/media\/tts\//i.test(String(t?.uri || "")) &&
        !/silence/i.test(String(t?.uri || "")))
  ).length;
}
