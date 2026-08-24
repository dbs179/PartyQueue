// Guest Wi-Fi QR for Party Display. Password stays server-side; /api/join
// only returns the SSID and a WIFI: payload image.

import { loadSettings, saveSettings } from "./settings.js";

const SSID_MAX = 64;
const PASS_MAX = 128;

function cleanSsid(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, SSID_MAX);
}

function cleanPassword(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, PASS_MAX);
}

/** ZXing / Android / iOS WIFI: field escaping. */
export function escapeWifiQrField(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/([";,:])/g, "\\$1");
}

/**
 * @param {{ ssid?: string, password?: string, hidden?: boolean }} opts
 * @returns {string} empty when there is no SSID
 */
export function wifiQrPayload({ ssid, password, hidden = false } = {}) {
  const s = cleanSsid(ssid);
  if (!s) return "";
  const p = cleanPassword(password);
  const hiddenPart = hidden ? "H:true;" : "";
  if (!p) {
    return `WIFI:T:nopass;S:${escapeWifiQrField(s)};${hiddenPart};`;
  }
  return `WIFI:T:WPA;S:${escapeWifiQrField(s)};P:${escapeWifiQrField(p)};${hiddenPart};`;
}

export function getGuestWifiSettings() {
  const s = loadSettings();
  return {
    guestWifiSsid: cleanSsid(s.guestWifiSsid || process.env.GUEST_WIFI_SSID || ""),
    guestWifiPassword: cleanPassword(
      s.guestWifiPassword || process.env.GUEST_WIFI_PASSWORD || ""
    ),
  };
}

/** SSID + QR payload only — never expose the password to guests. */
export function getGuestWifiPublic() {
  const { guestWifiSsid, guestWifiPassword } = getGuestWifiSettings();
  const payload = wifiQrPayload({
    ssid: guestWifiSsid,
    password: guestWifiPassword,
  });
  if (!payload) return null;
  return { ssid: guestWifiSsid, payload };
}

export function setGuestWifiSettings(partial = {}) {
  const next = { ...loadSettings() };
  if (partial.guestWifiSsid != null) {
    const ssid = cleanSsid(partial.guestWifiSsid);
    if (ssid) next.guestWifiSsid = ssid;
    else delete next.guestWifiSsid;
  }
  if (partial.guestWifiPassword != null) {
    const password = cleanPassword(partial.guestWifiPassword);
    if (password) next.guestWifiPassword = password;
    else delete next.guestWifiPassword;
  }
  saveSettings(next);
  return getGuestWifiSettings();
}
