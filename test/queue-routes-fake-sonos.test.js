// Happy-path tests for the queue routes against a scripted fake speaker,
// injected through the ctx.sonos seam in registerQueueRoutes. These cover
// what test/http-queue.test.js cannot: adds that succeed, list contents,
// remove/reorder/clear actually mutating the queue, and request-fairness
// decisions driven by the injected queue snapshot.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), `pq-queue-fake-${process.pid}-`)
);
for (const key of [
  "SETTINGS_FILE",
  "HOST_PIN_FILE",
  "HISTORY_FILE",
  "COOLDOWN_FILE",
  "REQUESTS_FILE",
  "REACTIONS_FILE",
  "SUGGESTIONS_FILE",
  "GUESTS_FILE",
  "ORIGIN_FILE",
  "DJ_MEMORY_FILE",
]) {
  process.env[`PARTYQUEUE_${key}`] = path.join(tmpRoot, `${key}.json`);
}
delete process.env.SETTINGS_PIN;
process.env.SONOS_HOST = "127.0.0.1";

const express = (await import("express")).default;
const { registerQueueRoutes } = await import("../src/routes/queue.js");
const { setRequestFairnessSettings } = await import("../src/settings.js");
const { clearRequests, getRequests } = await import("../src/request-log.js");

/** In-memory stand-in for the Sonos queue. */
function createFakeSonos() {
  const tracks = [];
  return {
    tracks,
    async getQueueList() {
      return tracks.map((t, i) => ({ ...t, position: i + 1 }));
    },
    async addTrackToQueue(uri, { name, artist, requestedBy, requestedByUser } = {}) {
      // Mirror the real contract: re-adding an already-queued track is
      // idempotent and reports requestCreated: false.
      const existing = tracks.findIndex((t) => t.uri === uri);
      if (existing !== -1) {
        return {
          queuePosition: existing + 1,
          absoluteQueuePosition: existing + 1,
          queueWasEmpty: false,
          requestCreated: false,
        };
      }
      tracks.push({ uri, title: name, artist, searched: true, requestedBy, requestedByUser });
      return {
        queuePosition: tracks.length,
        absoluteQueuePosition: tracks.length,
        queueWasEmpty: tracks.length === 1,
        requestCreated: true,
      };
    },
    async removeQueueTrack({ uri }) {
      const i = tracks.findIndex((t) => t.uri === uri);
      if (i === -1) throw new Error("Track not found in queue.");
      tracks.splice(i, 1);
      return { removed: 1 };
    },
    async reorderQueueTrack({ uri, beforeUri }) {
      const from = tracks.findIndex((t) => t.uri === uri);
      const to = tracks.findIndex((t) => t.uri === beforeUri);
      if (from === -1 || to === -1) throw new Error("Track not found in queue.");
      const [moved] = tracks.splice(from, 1);
      tracks.splice(to > from ? to - 1 : to, 0, moved);
      return { moved: true };
    },
    async clearQueueWithoutAutoRefill() {
      const cleared = tracks.length;
      tracks.length = 0;
      return { cleared };
    },
    async addPlaylistToQueue() {
      return { added: 0 };
    },
    async addRandomFromPlaylists() {
      return { added: 0 };
    },
    async play() {
      return { playing: true };
    },
    invalidateSonosSnapshots() {},
  };
}

const passthrough = (_req, _res, next) => next();

describe("queue routes with a fake speaker", { concurrency: false }, () => {
  let server = null;
  let baseUrl = "";
  let fake = null;

  before(async () => {
    fake = createFakeSonos();
    const app = express();
    app.use(express.json());
    registerQueueRoutes(app, {
      queueBurstLimit: passthrough,
      queueSustainedLimit: passthrough,
      destructiveLimit: passthrough,
      sonos: fake,
    });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
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

  const TRACK_A = {
    uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
    name: "Never Gonna Give You Up",
    artist: "Rick Astley",
  };
  const TRACK_B = {
    uri: "spotify:track:0V3wPSX9ygBnCm8psDIegu",
    name: "Anti-Hero",
    artist: "Taylor Swift",
  };

  test("POST /api/queue adds the track and records the request", async () => {
    clearRequests();
    const res = await postJson("/api/queue", {
      ...TRACK_A,
      requestedBy: "Ada",
      requestedByUser: "Ada",
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.queuePosition, 1);
    assert.equal(fake.tracks.length, 1);
    assert.equal(fake.tracks[0].uri, TRACK_A.uri);
    assert.equal(fake.tracks[0].requestedByUser, "Ada");

    const events = getRequests();
    assert.equal(events.length, 1);
    assert.equal(events[0].requestedBy, "Ada");
  });

  test("GET /api/queue/list returns the fake queue contents", async () => {
    await postJson("/api/queue", {
      ...TRACK_B,
      requestedBy: "Grace",
      requestedByUser: "Grace",
    });
    const res = await fetch(`${baseUrl}/api/queue/list`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tracks.length, 2);
    assert.deepEqual(
      body.tracks.map((t) => t.uri),
      [TRACK_A.uri, TRACK_B.uri]
    );
  });

  test("POST /api/queue/reorder moves a track ahead of another", async () => {
    const res = await postJson("/api/queue/reorder", {
      uri: TRACK_B.uri,
      beforeUri: TRACK_A.uri,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.deepEqual(
      fake.tracks.map((t) => t.uri),
      [TRACK_B.uri, TRACK_A.uri]
    );
  });

  test("POST /api/queue/remove deletes the requested track", async () => {
    const res = await postJson("/api/queue/remove", { uri: TRACK_B.uri });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.deepEqual(fake.tracks.map((t) => t.uri), [TRACK_A.uri]);
  });

  test("request fairness denies via the injected queue snapshot", async () => {
    setRequestFairnessSettings({
      requestFairnessEnabled: true,
      requestFairnessUpcomingThreshold: 1,
      requestFairnessUpcomingCap: 1,
    });
    try {
      // Ada already has TRACK_A upcoming (searched). A second distinct request
      // from Ada must hit the upcoming cap and never reach the speaker.
      fake.tracks[0].requestedByUser = "Ada";
      const before = fake.tracks.length;
      const res = await postJson("/api/queue", {
        ...TRACK_B,
        requestedBy: "Ada",
        requestedByUser: "Ada",
      });
      assert.equal(res.status, 409);
      const body = await res.json();
      assert.equal(body.code, "upcoming_cap");
      assert.equal(fake.tracks.length, before);
    } finally {
      setRequestFairnessSettings({ requestFairnessEnabled: false });
    }
  });

  test("re-requesting an upcoming track is idempotent", async () => {
    clearRequests();
    const res = await postJson("/api/queue", {
      ...TRACK_A,
      requestedBy: "Linus",
      requestedByUser: "Linus",
    });
    assert.equal(res.status, 200);
    // addTrackToQueue reports requestCreated: false — no new queue slot and
    // no rolling-quota / Party Stats event is consumed.
    assert.equal(fake.tracks.length, 1);
    assert.equal(getRequests().length, 0);
  });

  test("POST /api/queue/clear empties the queue", async () => {
    const res = await postJson("/api/queue/clear", {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(fake.tracks.length, 0);
  });
});
