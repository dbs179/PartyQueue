import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  broadcastQueueMutation,
  createQueueTrackChangeWatcher,
  QUEUE_MUTATION_FOLLOWUP_MS,
  QUEUE_SAFETY_INTERVAL_MS,
  queueSignature,
  registerQueueStreamRoutes,
} from "../src/queue-http.js";
import { createSnapshotMonitor } from "../src/now-playing-stream.js";

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = {};
    this.statusCode = 0;
    this.output = "";
    this.writableEnded = false;
    this.destroyed = false;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }

  flushHeaders() {}

  write(value) {
    this.output += value;
  }

  end() {
    this.writableEnded = true;
  }
}

test("queue signature changes only with queue tracks", () => {
  const tracks = [{ uri: "spotify:track:1", title: "One" }];
  assert.equal(
    queueSignature({ tracks, streamSequence: 1 }),
    queueSignature({ tracks, streamSequence: 99 })
  );
  assert.notEqual(queueSignature({ tracks }), queueSignature({ tracks: [] }));
});

test("queue signature ignores object key order but sees badge and edit fields", () => {
  const a = {
    uri: "spotify:track:1",
    title: "One",
    artist: "A",
    position: 2,
    itemId: "Q:1",
    searched: true,
    requestedBy: "Sam",
    dedication: "Jess",
    genreLane: "pop",
    genreLabel: "Pop",
    genreLanes: ["pop"],
    genreLabels: ["Pop"],
  };
  const b = {
    dedication: "Jess",
    genreLabels: ["Pop"],
    genreLanes: ["pop"],
    genreLabel: "Pop",
    genreLane: "pop",
    requestedBy: "Sam",
    searched: true,
    itemId: "Q:1",
    position: 2,
    artist: "A",
    title: "One",
    uri: "spotify:track:1",
  };
  assert.equal(queueSignature({ tracks: [a] }), queueSignature({ tracks: [b] }));

  assert.notEqual(
    queueSignature({ tracks: [a] }),
    queueSignature({ tracks: [{ ...a, dedication: "Pat" }] })
  );
  assert.notEqual(
    queueSignature({ tracks: [a] }),
    queueSignature({ tracks: [{ ...a, position: 3 }] })
  );
  assert.notEqual(
    queueSignature({ tracks: [a] }),
    queueSignature({ tracks: [{ ...a, fromPlaylist: true }] })
  );
  assert.notEqual(
    queueSignature({ tracks: [a] }),
    queueSignature({ tracks: [{ ...a, moodPick: true, mood: "80s" }] })
  );
  assert.notEqual(
    queueSignature({ tracks: [a] }),
    queueSignature({ tracks: [{ ...a, origin: "filler" }] })
  );
  const pending = { ...a, pending: true, failed: false, pendingId: "p1" };
  const failed = { ...a, pending: false, failed: true, pendingId: "p1" };
  assert.notEqual(
    queueSignature({ tracks: [pending] }),
    queueSignature({ tracks: [failed] }),
    "a failed add must republish even when the song itself did not change"
  );
});

test("queue SSE route sends retained data and releases demand on close", () => {
  let route = null;
  let subscribers = 0;
  const monitor = {
    health: { status: "connected" },
    subscribe(listener) {
      subscribers += 1;
      listener({
        tracks: [{ uri: "spotify:track:1", title: "One" }],
        streamSession: "queue-test",
        streamSequence: 1,
      });
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers -= 1;
      };
    },
  };
  const app = {
    get(path, handler) {
      assert.equal(path, "/api/queue/stream");
      route = handler;
    },
  };
  registerQueueStreamRoutes(app, { monitor });

  const req = new EventEmitter();
  const res = new FakeResponse();
  route(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/event-stream/);
  assert.match(res.output, /retry: 3000/);
  assert.match(res.output, /event: queue-status/);
  assert.match(res.output, /spotify:track:1/);
  assert.equal(subscribers, 1);

  req.emit("close");
  assert.equal(subscribers, 0);
});

