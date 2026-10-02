import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  clearZoneCache,
  deviceDriftInfoForTests,
  getZoneGroups,
  isQueueWriteRefusal,
  isTransportRefusalError,
  orderTopologyProbeDevices,
  resetDeviceDriftForTests,
  resolveCoordinator,
  setZoneCacheAgeForTests,
  settleTopologyFlightForTests,
  zoneCacheInfoForTests,
  ZONE_CACHE_MAX_AGE_MS,
} from "../src/sonos-core.js";
import { getSonosTargetRoom } from "../src/settings.js";
import {
  markPlayerUnreachable,
  reachabilityInfoForTests,
  resetSpeakerReachabilityForTests,
} from "../src/sonos-reachability.js";

// The skip map is shared household-wide, so a failover test must not leave a
// speaker cooling off for the next one.
afterEach(() => {
  resetSpeakerReachabilityForTests();
  resetDeviceDriftForTests();
  clearZoneCache();
});

test("isQueueWriteRefusal retries coordinator moves and transport refusals", () => {
  assert.equal(isQueueWriteRefusal(new Error("UPnP Error 800")), true);
  assert.equal(
    isQueueWriteRefusal(new Error("UPnP Error 701 Transition not available")),
    true
  );
  assert.equal(
    isQueueWriteRefusal(new Error("UPnP Error 711: Illegal seek target")),
    true
  );
  assert.equal(isQueueWriteRefusal(new Error("Sonos timeout")), false);
});

test("isTransportRefusalError matches Sonos 701 and 711", () => {
  assert.equal(
    isTransportRefusalError(new Error("Upnp Error: 701 Transition not available")),
    true
  );
  assert.equal(
    isTransportRefusalError(new Error("UPnP Error 711: Illegal seek target")),
    true
  );
  assert.equal(isTransportRefusalError(new Error("UPnP 800")), false);
  assert.equal(isTransportRefusalError(new Error("timeout")), false);
});

function mockManager(results) {
  let i = 0;
  return {
    Devices: [
      {
        GetZoneGroupState: async () => {
          const value = results[Math.min(i, results.length - 1)];
          i += 1;
          // Let clearZoneCache race mid-flight.
          await new Promise((r) => setTimeout(r, 20));
          return value;
        },
      },
    ],
  };
}

function countingManager(read) {
  const calls = { n: 0 };
  const m = {
    Devices: [
      {
        Name: "Kitchen",
        Host: "10.10.20.190",
        GetZoneGroupState: async () => {
          calls.n += 1;
          return read(calls.n);
        },
      },
    ],
  };
  return { m, calls };
}

test("two getZoneGroups calls after one success produce one GetZoneGroupState", async () => {
  const groups = [{ id: "kitchen-group" }];
  const { m, calls } = countingManager(() => groups);

  assert.deepEqual(await getZoneGroups(m), groups);
  assert.deepEqual(await getZoneGroups(m), groups);
  assert.equal(calls.n, 1);
});

test("repeated calls inside the staleness ceiling produce no new SOAP", async () => {
  const groups = [{ id: "kitchen-group" }];
  const { m, calls } = countingManager(() => groups);

  await getZoneGroups(m);
  setZoneCacheAgeForTests(ZONE_CACHE_MAX_AGE_MS - 1_000);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(await getZoneGroups(m), groups);
  }
  assert.equal(calls.n, 1);
});

test("past the staleness ceiling the caller gets the held map and one read runs behind it", async () => {
  const { m, calls } = countingManager((n) => [{ id: `pass-${n}` }]);

  assert.deepEqual(await getZoneGroups(m), [{ id: "pass-1" }]);
  setZoneCacheAgeForTests(ZONE_CACHE_MAX_AGE_MS);
  assert.ok(zoneCacheInfoForTests().ageMs >= ZONE_CACHE_MAX_AGE_MS);

  // Last-known-good now. The refresh is on the wire, not in the caller's path.
  assert.deepEqual(await getZoneGroups(m), [{ id: "pass-1" }]);
  assert.equal(zoneCacheInfoForTests().hasInFlight, true);

  await settleTopologyFlightForTests();
  assert.equal(calls.n, 2);

  // Everyone behind it rides the refreshed map, with no further SOAP.
  assert.deepEqual(await getZoneGroups(m), [{ id: "pass-2" }]);
  assert.deepEqual(await getZoneGroups(m), [{ id: "pass-2" }]);
  assert.deepEqual(await getZoneGroups(m), [{ id: "pass-2" }]);
  assert.equal(calls.n, 2);
});

