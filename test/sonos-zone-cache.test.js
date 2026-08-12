import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearZoneCache,
  getZoneGroups,
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
