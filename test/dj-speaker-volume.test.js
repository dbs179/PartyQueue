import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  flushSpeakerVolumeEpoch,
  publishSpeakerVolume,
  resetSpeakerVolumeForTests,
  speakerVolumeInFlightSnapshot,
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

test("diagnostic snapshot reports idle and writing lanes without changing them", async () => {
  const kitchen = speaker("Kitchen", "10.10.20.60", {
    setVolume: async () => {},
  });
  publishSpeakerVolume(kitchen, 12, 4);
  await drain();
  const pending = deferred();
  const office = speaker("Office", "10.10.20.50", {
    setVolume: () => pending.promise,
  });
  publishSpeakerVolume(office, 20, 4);
  await drain();
  const beforeOffice = speakerVolumeLaneForTests(office);
  const beforeKitchen = speakerVolumeLaneForTests(kitchen);
  const snap = speakerVolumeInFlightSnapshot(4);
  assert.deepEqual(speakerVolumeLaneForTests(office), beforeOffice);
  assert.deepEqual(speakerVolumeLaneForTests(kitchen), beforeKitchen);
  assert.equal(snap.speakers, 2);
  assert.equal(snap.writing, 1);
  assert.equal(snap.idle, 1);
  const writing = snap.lanes.find((lane) => lane.name === "Office");
  const quiet = snap.lanes.find((lane) => lane.name === "Kitchen");
  assert.equal(writing.state, "writing");
  assert.equal(writing.attemptedLevel, 20);
  assert.equal(writing.desiredLevel, 20);
  assert.equal(writing.followUpPending, false);
  assert.equal(writing.epoch, 4);
  assert.equal(writing.key, "10.10.20.50");
  assert.equal(quiet.state, "idle");
  assert.equal(quiet.attemptedLevel, null);
  assert.equal(quiet.desiredLevel, 12);
  assert.equal(writing.speaker, undefined);
  assert.equal(quiet.speaker, undefined);
  pending.resolve();
  await drain();
});

test("speaker write logs do not add follow-up attempts", async () => {
  const lines = [];
  const original = console.info;
  console.info = (line) => {
    lines.push(String(line));
  };
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
  try {
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
  } finally {
    console.info = original;
  }
  assert.deepEqual(sent, [8, 8, 8]);
  assert.deepEqual(reads, ["get"]);
  const finished = lines.filter(
    (line) => line.includes("[dj-volume] speaker-write") && line.includes("result=")
  );
  assert.equal(finished.filter((line) => line.includes("result=timeout")).length, 2);
  assert.equal(finished.filter((line) => line.includes("result=success")).length, 1);
  assert.ok(finished.every((line) => /start=\S+/.test(line) && /finish=\S+/.test(line)));
  assert.ok(
    lines.some(
      (line) =>
        line.includes("[dj-volume] speaker-cleanup-read") &&
        line.includes("result=success")
    )
  );
});

test("an in-flight write logs the newer desired level that replaced it", async () => {
  const lines = [];
  const original = console.info;
  console.info = (line) => {
    lines.push(String(line));
  };
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
  try {
    publishSpeakerVolume(office, 12, 1);
    await drain();
    publishSpeakerVolume(office, 22, 1);
    pending[0].resolve();
    await drain();
    pending[1].resolve();
    await drain();
  } finally {
    console.info = original;
  }
  assert.deepEqual(sent, [12, 22]);
  assert.ok(
    lines.some(
      (line) =>
        line.includes("level=12") &&
        line.includes("result=success") &&
        line.includes("replaced=22")
    )
  );
});
