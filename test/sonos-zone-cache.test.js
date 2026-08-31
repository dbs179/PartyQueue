import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  clearZoneCache,
  deviceDriftInfoForTests,
  getZoneGroups,
  orderTopologyProbeDevices,
  resetDeviceDriftForTests,
  zoneCacheInfoForTests,
} from "../src/sonos-core.js";
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

test("clearZoneCache drops in-flight coalescing and bumps generation", async () => {
  clearZoneCache();
  const before = zoneCacheInfoForTests().generation;
  const m = mockManager([[{ label: "stale" }], [{ label: "fresh" }]]);

  const pending = getZoneGroups(m);
  clearZoneCache();
  const afterClear = zoneCacheInfoForTests();
  assert.equal(afterClear.hasInFlight, false);
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

test("a failed topology probe puts that speaker in the shared cool-off", async () => {
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
  assert.deepEqual(reachabilityInfoForTests().skipped, ["10.10.20.196"]);
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
