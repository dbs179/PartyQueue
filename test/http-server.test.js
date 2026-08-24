import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), `pq-http-server-${process.pid}-`)
);
process.env.PARTYQUEUE_SETTINGS_FILE = path.join(tmpRoot, "settings.json");
process.env.PARTYQUEUE_HOST_PIN_FILE = path.join(tmpRoot, "host-pin.json");
process.env.PARTYQUEUE_HISTORY_FILE = path.join(tmpRoot, "history.json");
process.env.PARTYQUEUE_COOLDOWN_FILE = path.join(tmpRoot, "cooldowns.json");
process.env.PARTYQUEUE_REQUESTS_FILE = path.join(tmpRoot, "requests.json");
process.env.PARTYQUEUE_REACTIONS_FILE = path.join(tmpRoot, "reactions.json");
process.env.PARTYQUEUE_SUGGESTIONS_FILE = path.join(tmpRoot, "suggestions.json");
process.env.PARTYQUEUE_GUESTS_FILE = path.join(tmpRoot, "guests.json");
process.env.PARTYQUEUE_ORIGIN_FILE = path.join(tmpRoot, "origins.json");
process.env.PARTYQUEUE_DJ_MEMORY_FILE = path.join(tmpRoot, "dj-memory.json");
delete process.env.SETTINGS_PIN;
// Avoid requiring Origin on bare fetch helpers used by this harness.
process.env.PUBLIC_BASE_URL = "";

const { createApp, startServer, shutdownServer } = await import(
  "../src/server.js"
);

describe("HTTP server harness", { concurrency: false }, () => {
  let baseUrl = "";
  let runtime = null;

  before(async () => {
    const harness = createApp();
    assert.equal(harness.listening, false);

    runtime = startServer({
      port: 18089,
      host: "127.0.0.1",
      signals: false,
      seed: false,
      warm: false,
      exit() {
        /* keep the test runner alive */
      },
    });
    if (!runtime.httpServer.listening) {
      await once(runtime.httpServer, "listening");
    }
    baseUrl = `http://127.0.0.1:${runtime.port}`;
  });

  after(async () => {
    await shutdownServer({ reason: "http-server.test teardown", exit: false });
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("GET /api/health stays a stable liveness contract", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("x-request-id"));
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, "string");
    assert.equal(typeof body.spotifyConfigured, "boolean");
  });

  test("GET /api/ready reports listening while the harness is up", async () => {
    const res = await fetch(`${baseUrl}/api/ready`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ready, true);
    assert.equal(typeof body.partyReady, "boolean");
    assert.equal(body.checks.listening, true);
    assert.equal(body.checks.shuttingDown, false);
    assert.equal(body.checks.dataWritable, true);
    assert.equal(typeof body.checks.spotifyConfigured, "boolean");
    assert.equal(typeof body.checks.sonosHostConfigured, "boolean");
    assert.equal(typeof body.checks.sonosOk, "boolean");
    assert.ok(
      ["connecting", "connected", "disconnected", "unknown"].includes(
        body.checks.sonos
      )
    );
    assert.equal(typeof body.checks.nowPlaying, "object");
  });

  test("cross-origin POSTs are blocked by the CSRF guard", async () => {
    const res = await fetch(`${baseUrl}/api/queue/clear`, {
      method: "POST",
      headers: {
        Origin: "http://evil.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error || "", /cross-origin/i);
  });

  test("incoming X-Request-Id is echoed on responses", async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { "X-Request-Id": "phase2-test-id" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-request-id"), "phase2-test-id");
  });

  test("static UI modules are served with Cache-Control: no-store", async () => {
    const res = await fetch(`${baseUrl}/js/main.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") || "", /no-store/i);
    const body = await res.text();
    assert.match(body, /import\s+["']\.\/app\.js["']/);
  });

  test("branded index does not leave the dev-reload placeholder", async () => {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.doesNotMatch(html, /__PQ_DEV_RELOAD__/);
    assert.match(page.headers.get("cache-control") || "", /no-store/i);
  });

  test("branded index loads the bundled client with a version query", async () => {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /js\/dist\/main\.js\?v=/);
    assert.doesNotMatch(html, /__PQ_VERSION__/);
  });

  test("brand JSON and Look page expose desktop + phone banners", async () => {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /heroBannerMobile/);
    assert.match(html, /headerFontSizeMobile/);
    assert.match(html, /id="banner-mobile-gallery"/);
    assert.match(html, /id="banner-mobile-upload-btn"/);
    assert.match(html, /id="set-header-font-size-mobile"/);
    assert.match(html, /id="set-header-all-caps-mobile"/);
    assert.match(html, /slot=.*mobile|matchMedia\("\(min-width: 960px\)"\)/);

    const desktopBanner = await fetch(`${baseUrl}/banner?slot=desktop&b=default`);
    assert.equal(desktopBanner.status, 200);
    assert.match(desktopBanner.headers.get("content-type") || "", /image\//);

    const mobileBanner = await fetch(`${baseUrl}/banner?slot=mobile&b=default`);
    assert.equal(mobileBanner.status, 200);
    assert.match(mobileBanner.headers.get("content-type") || "", /image\//);
  });

  test("Party Display assets and join QR are available without Sonos", async () => {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /id="view-display"/);
    assert.match(html, /id="display-queue"/);

    const join = await fetch(`${baseUrl}/api/join`);
    assert.equal(join.status, 200);
    const body = await join.json();
    assert.match(body.url || "", /^https?:\/\//);
    assert.match(body.qrSvg || "", /<svg[\s>]/i);
    assert.match(body.qrPng || "", /^data:image\/png;base64,/);
    assert.equal(Object.hasOwn(body, "password"), false);
    assert.equal(Object.hasOwn(body, "guestWifiPassword"), false);
    assert.equal(typeof body.wifiSsid, "string");
  });

  test("request fairness controls are present in Queue settings", async () => {
    const page = await fetch(`${baseUrl}/`);
    const html = await page.text();
    assert.match(html, /id="set-request-fairness-enabled"/);
    assert.match(html, /id="set-request-fairness-threshold"/);
    assert.match(html, /id="set-request-fairness-upcoming"/);
    assert.match(html, /id="set-request-fairness-rolling-max"/);
    assert.match(html, /id="set-request-fairness-window"/);
    assert.match(html, /id="set-request-fairness-host-bypass"/);
    assert.match(html, /id="set-set-request-fairness-enabled"/);
    assert.match(html, /id="set-set-request-fairness-window"/);
    assert.match(html, /id="settings-clear-fairness"/);
    assert.match(html, /id="settings-clear-dj-shout-memory"/);
    assert.match(html, /id="booth-new-party"/);
    assert.match(html, /id="set-loved-reaction-set"/);
    assert.match(html, /id="set-hated-reaction-set"/);
    assert.match(html, /id="set-requested-reaction-set"/);
    assert.match(html, /id="set-special-set-every"/);
  });

  test("GET /api/settings/pin-required reports whether a host PIN is set", async () => {
    const res = await fetch(`${baseUrl}/api/settings/pin-required`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.required, "boolean");
  });

  test("GET /api/settings/pin-session reports the host session state", async () => {
    // This client holds no host session cookie, so ok mirrors the PIN state:
    // true only when there is no PIN to gate (dotenv may supply SETTINGS_PIN).
    const res = await fetch(`${baseUrl}/api/settings/pin-session`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const pin = await (await fetch(`${baseUrl}/api/settings/pin-required`)).json();
    assert.equal(body.ok, !pin.required);
  });
});


