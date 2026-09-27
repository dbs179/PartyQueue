// Write-behind guest adds: the guest is answered immediately, the speaker work
// happens in add-drainer.js, and add-trueup.js reconciles between songs.
//
// The scenario that matters most here is the ambiguous timeout - the add
// actually landed but the call gave up - because that is the one where a naive
// retry would make a song play twice.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), `pq-async-adds-${process.pid}-`)
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
  "PENDING_ADDS_FILE",
]) {
  process.env[`PARTYQUEUE_${key}`] = path.join(tmpRoot, `${key}.json`);
}
delete process.env.SETTINGS_PIN;
process.env.SONOS_HOST = "127.0.0.1";
process.env.PARTYQUEUE_ASYNC_ADDS = "1";

const express = (await import("express")).default;
const { registerQueueRoutes } = await import("../src/routes/queue.js");
const { setRequestFairnessSettings } = await import("../src/settings.js");
const { clearRequests } = await import("../src/request-log.js");
const { makeCachedReader } = await import("../src/sonos-cache.js");
const { runAddTrueUp } = await import("../src/add-trueup.js");
const {
  clearPendingAdds,
  listPendingAdds,
  listPlaceable,
} = await import("../src/pending-adds.js");
const {
  configureAddDrainer,
  drainOnce,
  stopAddDrainer,
} = await import("../src/add-drainer.js");

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
const TRACK_C = {
  uri: "spotify:track:1BxfuPKGuaTgP7aM0Bbdwr",
  name: "Cruel Summer",
  artist: "Taylor Swift",
};

/** In-memory stand-in for the Sonos queue, with scriptable misbehaviour. */
function createFakeSonos() {
  const tracks = [];
  return {
    tracks,
    removals: 0,
    // Set to make the speaker hang, throw, or "succeed then fail".
    addBehaviour: null,
    async getQueueList() {
      return tracks.map((t, i) => ({ ...t, position: i + 1 }));
    },
    async addTrackToQueue(uri, { name, artist, requestedBy, requestedByUser } = {}) {
      const behaviour = this.addBehaviour;
      if (behaviour === "hang") {
        await new Promise(() => {});
      }
      if (behaviour === "throw") {
        throw new Error("Sonos timeout");
      }
      const existing = tracks.findIndex((t) => t.uri === uri);
      if (existing !== -1) {
        return {
          queuePosition: existing + 1,
          absoluteQueuePosition: existing + 1,
          queueWasEmpty: false,
          requestCreated: false,
        };
      }
      tracks.push({
        uri,
        id: uri.split(":").pop(),
        title: name,
        artist,
        searched: true,
        requestedBy,
        requestedByUser,
      });
      if (behaviour === "landed-then-timeout") {
        // The exact party-night failure: the speaker took the track, then the
        // call gave up before we heard back.
        throw new Error("Sonos timeout");
      }
      return {
        queuePosition: tracks.length,
        absoluteQueuePosition: tracks.length,
        queueWasEmpty: tracks.length === 1,
        requestCreated: true,
      };
    },
    async removeQueueTrack({ uri }) {
      this.removals += 1;
      const i = tracks.findIndex((t) => t.uri === uri);
      if (i === -1) throw new Error("Track not found in queue.");
      tracks.splice(i, 1);
      return { removed: 1 };
    },
    async play() {
      return { playing: true };
    },
    async removeUpcomingFillerTracks() {
      return { removed: 0, removedBefore: 0 };
    },
    invalidateSonosSnapshots() {},
    recordRequest() {},
    ensureGuestProfile() {
      return false;
    },
    shouldShoutOnSearch() {
      return false;
    },
    announceRequestShout: async () => ({ ok: true }),
    queueRequestShout: async () => ({ ok: true }),
    releaseReservedFirstShout() {},
  };
}

const passthrough = (_req, _res, next) => next();

