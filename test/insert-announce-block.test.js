import test from "node:test";
import assert from "node:assert/strict";
import { insertAnnounceBlock } from "../src/sonos-queue-mutations.js";
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

function media(url) {
  return {
    url,
    title: url,
    artist: "PartyQueue",
    durationSec: 1,
  };
}

test("insertAnnounceBlock keeps strip + pads inside one write lock", async () => {
  const steps = [];
  let releaseEnqueue;
  const enqueueGate = new Promise((r) => (releaseEnqueue = r));
  let enqueues = 0;

  const insert = insertAnnounceBlock({
    queuePosition: 3,
    preemptGeneration: queueWorkGeneration(),
    ramp: media("http://x/ramp.mp3"),
    tts: media("http://x/tts.mp3"),
    restore: media("http://x/restore.mp3"),
    ops: {
      removePads: async () => {
        steps.push("strip");
        return { removed: 0, removedBefore: 0, protectedThrough: 0 };
      },
      enqueue: async (url) => {
        enqueues += 1;
        steps.push(`enqueue:${url.split("/").pop()}`);
        if (enqueues === 1) await enqueueGate;
        return { url };
      },
      pauseTrim: () => {},
    },
  });

  await sleep(15);
  // Guest-style write must wait behind the whole announce block.
  let guestRan = false;
  const guest = withSonosWriteLock(() => {
    guestRan = true;
    steps.push("guest-add");
  });
  // Pause must still work immediately on the transport lane.
  await withSonosTransportLane(() => steps.push("pause"));
  assert.equal(guestRan, false);
  assert.ok(steps.includes("pause"));
  assert.ok(steps.includes("strip"));
  assert.ok(steps.includes("enqueue:ramp.mp3"));

  releaseEnqueue();
  await insert;
  await guest;
  assert.deepEqual(steps, [
    "strip",
    "enqueue:ramp.mp3",
    "pause",
    "enqueue:tts.mp3",
    "enqueue:restore.mp3",
    "guest-add",
  ]);
});

test("insertAnnounceBlock aborts between pads when Clear preempts", async () => {
  resetQueuePreemptForTests();
  const gen = queueWorkGeneration();
  const urls = [];

  const result = await insertAnnounceBlock({
    queuePosition: 1,
    preemptGeneration: gen,
    ramp: media("http://x/ramp.mp3"),
    tts: media("http://x/tts.mp3"),
    restore: media("http://x/restore.mp3"),
    ops: {
      removePads: async () => ({
        removed: 1,
        removedBefore: 1,
        protectedThrough: 0,
      }),
      enqueue: async (url) => {
        urls.push(url);
        if (urls.length === 1) preemptQueueWork(); // Clear during insert
        return { url };
      },
      pauseTrim: () => {},
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "queue-preempted");
  assert.equal(result.partial, true);
  assert.deepEqual(urls, ["http://x/ramp.mp3"]);
  resetQueuePreemptForTests();
});

test("insertAnnounceBlock adjusts position after supersede wipe", async () => {
  resetQueuePreemptForTests();
  const positions = [];

  const result = await insertAnnounceBlock({
    queuePosition: 5,
    preemptGeneration: queueWorkGeneration(),
    ramp: media("http://x/ramp.mp3"),
    tts: media("http://x/tts.mp3"),
    restore: media("http://x/restore.mp3"),
    ops: {
      removePads: async () => ({
        removed: 2,
        removedBefore: 2,
        protectedThrough: 0,
      }),
      enqueue: async (_url, opts) => {
        positions.push(opts.position);
        return {};
      },
      pauseTrim: () => {},
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.rampPos, 3);
  assert.deepEqual(positions, [3, 4, 5]);
  resetQueuePreemptForTests();
});
