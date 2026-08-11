import test from "node:test";
import assert from "node:assert/strict";
import {
  withSonosWriteLock,
  withSonosTransportLane,
  setSonosLaneTimeoutsForTests,
  setSonosLaneTimeoutHookForTests,
  resetSonosLaneTimeoutsForTests,
} from "../src/sonos-lock.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.afterEach(() => {
  resetSonosLaneTimeoutsForTests();
});

test("transport lane does not wait behind a long queue write", async () => {
  const order = [];
  let releaseWrite;
  const writeGate = new Promise((r) => (releaseWrite = r));

  // A long Never-Ending-style refill holding the write lock.
  const write = withSonosWriteLock(async () => {
    order.push("write-start");
    await writeGate;
    order.push("write-end");
  });

  await sleep(10); // let the write lock engage
  await withSonosTransportLane(() => order.push("pause"));

  assert.deepEqual(order, ["write-start", "pause"]);
  releaseWrite();
  await write;
  assert.deepEqual(order, ["write-start", "pause", "write-end"]);
});

test("each lane still serializes its own operations", async () => {
  const order = [];
  const first = withSonosTransportLane(async () => {
    order.push("t1-start");
    await sleep(20);
    order.push("t1-end");
  });
  const second = withSonosTransportLane(() => order.push("t2"));
  await Promise.all([first, second]);
  assert.deepEqual(order, ["t1-start", "t1-end", "t2"]);
});

test("a rejected operation does not break its lane", async () => {
  await assert.rejects(
    withSonosWriteLock(() => {
      throw new Error("boom");
    })
  );
  assert.equal(await withSonosWriteLock(() => "ok"), "ok");
});

test("transport lane is reentrant (nested setVolume during next)", async () => {
  const order = [];
  await withSonosTransportLane(async () => {
    order.push("outer");
    await withSonosTransportLane(() => order.push("inner"));
    order.push("after");
  });
  assert.deepEqual(order, ["outer", "inner", "after"]);
});

test("write lock times out a hung mutation and unblocks the next caller", async () => {
  setSonosLaneTimeoutsForTests({ writeMs: 40 });
  setSonosLaneTimeoutHookForTests(() => {});
  const started = Date.now();
  await assert.rejects(
    withSonosWriteLock(() => new Promise(() => {})),
    /Sonos queue operation timed out/
  );
  assert.ok(Date.now() - started < 500, "timeout should not wait forever");
  assert.equal(await withSonosWriteLock(() => "recovered"), "recovered");
});

test("transport lane times out a hung command and unblocks the next caller", async () => {
  setSonosLaneTimeoutsForTests({ transportMs: 40 });
  setSonosLaneTimeoutHookForTests(() => {});
  await assert.rejects(
    withSonosTransportLane(() => new Promise(() => {})),
    /Sonos transport operation timed out/
  );
  assert.equal(await withSonosTransportLane(() => "ok"), "ok");
});
