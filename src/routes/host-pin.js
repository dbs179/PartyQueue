// Host PIN gate routes. Optional SETTINGS_PIN: UI gates DJ Booth; when set,
// requireHost also protects host APIs (settings, credentials, resets, restart,
// guest admin, uploads). Party controls (transport, volume, Random, clear
// queue, Mix) stay open on the LAN. Leave PIN blank and requireHost is a
// no-op. PIN is never sent to clients.

import { upsertEnvKeys } from "../env-file.js";
import {
  isHostPinConfigured,
  hostPinStatus,
  verifyHostPin,
  verifyHostBootstrapCode,
  ensureHostBootstrapCode,
  setHostPin,
  clearHostPin,
  createHostSession,
  setHostSessionCookie,
  clearHostSessionCookie,
  extractHostToken,
  isValidHostToken,
} from "../host-auth.js";
import { setContentSettings } from "../settings.js";
import { nudgePartySettingsStream } from "../party-settings-http.js";

const PIN_MAX_FAILS = 5; // failures before a short lockout kicks in
const PIN_LOCK_MS = 30_000;

/** @param {import('express').Express} app */
export function registerHostPinRoutes(app) {
  const pinAttempts = new Map(); // client key -> { fails, lockUntil }

  function pinClientKey(req) {
    const key = req.ip || req.socket?.remoteAddress || "unknown";
    // Bound the map under IP-spoofing floods: drop expired locks first, then
    // oldest entries. Locked-out clients stay locked for their window.
    if (pinAttempts.size > 500) {
      const now = Date.now();
      for (const [ip, rec] of pinAttempts) {
        if (rec.lockUntil <= now) pinAttempts.delete(ip);
      }
      while (pinAttempts.size > 500) {
        pinAttempts.delete(pinAttempts.keys().next().value);
      }
    }
    return key;
  }

  // Whether a host PIN is configured (file hash and/or SETTINGS_PIN env).
  app.get("/api/settings/pin-required", (_req, res) => {
    res.json(hostPinStatus());
  });

  // Whether this browser still holds a valid host session. Lets the UI
  // re-lock the DJ Booth after the server session expires or a restart wipes
  // it (the client's own "unlocked" flag would otherwise outlive it). Never
  // issues or refreshes a session.
  app.get("/api/settings/pin-session", (req, res) => {
    if (!isHostPinConfigured()) return res.json({ ok: true });
    res.json({ ok: isValidHostToken(extractHostToken(req)) });
  });

  // Verify a candidate PIN. Lockout blunts LAN brute force. On success issues
  // an HttpOnly host-session cookie; the token is never exposed to JavaScript.
  app.post("/api/settings/verify-pin", (req, res) => {
    if (!isHostPinConfigured()) return res.json({ ok: true });

    const key = pinClientKey(req);
    const now = Date.now();
    const rec = pinAttempts.get(key) || { fails: 0, lockUntil: 0 };

    if (rec.lockUntil > now) {
      return res
        .status(429)
        .json({ ok: false, error: "Too many attempts.", retryMs: rec.lockUntil - now });
    }

    const candidate = typeof req.body?.pin === "string" ? req.body.pin : "";
    if (candidate && verifyHostPin(candidate)) {
      pinAttempts.delete(key);
      const token = createHostSession();
      setHostSessionCookie(res, token, req);
      return res.json({ ok: true });
    }

    rec.fails += 1;
    if (rec.fails >= PIN_MAX_FAILS) {
      rec.lockUntil = now + PIN_LOCK_MS;
      rec.fails = 0;
    }
    pinAttempts.set(key, rec);
    return res.status(401).json({ ok: false, error: "Incorrect PIN." });
  });

  // Set or change host PIN (stored hashed in data/host-pin.json).
  // First-time set requires the short-lived bootstrap code in the data volume.
  // Change requires the current PIN or a valid host session.
  app.post("/api/settings/pin", (req, res) => {
    const nextPin = typeof req.body?.pin === "string" ? req.body.pin : "";
    const currentPin =
      typeof req.body?.currentPin === "string" ? req.body.currentPin : "";

    if (isHostPinConfigured()) {
      const token = extractHostToken(req);
      const sessionOk = isValidHostToken(token);
      const currentOk = currentPin && verifyHostPin(currentPin);
      if (!sessionOk && !currentOk) {
        return res.status(401).json({
          ok: false,
          error: "Enter your current PIN to change it.",
          pinRequired: true,
        });
      }
    } else {
      ensureHostBootstrapCode();
      const key = pinClientKey(req);
      const now = Date.now();
      const rec = pinAttempts.get(key) || { fails: 0, lockUntil: 0 };
      if (rec.lockUntil > now) {
        return res.status(429).json({
          ok: false,
          error: "Too many setup-code attempts.",
          retryMs: rec.lockUntil - now,
          bootstrapRequired: true,
        });
      }
      if (!verifyHostBootstrapCode(req.body?.bootstrapCode)) {
        rec.fails += 1;
        if (rec.fails >= PIN_MAX_FAILS) {
          rec.lockUntil = now + PIN_LOCK_MS;
          rec.fails = 0;
        }
        pinAttempts.set(key, rec);
        return res.status(401).json({
          ok: false,
          error: "Enter the setup code from data/host-bootstrap-code.json.",
          bootstrapRequired: true,
        });
      }
      pinAttempts.delete(key);
    }

    const result = setHostPin(nextPin);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }
    // Prefer the hashed file PIN — drop plain SETTINGS_PIN from .env if present.
    try {
      upsertEnvKeys({ SETTINGS_PIN: null });
      delete process.env.SETTINGS_PIN;
    } catch (err) {
      console.warn("[settings/pin] could not clear SETTINGS_PIN from .env:", err.message);
    }
    const token = createHostSession();
    setHostSessionCookie(res, token, req);
    res.json({ ok: true, ...hostPinStatus() });
  });

  // Clear file-based PIN. Env SETTINGS_PIN must be removed from .env separately.
  app.delete("/api/settings/pin", (req, res) => {
    if (!isHostPinConfigured()) {
      return res.json({ ok: true, ...hostPinStatus() });
    }
    const token = extractHostToken(req);
    const sessionOk = isValidHostToken(token);
    const currentPin =
      typeof req.body?.currentPin === "string" ? req.body.currentPin : "";
    const currentOk = currentPin && verifyHostPin(currentPin);
    if (!sessionOk && !currentOk) {
      return res.status(401).json({
        ok: false,
        error: "Unlock with your PIN first, or send currentPin.",
        pinRequired: true,
      });
    }
    const result = clearHostPin();
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error, ...hostPinStatus() });
    }
    setContentSettings({ hostControlsOnly: false });
    nudgePartySettingsStream();
    clearHostSessionCookie(res);
    res.json({ ok: true, ...hostPinStatus() });
  });
}
