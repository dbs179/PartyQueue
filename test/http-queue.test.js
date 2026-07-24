// HTTP-level contract tests for the /api/queue* routes. Boots the real server
// (no Sonos, no seeding, no cache warm) with SONOS_HOST pinned to 127.0.0.1 so
// every speaker call fails fast with connection-refused instead of scanning
// the real LAN. Covers input validation, guest-identity requirements, the
// Sonos-unreachable error shape, rate-limit responses, and the SSE stream
// handshake. Happy paths that need a live speaker stay in the smoke scripts.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), `pq-http-queue-${process.pid}-`)
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
// No Sonos speaker here: connection refused beats a 10s LAN discovery sweep,
// and it guarantees the suite never touches real speakers on the dev network.
process.env.SONOS_HOST = "127.0.0.1";
delete process.env.SONOS_ROOM;

const { startServer, shutdownServer } = await import("../src/server.js");

const TRACK = {
  uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
  name: "Never Gonna Give You Up",
  artist: "Rick Astley",
};

describe("/api/queue* HTTP contracts", { concurrency: false }, () => {
  let baseUrl = "";
  let runtime = null;

  before(async () => {
    runtime = startServer({
      port: 18091,
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
    await shutdownServer({ reason: "http-queue.test teardown", exit: false });
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function postJson(pathname, body) {
    return fetch(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("GET /api/queue/list reports 502 with an error when Sonos is unreachable", async () => {
    const res = await fetch(`${baseUrl}/api/queue/list`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(typeof body.error, "string");
    assert.ok(body.error.length > 0);
  });

  test("POST /api/queue validates uri, guest name, and surfaces Sonos failures", async () => {
    // Burst limit is 3 per 10s per IP; these three are the budget.
    const noUri = await postJson("/api/queue", { name: "x" });
    assert.equal(noUri.status, 400);
    assert.match((await noUri.json()).error, /uri/i);

    const noName = await postJson("/api/queue", { uri: TRACK.uri });
    assert.equal(noName.status, 400);
    assert.match((await noName.json()).error, /name/i);

    const valid = await postJson("/api/queue", {
      ...TRACK,
      requestedBy: "Smoke Tester",
      requestedByUser: "Smoke Tester",
    });
    assert.equal(valid.status, 502);
    assert.equal(typeof (await valid.json()).error, "string");
  });

  test("POST /api/queue rate-limits the fourth burst request", async () => {
    const res = await postJson("/api/queue", {
      ...TRACK,
      requestedBy: "Smoke Tester",
      requestedByUser: "Smoke Tester",
    });
    assert.equal(res.status, 429);
    assert.ok(res.headers.get("retry-after"));
    const body = await res.json();
    assert.equal(typeof body.error, "string");
    assert.equal(typeof body.retryMs, "number");
  });

  test("POST /api/queue/dedication rejects a malformed track uri", async () => {
    const res = await postJson("/api/queue/dedication", {
      uri: "not-a-spotify-uri",
      dedication: "for the crew",
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /uri/i);
  });

  test("destructive queue routes validate input and share one rate limit", async () => {
    // destructiveLimit allows 2 per 2.5s per IP across remove/reorder/clear.
    const remove = await postJson("/api/queue/remove", {});
    assert.equal(remove.status, 400);
    assert.match((await remove.json()).error, /uri/i);

    const reorder = await postJson("/api/queue/reorder", {});
    assert.equal(reorder.status, 400);
    assert.match((await reorder.json()).error, /uri/i);

    const limited = await postJson("/api/queue/clear", {});
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get("retry-after"));
  });

  test("GET /api/queue/stream opens an SSE stream and sends queue-status first", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/queue/stream`, {
      signal: controller.signal,
    });
    try {
      assert.equal(res.status, 200);
      assert.match(
        res.headers.get("content-type") || "",
        /text\/event-stream/
      );
      assert.match(res.headers.get("cache-control") || "", /no-cache/);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const deadline = Date.now() + 5000;
      while (!buffer.includes("event: queue-status") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      assert.match(buffer, /retry: 3000/);
      assert.match(buffer, /event: queue-status/);
      assert.match(buffer, /data: \{/);
    } finally {
      controller.abort();
    }
  });
});
