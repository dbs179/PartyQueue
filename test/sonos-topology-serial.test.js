import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  clearZoneCache,
  deviceForMember,
  getZoneGroups,
  refreshCachedZoneTopology,
  resetDeviceDriftForTests,
  resetZoneTopologyRefreshForTests,
  zoneCacheInfoForTests,
} from "../src/sonos-core.js";
import { resetSpeakerReachabilityForTests } from "../src/sonos-reachability.js";
import { resetSpeakerHealthForTests } from "../src/sonos-speaker-health.js";
import { resetSonosManagerHealthStateForTests } from "../src/sonos-manager-health.js";

afterEach(() => {
  resetZoneTopologyRefreshForTests();
  resetSonosManagerHealthStateForTests();
  resetSpeakerHealthForTests();
  resetSpeakerReachabilityForTests();
  resetDeviceDriftForTests();
  clearZoneCache();
});

/**
 * One GetZoneGroupState chain. `active` counts chains on the wire right now.
 * @param {(n: number) => Promise<unknown>} read
 */
function trackingManager(read) {
  const calls = { n: 0, active: 0, max: 0 };
  const device = (name, uuid) => ({
    Name: name,
    Uuid: uuid,
    Host: uuid,
    GroupName: name,
    Coordinator: null,
    GetZoneGroupState: () => {
      calls.n += 1;
      calls.active += 1;
      calls.max = Math.max(calls.max, calls.active);
      const n = calls.n;
      return Promise.resolve()
        .then(() => read(n))
        .finally(() => {
          calls.active -= 1;
        });
    },
  });
  const office = device("Office", "office");
  const kitchen = device("Kitchen", "kitchen");
  office.Coordinator = office;
  kitchen.Coordinator = kitchen;
  return { m: { Devices: [office, kitchen] }, calls, office, kitchen };
}

const officeMap = [
  {
    coordinator: { name: "Office", uuid: "office" },
    members: [{ name: "Office", uuid: "office" }],
  },
];
const kitchenMap = [
  {
    coordinator: { name: "Kitchen", uuid: "kitchen" },
    members: [{ name: "Kitchen", uuid: "kitchen" }],
  },
];

function gate() {
  /** @type {(value?: unknown) => void} */
  let release = () => {};
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("two non-fresh callers share one topology read", async () => {
  const held = gate();
  const { m, calls } = trackingManager(() => held.promise.then(() => officeMap));
  const first = getZoneGroups(m);
  const second = getZoneGroups(m);
  assert.equal(calls.n, 1);
  assert.equal(calls.max, 1);
  held.release();
  assert.deepEqual(await first, officeMap);
  assert.deepEqual(await second, officeMap);
  assert.equal(calls.n, 1);
  assert.equal(calls.max, 1);
});

test("a fresh caller reuses a same-generation in-flight read", async () => {
  const held = gate();
  const { m, calls } = trackingManager(() => held.promise.then(() => officeMap));
  const background = getZoneGroups(m);
  const fresh = getZoneGroups(m, { fresh: true });
  assert.equal(calls.active, 1);
  assert.equal(calls.n, 1);
  held.release();
  assert.deepEqual(await background, officeMap);
  assert.deepEqual(await fresh, officeMap);
  assert.equal(calls.n, 1);
  assert.equal(calls.max, 1);
});

test("clearZoneCache does not let the old read win, and fresh callers share one follow-up", async () => {
  const held = gate();
  const script = [officeMap, kitchenMap];
  const { m, calls } = trackingManager((n) => {
    if (n === 1) return held.promise.then(() => script[0]);
    return script[n - 1] || kitchenMap;
  });

  const background = getZoneGroups(m);
  assert.equal(calls.n, 1);
  clearZoneCache();
  assert.equal(zoneCacheInfoForTests().hasInFlight, true);
  assert.equal(calls.n, 1);

  const afterJoin = getZoneGroups(m, { fresh: true });
  const picker = getZoneGroups(m, { fresh: true });
  const recovery = getZoneGroups(m, { fresh: true });
  assert.equal(calls.n, 1);
  assert.equal(calls.max, 1);

  held.release();
  assert.deepEqual(await background, officeMap);
  assert.equal(zoneCacheInfoForTests().hasCache, false);
  const joined = await afterJoin;
  const picked = await picker;
  const recovered = await recovery;
  assert.deepEqual(joined, kitchenMap);
  assert.deepEqual(picked, kitchenMap);
  assert.deepEqual(recovered, kitchenMap);
  assert.equal(deviceForMember(m, recovered[0].coordinator).Name, "Kitchen");
  assert.equal(calls.n, 2);
  assert.equal(calls.max, 1);
  assert.equal(zoneCacheInfoForTests().hasCache, true);
});

test("a failed in-flight read gives a fresh waiter one follow-up and keeps the last good map", async () => {
  const held = gate();
  const { m, calls } = trackingManager((n) => {
    if (n === 1) return officeMap;
    if (n === 2) {
      return held.promise.then(() => Promise.reject(new Error("Sonos topology timed out after 4s")));
    }
    return kitchenMap;
  });
  // One probe target. A second speaker with GetZoneGroupState would answer
  // the failover and hide the failure. Keep Kitchen in the device list so the
  // follow-up map is still a known member.
  const kitchen = m.Devices[1];
  delete kitchen.GetZoneGroupState;
  m.Devices.length = 1;
  m.Devices.push(kitchen);

  assert.deepEqual(await getZoneGroups(m), officeMap);
  const failing = getZoneGroups(m, { fresh: true });
  const waiter = getZoneGroups(m, { fresh: true });
  assert.equal(calls.n, 2);
  assert.equal(calls.active, 1);
  held.release();
  assert.deepEqual(await failing, officeMap);
  assert.deepEqual(await waiter, kitchenMap);
  assert.equal(calls.n, 3);
  assert.equal(calls.max, 1);
  assert.deepEqual(await getZoneGroups(m), kitchenMap);
});

test("a periodic tick skips an in-flight topology read and does not queue one", async () => {
  const held = gate();
  const { m, calls } = trackingManager(() => held.promise.then(() => officeMap));
  const background = getZoneGroups(m);
  const skipped = await refreshCachedZoneTopology({ manager: m, now: Date.now() });
  assert.deepEqual(skipped, { skipped: "overlap" });
  assert.equal(calls.n, 1);
  held.release();
  await background;
  assert.equal(calls.n, 1);
  assert.equal(calls.max, 1);
});