test("queue mutation pings every open SSE client so HA Random refreshes idle tabs", () => {
  let route = null;
  const monitor = {
    health: { status: "connected" },
    subscribe() {
      return () => {};
    },
  };
  const app = {
    get(_path, handler) {
      route = handler;
    },
  };
  registerQueueStreamRoutes(app, { monitor });

  const req = new EventEmitter();
  const res = new FakeResponse();
  route(req, res);
  const before = res.output;
  broadcastQueueMutation();
  const added = res.output.slice(before.length);
  assert.match(added, /event: queue-changed/);
  assert.match(added, /data: \{/);
  req.emit("close");
});

function fakeClockMonitor(readSnapshot) {
  const now = { t: 0 };
  const timers = [];
  const monitor = createSnapshotMonitor({
    monitorName: "queue-test",
    readSnapshot,
    signatureFor: queueSignature,
    intervalMs: QUEUE_SAFETY_INTERVAL_MS,
    intervalFor: () => QUEUE_SAFETY_INTERVAL_MS,
    now: () => now.t,
    setTimer: (fn, ms) => {
      const timer = { fn, at: now.t + Math.max(0, Number(ms) || 0) };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const at = timers.indexOf(timer);
      if (at !== -1) timers.splice(at, 1);
    },
    logger: { warn() {} },
  });
  async function flush(to) {
    now.t = to;
    const due = timers.filter((t) => t.at <= now.t).sort((a, b) => a.at - b.at);
    for (const timer of due) {
      const at = timers.indexOf(timer);
      if (at !== -1) timers.splice(at, 1);
      timer.fn();
    }
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }
  return { monitor, now, timers, flush };
}

test("a stable track does not re-read the queue across former 3-second ticks", async () => {
  let reads = 0;
  const { monitor, flush } = fakeClockMonitor(async () => {
    reads += 1;
    return { tracks: [{ uri: "spotify:track:1" }] };
  });
  monitor.subscribe(() => {});
  await flush(0);
  assert.equal(reads, 1, "first subscriber reads once");

  await flush(3_000);
  await flush(6_000);
  await flush(9_000);
  assert.equal(reads, 1, "the 3-second clock is gone");
  await monitor.stop();
});

test("broadcastQueueMutation causes a queue read", async () => {
  let reads = 0;
  const { monitor, flush } = fakeClockMonitor(async () => {
    reads += 1;
    return { tracks: [] };
  });
  monitor.subscribe(() => {});
  await flush(0);
  assert.equal(reads, 1);
  monitor.nudge();
  await flush(0);
  assert.equal(reads, 2);
  await monitor.stop();
});

test("a new now-playing URI nudges; the same URI and index do not", () => {
  let nudges = 0;
  const watch = createQueueTrackChangeWatcher(() => {
    nudges += 1;
  });
  assert.equal(watch({ uri: "spotify:track:a", queueTrack: 1 }), true);
  assert.equal(nudges, 1);
  assert.equal(watch({ uri: "spotify:track:a", queueTrack: 1 }), false);
  assert.equal(watch({ uri: "spotify:track:a", queueTrack: 1, title: "x" }), false);
  assert.equal(nudges, 1);
  assert.equal(watch({ uri: "spotify:track:b", queueTrack: 1 }), true);
  assert.equal(watch({ uri: "spotify:track:b", queueTrack: 2 }), true);
  assert.equal(nudges, 3);
});

test("mutation follow-ups are still 400ms and 1600ms", () => {
  assert.deepEqual(QUEUE_MUTATION_FOLLOWUP_MS, [400, 1600]);
});

test("with zero subscribers the safety timer does not read", async () => {
  let reads = 0;
  const { monitor, flush } = fakeClockMonitor(async () => {
    reads += 1;
    return { tracks: [] };
  });
  await flush(QUEUE_SAFETY_INTERVAL_MS);
  assert.equal(reads, 0);
  await monitor.stop();
});

test("with a subscriber the safety read happens at 60 seconds", async () => {
  let reads = 0;
  const { monitor, flush } = fakeClockMonitor(async () => {
    reads += 1;
    return { tracks: [] };
  });
  monitor.subscribe(() => {});
  await flush(0);
  assert.equal(reads, 1);
  await flush(QUEUE_SAFETY_INTERVAL_MS);
  assert.equal(reads, 2);
  await monitor.stop();
});