test("an aged cache whose refresh fails keeps serving the last good map", async () => {
  const groups = [{ id: "kitchen-group" }];
  let failing = false;
  const { m, calls } = countingManager(() => {
    if (failing) throw new Error("Sonos topology timed out after 4s");
    return groups;
  });

  assert.deepEqual(await getZoneGroups(m), groups);
  failing = true;
  setZoneCacheAgeForTests(ZONE_CACHE_MAX_AGE_MS);

  // Last-known-good, not a throw — and the caller never saw the failure.
  assert.deepEqual(await getZoneGroups(m), groups);
  await settleTopologyFlightForTests();
  assert.equal(calls.n, 2);

  // And the failure holds off the next age-triggered probe, so an unreachable
  // household does not get one failover chain per caller.
  assert.equal(zoneCacheInfoForTests().retryHeldOff, true);
  assert.deepEqual(await getZoneGroups(m), groups);
  assert.deepEqual(await getZoneGroups(m), groups);
  assert.equal(calls.n, 2);

  // An explicit clear still forces a read regardless of the hold-off.
  failing = false;
  clearZoneCache();
  assert.deepEqual(await getZoneGroups(m), groups);
  assert.equal(calls.n, 3);
});

// A stale ceiling means "re-read soon", never "wait here for SOAP". The
// announcement volume loop reaches getZoneGroups through resolveCoordinator
// every 150 ms, and a topology probe is 4 s per device with failover.

/**
 * First read answers at once to seed the cache; every later read parks until
 * the test releases it. That is what makes "did the caller wait?" provable.
 */
function deferredManager() {
  const calls = { n: 0 };
  let open = () => {};
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const m = {
    Devices: [
      {
        Name: "Office",
        Host: "10.10.20.196",
        Uuid: "RINCON_OFFICE",
        GetZoneGroupState: async () => {
          calls.n += 1;
          if (calls.n === 1) return [{ id: "held" }];
          await gate;
          return [{ id: `refreshed-${calls.n}` }];
        },
      },
    ],
  };
  return { m, calls, release: () => open() };
}

test("a stale-cache caller returns the held map before the background read finishes", async () => {
  const { m, calls, release } = deferredManager();

  assert.deepEqual(await getZoneGroups(m), [{ id: "held" }]);
  setZoneCacheAgeForTests(ZONE_CACHE_MAX_AGE_MS);

  // The probe is parked inside GetZoneGroupState and the caller is already done.
  assert.deepEqual(await getZoneGroups(m), [{ id: "held" }]);
  assert.equal(calls.n, 2);
  assert.equal(zoneCacheInfoForTests().hasInFlight, true);

  release();
  await settleTopologyFlightForTests();
  assert.deepEqual(await getZoneGroups(m), [{ id: "refreshed-2" }]);
  assert.equal(calls.n, 2);
});

test("many stale-cache callers share one background acquisition", async () => {
  const { m, calls, release } = deferredManager();

  assert.deepEqual(await getZoneGroups(m), [{ id: "held" }]);
  setZoneCacheAgeForTests(ZONE_CACHE_MAX_AGE_MS);

  const results = await Promise.all(
    Array.from({ length: 8 }, () => getZoneGroups(m))
  );
  for (const groups of results) assert.deepEqual(groups, [{ id: "held" }]);
  assert.equal(calls.n, 2, "one probe chain, not one per caller");

  release();
  await settleTopologyFlightForTests();
});

