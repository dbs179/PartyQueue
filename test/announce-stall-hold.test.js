import { test } from "node:test";
import assert from "node:assert/strict";

import { createStallHold } from "../src/announce-stall-hold.js";

const PAD = "http://pq.local:8088/media/tts/silence-ramp-3s.mp3?t=abc123";

const quietLogger = { info() {}, warn() {}, error() {} };

/**
 * Scripted transport whose polling the test drives by hand.
 *
 * `sleep` parks until the test calls `tick()`, so assertions land at a known
 * point in the loop. Letting the fake sleep resolve on its own instead makes
 * the watcher burn its entire deadline in microtasks before the test looks.
 *
 * `steps` is read one per poll; once exhausted the last step repeats, so a test
 * can leave the pad sitting on the playhead.
 */
function fakeIo(steps) {
  const calls = [];
  let i = 0;
  let clock = 0;
  let wake = null;
  return {
    calls,
    /** Advance one poll and wait for the watcher to come back round. */
    async tick() {
      i += 1;
      const go = wake;
      wake = null;
      go?.();
      await new Promise((r) => setImmediate(r));
    },
    io: {
      now: () => clock,
      read: async () => steps[Math.min(i, steps.length - 1)],
      pause: async () => calls.push("pause"),
      resume: async () => calls.push("resume"),
      sleep: (ms) =>
        new Promise((resolve) => {
          clock += ms;
          wake = resolve;
        }),
    },
  };
}

test("the room is paused once the parked pad reaches the playhead", async () => {
  const { io, calls, tick } = fakeIo([
    { uri: "x-sonos-spotify:spotify:track:song", state: "PLAYING" },
    { uri: PAD, state: "PLAYING" },
  ]);
  const hold = createStallHold({ padUrl: PAD, io, logger: quietLogger });
  hold.start();
  await new Promise((r) => setImmediate(r));

  assert.equal(hold.held, false, "song still playing");
  await tick(); // pad reaches the playhead
  assert.equal(hold.held, true);

  await hold.release();
  assert.deepEqual(calls, ["pause", "resume"]);
});

test("a pad that is still queued behind a song is not paused early", async () => {
  const { io, calls, tick } = fakeIo([
    { uri: "x-sonos-spotify:spotify:track:song", state: "PLAYING" },
  ]);
  const hold = createStallHold({ padUrl: PAD, io, logger: quietLogger });
  hold.start();
  await new Promise((r) => setImmediate(r));
  await tick();

  assert.equal(hold.held, false);
  await hold.release();
  assert.deepEqual(calls, [], "must not touch a song that is still playing");
});

test("releasing without ever holding does not issue a stray Play", async () => {
  const { io, calls } = fakeIo([
    { uri: "x-sonos-spotify:spotify:track:song", state: "PLAYING" },
  ]);
  const hold = createStallHold({ padUrl: PAD, io, logger: quietLogger });
  hold.start();
  await hold.release();

  assert.deepEqual(calls, []);
});

test("the pad is matched by its per-announce token, not just the file name", async () => {
  // Two parked shouts share silence-ramp-3s.mp3 and differ only by token, so
  // matching on the file name alone would let one hold claim the other's pad.
  const other = "http://pq.local:8088/media/tts/silence-ramp-3s.mp3?t=zzz999";
  const { io, calls, tick } = fakeIo([{ uri: other, state: "PLAYING" }]);
  const hold = createStallHold({ padUrl: PAD, io, logger: quietLogger });
  hold.start();
  await new Promise((r) => setImmediate(r));
  await tick();

  assert.equal(hold.held, false, "must not hold on another shout's pad");
  await hold.release();
  assert.deepEqual(calls, []);
});

test("a hold with a deadline handler skips to the request instead of resuming the pad", async () => {
  const calls = [];
  let clock = 0;
  const io = {
    now: () => clock,
    read: async () => ({ uri: PAD, state: "PLAYING" }),
    pause: async () => calls.push("pause"),
    resume: async () => calls.push("resume"),
    sleep: async (ms) => {
      clock += ms;
    },
  };
  const hold = createStallHold({
    padUrl: PAD,
    io,
    maxHoldMs: 1000,
    onDeadline: async () => {
      calls.push("to-request");
    },
    logger: quietLogger,
  });
  await hold.start();
  assert.deepEqual(calls, ["pause", "to-request"]);
});

test("a hold that outlives its deadline resumes the room on its own", async () => {
  // Free-running sleep here on purpose: the point is that the watcher reaches
  // its own deadline without anyone releasing it.
  const calls = [];
  let clock = 0;
  const io = {
    now: () => clock,
    read: async () => ({ uri: PAD, state: "PLAYING" }),
    pause: async () => calls.push("pause"),
    resume: async () => calls.push("resume"),
    sleep: async (ms) => {
      clock += ms;
    },
  };
  const hold = createStallHold({
    padUrl: PAD,
    io,
    maxHoldMs: 1000,
    logger: quietLogger,
  });
  await hold.start();

  assert.deepEqual(
    calls,
    ["pause", "resume"],
    "a dead announce must never leave the party paused"
  );
});

test("a transport read error does not abandon the hold", async () => {
  const calls = [];
  let reads = 0;
  let clock = 0;
  let wake = null;
  const io = {
    now: () => clock,
    read: async () => {
      reads += 1;
      if (reads < 3) throw new Error("Sonos unreachable");
      return { uri: PAD, state: "PLAYING" };
    },
    pause: async () => calls.push("pause"),
    resume: async () => calls.push("resume"),
    sleep: (ms) =>
      new Promise((resolve) => {
        clock += ms;
        wake = resolve;
      }),
  };
  const tick = async () => {
    const go = wake;
    wake = null;
    go?.();
    await new Promise((r) => setImmediate(r));
  };

  const hold = createStallHold({ padUrl: PAD, io, logger: quietLogger });
  hold.start();
  await new Promise((r) => setImmediate(r));
  await tick(); // second failed read
  await tick(); // Sonos answers

  assert.equal(hold.held, true, "should recover once Sonos answers again");
  await hold.release();
  assert.deepEqual(calls, ["pause", "resume"]);
});

test("a failing resume is reported rather than silently leaving a pause", async () => {
  const { io } = fakeIo([{ uri: PAD, state: "PLAYING" }]);
  io.resume = async () => {
    throw new Error("Sonos error on Play");
  };
  const errors = [];
  const hold = createStallHold({
    padUrl: PAD,
    io,
    logger: { ...quietLogger, error: (m) => errors.push(m) },
  });
  hold.start();
  await new Promise((r) => setImmediate(r));

  const released = await hold.release();
  assert.equal(released, false);
  assert.match(errors.join(" "), /could not resume/);
});
