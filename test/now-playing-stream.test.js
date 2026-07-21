import test from "node:test";
import assert from "node:assert/strict";
import {
  createSnapshotMonitor,
  createNowPlayingMonitor,
  nowPlayingSignature,
} from "../src/now-playing-stream.js";
import {
  NOW_PLAYING_TTL_MS,
  SNAPSHOT_TTL_MS,
} from "../src/sonos.js";

function makeMonitor(readSnapshot) {
  return createNowPlayingMonitor({
    readSnapshot,
    autoSchedule: false,
    logger: { warn() {} },
  });
}

test("one Now Playing read serves every subscriber", async () => {
  let reads = 0;
  const monitor = makeMonitor(async () => {
    reads += 1;
    return { uri: "spotify:track:1", title: "One", positionSec: 4 };
  });
  const first = [];
  const second = [];
  monitor.subscribe((snapshot) => first.push(snapshot));
  monitor.subscribe((snapshot) => second.push(snapshot));

  await monitor.pollNow();

  assert.equal(reads, 1);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.deepEqual(first[0], second[0]);
  await monitor.stop();
});

test("generic snapshot monitor supports queue payload signatures", async () => {
  let reads = 0;
  const received = [];
  const monitor = createSnapshotMonitor({
    autoSchedule: false,
    monitorName: "queue",
    logger: { warn() {} },
    signatureFor: (snapshot) => JSON.stringify(snapshot?.tracks || []),
    readSnapshot: async () => {
      reads += 1;
      return {
        tracks: [{ uri: "spotify:track:1", title: "One" }],
      };
    },
  });
  monitor.subscribe((snapshot) => received.push(snapshot));
  monitor.subscribe(() => {});

  await monitor.pollNow();
  await monitor.pollNow();

  assert.equal(reads, 2);
  assert.equal(received.length, 1);
  assert.equal(received[0].tracks[0].title, "One");
  assert.equal(received[0].streamSequence, 1);
  await monitor.stop();
});

test("position-only changes are deduplicated but meaningful changes publish", async () => {
  const snapshots = [
    { uri: "spotify:track:1", state: "PLAYING", positionSec: 1 },
    { uri: "spotify:track:1", state: "PLAYING", positionSec: 2 },
    { uri: "spotify:track:1", state: "PAUSED_PLAYBACK", positionSec: 2 },
  ];
  const received = [];
  const monitor = makeMonitor(async () => snapshots.shift());
  monitor.subscribe((snapshot) => received.push(snapshot));

  await monitor.pollNow();
  await monitor.pollNow();
  await monitor.pollNow();

  assert.equal(received.length, 2);
  assert.equal(received[1].state, "PAUSED_PLAYBACK");
  assert.equal(received[1].streamSequence, 2);
  await monitor.stop();
});

test("a new subscriber immediately receives the shared latest snapshot", async () => {
  let reads = 0;
  const monitor = makeMonitor(async () => {
    reads += 1;
    return { uri: "spotify:track:1", title: "One" };
  });
  const unsubscribeFirst = monitor.subscribe(() => {});
  await monitor.pollNow();
  const received = [];

  monitor.subscribe((snapshot) => received.push(snapshot));

  assert.equal(reads, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].title, "One");
  unsubscribeFirst();
  await monitor.stop();
});

test("a reconnect receives the newest position without broadcasting clock ticks", async () => {
  const snapshots = [
    { uri: "spotify:track:1", title: "One", positionSec: 2 },
    { uri: "spotify:track:1", title: "One", positionSec: 8 },
  ];
  const first = [];
  const second = [];
  const monitor = makeMonitor(async () => snapshots.shift());
  monitor.subscribe((snapshot) => first.push(snapshot));

  await monitor.pollNow();
  await monitor.pollNow();
  monitor.subscribe((snapshot) => second.push(snapshot));

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(second[0].positionSec, 8);
  assert.equal(second[0].streamSequence, first[0].streamSequence);
  await monitor.stop();
});

