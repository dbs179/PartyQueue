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
      ensurePlayMode: async () => {},
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
  const strips = [];

  const result = await insertAnnounceBlock({
    queuePosition: 1,
    preemptGeneration: gen,
    ramp: media("http://x/ramp.mp3"),
    tts: media("http://x/tts.mp3"),
    restore: media("http://x/restore.mp3"),
    ops: {
      removePads: async (opts) => {
        strips.push(opts);
        return {
          removed: 1,
          removedBefore: strips.length === 1 ? 1 : 0,
          protectedThrough: 0,
        };
      },
      enqueue: async (url) => {
        urls.push(url);
        if (urls.length === 1) preemptQueueWork(); // Clear during insert
        return { url };
      },
      pauseTrim: () => {},
      ensurePlayMode: async () => {},
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "queue-preempted");
  assert.equal(result.partial, true);
  assert.equal(result.cleaned, true);
  assert.deepEqual(urls, ["http://x/ramp.mp3"]);
  assert.equal(strips.length, 2, "initial supersede strip plus leftover cleanup");
  assert.equal(strips[1].beforePosition, 1);
  resetQueuePreemptForTests();
});

test("insertAnnounceBlock strips leftover ramp+TTS when preempted before restore", async () => {
  resetQueuePreemptForTests();
  const urls = [];
  const strips = [];

  const result = await insertAnnounceBlock({
    queuePosition: 2,
    preemptGeneration: queueWorkGeneration(),
    ramp: media("http://x/ramp.mp3"),
    tts: media("http://x/tts.mp3"),
    restore: media("http://x/restore.mp3"),
    ops: {
      removePads: async (opts) => {
        strips.push(opts);
        return { removed: 0, removedBefore: 0, protectedThrough: 0 };
      },
      enqueue: async (url) => {
        urls.push(url);
        if (urls.length === 2) preemptQueueWork();
        return { url };
      },
      pauseTrim: () => {},
      ensurePlayMode: async () => {},
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.cleaned, true);
  assert.deepEqual(urls, ["http://x/ramp.mp3", "http://x/tts.mp3"]);
  assert.equal(strips.length, 2);
  assert.equal(strips[1].beforePosition, 2);
  resetQueuePreemptForTests();
});

test("insertAnnounceBlock leaves a complete block when preempted after restore", async () => {
  resetQueuePreemptForTests();
  const urls = [];
  let stripCount = 0;

  const result = await insertAnnounceBlock({
    queuePosition: 1,
    preemptGeneration: queueWorkGeneration(),
    ramp: media("http://x/ramp.mp3"),
    tts: media("http://x/tts.mp3"),
    restore: media("http://x/restore.mp3"),
    ops: {
      removePads: async () => {
        stripCount += 1;
        return { removed: 0, removedBefore: 0, protectedThrough: 0 };
      },
      enqueue: async (url) => {
        urls.push(url);
        if (urls.length === 3) preemptQueueWork();
        return { url };
      },
      pauseTrim: () => {},
      ensurePlayMode: async () => {},
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.partial, false);
  assert.equal(result.inserted, true);
  assert.deepEqual(urls, [
    "http://x/ramp.mp3",
    "http://x/tts.mp3",
    "http://x/restore.mp3",
  ]);
  assert.equal(stripCount, 1, "do not strip a complete announce block");
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
      ensurePlayMode: async () => {},
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.rampPos, 3);
  assert.deepEqual(positions, [3, 4, 5]);
  resetQueuePreemptForTests();
});

test("insertAnnounceBlock re-demotes under the write lock before pads", async () => {
  resetQueuePreemptForTests();
  const steps = [];
  const positions = [];

  const result = await insertAnnounceBlock({
    queuePosition: 2,
    applyLeadBuffer: true,
    preemptGeneration: queueWorkGeneration(),
    ramp: media("http://x/ramp.mp3"),
    tts: media("http://x/tts.mp3"),
    restore: media("http://x/restore.mp3"),
    ops: {
      ensureLeadBuffer: async (pos) => {
        steps.push(`lead:${pos}`);
        return { buffered: true, absoluteQueuePosition: 3, reason: "demoted" };
      },
      removePads: async () => {
        steps.push("strip");
        return { removed: 0, removedBefore: 0, protectedThrough: 0 };
      },
      enqueue: async (_url, opts) => {
        steps.push("enqueue");
        positions.push(opts.position);
        return {};
      },
      pauseTrim: () => {},
      ensurePlayMode: async () => {},
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.rampPos, 3);
  assert.deepEqual(positions, [3, 4, 5]);
  assert.deepEqual(steps, [
    "lead:2",
    "strip",
    "enqueue",
    "enqueue",
    "enqueue",
  ]);
  resetQueuePreemptForTests();
});

test("insertAnnounceBlock with tts2 places punch between lead TTS and restore", async () => {
  resetQueuePreemptForTests();
  const urls = [];
  const result = await insertAnnounceBlock({
    queuePosition: 1,
    preemptGeneration: queueWorkGeneration(),
    ramp: media("http://x/ramp.mp3"),
    tts: media("http://x/tts.mp3"),
    tts2: media("http://x/tts2.mp3"),
    restore: media("http://x/restore.mp3"),
    ops: {
      removePads: async () => ({
        removed: 0,
        removedBefore: 0,
        protectedThrough: 0,
      }),
      enqueue: async (url) => {
        urls.push(url);
        return { url };
      },
      pauseTrim: () => {},
      ensurePlayMode: async () => {},
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.ttsPos, result.rampPos + 1);
  assert.equal(result.tts2Pos, result.ttsPos + 1);
  assert.equal(result.restorePos, result.tts2Pos + 1);
  assert.deepEqual(urls, [
    "http://x/ramp.mp3",
    "http://x/tts.mp3",
    "http://x/tts2.mp3",
    "http://x/restore.mp3",
  ]);
  resetQueuePreemptForTests();
});

test("insertAnnounceBlock without tts2 keeps the original three-clip sandwich", async () => {
  resetQueuePreemptForTests();
  const urls = [];
  const result = await insertAnnounceBlock({
    queuePosition: 1,
    preemptGeneration: queueWorkGeneration(),
    ramp: media("http://x/ramp.mp3"),
    tts: media("http://x/tts.mp3"),
    restore: media("http://x/restore.mp3"),
    ops: {
      removePads: async () => ({
        removed: 0,
        removedBefore: 0,
        protectedThrough: 0,
      }),
      enqueue: async (url) => {
        urls.push(url);
        return { url };
      },
      pauseTrim: () => {},
      ensurePlayMode: async () => {},
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.tts2Pos, null);
  assert.equal(result.restorePos, result.ttsPos + 1);
  assert.deepEqual(urls, [
    "http://x/ramp.mp3",
    "http://x/tts.mp3",
    "http://x/restore.mp3",
  ]);
  resetQueuePreemptForTests();
});
