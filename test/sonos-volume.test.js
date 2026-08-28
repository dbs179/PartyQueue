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
