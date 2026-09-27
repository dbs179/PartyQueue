import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  lockGroupVolume,
  resetVolumeReachabilityForTests,
  setPlayerVolumeTimeoutForTests,
  setSkipUnreachableMsForTests,
  SETTLE_MS,
  resolveVolumeForDisplay,
  noteGroupVolume,
  getCachedGroupVolume,
  configureVolumeIo,
  volumeUp,
  volumeGetPayload,
} from "../src/sonos-volume.js";

afterEach(() => {
  resetVolumeReachabilityForTests();
});

function fakePlayer(host, { volume = 10, hangMs = 0, fail = false } = {}) {
  let current = volume;
  let reads = 0;
  let writes = 0;
  return {
    Host: host,
    get reads() {
      return reads;
    },
    get writes() {
      return writes;
    },
    get volume() {
      return current;
    },
    RenderingControlService: {
      async GetVolume() {
        reads += 1;
        if (hangMs) await new Promise((r) => setTimeout(r, hangMs));
        if (fail) {
          const err = new Error("connect EHOSTUNREACH");
          err.code = "EHOSTUNREACH";
          throw err;
        }
        return { CurrentVolume: String(current) };
      },
      async SetVolume({ DesiredVolume }) {
        writes += 1;
        if (hangMs) await new Promise((r) => setTimeout(r, hangMs));
        if (fail) {
          const err = new Error("connect EHOSTUNREACH");
          err.code = "EHOSTUNREACH";
          throw err;
        }
        current = DesiredVolume;
      },
    },
  };
}

test("lockGroupVolume skips a dead member and still locks reachable players", async () => {
  setPlayerVolumeTimeoutForTests(30);
  setSkipUnreachableMsForTests(60_000);
  const kitchen = fakePlayer("10.10.20.190", { volume: 10 });
  const office = fakePlayer("10.10.20.196", { volume: 10, fail: true });

  const locked = await lockGroupVolume([kitchen, office], 20);

  assert.equal(locked, true);
  assert.equal(kitchen.volume, 20);
  assert.ok(office.writes >= 1, "first pass should attempt the dead player");
});

test("lockGroupVolume does not keep SOAP-ing a recently unreachable player", async () => {
  setPlayerVolumeTimeoutForTests(30);
  setSkipUnreachableMsForTests(60_000);
  const kitchen = fakePlayer("10.10.20.190", { volume: 10 });
  const office = fakePlayer("10.10.20.196", { volume: 10, fail: true });

  await lockGroupVolume([kitchen, office], 15);
  const writesAfterFirst = office.writes;
  const readsAfterFirst = office.reads;

  await lockGroupVolume([kitchen, office], 18);

  assert.equal(office.writes, writesAfterFirst);
  assert.equal(office.reads, readsAfterFirst);
  assert.equal(kitchen.volume, 18);
});

test("lockGroupVolume still writes when every member was marked skipped", async () => {
  setPlayerVolumeTimeoutForTests(30);
  setSkipUnreachableMsForTests(60_000);
  const dead = fakePlayer("10.10.20.10", { volume: 8, fail: true });
  await lockGroupVolume([dead], 20);
  assert.ok(dead.writes >= 1);

  const office = fakePlayer("10.10.20.10", { volume: 8 });
  const locked = await lockGroupVolume([office], 22);
  assert.equal(locked, true);
  assert.ok(office.writes >= 1, "must retry the only room even while skipped");
  assert.equal(office.volume, 22);
});

test("lockGroupVolume times out a hung player instead of waiting forever", async () => {
  setPlayerVolumeTimeoutForTests(25);
  const kitchen = fakePlayer("10.10.20.190", { volume: 8 });
  const office = fakePlayer("10.10.20.196", { volume: 8, hangMs: 80 });
  const started = Date.now();

  const locked = await lockGroupVolume([kitchen, office], 12);

  assert.equal(locked, true);
  assert.ok(Date.now() - started < 2_000 + SETTLE_MS * 2);
  assert.equal(kitchen.volume, 12);
});

test("resolveVolumeForDisplay prefers the DJ ramp commanded level", () => {
  const ramping = resolveVolumeForDisplay({
    handoff: {
      phase: "ramping-up",
      volumeLocked: true,
      currentVolume: 27,
    },
    cached: 15,
  });
  assert.deepEqual(ramping, {
    volume: 27,
    ramping: true,
    phase: "ramping-up",
  });

  const idle = resolveVolumeForDisplay({
    handoff: { phase: "idle", volumeLocked: false, currentVolume: null },
    cached: 15,
  });
  assert.deepEqual(idle, { volume: 15, ramping: false, phase: "idle" });
});

test("noteGroupVolume caches a 0–100 reading", () => {
  noteGroupVolume(32.4);
  assert.equal(getCachedGroupVolume(), 32);
});

test("volumeUp with a remembered level does not read first", async () => {
  noteGroupVolume(15);
  const kitchen = fakePlayer("10.10.20.190", { volume: 99 });
  configureVolumeIo({
    resolveMembers: async () => [kitchen],
  });

  const result = await volumeUp(1);

  assert.equal(result.volume, 16);
  assert.equal(kitchen.volume, 16);
  assert.equal(getCachedGroupVolume(), 16);
});

test("volumeUp with no memory reads once and steps from the loudest", async () => {
  const kitchen = fakePlayer("10.10.20.190", { volume: 10 });
  const patio = fakePlayer("10.10.20.191", { volume: 14 });
  configureVolumeIo({
    resolveMembers: async () => [kitchen, patio],
  });

  const result = await volumeUp(1);

  assert.equal(result.volume, 15);
  assert.equal(kitchen.volume, 15);
  assert.equal(patio.volume, 15);
  assert.equal(getCachedGroupVolume(), 15);
  assert.equal(kitchen.reads >= 1, true);
});

test("GET /api/volume with memory does not need Sonos", () => {
  noteGroupVolume(18);
  assert.deepEqual(volumeGetPayload(), {
    ok: true,
    volume: 18,
    ramping: false,
  });
});

test("GET /api/volume with no memory returns null", () => {
  assert.deepEqual(volumeGetPayload(), {
    ok: true,
    volume: null,
    ramping: false,
  });
});

test("GET /api/volume during a DJ ramp returns the commanded level", () => {
  noteGroupVolume(12);
  assert.deepEqual(
    volumeGetPayload({
      phase: "ramping-up",
      volumeLocked: true,
      currentVolume: 27,
    }),
    { ok: true, volume: 27, ramping: true, phase: "ramping-up" }
  );
});
