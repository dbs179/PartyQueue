import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRequestFairness,
  withRequestFairnessLock,
} from "../src/request-fairness.js";

const enabled = {
  requestFairnessEnabled: true,
  requestFairnessUpcomingThreshold: 5,
  requestFairnessUpcomingCap: 2,
  requestFairnessRollingMax: 5,
  requestFairnessWindowMinutes: 30,
  requestFairnessHostBypass: true,
};

const requested = (user, id) => ({
  uri: `spotify:track:${id}`,
  title: `Song ${id}`,
  artist: "Artist",
  searched: true,
  requestedByUser: user,
});

test("request fairness is disabled by default", () => {
  const result = evaluateRequestFairness({
    settings: { requestFairnessEnabled: false },
    user: "Alex",
    queue: [requested("Alex", "one"), requested("Alex", "two")],
    events: Array.from({ length: 8 }, (_, i) => ({
      requestedBy: "Alex",
      ts: Date.now() - i * 1000,
    })),
    target: { uri: "spotify:track:new", name: "New", artist: "Artist" },
  });
  assert.equal(result.allowed, true);
});

test("upcoming cap uses canonical User case-insensitively", () => {
  const result = evaluateRequestFairness({
    settings: { ...enabled, requestFairnessUpcomingThreshold: 2 },
    user: "ALEX",
    queue: [
      requested("Alex", "one"),
      requested("alex", "two"),
      requested("Bailey", "three"),
    ],
    target: { uri: "spotify:track:new", name: "New", artist: "Artist" },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, "upcoming_cap");
  assert.equal(result.upcomingCount, 2);
});

test("solo requester is not capped even with a full waiting queue", () => {
  const eightByAlex = ["one", "two", "three", "four", "five", "six", "seven", "eight"].map(
    (id) => requested("Alex", id)
  );
  const result = evaluateRequestFairness({
    settings: enabled,
    user: "Alex",
    queue: eightByAlex,
    events: Array.from({ length: 8 }, (_, i) => ({
      requestedBy: "Alex",
      ts: Date.now() - i * 1000,
    })),
    target: { uri: "spotify:track:nine", name: "Song nine", artist: "Artist" },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.limitsActive, false);
  assert.equal(result.uniqueRequesters, 1);
});

test("upcoming cap begins only after a second requester and the song threshold", () => {
  const fourByAlex = ["one", "two", "three", "four"].map((id) =>
    requested("Alex", id)
  );
  const belowThreshold = evaluateRequestFairness({
    settings: enabled,
    user: "Bailey",
    queue: fourByAlex,
    target: { uri: "spotify:track:five", name: "Song five", artist: "Artist" },
  });
  const atThreshold = evaluateRequestFairness({
    settings: enabled,
    user: "Alex",
    queue: [...fourByAlex, requested("Bailey", "five")],
    target: { uri: "spotify:track:six", name: "Song six", artist: "Artist" },
  });
  const anotherGuestBelowCap = evaluateRequestFairness({
    settings: enabled,
    user: "Bailey",
    queue: [...fourByAlex, requested("Bailey", "five")],
    target: { uri: "spotify:track:six", name: "Song six", artist: "Artist" },
  });

  assert.equal(belowThreshold.allowed, true);
  assert.equal(belowThreshold.limitsActive, false);
  assert.equal(atThreshold.allowed, false);
  assert.equal(atThreshold.totalRequestedUpcoming, 5);
  assert.equal(atThreshold.upcomingThreshold, 5);
  assert.equal(atThreshold.uniqueRequesters, 2);
  assert.equal(anotherGuestBelowCap.allowed, true);
});

test("legacy requestedBy-only queue rows still count as a second person", () => {
  const fourByAlex = ["one", "two", "three", "four"].map((id) =>
    requested("Alex", id)
  );
  const legacyBailey = {
    uri: "spotify:track:five",
    title: "Song five",
    artist: "Artist",
    searched: true,
    requestedBy: "Bailey",
  };
  const result = evaluateRequestFairness({
    settings: enabled,
    user: "Alex",
    queue: [...fourByAlex, legacyBailey],
    target: { uri: "spotify:track:six", name: "Song six", artist: "Artist" },
  });
  assert.equal(result.uniqueRequesters, 2);
  assert.equal(result.limitsActive, true);
  assert.equal(result.allowed, false);
});

test("legacy requestedBy-only rows count toward that guest's upcoming cap", () => {
  const result = evaluateRequestFairness({
    settings: { ...enabled, requestFairnessUpcomingThreshold: 2 },
    user: "Bailey",
    queue: [
      requested("Alex", "one"),
      {
        uri: "spotify:track:two",
        title: "Song two",
        artist: "Artist",
        searched: true,
        requestedBy: "Bailey",
      },
      {
        uri: "spotify:track:three",
        title: "Song three",
        artist: "Artist",
        searched: true,
        requestedBy: "Bailey",
      },
    ],
    target: { uri: "spotify:track:four", name: "Song four", artist: "Artist" },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "upcoming_cap");
  assert.equal(result.upcomingCount, 2);
});

test("second requester in the rolling window keeps limits on after their song plays", () => {
  const sixByAlex = ["one", "two", "three", "four", "five", "six"].map((id) =>
    requested("Alex", id)
  );
  const now = Date.now();
  const result = evaluateRequestFairness({
    settings: enabled,
    user: "Alex",
    queue: sixByAlex,
    events: [{ requestedBy: "Bailey", ts: now - 60_000 }],
    target: { uri: "spotify:track:seven", name: "Song seven", artist: "Artist" },
    now,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "upcoming_cap");
  assert.equal(result.limitsActive, true);
});

test("limits turn back off when requested songs waiting drop below the threshold", () => {
  const now = Date.now();
  const result = evaluateRequestFairness({
    settings: enabled,
    user: "Alex",
    queue: [
      requested("Alex", "one"),
      requested("Alex", "two"),
      requested("Bailey", "three"),
      requested("Bailey", "four"),
    ],
    events: [
      { requestedBy: "Alex", ts: now - 60_000 },
      { requestedBy: "Bailey", ts: now - 30_000 },
    ],
    target: { uri: "spotify:track:five", name: "Song five", artist: "Artist" },
    now,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.limitsActive, false);
  assert.equal(result.totalRequestedUpcoming, 4);
});

test("rolling quota returns a retry time based on the expiring request", () => {
  const now = 1_800_000;
  const result = evaluateRequestFairness({
    settings: { ...enabled, requestFairnessRollingMax: 2 },
    user: "Alex",
    queue: [
      requested("Alex", "one"),
      requested("Bailey", "two"),
      requested("Bailey", "three"),
      requested("Bailey", "four"),
      requested("Bailey", "five"),
    ],
    events: [
      { requestedBy: "alex", ts: 300_000 },
      { requestedBy: "Alex", ts: 1_200_000 },
      { requestedBy: "Bailey", ts: 1_000_000 },
    ],
    target: { uri: "spotify:track:new", name: "New", artist: "Artist" },
    now,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.status, 429);
  assert.equal(result.code, "rolling_quota");
  assert.equal(result.retryAt, 2_100_000);
  assert.equal(result.retryAfterSec, 300);
});

test("an existing searched song is idempotent and bypasses caps", () => {
  const result = evaluateRequestFairness({
    settings: { ...enabled, requestFairnessUpcomingCap: 1 },
    user: "Bailey",
    queue: [requested("Alex", "same")],
    events: Array.from({ length: 5 }, (_, i) => ({
      requestedBy: "Bailey",
      ts: Date.now() - i * 1000,
    })),
    target: {
      uri: "spotify:track:same",
      name: "Song same",
      artist: "Artist",
    },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.requestCreated, false);
  assert.equal(result.alreadyRequested, true);
});

test("force only bypasses a same-song match, never an exact ID", () => {
  const queue = [
    {
      ...requested("Alex", "album-version"),
      title: "One More Time",
      artist: "Daft Punk",
    },
  ];
  const differentVersion = evaluateRequestFairness({
    settings: enabled,
    user: "Bailey",
    queue,
    force: true,
    target: {
      uri: "spotify:track:single-version",
      name: "One More Time",
      artist: "Daft Punk",
    },
  });
  const exactVersion = evaluateRequestFairness({
    settings: enabled,
    user: "Bailey",
    queue,
    force: true,
    target: {
      uri: "spotify:track:album-version",
      name: "One More Time",
      artist: "Daft Punk",
    },
  });
  assert.equal(differentVersion.requestCreated, true);
  assert.equal(exactVersion.requestCreated, false);
});

test("authenticated host bypass is optional", () => {
  const atCap = [
    requested("Host", "one"),
    requested("Host", "two"),
    requested("Bailey", "three"),
  ];
  const bypassed = evaluateRequestFairness({
    settings: enabled,
    user: "Host",
    queue: atCap,
    hostAuthenticated: true,
    target: { uri: "spotify:track:new", name: "New", artist: "Artist" },
  });
  const enforced = evaluateRequestFairness({
    settings: {
      ...enabled,
      requestFairnessUpcomingThreshold: 2,
      requestFairnessHostBypass: false,
    },
    user: "Host",
    queue: atCap,
    hostAuthenticated: true,
    target: { uri: "spotify:track:new", name: "New", artist: "Artist" },
  });
  assert.equal(bypassed.allowed, true);
  assert.equal(bypassed.hostBypass, true);
  assert.equal(enforced.allowed, false);
});

test("fairness lock serializes checks through commit work", async () => {
  const order = [];
  let release;
  const first = withRequestFairnessLock(async () => {
    order.push("first-start");
    await new Promise((resolve) => {
      release = resolve;
    });
    order.push("first-end");
  });
  const second = withRequestFairnessLock(async () => {
    order.push("second");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first-start"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
});