test("a cold cache still waits for the acquisition", async () => {
  clearZoneCache();
  let open = () => {};
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  let calls = 0;
  const m = {
    Devices: [
      {
        Name: "Kitchen",
        Host: "10.10.20.190",
        GetZoneGroupState: async () => {
          calls += 1;
          await gate;
          return [{ id: "cold" }];
        },
      },
    ],
  };

  let settled = false;
  const pending = getZoneGroups(m).then((groups) => {
    settled = true;
    return groups;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false, "no held map, so the caller must wait");

  open();
  assert.deepEqual(await pending, [{ id: "cold" }]);
  assert.equal(calls, 1);
  assert.equal(zoneCacheInfoForTests().hasCache, true);
});

test("an explicit fresh read still waits, even with a usable held map", async () => {
  const { m, calls, release } = deferredManager();

  assert.deepEqual(await getZoneGroups(m), [{ id: "held" }]);

  let settled = false;
  const pending = getZoneGroups(m, { fresh: true }).then((groups) => {
    settled = true;
    return groups;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false, "fresh: true must not be silently redefined");
  assert.equal(calls.n, 2);

  release();
  assert.deepEqual(await pending, [{ id: "refreshed-2" }]);
});

test("the announcement transport path does not wait on a stale topology read", async () => {
  // getTransportTick resolves its coordinator through
  // resolveCoordinator -> resolveGroup -> getZoneGroups on every poll. Build
  // the topology around whatever room this install targets so the test does
  // not depend on local settings.
  const room = getSonosTargetRoom() || "Kitchen";
  const uuid = "RINCON_TARGET";
  const held = [
    {
      coordinator: { name: room, uuid },
      members: [{ name: room, uuid, host: "10.10.20.190" }],
    },
  ];
  let open = () => {};
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  let calls = 0;
  const device = {
    Name: room,
    Host: "10.10.20.190",
    Uuid: uuid,
    GetZoneGroupState: async () => {
      calls += 1;
      if (calls === 1) return held;
      // A wedged target: this probe never comes back on its own.
      await gate;
      return held;
    },
  };
  const m = { Devices: [device] };

  await getZoneGroups(m);
  setZoneCacheAgeForTests(ZONE_CACHE_MAX_AGE_MS);

  const started = Date.now();
  for (let i = 0; i < 10; i += 1) {
    assert.equal(await resolveCoordinator(m), device);
  }
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 1_000,
    `transport resolution stayed off the topology probe (${elapsed}ms)`
  );
  assert.equal(calls, 2, "ten polls, one background probe");

  open();
  await settleTopologyFlightForTests();
});

test("clearZoneCache then getZoneGroups reads again", async () => {
  const { m, calls } = countingManager((n) => [{ id: `pass-${n}` }]);

  assert.deepEqual(await getZoneGroups(m), [{ id: "pass-1" }]);
  clearZoneCache();
  assert.deepEqual(await getZoneGroups(m), [{ id: "pass-2" }]);
  assert.equal(calls.n, 2);
});

test("fresh: true reads even when the cache is full", async () => {
  const { m, calls } = countingManager((n) => [{ id: `pass-${n}` }]);

  assert.deepEqual(await getZoneGroups(m), [{ id: "pass-1" }]);
  assert.deepEqual(await getZoneGroups(m, { fresh: true }), [{ id: "pass-2" }]);
  assert.equal(calls.n, 2);
});

test("a failed refresh returns the previous groups", async () => {
  const first = [{ id: "kitchen-group" }];
  const { m, calls } = countingManager((n) => {
    if (n === 1) return first;
    throw new Error("Sonos topology timed out after 4s");
  });

  assert.deepEqual(await getZoneGroups(m), first);
  assert.deepEqual(await getZoneGroups(m, { fresh: true }), first);
  assert.equal(calls.n, 2);
  assert.equal(zoneCacheInfoForTests().hasCache, true);
});

test("clearZoneCache keeps the in-flight read and bumps generation", async () => {
  clearZoneCache();
  const before = zoneCacheInfoForTests().generation;
  const m = mockManager([[{ label: "stale" }], [{ label: "fresh" }]]);

  const pending = getZoneGroups(m);
  clearZoneCache();
  const afterClear = zoneCacheInfoForTests();
  assert.equal(afterClear.hasInFlight, true);
  assert.ok(afterClear.generation > before);

  const stale = await pending;
  assert.deepEqual(stale, [{ label: "stale" }]);
  // Superseded read must not refill the shared cache.
  assert.equal(zoneCacheInfoForTests().hasCache, false);

  const fresh = await getZoneGroups(m, { fresh: true });
  assert.deepEqual(fresh, [{ label: "fresh" }]);
  assert.equal(zoneCacheInfoForTests().hasCache, true);
});

test("getZoneGroups fails over from a dead Devices[0] to the next speaker", async () => {
  clearZoneCache();
  let firstCalls = 0;
  let secondCalls = 0;
  const m = {
    Devices: [
      {
        Name: "Office",
        Host: "10.10.20.196",
        GetZoneGroupState: async () => {
          firstCalls += 1;
          const err = new Error("connect EHOSTUNREACH");
          err.code = "EHOSTUNREACH";
          throw err;
        },
      },
      {
        Name: "Kitchen",
        Host: "10.10.20.190",
        GetZoneGroupState: async () => {
          secondCalls += 1;
          return [{ id: "kitchen-group" }];
        },
      },
    ],
  };

  const groups = await getZoneGroups(m, {
    fresh: true,
    preferHost: "",
    preferRoom: "",
  });
  assert.deepEqual(groups, [{ id: "kitchen-group" }]);
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);
});

test("orderTopologyProbeDevices prefers the party host over SSDP order", () => {
  const ordered = orderTopologyProbeDevices(
    [
      { Name: "Office", Host: "10.10.20.196" },
      { Name: "Kitchen", Host: "10.10.20.190" },
      { Name: "Garage", Host: "10.10.20.191" },
    ],
    { preferHost: "10.10.20.190", preferRoom: "Living Room" }
  );
  assert.equal(ordered[0].Name, "Kitchen");
});

