import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  noteSonosReadSuccess,
  resetSonosManagerHealthStateForTests,
} from "../src/sonos-manager-health.js";
import {
  clearZoneCache,
  getZoneGroups,
  resetDeviceDriftForTests,
  refreshCachedZoneTopology,
  resetZoneTopologyRefreshForTests,
  setZoneTopologyLoggerForTests,
  SONOS_TOPOLOGY_REFRESH_MS,
  startPeriodicZoneTopologyRefresh,
  stopPeriodicZoneTopologyRefresh,
  zoneCacheInfoForTests,
  zoneTopologyRefreshInfo,
} from "../src/sonos-core.js";
import { resetSpeakerReachabilityForTests } from "../src/sonos-reachability.js";
import {
  listSpeakerHealth,
  DEGRADED_AFTER_FAILURES,
  RECOVERY_SUCCESSES,
  resetSpeakerHealthForTests,
  SPEAKER_HEALTH_PROBE_MS,
  SPEAKER_HEALTH_RECENT_SIGNAL_MS,
  UNRESPONSIVE_AFTER_FAILURES,
} from "../src/sonos-speaker-health.js";

afterEach(() => {
  resetZoneTopologyRefreshForTests();
  resetSonosManagerHealthStateForTests();
  resetSpeakerHealthForTests();
  resetSpeakerReachabilityForTests();
  resetDeviceDriftForTests();
  clearZoneCache();
});

function house(label, members) {
  const uuid = label.toLowerCase().replace(/\s+/g, "-");
  const list = members || [{ name: label, uuid }];
  return [
    {
      coordinator: { name: label, uuid: list[0]?.uuid || uuid },
      members: list,
    },
  ];
}

function oneSpeaker(read, extras = []) {
  const calls = { n: 0 };
  const m = {
    Devices: [
      {
        Name: "Living Room",
        Host: "10.10.20.10",
        Uuid: "living-room",
        GetZoneGroupState: () => {
          calls.n += 1;
          return read(calls.n);
        },
      },
      ...extras,
    ],
  };
  return { m, calls };
}

const kitchen = { Name: "Kitchen", Host: "10.10.20.11", Uuid: "kitchen" };
const office = { Name: "Office", Host: "10.10.20.50", Uuid: "office" };

function captureLogs() {
  const info = [];
  const warn = [];
  setZoneTopologyLoggerForTests({
    info: (line) => info.push(line),
    warn: (line) => warn.push(line),
  });
  return { info, warn };
}

test("the periodic refresh is armed at five minutes and runs on that tick", async () => {
  assert.equal(SONOS_TOPOLOGY_REFRESH_MS, 5 * 60_000);
  const grouped = house("Living Room");
  const { m, calls } = oneSpeaker(() => Promise.resolve(grouped));
  let tick = null;
  assert.equal(
    startPeriodicZoneTopologyRefresh({
      manager: m,
      intervalMs: SONOS_TOPOLOGY_REFRESH_MS,
      setInterval: (fn, ms) => {
        tick = { fn, ms };
        return { fn, ms };
      },
    }),
    true
  );
  assert.equal(
    startPeriodicZoneTopologyRefresh({
      manager: m,
      setInterval: () => {
        throw new Error("second timer");
      },
    }),
    false
  );
  assert.equal(tick.ms, SONOS_TOPOLOGY_REFRESH_MS);
  assert.equal(calls.n, 0);
  assert.equal(zoneTopologyRefreshInfo().armed, true);

  tick.fn();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.n, 1);
  assert.deepEqual(await getZoneGroups(m), grouped);
  assert.equal(calls.n, 1);
  assert.ok(zoneTopologyRefreshInfo().lastTopologyRefreshAttempt > 0);
  assert.ok(zoneTopologyRefreshInfo().lastSuccessfulTopologyRefresh > 0);
});

