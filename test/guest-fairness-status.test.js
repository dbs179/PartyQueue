import test from "node:test";
import assert from "node:assert/strict";
import { buildGuestFairnessStatus } from "../src/guest-fairness-status.js";

const songOn = {
  requestFairnessEnabled: true,
  requestFairnessUpcomingThreshold: 5,
  requestFairnessUpcomingCap: 2,
  requestFairnessRollingMax: 5,
  requestFairnessWindowMinutes: 30,
  requestFairnessHostBypass: false,
};

const setOn = {
  setRequestFairnessEnabled: true,
  setRequestFairnessMax: 1,
  setRequestFairnessWindowMinutes: 60,
};

const requested = (user, id) => ({
  uri: `spotify:track:${id}`,
  title: `Song ${id}`,
  artist: "Artist",
  searched: true,
  requestedByUser: user,
});

test("inactive when both policies are off", () => {
  const status = buildGuestFairnessStatus({
    user: "Alex",
    songSettings: { requestFairnessEnabled: false },
    setSettings: { setRequestFairnessEnabled: false },
  });
  assert.equal(status.active, false);
  assert.equal(status.song.enabled, false);
  assert.equal(status.setRequest.enabled, false);
});

test("reports song + set remaining before any requests", () => {
  const status = buildGuestFairnessStatus({
    user: "Alex",
    songSettings: songOn,
    setSettings: setOn,
    queue: [],
    events: [],
  });
  assert.equal(status.active, true);
  assert.equal(status.song.rollingRemaining, 5);
  assert.equal(status.song.canRequest, true);
  assert.equal(status.setRequest.rollingRemaining, 1);
  assert.equal(status.setRequest.canRequest, true);
});

test("reduces set remaining after a setRequest event", () => {
  const now = Date.now();
  const status = buildGuestFairnessStatus({
    user: "Alex",
    songSettings: { requestFairnessEnabled: false },
    setSettings: setOn,
    events: [{ kind: "setRequest", requestedBy: "Alex", ts: now - 1000 }],
    now,
  });
  assert.equal(status.setRequest.rollingRemaining, 0);
  assert.equal(status.setRequest.canRequest, false);
  assert.ok(status.setRequest.retryAt > now);
});

test("upcoming wait when guest is at their waiting-queue cap", () => {
  const status = buildGuestFairnessStatus({
    user: "Alex",
    songSettings: { ...songOn, requestFairnessUpcomingThreshold: 2 },
    setSettings: { setRequestFairnessEnabled: false },
    queue: [requested("Alex", "one"), requested("Alex", "two")],
    events: [],
  });
  assert.equal(status.song.upcomingActive, true);
  assert.equal(status.song.upcomingRemaining, 0);
  assert.equal(status.song.canRequest, false);
  assert.equal(status.song.code, "upcoming_cap");
  // Rolling budget is still reported separately.
  assert.equal(status.song.rollingRemaining, 5);
});

test("needsName when policy is on but user is blank", () => {
  const status = buildGuestFairnessStatus({
    user: "",
    songSettings: songOn,
    setSettings: setOn,
  });
  assert.equal(status.song.needsName, true);
  assert.equal(status.setRequest.needsName, true);
});
