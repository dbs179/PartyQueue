import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSetRequestFairness } from "../src/set-request-fairness.js";
import { evaluateRequestFairness } from "../src/request-fairness.js";
import { findInsertPosition } from "../src/sonos-queue-policy.js";

const setEnabled = {
  setRequestFairnessEnabled: true,
  setRequestFairnessMax: 1,
  setRequestFairnessWindowHours: 1,
  requestFairnessHostBypass: true,
};

test("set request fairness allows first set then blocks within the hour", () => {
  const now = Date.now();
  const first = evaluateSetRequestFairness({
    settings: setEnabled,
    user: "Alex",
    events: [],
    now,
  });
  assert.equal(first.allowed, true);

  const second = evaluateSetRequestFairness({
    settings: setEnabled,
    user: "Alex",
    events: [
      {
        kind: "setRequest",
        id: "set:artist1",
        requestedBy: "Alex",
        ts: now - 5 * 60_000,
      },
    ],
    now,
  });
  assert.equal(second.allowed, false);
  assert.equal(second.code, "set_request_quota");
  assert.ok(second.retryAfterSec > 0);
});

test("set request fairness is independent of song request events", () => {
  const now = Date.now();
  const result = evaluateSetRequestFairness({
    settings: setEnabled,
    user: "Alex",
    events: Array.from({ length: 10 }, (_, i) => ({
      requestedBy: "Alex",
      ts: now - i * 1000,
      id: `song${i}`,
    })),
    now,
  });
  assert.equal(result.allowed, true);
});

test("song request fairness ignores setRequest and setTrack ledger rows", () => {
  const now = Date.now();
  const result = evaluateRequestFairness({
    settings: {
      requestFairnessEnabled: true,
      requestFairnessUpcomingThreshold: 5,
      requestFairnessUpcomingCap: 2,
      requestFairnessRollingMax: 1,
      requestFairnessWindowMinutes: 30,
      requestFairnessHostBypass: false,
    },
    user: "Alex",
    events: [
      {
        kind: "setRequest",
        id: "set:x",
        requestedBy: "Alex",
        ts: now - 1000,
      },
      {
        kind: "setTrack",
        id: "t1",
        requestedBy: "Alex",
        ts: now - 1000,
      },
    ],
    target: { uri: "spotify:track:new", name: "New", artist: "A" },
    now,
  });
  assert.equal(result.allowed, true);
});

test("song upcoming cap ignores setRequest queue tracks", () => {
  const result = evaluateRequestFairness({
    settings: {
      requestFairnessEnabled: true,
      requestFairnessUpcomingThreshold: 2,
      requestFairnessUpcomingCap: 2,
      requestFairnessRollingMax: 5,
      requestFairnessWindowMinutes: 30,
      requestFairnessHostBypass: false,
    },
    user: "Alex",
    queue: [
      {
        uri: "spotify:track:a",
        searched: true,
        setRequest: true,
        requestedByUser: "Alex",
      },
      {
        uri: "spotify:track:b",
        searched: true,
        setRequest: true,
        requestedByUser: "Alex",
      },
    ],
    target: { uri: "spotify:track:new", name: "New", artist: "A" },
  });
  assert.equal(result.allowed, true);
});

test("after a contiguous set block, next single inserts after the set", () => {
  // Simulate: now playing + 1 prior request + 5 set tracks + filler.
  // searched ids include the prior request and the five set tracks.
  const items = [
    { TrackUri: "spotify:track:cur" },
    { TrackUri: "spotify:track:req1" },
    { TrackUri: "spotify:track:s1" },
    { TrackUri: "spotify:track:s2" },
    { TrackUri: "spotify:track:s3" },
    { TrackUri: "spotify:track:s4" },
    { TrackUri: "spotify:track:s5" },
    { TrackUri: "spotify:track:filler" },
  ];
  const searchedIds = new Set([
    "req1",
    "s1",
    "s2",
    "s3",
    "s4",
    "s5",
  ]);
  const pos = findInsertPosition(items, {
    currentTrack: 1,
    playingFromQueue: true,
    searchedIds,
  });
  // Insert before filler at absolute index 8.
  assert.equal(pos, 8);
});

test("set request fairness disabled allows unlimited sets", () => {
  const result = evaluateSetRequestFairness({
    settings: { ...setEnabled, setRequestFairnessEnabled: false },
    user: "Alex",
    events: [
      { kind: "setRequest", requestedBy: "Alex", ts: Date.now() },
      { kind: "setRequest", requestedBy: "Alex", ts: Date.now() },
    ],
  });
  assert.equal(result.allowed, true);
});