// Replaces "a periodic refresh is skipped during recent Sonos activity". That
// gate meant the safety net never ran during a party, because ordinary traffic
// kept resetting its clock. Successful traffic proves the coordinator we are
// already using answers; it says nothing about how the household is grouped.
test("continuous successful Sonos traffic does not suppress the periodic refresh", async () => {
  const grouped = house("Living Room");
  const { m, calls } = oneSpeaker(() => Promise.resolve(grouped));

  noteSonosReadSuccess();
  const first = await refreshCachedZoneTopology({ manager: m });
  assert.equal(first.ok, true);
  assert.equal(calls.n, 1);
  assert.ok(zoneTopologyRefreshInfo().lastTopologyRefreshAttempt > 0);

  // Still busy, and it still runs.
  noteSonosReadSuccess();
  const second = await refreshCachedZoneTopology({ manager: m });
  assert.equal(second.ok, true);
  assert.equal(calls.n, 2);
  assert.deepEqual(await getZoneGroups(m), grouped);
});

test("a successful refresh replaces the cached topology", async () => {
  const first = house("Living Room");
  const next = house("Kitchen");
  const { m, calls } = oneSpeaker((n) => Promise.resolve(n === 1 ? first : next), [kitchen]);
  await refreshCachedZoneTopology({ manager: m });
  assert.deepEqual(await getZoneGroups(m), first);
  const again = await refreshCachedZoneTopology({ manager: m });
  assert.equal(again.changed, true);
  assert.deepEqual(await getZoneGroups(m), next);
  assert.equal(calls.n, 2);
});

test("an external regroup is logged once, and member order is not a change", async () => {
  const { info } = captureLogs();
  const grouped = [
    {
      coordinator: { name: "Living Room", uuid: "living-room" },
      members: [
        { name: "Office", uuid: "office" },
        { name: "Living Room", uuid: "living-room" },
      ],
    },
  ];
  const reordered = [
    {
      coordinator: { name: "Living Room", uuid: "living-room" },
      members: [
        { name: "Living Room", uuid: "living-room" },
        { name: "Office", uuid: "office" },
      ],
    },
  ];
  const split = [
    {
      coordinator: { name: "Office", uuid: "office" },
      members: [{ name: "Office", uuid: "office" }],
    },
    {
      coordinator: { name: "Living Room", uuid: "living-room" },
      members: [{ name: "Living Room", uuid: "living-room" }],
    },
  ];
  const script = [grouped, reordered, split, split];
  const { m } = oneSpeaker(
    (n) => Promise.resolve(script[Math.min(n, script.length) - 1]),
    [office]
  );

  await refreshCachedZoneTopology({ manager: m });
  await refreshCachedZoneTopology({ manager: m });
  assert.deepEqual(info, []);
  await refreshCachedZoneTopology({ manager: m });
  assert.deepEqual(info, [
    "[sonos] topology changed: Living Room + Office -> Office | Living Room",
  ]);
  await refreshCachedZoneTopology({ manager: m });
  assert.equal(info.length, 1);
});

test("a failed refresh keeps the previous topology and warns once per streak", async () => {
  const { warn } = captureLogs();
  const first = house("Living Room");
  const { m, calls } = oneSpeaker((n) => {
    if (n === 1) return Promise.resolve(first);
    return Promise.reject(new Error("Sonos topology timed out after 4s"));
  });

  await refreshCachedZoneTopology({ manager: m });
  const cached = await getZoneGroups(m);
  const successAt = zoneTopologyRefreshInfo().lastSuccessfulTopologyRefresh;

  const failed = await refreshCachedZoneTopology({ manager: m });
  assert.deepEqual(failed, { ok: false, preserved: true, changed: false });
  assert.equal(await getZoneGroups(m), cached);
  assert.equal(zoneCacheInfoForTests().hasCache, true);
  assert.equal(zoneTopologyRefreshInfo().lastSuccessfulTopologyRefresh, successAt);
  assert.ok(zoneTopologyRefreshInfo().lastTopologyRefreshAttempt >= successAt);
  assert.equal(warn.length, 1);
  assert.match(warn[0], /keeping last group map/);

  await refreshCachedZoneTopology({ manager: m });
  assert.equal(await getZoneGroups(m), cached);
  assert.equal(warn.length, 1);
  assert.equal(calls.n, 3);
});