test("orderTopologyProbeDevices prefers the target room over the pinned host", () => {
  const ordered = orderTopologyProbeDevices(
    [
      { Name: "Office", Host: "10.10.20.196" },
      { Name: "Kitchen", Host: "10.10.20.190" },
      { Name: "Living Room", Host: "10.10.20.193" },
    ],
    { preferHost: "10.10.20.190", preferRoom: "Living Room" }
  );
  assert.deepEqual(
    ordered.map((d) => d.Name),
    ["Living Room", "Kitchen", "Office"]
  );
});

test("getZoneGroups probes the preferred room before Office", async () => {
  clearZoneCache();
  let officeCalls = 0;
  let kitchenCalls = 0;
  const m = {
    Devices: [
      {
        Name: "Office",
        Host: "10.10.20.196",
        GetZoneGroupState: async () => {
          officeCalls += 1;
          throw new Error("Error parsing ZoneGroup");
        },
      },
      {
        Name: "Kitchen",
        Host: "10.10.20.190",
        GetZoneGroupState: async () => {
          kitchenCalls += 1;
          return [{ id: "kitchen-group" }];
        },
      },
    ],
  };

  const groups = await getZoneGroups(m, {
    fresh: true,
    preferHost: "10.10.20.190",
    preferRoom: "Kitchen",
  });
  assert.deepEqual(groups, [{ id: "kitchen-group" }]);
  assert.equal(kitchenCalls, 1);
  assert.equal(officeCalls, 0);
});

test("a failed topology probe does not ban SetVolume on that speaker", async () => {
  // Topology SOAP is not "this speaker is dead." Marking Office unreachable
  // here used to ban SetVolume for 60s, so the DJ never ducked.
  clearZoneCache();
  const m = {
    Devices: [
      {
        Name: "Office",
        Host: "10.10.20.196",
        GetZoneGroupState: async () => {
          const err = new Error("connect EHOSTUNREACH");
          err.code = "EHOSTUNREACH";
          throw err;
        },
      },
      {
        Name: "Kitchen",
        Host: "10.10.20.190",
        GetZoneGroupState: async () => [{ id: "kitchen-group" }],
      },
    ],
  };

  await getZoneGroups(m, { fresh: true, preferHost: "", preferRoom: "" });
  assert.deepEqual(reachabilityInfoForTests().skipped, []);
});

test("orderTopologyProbeDevices sinks a speaker inside its cool-off", () => {
  const office = { Name: "Office", Host: "10.10.20.196" };
  const kitchen = { Name: "Kitchen", Host: "10.10.20.190" };
  markPlayerUnreachable(office);

  // Office is the target room and would normally win outright.
  const ordered = orderTopologyProbeDevices([office, kitchen], {
    preferHost: "",
    preferRoom: "Office",
  });
  assert.deepEqual(
    ordered.map((d) => d.Name),
    ["Kitchen", "Office"]
  );
});

test("an unmanaged topology member rebuilds the device list once per cool-off", async () => {
  clearZoneCache();
  resetDeviceDriftForTests();
  const topology = [
    {
      members: [
        { uuid: "RINCON_KITCHEN", host: "10.10.20.190", name: "Kitchen" },
        // Office came back online after the manager was built.
        { uuid: "RINCON_OFFICE", host: "10.10.20.196", name: "Office" },
      ],
    },
  ];
  const m = {
    Devices: [
      {
        Name: "Kitchen",
        Host: "10.10.20.190",
        Uuid: "RINCON_KITCHEN",
        GetZoneGroupState: async () => topology,
      },
    ],
  };

  await getZoneGroups(m, { fresh: true, preferHost: "", preferRoom: "" });
  assert.equal(deviceDriftInfoForTests().refreshes, 1);

  await getZoneGroups(m, { fresh: true, preferHost: "", preferRoom: "" });
  assert.equal(
    deviceDriftInfoForTests().refreshes,
    1,
    "second read inside the cool-off must not rediscover again"
  );
});

test("topology whose members are all managed never rebuilds", async () => {
  clearZoneCache();
  resetDeviceDriftForTests();
  const m = {
    Devices: [
      {
        Name: "Kitchen",
        Host: "10.10.20.190",
        Uuid: "RINCON_KITCHEN",
        GetZoneGroupState: async () => [
          {
            members: [
              { uuid: "RINCON_KITCHEN", host: "10.10.20.190", name: "Kitchen" },
            ],
          },
        ],
      },
    ],
  };

  await getZoneGroups(m, { fresh: true, preferHost: "", preferRoom: "" });
  assert.equal(deviceDriftInfoForTests().refreshes, 0);
});
