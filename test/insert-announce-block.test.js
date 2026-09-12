import test from "node:test";
import assert from "node:assert/strict";
import { insertAnnounceClip } from "../src/sonos-queue-mutations.js";
import {
  withSonosWriteLock,
  withSonosTransportLane,
} from "../src/sonos-lock.js";
import {
  preemptQueueWork,
  queueWorkGeneration,
  resetQueuePreemptForTests,
} from "../src/queue-preempt.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function announce(url = "http://x/dj-announce-abc.mp3") {
  return { url, title: "DJ Holy Roller", artist: "PartyQueue", durationSec: 24 };
}

const noopOps = {
  removePads: async () => ({
    removed: 0,
    removedBefore: 0,
    protectedThrough: 0,
  }),
  enqueue: async () => {},
  pauseTrim: () => {},
  ensurePlayMode: async () => {},
};

test("the announce insert holds the write lock across strip and enqueue", async () => {
  const steps = [];
  let releaseEnqueue;
  const enqueueGate = new Promise((r) => (releaseEnqueue = r));

  const insert = insertAnnounceClip({
    queuePosition: 3,
    preemptGeneration: queueWorkGeneration(),
    clip: announce(),
    ops: {
      ...noopOps,
      removePads: async () => {
        steps.push("strip");
        return { removed: 0, removedBefore: 0, protectedThrough: 0 };
      },
      enqueue: async (url) => {
        steps.push(`enqueue:${url.split("/").pop()}`);
        await enqueueGate;
      },
    },
  });

  await sleep(15);
  let guestRan = false;
  const guest = withSonosWriteLock(() => {
    guestRan = true;
    steps.push("guest-add");
  });
  // Pause must still work immediately on the transport lane.
  await withSonosTransportLane(() => steps.push("pause"));
  assert.equal(guestRan, false, "a guest add must wait for the announce");

  releaseEnqueue();
  await insert;
  await guest;
  assert.deepEqual(steps, [
    "strip",
    "enqueue:dj-announce-abc.mp3",
    "pause",
    "guest-add",
  ]);
});

test("the announce is one row, so nothing can land inside it", async () => {
  const enqueued = [];
  const result = await insertAnnounceClip({
    queuePosition: 4,
    preemptGeneration: queueWorkGeneration(),
    clip: announce(),
    ops: {
      ...noopOps,
      enqueue: async (url, opts) => enqueued.push([url, opts.position]),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.clipPos, 4);
  assert.equal(enqueued.length, 1, "exactly one Sonos row");
  assert.deepEqual(enqueued[0], ["http://x/dj-announce-abc.mp3", 4]);
});

test("banter is already inside the clip, so it is still a single row", async () => {
  // The punch clip is baked in upstream; the queue never sees a second row.
  const enqueued = [];
  const result = await insertAnnounceClip({
    queuePosition: 2,
    preemptGeneration: queueWorkGeneration(),
    clip: { ...announce("http://x/dj-announce-banter.mp3"), durationSec: 38 },
    ops: {
      ...noopOps,
      enqueue: async (url, opts) => enqueued.push([url, opts.position, opts.durationSec]),
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(enqueued, [["http://x/dj-announce-banter.mp3", 2, 38]]);
});

test("a preempt before the enqueue leaves nothing in the queue", async () => {
  resetQueuePreemptForTests();
  const generation = queueWorkGeneration();
  let enqueued = 0;

  const result = await insertAnnounceClip({
    queuePosition: 2,
    preemptGeneration: generation,
    clip: announce(),
    ops: {
      ...noopOps,
      removePads: async () => {
        preemptQueueWork("clear");
        return { removed: 0, removedBefore: 0, protectedThrough: 0 };
      },
      enqueue: async () => {
        enqueued += 1;
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "queue-preempted");
  assert.equal(enqueued, 0);
  assert.equal(result.inserted, undefined, "nothing was inserted");
  resetQueuePreemptForTests();
});

test("a preempt after the enqueue reports a whole announce, never a partial one", async () => {
  resetQueuePreemptForTests();
  const generation = queueWorkGeneration();

  const result = await insertAnnounceClip({
    queuePosition: 2,
    preemptGeneration: generation,
    clip: announce(),
    ops: {
      ...noopOps,
      enqueue: async () => {
        preemptQueueWork("clear");
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "queue-preempted");
  assert.equal(result.inserted, true);
  // The old four-row insert could strand a ramp with no DJ behind it; one row
  // is all-or-nothing, so there is no partial state to report or clean up.
  assert.equal(result.partial, undefined);
  assert.equal(result.cleaned, undefined);
  resetQueuePreemptForTests();
});

test("the insert position moves down when supersede removed pads ahead of it", async () => {
  const enqueued = [];
  const result = await insertAnnounceClip({
    queuePosition: 5,
    preemptGeneration: queueWorkGeneration(),
    clip: announce(),
    ops: {
      ...noopOps,
      removePads: async () => ({
        removed: 2,
        removedBefore: 2,
        protectedThrough: 0,
      }),
      enqueue: async (url, opts) => enqueued.push(opts.position),
    },
  });

  assert.equal(result.clipPos, 3);
  assert.deepEqual(enqueued, [3]);
});

test("the insert lands after an announce that supersede chose to protect", async () => {
  const result = await insertAnnounceClip({
    queuePosition: 2,
    preemptGeneration: queueWorkGeneration(),
    clip: announce(),
    ops: {
      ...noopOps,
      removePads: async () => ({
        removed: 0,
        removedBefore: 0,
        protectedThrough: 4,
      }),
    },
  });

  assert.equal(result.clipPos, 5, "must not land on top of the protected block");
});

test("the request position is re-resolved under the lock before inserting", async () => {
  const result = await insertAnnounceClip({
    queuePosition: 2,
    preemptGeneration: queueWorkGeneration(),
    applyLeadBuffer: true,
    clip: announce(),
    ops: {
      ...noopOps,
      ensureLeadBuffer: async () => ({
        absoluteQueuePosition: 7,
        reason: "re-resolved",
      }),
    },
  });

  assert.equal(result.clipPos, 7);
});

test("a missing clip url is a programming error, not a silent no-op", async () => {
  await assert.rejects(
    insertAnnounceClip({
      queuePosition: 1,
      preemptGeneration: queueWorkGeneration(),
      clip: { title: "no url" },
      ops: noopOps,
    }),
    /requires a baked clip url/
  );
});
