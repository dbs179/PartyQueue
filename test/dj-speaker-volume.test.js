import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  flushSpeakerVolumeEpoch,
  publishSpeakerVolume,
  resetSpeakerVolumeForTests,
  speakerVolumeLaneForTests,
} from "../src/dj-speaker-volume.js";
import {
  isPlayerSkipped,
  markPlayerUnreachable,
  reachabilityInfoForTests,
  resetSpeakerReachabilityForTests,
} from "../src/sonos-reachability.js";
import {
  listSpeakerHealth,
  resetSpeakerHealthForTests,
} from "../src/sonos-speaker-health.js";

afterEach(() => {
  resetSpeakerVolumeForTests();
  resetSpeakerReachabilityForTests();
  resetSpeakerHealthForTests();
});

function speaker(name, host, hooks = {}) {
  return {
    Name: name,
    Host: host,
    ...hooks,
  };
}

async function drain() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function deferred() {
  /** @type {(value?: unknown) => void} */
  let resolve;
  /** @type {(err: Error) => void} */
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("a speaker never has two SetVolume calls in flight", async () => {
  const pending = [];
  const office = speaker("Office", "10.10.20.50", {
    setVolume: () => {
      const gate = deferred();
      pending.push(gate);
      return gate.promise;
    },
  });
  publishSpeakerVolume(office, 20, 1);
  publishSpeakerVolume(office, 16, 1);
  publishSpeakerVolume(office, 8, 1);
  await drain();
  assert.equal(pending.length, 1);
  assert.equal(speakerVolumeLaneForTests(office).inFlight, true);
  assert.equal(speakerVolumeLaneForTests(office).desired, 8);
  pending[0].resolve();
  await drain();
  assert.equal(pending.length, 2);
  assert.equal(speakerVolumeLaneForTests(office).inFlightLevel, 8);
  pending[1].resolve();
  await drain();
  assert.equal(speakerVolumeLaneForTests(office).inFlight, false);
  assert.equal(speakerVolumeLaneForTests(office).lastResolvedLevel, 8);
});

test("levels published during a write collapse to the newest target", async () => {
  const sent = [];
  const pending = [];
  const office = speaker("Office", "10.10.20.50", {
    setVolume: (level) => {
      sent.push(level);
      const gate = deferred();
      pending.push(gate);
      return gate.promise;
    },
  });
  publishSpeakerVolume(office, 12, 1);
  await drain();
  publishSpeakerVolume(office, 16, 1);
  publishSpeakerVolume(office, 22, 1);
  pending[0].resolve();
  await drain();
  assert.deepEqual(sent, [12, 22]);
  pending[1].resolve();
  await drain();
  assert.deepEqual(sent, [12, 22]);
});

test("a timeout is recorded in speaker health and does not skip the speaker", async () => {
  const sent = [];
  let failAnnounce = true;
  const office = speaker("Office", "10.10.20.50", {
    setVolume: async (level) => {
      sent.push(level);
      if (failAnnounce && level === 20) {
        throw new Error("Sonos volume write timed out");
      }
    },
  });
  publishSpeakerVolume(office, 20, 1);
  await drain();
  const health = listSpeakerHealth().find((row) => row.host === "10.10.20.50");
  assert.equal(health.consecutiveFailures >= 1, true);
  assert.equal(health.lastFailureReason, "timeout");
  assert.equal(isPlayerSkipped(office), false);
  assert.deepEqual(reachabilityInfoForTests().skipped, []);
  failAnnounce = false;
  publishSpeakerVolume(office, 8, 1);
  await drain();
  assert.ok(sent.includes(8));
  assert.equal(isPlayerSkipped(office), false);
});

test("a successful DJ write does not clear a skip from another subsystem", async () => {
  const office = speaker("Office", "10.10.20.50", {
    setVolume: async () => {},
  });
  markPlayerUnreachable(office);
  assert.equal(isPlayerSkipped(office), true);
  publishSpeakerVolume(office, 20, 1);
  await drain();
  assert.equal(speakerVolumeLaneForTests(office).lastResolvedLevel, 20);
  assert.equal(isPlayerSkipped(office), true);
  const health = listSpeakerHealth().find((row) => row.host === "10.10.20.50");
  assert.equal(health.consecutiveSuccesses >= 1, true);
});

test("a stale epoch cannot send after a newer epoch owns the lane", async () => {
  const sent = [];
  const pending = [];
  const office = speaker("Office", "10.10.20.50", {
    setVolume: (level) => {
      sent.push(level);
      const gate = deferred();
      pending.push(gate);
      return gate.promise;
    },
  });
  publishSpeakerVolume(office, 20, 1);
  await drain();
  publishSpeakerVolume(office, 14, 2);
  publishSpeakerVolume(office, 8, 1);
  pending[0].resolve();
  await drain();
  assert.deepEqual(sent, [20, 14]);
  pending[1].resolve();
  await drain();
  assert.equal(speakerVolumeLaneForTests(office).ownerEpoch, 2);
  assert.equal(speakerVolumeLaneForTests(office).lastResolvedLevel, 14);
});

test("a timed-out endpoint is read once and corrected once inside the cleanup budget", async () => {
  const sent = [];
  const reads = [];
  let timeoutsLeft = 2;
  const office = speaker("Office", "10.10.20.50", {
    setVolume: async (level) => {
      sent.push(level);
      if (timeoutsLeft > 0) {
        timeoutsLeft -= 1;
        throw new Error("Sonos volume write timed out");
      }
    },
    getVolume: async () => {
      reads.push("get");
      return 20;
    },
  });
  let clock = 0;
  publishSpeakerVolume(office, 8, 1);
  await drain();
  await flushSpeakerVolumeEpoch(1, {
    budgetMs: 4_500,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await Promise.resolve();
    },
  });
  assert.deepEqual(sent, [8, 8, 8]);
  assert.deepEqual(reads, ["get"]);
  assert.equal(speakerVolumeLaneForTests(office).closedEpoch, 1);
  const before = sent.length;
  clock += 10_000;
  publishSpeakerVolume(office, 8, 1);
  await drain();
  assert.equal(sent.length, before);
});