describe("write-behind guest adds", { concurrency: false }, () => {
  let server = null;
  let baseUrl = "";
  let fake = null;

  before(async () => {
    fake = createFakeSonos();
    // Drive the drainer by hand so the assertions are deterministic; the
    // route's nudge becomes a no-op once the loop is stopped.
    stopAddDrainer();
    configureAddDrainer({
      addTrackToQueue: (...args) => fake.addTrackToQueue(...args),
      play: () => fake.play(),
      recordRequest: () => {},
      ensureGuestProfile: () => false,
      shouldShoutOnSearch: () => false,
      announceRequestShout: async () => ({ ok: true }),
      queueRequestShout: async () => ({ ok: true }),
      releaseReservedFirstShout: () => {},
    });

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
    stopAddDrainer();
    configureAddDrainer({});
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  beforeEach(() => {
    clearPendingAdds();
    clearRequests();
    fake.tracks.length = 0;
    fake.removals = 0;
    fake.addBehaviour = null;
  });

  function postJson(pathname, body) {
    return fetch(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** Burn through the retry budget by stepping past each backoff window. */
  async function exhaustAttempts(passes = 6) {
    for (let i = 1; i <= passes; i++) {
      await drainOnce({ now: Date.now() + i * 10 * 60_000 });
    }
  }

  async function add(track, user = "Dave") {
    const res = await postJson("/api/queue", {
      ...track,
      requestedBy: user,
      requestedByUser: user,
    });
    return { res, body: await res.json() };
  }

  test("the guest is answered while the speaker is still wedged", async () => {
    fake.addBehaviour = "hang";

    const started = Date.now();
    const { res, body } = await add(TRACK_A);
    const elapsed = Date.now() - started;

    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.pending, true);
    assert.ok(body.pendingId);
    assert.ok(elapsed < 1000, `ack took ${elapsed}ms`);
    // Nothing reached the speaker; the song is safe in the outbox.
    assert.equal(fake.tracks.length, 0);
    assert.equal(listPendingAdds().length, 1);
  });

  test("the acknowledgement carries no queue position", async () => {
    const { body } = await add(TRACK_A);

    // Working out a position needs a live Sonos read, which is exactly what
    // this path refuses to do. Guests read position off the party display.
    assert.equal(body.queuePosition, undefined);
    assert.equal(body.promoted, undefined);
  });

  test("the drainer places the song on the speaker", async () => {
    await add(TRACK_A);

    assert.equal(await drainOnce(), "placed");

    assert.equal(fake.tracks.length, 1);
    assert.equal(fake.tracks[0].uri, TRACK_A.uri);
    // Kept only so the row survives until Sonos shows it; the true-up deletes
    // it once the song is actually visible in the queue.
    assert.equal(listPendingAdds()[0].state, "placed");
    assert.deepEqual(listPlaceable(), [], "never placed a second time");
  });

  test("adds are placed in the order guests tapped", async () => {
    await add(TRACK_A, "Dave");
    await add(TRACK_B, "Maria");
    await add(TRACK_C, "Owen");

    await drainOnce();
    await drainOnce();
    await drainOnce();

    assert.deepEqual(
      fake.tracks.map((t) => t.uri),
      [TRACK_A.uri, TRACK_B.uri, TRACK_C.uri]
    );
  });

  test("a repeat tap does not create a second pending entry", async () => {
    await add(TRACK_A, "Dave");
    const { body } = await add(TRACK_A, "Dave");

    assert.equal(body.alreadyRequested, true);
    assert.equal(body.requestCreated, false);
    assert.equal(listPendingAdds().length, 1);
  });

  test("an add that landed but timed out is never queued twice", async () => {
    fake.addBehaviour = "landed-then-timeout";
    await add(TRACK_A);

    // The attempt throws even though the track is now in the queue.
    assert.equal(await drainOnce(), "retry");
    assert.equal(fake.tracks.length, 1);
    assert.equal(listPendingAdds().length, 1, "still unconfirmed");

    // The true-up sees it in the live queue and retires the entry, so the
    // drainer never gets a second go at it.
    fake.addBehaviour = null;
    const result = await runAddTrueUp({ getQueueList: () => fake.getQueueList() });

    assert.equal(result.confirmed, 1);
    assert.equal(listPendingAdds()[0].state, "placed", "kept only to draw the row");
    assert.equal(await drainOnce(), "idle");
    assert.equal(fake.tracks.length, 1, "exactly one copy");
  });

  test("emptying the queue mid-read is not counted as a confirmation", async () => {
    const { clearPendingAdds } = await import("../src/pending-adds.js");
    fake.addBehaviour = "landed-then-timeout";
    await add(TRACK_A, "Dave");
    assert.equal(await drainOnce(), "retry");
    fake.addBehaviour = null;

    // The queue read is awaited, so the host can empty the outbox between it
    // and the rows coming back. Nothing is left to confirm at that point.
    const result = await runAddTrueUp({
      getQueueList: async () => {
        const rows = await fake.getQueueList();
        clearPendingAdds();
        return rows;
      },
    });

    assert.equal(result.confirmed, 0);
    assert.equal(listPendingAdds().length, 0);
  });

  test("last call does not discard songs guests already asked for", async () => {
    const { preemptQueueWork } = await import("../src/queue-preempt.js");
    fake.addBehaviour = "hang";
    await add(TRACK_A, "Dave");
    fake.addBehaviour = null;

    // The End-of-Night ritual bumps the preempt generation and clears filler
    // precisely so real requests play out the night. Cancellation must not be
    // inferred from that bump.
    preemptQueueWork();

    assert.equal(await drainOnce(), "placed");
    assert.equal(fake.tracks.length, 1);
  });

  test("emptying the queue drops adds that never reached the speaker", async () => {
    const { clearPendingAdds } = await import("../src/pending-adds.js");
    fake.addBehaviour = "hang";
    await add(TRACK_A, "Dave");
    assert.equal(listPendingAdds().length, 1);

    // What clearQueueWithoutAutoRefill() calls at the real choke point.
    clearPendingAdds();

    assert.equal(await drainOnce(), "idle");
    assert.equal(fake.tracks.length, 0);
  });

  test("the true-up never removes anything from Sonos", async () => {
    await add(TRACK_A);
    await drainOnce();
    // A song that played and was trimmed away is simply absent; that is not a
    // failure and must not provoke any removal or re-add.
    fake.tracks.length = 0;

    await runAddTrueUp({ getQueueList: () => fake.getQueueList() });

    assert.equal(fake.removals, 0);
    assert.equal(fake.tracks.length, 0);
  });

  test("a placed song that later disappears is not resurrected", async () => {
    await add(TRACK_A);
    await drainOnce();
    assert.equal(listPendingAdds()[0].state, "placed");

    // Trimmed after playing.
    fake.tracks.length = 0;
    await runAddTrueUp({ getQueueList: () => fake.getQueueList() });
    await drainOnce();

    assert.equal(fake.tracks.length, 0, "the party already heard it");
  });

  test("one queue row cannot confirm two different guests' adds", async () => {
    await add(TRACK_A, "Dave");
    await add(TRACK_A, "Maria");
    assert.equal(listPendingAdds().length, 2);

    // Only one copy is actually in the queue.
    fake.tracks.push({
      uri: TRACK_A.uri,
      id: TRACK_A.uri.split(":").pop(),
      title: TRACK_A.name,
      searched: true,
      requestedByUser: "Dave",
    });
    const result = await runAddTrueUp({ getQueueList: () => fake.getQueueList() });

    assert.equal(result.confirmed, 1);
    assert.equal(result.waiting, 1);
    // The confirmed entry is kept as a placed shadow row until Sonos shows it,
    // so check states rather than who is left in the store.
    const states = Object.fromEntries(
      listPendingAdds().map((e) => [e.requestedByUser, e.state])
    );
    assert.equal(states.Dave, "placed", "the one queued copy is his");
    assert.equal(states.Maria, "pending", "still waiting for a copy of her own");
  });

  test("a hopeless add is surfaced to the guest and can be retried", async () => {
    fake.addBehaviour = "throw";
    const { body } = await add(TRACK_A);

    await exhaustAttempts();

    const failed = listPendingAdds().find((e) => e.id === body.pendingId);
    assert.equal(failed.state, "failed");
    assert.match(failed.lastError, /Sonos timeout/);

    // The speaker recovers and the guest taps retry.
    fake.addBehaviour = null;
    const retry = await postJson(`/api/queue/pending/${body.pendingId}/retry`, {
      requestedBy: "Dave",
      requestedByUser: "Dave",
    });
    assert.equal(retry.status, 200);

    assert.equal(await drainOnce(), "placed");
    assert.equal(fake.tracks.length, 1);
  });

  test("only the requester can retry their song", async () => {
    fake.addBehaviour = "throw";
    const { body } = await add(TRACK_A, "Dave");
    await exhaustAttempts();

    const res = await postJson(`/api/queue/pending/${body.pendingId}/retry`, {
      requestedBy: "Maria",
      requestedByUser: "Maria",
    });

    assert.equal(res.status, 409);
  });

  test("pending songs show up in the queue list right away", async () => {
    fake.addBehaviour = "hang";
    await add(TRACK_A, "Dave");

    const res = await fetch(`${baseUrl}/api/queue/list`);
    const body = await res.json();

    const row = body.tracks.find((t) => t.uri === TRACK_A.uri);
    assert.ok(row, "the guest can see the song they just added");
    assert.equal(row.pending, true);
    assert.equal(row.requestedByUser, "Dave");
  });

  test("a failed song stays in the list with its reason", async () => {
    fake.addBehaviour = "throw";
    await add(TRACK_A, "Dave");
    await exhaustAttempts();

    const body = await (await fetch(`${baseUrl}/api/queue/list`)).json();

    const row = body.tracks.find((t) => t.uri === TRACK_A.uri);
    assert.equal(row.failed, true);
    assert.match(row.failedReason, /Retry/);
    // Speaker IPs and SOAP URLs stay in the server log.
    assert.doesNotMatch(row.failedReason, /http|1400|Sonos timeout/);
  });

  test("the live stream shows the same rows as the REST list", async () => {
    fake.addBehaviour = "hang";
    await add(TRACK_A, "Dave");

    const { readQueuePayload } = await import("../src/queue-http.js");
    const { getQueueList } = await import("../src/sonos.js");
    // The stream reads the real cached reader, so plant a snapshot rather than
    // standing up a speaker.
    getQueueList.seed([{ uri: TRACK_C.uri, title: TRACK_C.name }]);

    const rest = await (await fetch(`${baseUrl}/api/queue/list`)).json();
    const streamed = await readQueuePayload();

    // The stream is what repaints the UI; if it omitted the pending row the
    // song would appear on a poll and vanish on the next push.
    assert.equal(rest.tracks.some((t) => t.pending), true);
    assert.equal(streamed.tracks.some((t) => t.pending), true);
    assert.equal(
      streamed.tracks.filter((t) => t.pending).length,
      rest.tracks.filter((t) => t.pending).length
    );
  });

  test("the stream signature moves when the queue goes stale", async () => {
    const { queueSignature } = await import("../src/queue-http.js");
    const tracks = [{ uri: TRACK_A.uri, title: TRACK_A.name }];

    // Losing the live read is a visible change even when the rows match, so it
    // has to push an update rather than being swallowed as "no change".
    assert.notEqual(
      queueSignature({ tracks }),
      queueSignature({ tracks, stale: true })
    );
  });

  test("pending adds count against the fairness cap", async () => {
    setRequestFairnessSettings({
      requestFairnessEnabled: true,
      requestFairnessUpcomingThreshold: 1,
      requestFairnessUpcomingCap: 1,
    });
    try {
      fake.addBehaviour = "hang";
      // Another guest is already waiting, so caps are live.
      fake.tracks.push({
        uri: TRACK_C.uri,
        id: TRACK_C.uri.split(":").pop(),
        title: TRACK_C.name,
        searched: true,
        requestedByUser: "Maria",
      });

      const first = await add(TRACK_A, "Dave");
      assert.equal(first.body.pending, true);

      // Dave's second add must be refused even though the first one has not
      // reached the speaker yet - quota is consumed at acknowledgement.
      const second = await add(TRACK_B, "Dave");
      assert.equal(second.res.status, 409);
      assert.equal(second.body.code, "upcoming_cap");
    } finally {
      setRequestFairnessSettings({ requestFairnessEnabled: false });
    }
  });
});

describe("queue display when Sonos reads fail", () => {
  beforeEach(() => {
    // The display merges the outbox in, so start from a clean one.
    clearPendingAdds();
  });

  test("serves the last known good snapshot instead of an error", async () => {
    const { readQueueForDisplay } = await import("../src/queue-view.js");
    let healthy = true;
    const reader = makeCachedReader(async () => {
      if (!healthy) throw new Error("Sonos unreachable");
      return [{ uri: TRACK_A.uri, title: TRACK_A.name }];
    }, 1);

    const firstRead = await readQueueForDisplay(reader);
    assert.equal(firstRead.tracks.length, 1);
    assert.equal(firstRead.stale, undefined);

    healthy = false;
    reader.bust();
    const stale = await readQueueForDisplay(reader);

    assert.equal(stale.stale, true);
    assert.equal(stale.tracks.length, 1, "the TV keeps its list");
    assert.ok(stale.staleAt > 0);
  });

  test("propagates the error when there is no snapshot to fall back to", async () => {
    const { readQueueForDisplay } = await import("../src/queue-view.js");
    const reader = makeCachedReader(async () => {
      throw new Error("Sonos unreachable");
    }, 1000);

    await assert.rejects(() => readQueueForDisplay(reader), /Sonos unreachable/);
  });
});
