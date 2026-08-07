import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  SONOS_OFFLINE_BEFORE_RESET_MS,
  SONOS_RESET_COOLDOWN_MS,
  configureSonosManagerHealth,
  noteSonosReadSuccess,
  noteSonosReadFailure,
  clearSonosUnhealthy,
  getSonosManagerHealth,
  resetSonosManagerHealthStateForTests,
} from "../src/sonos-manager-health.js";

let now = 0;
let demand = true;
let resets = 0;

beforeEach(() => {
  resetSonosManagerHealthStateForTests();
  now = 1_000_000;
  demand = true;
  resets = 0;
  configureSonosManagerHealth({
    now: () => now,
    demandChecker: () => demand,
    reset: () => {
      resets += 1;
    },
    logger: { warn() {} },
  });
});

test("failures without demand never start the offline clock or reset", () => {
  demand = false;
  assert.deepEqual(noteSonosReadFailure(), {
    reset: false,
    reason: "no-demand",
  });
  now += SONOS_OFFLINE_BEFORE_RESET_MS + 1;
  assert.deepEqual(noteSonosReadFailure(), {
    reset: false,
    reason: "no-demand",
  });
  assert.equal(resets, 0);
  assert.equal(getSonosManagerHealth().unhealthySince, 0);
});

test("brief outages under 10 minutes do not rediscover", () => {
  noteSonosReadSuccess();
  const first = noteSonosReadFailure();
  assert.equal(first.reset, false);
  assert.equal(first.reason, "waiting");
  now += 5 * 60_000;
  assert.equal(noteSonosReadFailure().reset, false);
  assert.equal(resets, 0);
});

test("sustained failure for 10 minutes with demand resets once", () => {
  noteSonosReadSuccess();
  noteSonosReadFailure();
  now += SONOS_OFFLINE_BEFORE_RESET_MS - 1;
  assert.equal(noteSonosReadFailure().reset, false);
  now += 2;
  const result = noteSonosReadFailure();
  assert.equal(result.reset, true);
  assert.equal(result.reason, "reset");
  assert.equal(resets, 1);
});

test("many failures from many readers do not cascade rediscovery", () => {
  noteSonosReadSuccess();
  noteSonosReadFailure();
  now += SONOS_OFFLINE_BEFORE_RESET_MS + 1;
  // Simulate NP + queue + groups all failing in the same window.
  assert.equal(noteSonosReadFailure().reset, true);
  assert.equal(noteSonosReadFailure().reset, false); // cooldown
  assert.equal(noteSonosReadFailure().reset, false);
  assert.equal(noteSonosReadFailure().reset, false);
  assert.equal(resets, 1);
});

test("cooldown blocks another reset until it expires", () => {
  noteSonosReadSuccess();
  noteSonosReadFailure();
  now += SONOS_OFFLINE_BEFORE_RESET_MS + 1;
  assert.equal(noteSonosReadFailure().reset, true);
  now += SONOS_RESET_COOLDOWN_MS - 1;
  assert.equal(noteSonosReadFailure().reason, "cooldown");
  assert.equal(resets, 1);
  now += 2;
  assert.equal(noteSonosReadFailure().reset, true);
  assert.equal(resets, 2);
});

test("a successful read clears the unhealthy clock", () => {
  noteSonosReadFailure();
  now += SONOS_OFFLINE_BEFORE_RESET_MS - 1_000;
  noteSonosReadSuccess();
  assert.equal(getSonosManagerHealth().unhealthySince, 0);
  // Need another full 10 minutes of failure after recovery.
  noteSonosReadFailure();
  now += SONOS_OFFLINE_BEFORE_RESET_MS - 1;
  assert.equal(noteSonosReadFailure().reset, false);
  assert.equal(resets, 0);
});

test("clearSonosUnhealthy resets the offline clock without counting as a rediscovery", () => {
  noteSonosReadFailure();
  now += SONOS_OFFLINE_BEFORE_RESET_MS + 1;
  clearSonosUnhealthy();
  assert.equal(getSonosManagerHealth().unhealthySince, 0);
  assert.equal(noteSonosReadFailure().reset, false);
  assert.equal(resets, 0);
});
