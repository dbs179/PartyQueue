import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  setConnStatus,
  paintConnStatusUnavailable,
  applySpotifyAppStatus,
  applyLastfmStatus,
  applyHaStatus,
  applySonosConnStatus,
  applySpotifyAccountStatus,
  paintSpotifyAccountUnavailable,
} from "../public/js/connection-status.js";

function makeEl(initial = {}) {
  const classes = new Set(initial.classes || []);
  return {
    textContent: initial.textContent || "",
    value: initial.value ?? "",
    placeholder: initial.placeholder || "",
    readOnly: !!initial.readOnly,
    disabled: !!initial.disabled,
    classList: {
      add: (c) => classes.add(c),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    _classes: classes,
  };
}

beforeEach(() => {
  globalThis.document = { activeElement: null };
  globalThis.window = { location: { origin: "http://party.local" } };
});

afterEach(() => {
  delete globalThis.document;
  delete globalThis.window;
});

test("setConnStatus swaps class + text", () => {
  const el = makeEl({ classes: ["status-unknown"] });
  setConnStatus(el, "connected", "Credentials OK");
  assert.equal(el.textContent, "Credentials OK");
  assert.ok(el.classList.contains("status-connected"));
  assert.ok(!el.classList.contains("status-unknown"));
});

test("paintConnStatusUnavailable uses unknown + default label", () => {
  const el = makeEl();
  paintConnStatusUnavailable(el);
  assert.equal(el.textContent, "Unavailable");
  assert.ok(el.classList.contains("status-unknown"));
});

test("applySpotifyAppStatus paints configured credentials + fields", () => {
  const els = {
    statusEl: makeEl(),
    clientIdInput: makeEl(),
    clientSecretInput: makeEl(),
    redirectInput: makeEl(),
    marketInput: makeEl(),
    secretHint: makeEl(),
    saveBtn: makeEl({ disabled: true }),
    clearBtn: makeEl({ disabled: true }),
  };
  applySpotifyAppStatus(els, {
    configured: true,
    clientId: "cid",
    clientSecretSet: true,
    redirectUri: "http://party.local/auth/callback",
    market: "CA",
  });
  assert.equal(els.statusEl.textContent, "Credentials OK");
  assert.ok(els.statusEl.classList.contains("status-connected"));
  assert.equal(els.clientIdInput.value, "cid");
  assert.equal(els.clientSecretInput.value, "********");
  assert.equal(els.marketInput.value, "CA");
  assert.equal(els.saveBtn.disabled, false);
});

test("applySpotifyAppStatus suggests callback when redirect missing", () => {
  const redirectInput = makeEl();
  applySpotifyAppStatus(
    { statusEl: makeEl(), redirectInput },
    { configured: false }
  );
  assert.equal(redirectInput.value, "http://party.local/auth/callback");
});

test("applyLastfmStatus masks key when set", () => {
  const els = {
    statusEl: makeEl(),
    keyInput: makeEl(),
    keyHint: makeEl(),
    saveBtn: makeEl({ disabled: true }),
    clearBtn: makeEl({ disabled: true }),
  };
  applyLastfmStatus(els, { configured: true, apiKeySet: true });
  assert.equal(els.statusEl.textContent, "Credentials OK");
  assert.equal(els.keyInput.value, "********");
  assert.equal(els.saveBtn.disabled, false);
});

test("applyHaStatus paints url and masked token", () => {
  const els = {
    statusEl: makeEl(),
    urlInput: makeEl(),
    tokenInput: makeEl(),
    tokenHint: makeEl(),
    saveBtn: makeEl({ disabled: true }),
    clearBtn: makeEl({ disabled: true }),
  };
  applyHaStatus(els, {
    configured: false,
    url: "http://ha.local",
    tokenSet: false,
  });
  assert.equal(els.statusEl.textContent, "Credentials missing");
  assert.equal(els.urlInput.value, "http://ha.local");
  assert.equal(els.tokenInput.value, "");
  assert.match(els.tokenInput.placeholder, /token/i);
});

test("applySonosConnStatus distinguishes pinned vs discovery", () => {
  const els = {
    statusEl: makeEl(),
    hostInput: makeEl(),
    roomInput: makeEl(),
    saveBtn: makeEl({ disabled: true }),
    clearBtn: makeEl({ disabled: true }),
  };
  applySonosConnStatus(els, {
    hostSet: true,
    host: "192.168.1.10",
    room: "Kitchen",
  });
  assert.equal(els.statusEl.textContent, "Pinned IP");
  assert.ok(els.statusEl.classList.contains("status-connected"));
  assert.equal(els.hostInput.value, "192.168.1.10");
  assert.equal(els.roomInput.value, "Kitchen");

  applySonosConnStatus(els, { hostSet: false, host: "", room: "" });
  assert.equal(els.statusEl.textContent, "Discovery");
  assert.ok(els.statusEl.classList.contains("status-limited"));
});

test("applySpotifyAccountStatus covers linked / limited / unlinked", () => {
  const els = { statusEl: makeEl(), cacheWarmed: makeEl() };
  const now = Date.parse("2026-08-08T12:00:00Z");

  applySpotifyAccountStatus(
    els,
    { connected: true, poolWarmedAt: now - 120_000 },
    { now }
  );
  assert.equal(els.statusEl.textContent, "Account linked");
  assert.equal(els.cacheWarmed.value, "2m ago");

  applySpotifyAccountStatus(els, {
    connected: true,
    rateLimited: true,
    cooldownSeconds: 90,
  });
  assert.match(els.statusEl.textContent, /Rate-limited/);
  assert.match(els.statusEl.textContent, /1m 30s/);

  applySpotifyAccountStatus(els, { connected: false });
  assert.equal(els.statusEl.textContent, "Account not linked");
  assert.equal(els.cacheWarmed.value, "Account not linked");
});

test("paintSpotifyAccountUnavailable sets both fields", () => {
  const els = { statusEl: makeEl(), cacheWarmed: makeEl({ value: "x" }) };
  paintSpotifyAccountUnavailable(els);
  assert.equal(els.statusEl.textContent, "Status unavailable");
  assert.equal(els.cacheWarmed.value, "Unavailable");
});