test("concurrent polls share one non-overlapping read", async () => {
  let reads = 0;
  let release;
  const monitor = makeMonitor(
    () =>
      new Promise((resolve) => {
        reads += 1;
        release = resolve;
      })
  );
  monitor.subscribe(() => {});

  const first = monitor.pollNow();
  const second = monitor.pollNow();
  await Promise.resolve();
  assert.equal(reads, 1);
  release({ uri: "spotify:track:1" });
  await Promise.all([first, second]);
  assert.equal(reads, 1);
  await monitor.stop();
});

test("the final disconnect stops demand and clears the retained snapshot", async () => {
  let reads = 0;
  const monitor = makeMonitor(async () => {
    reads += 1;
    return { uri: "spotify:track:1" };
  });
  const unsubscribe = monitor.subscribe(() => {});
  await monitor.pollNow();
  unsubscribe();

  await monitor.pollNow();

  assert.equal(reads, 1);
  assert.equal(monitor.subscriberCount, 0);
  assert.equal(monitor.latest, null);
  await monitor.stop();
});

test("an in-flight read is discarded after the final disconnect", async () => {
  let release;
  const received = [];
  const monitor = makeMonitor(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const unsubscribe = monitor.subscribe((snapshot) => received.push(snapshot));
  const poll = monitor.pollNow();
  await Promise.resolve();

  unsubscribe();
  release({ uri: "spotify:track:1" });
  await poll;

  assert.equal(received.length, 0);
  assert.equal(monitor.latest, null);
  await monitor.stop();
});

test("poll failures can retry without dropping subscribers", async () => {
  let reads = 0;
  const received = [];
  const monitor = makeMonitor(async () => {
    reads += 1;
    if (reads === 1) throw new Error("temporary");
    return { uri: "spotify:track:2" };
  });
  monitor.subscribe((snapshot) => received.push(snapshot));

  await monitor.pollNow();
  await monitor.pollNow();

  assert.equal(reads, 2);
  assert.equal(received.length, 1);
  assert.equal(received[0].uri, "spotify:track:2");
  await monitor.stop();
});

test("repeated Sonos failures publish health and recovery refreshes clients", async () => {
  let attempt = 0;
  const statuses = [];
  const received = [];
  const monitor = createNowPlayingMonitor({
    autoSchedule: false,
    failureThreshold: 2,
    logger: { warn() {} },
    onStatusChange: (status) => statuses.push(status.status),
    readSnapshot: async () => {
      attempt += 1;
      if (attempt === 2 || attempt === 3) throw new Error("Sonos offline");
      return {
        uri: "spotify:track:1",
        state: "PLAYING",
        positionSec: attempt,
      };
    },
  });
  monitor.subscribe((snapshot) => received.push(snapshot));

  await monitor.pollNow();
  await monitor.pollNow();
  await monitor.pollNow();
  assert.equal(monitor.health.status, "disconnected");
  await monitor.pollNow();

  assert.deepEqual(statuses, ["connected", "disconnected", "connected"]);
  assert.equal(received.length, 2);
  assert.equal(received[1].streamSequence, 2);
  assert.equal(received[1].positionSec, 4);
  await monitor.stop();
});

test("shutdown waits for an active read and rejects new subscribers", async () => {
  let release;
  const monitor = makeMonitor(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  monitor.subscribe(() => {});
  const poll = monitor.pollNow();
  await Promise.resolve();
  const stopping = monitor.stop();
  release({ uri: "spotify:track:1" });

  await Promise.all([poll, stopping]);

  assert.equal(monitor.subscriberCount, 0);
  assert.throws(() => monitor.subscribe(() => {}), /stopped/);
});

test("the fingerprint ignores playback clock fields and key order", () => {
  const first = {
    title: "One",
    reactions: { fire: 2, like: 1 },
    positionSec: 1,
    positionObservedAt: 100,
  };
  const second = {
    positionObservedAt: 200,
    reactions: { like: 1, fire: 2 },
    positionSec: 9,
    title: "One",
  };
  assert.equal(nowPlayingSignature(first), nowPlayingSignature(second));
});

test("Now Playing cache expires before queue and group snapshots", () => {
  assert.equal(NOW_PLAYING_TTL_MS, 1000);
  assert.equal(SNAPSHOT_TTL_MS, 3000);
  assert.ok(NOW_PLAYING_TTL_MS < SNAPSHOT_TTL_MS);
});
