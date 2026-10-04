import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  lockGroupVolume,
  lockAndRememberGroupVolume,
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
  seedGroupVolumeForDisplay,
  setVolumeSeedRetryForTests,
} from "../src/sonos-volume.js";
import { setDjVolumeHandoffArmed } from "../src/dj-volume-handoff-state.js";

afterEach(() => {
  resetVolumeReachabilityForTests();
  setDjVolumeHandoffArmed(false);
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

test("a fresh server seeds the header once and then never reads again", async () => {
  const kitchen = fakePlayer("10.10.20.10", { volume: 15 });
  const office = fakePlayer("10.10.20.11", { volume: 15 });
  configureVolumeIo({ resolveMembers: async () => [kitchen, office] });

  // Every open screen asking at once shares the single seed read.
  const seeded = await Promise.all([
    seedGroupVolumeForDisplay(),
    seedGroupVolumeForDisplay(),
    seedGroupVolumeForDisplay(),
  ]);

  assert.deepEqual(seeded, [15, 15, 15]);
  assert.equal(office.reads, 1);
  assert.deepEqual(volumeGetPayload(), { ok: true, volume: 15, ramping: false });

  // A night of polling from every screen must never touch Sonos again.
  for (let i = 0; i < 50; i += 1) await seedGroupVolumeForDisplay();
  assert.equal(kitchen.reads, 1, "the Office speaker must not be polled on a clock");
  assert.equal(office.reads, 1);
});

test("a level PartyQueue already set needs no seed read at all", async () => {
  const office = fakePlayer("10.10.20.11", { volume: 15 });
  configureVolumeIo({ resolveMembers: async () => [office] });
  noteGroupVolume(22);

  assert.equal(await seedGroupVolumeForDisplay(), 22);
  assert.equal(office.reads, 0);
});

test("an armed announce keeps the seed off the speakers", async () => {
  const office = fakePlayer("10.10.20.11", { volume: 15 });
  configureVolumeIo({ resolveMembers: async () => [office] });
  setDjVolumeHandoffArmed(true);

  assert.equal(await seedGroupVolumeForDisplay(), null);
  assert.equal(office.reads, 0, "a mid-shout sample would cache the boost");

  setDjVolumeHandoffArmed(false);
  assert.equal(await seedGroupVolumeForDisplay(), 15);
});

test("a room that is off at startup is not re-read on every poll", async () => {
  setVolumeSeedRetryForTests(60_000);
  const office = fakePlayer("10.10.20.11", { fail: true });
  configureVolumeIo({ resolveMembers: async () => [office] });

  assert.equal(await seedGroupVolumeForDisplay(), null);
  for (let i = 0; i < 20; i += 1) await seedGroupVolumeForDisplay();
  assert.equal(office.reads, 1);
  assert.deepEqual(volumeGetPayload(), { ok: true, volume: null, ramping: false });
});

test("group-all volume stays at 15 for the header poll", async () => {
  setPlayerVolumeTimeoutForTests(30);
  noteGroupVolume(34);
  const state = {
    volumes: [34, 40],
    calls: [],
    snapped: null,
    reverted: false,
  };
  const coordinator = {
    Name: "Living Room",
    Uuid: "living",
    RenderingControlService: {
      async GetVolume() {
        return { CurrentVolume: String(state.volumes[0]) };
      },
      async SetVolume({ DesiredVolume }) {
        state.volumes[0] = DesiredVolume;
        state.calls.push("player");
      },
    },
    GroupRenderingControlService: {
      async SnapshotGroupVolume() {
        state.snapped = [...state.volumes];
        state.calls.push("snapshot");
      },
      async SetGroupVolume({ DesiredVolume }) {
        state.calls.push(["group", DesiredVolume]);
        // Freshly joined groups push the old group level once.
        if (!state.reverted) {
          state.reverted = true;
          state.volumes = [34, 34];
        }
      },
    },
  };
  coordinator.Coordinator = coordinator;
  const kitchen = {
    Name: "Kitchen",
    Uuid: "kitchen",
    Coordinator: coordinator,
    RenderingControlService: {
      async GetVolume() {
        return { CurrentVolume: String(state.volumes[1]) };
      },
      async SetVolume({ DesiredVolume }) {
        state.volumes[1] = DesiredVolume;
      },
    },
  };

  const locked = await lockAndRememberGroupVolume([coordinator, kitchen], 15);

  assert.equal(locked, true);
  assert.equal(state.reverted, true);
  assert.deepEqual(state.volumes, [15, 15]);
  assert.deepEqual(state.snapped, [15, 15]);
  assert.deepEqual(
    state.calls.find((entry) => Array.isArray(entry)),
    ["group", 15]
  );
  assert.equal(getCachedGroupVolume(), 15);
  assert.deepEqual(volumeGetPayload(), {
    ok: true,
    volume: 15,
    ramping: false,
  });
});

test("a failed group volume lock keeps the previous header level", async () => {
  setPlayerVolumeTimeoutForTests(30);
  noteGroupVolume(34);
  const dead = fakePlayer("10.10.20.12", { fail: true });

  const locked = await lockAndRememberGroupVolume([dead], 15);

  assert.equal(locked, false);
  assert.equal(getCachedGroupVolume(), 34);
  assert.deepEqual(volumeGetPayload(), { ok: true, volume: 34, ramping: false });
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
