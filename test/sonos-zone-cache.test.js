import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearZoneCache,
  getZoneGroups,
  orderTopologyProbeDevices,
  zoneCacheInfoForTests,
} from "../src/sonos-core.js";

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