test("an in-flight refresh skips the next cycle instead of queuing", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const grouped = house("Living Room");
  const { m, calls } = oneSpeaker(() => gate.then(() => grouped));
  let ticks = 0;
  let tick = null;
  startPeriodicZoneTopologyRefresh({
    manager: m,
    setInterval: (fn) => {
      tick = fn;
      return { fn };
    },
  });

  const first = refreshCachedZoneTopology({ manager: m });
  const second = await refreshCachedZoneTopology({ manager: m });
  assert.deepEqual(second, { skipped: "overlap" });
  tick();
  ticks += 1;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ticks, 1);
  assert.equal(calls.n, 1);
  assert.equal(zoneTopologyRefreshInfo().inFlight, true);
  release();
  assert.equal((await first).ok, true);
  assert.equal(calls.n, 1);
  assert.equal(zoneTopologyRefreshInfo().inFlight, false);
});

test("stopping the topology refresh clears the only timer", () => {
  let cleared = null;
  const handle = {};
  assert.equal(
    startPeriodicZoneTopologyRefresh({
      setInterval: () => handle,
      clearInterval: (id) => {
        cleared = id;
      },
    }),
    true
  );
  assert.equal(zoneTopologyRefreshInfo().armed, true);
  stopPeriodicZoneTopologyRefresh();
  assert.equal(cleared, handle);
  assert.equal(zoneTopologyRefreshInfo().armed, false);
});

test("explicit fresh reads and clearZoneCache still re-read", async () => {
  const { m, calls } = oneSpeaker((n) => Promise.resolve(house(`Pass ${n}`)), [
    { Name: "Pass 1", Host: "10.10.20.21", Uuid: "pass-1" },
    { Name: "Pass 2", Host: "10.10.20.22", Uuid: "pass-2" },
    { Name: "Pass 3", Host: "10.10.20.23", Uuid: "pass-3" },
  ]);
  await refreshCachedZoneTopology({ manager: m });
  assert.deepEqual(await getZoneGroups(m, { fresh: true }), house("Pass 2"));
  clearZoneCache();
  assert.equal(zoneCacheInfoForTests().hasCache, false);
  assert.deepEqual(await getZoneGroups(m), house("Pass 3"));
  assert.equal(calls.n, 3);
});

test("a household topology success does not mark every speaker healthy", async () => {
  const grouped = [
    {
      coordinator: { name: "Living Room", uuid: "living-room" },
      members: [
        { name: "Living Room", uuid: "living-room" },
        { name: "Office", uuid: "office" },
      ],
    },
  ];
  const calls = [];
  const m = {
    Devices: ["Living Room", "Office"].map((name, index) => ({
      Name: name,
      Host: `10.10.20.${10 + index}`,
      Uuid: name.toLowerCase().replace(" ", "-"),
      GetZoneGroupState: async () => {
        calls.push(name);
        return grouped;
      },
    })),
  };
  await refreshCachedZoneTopology({ manager: m });
  assert.equal(calls.length, 1);
  const healthy = listSpeakerHealth().filter((row) => row.state === "HEALTHY");
  assert.equal(healthy.length, 1);
  assert.equal(healthy[0].name, calls[0]);
});

test("speaker health timing constants are unchanged", () => {
  assert.equal(SPEAKER_HEALTH_PROBE_MS, 60_000);
  assert.equal(SPEAKER_HEALTH_RECENT_SIGNAL_MS, 45_000);
  assert.equal(DEGRADED_AFTER_FAILURES, 2);
  assert.equal(UNRESPONSIVE_AFTER_FAILURES, 3);
  assert.equal(RECOVERY_SUCCESSES, 2);
});

test("refresh does nothing until a Sonos manager exists", async () => {
  assert.deepEqual(await refreshCachedZoneTopology(), { skipped: "not-ready" });
  assert.equal(zoneCacheInfoForTests().hasCache, false);
  assert.equal(zoneTopologyRefreshInfo().lastTopologyRefreshAttempt, 0);
});
