import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_REQUESTS = path.join(
  os.tmpdir(),
  `pq-party-stats-req-${process.pid}-${Date.now()}.json`
);
const TMP_REACTIONS = path.join(
  os.tmpdir(),
  `pq-party-stats-rx-${process.pid}-${Date.now()}.json`
);

process.env.PARTYQUEUE_REQUESTS_FILE = TMP_REQUESTS;
process.env.PARTYQUEUE_REACTIONS_FILE = TMP_REACTIONS;

const reqlog = await import("../src/request-log.js");
const reactions = await import("../src/reactions.js");
const stats = await import("../src/party-stats.js");

let now = 1_000_000;
const noTracks = async () => new Map();

beforeEach(() => {
  now = 1_000_000;
  reqlog.clearRequests();
  reactions.clearReactions();
  stats.configurePartyStatsCacheForTests({
    now: () => now,
    ttlMs: 3000,
  });
});

afterEach(() => {
  try {
    fs.unlinkSync(TMP_REQUESTS);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(TMP_REACTIONS);
  } catch {
    /* ignore */
  }
});

test("getPartyStatsPayload caches within TTL", async () => {
  reqlog.recordRequest(
    { id: "a", name: "Song A", artist: "Art", requestedBy: "Pat" },
    now
  );
  const first = await stats.getPartyStatsPayload({ getTracksByIds: noTracks });
  assert.equal(first.tonight.total, 1);
  assert.equal(stats.partyStatsCacheInfoForTests().hasCache, true);

  // Mutating the store without going through recordRequest would normally be
  // impossible; force a second build only after TTL by advancing time.
  now += 500;
  const second = await stats.getPartyStatsPayload({ getTracksByIds: noTracks });
  assert.equal(second, first);
});

test("TTL expiry rebuilds payload", async () => {
  reqlog.recordRequest(
    { id: "a", name: "Song A", artist: "Art" },
    now
  );
  const first = await stats.getPartyStatsPayload({ getTracksByIds: noTracks });
  now += 3001;
  const second = await stats.getPartyStatsPayload({ getTracksByIds: noTracks });
  assert.notEqual(second, first);
  assert.equal(second.tonight.total, 1);
});

test("recordRequest invalidates cache so next read sees the add", async () => {
  const empty = await stats.getPartyStatsPayload({ getTracksByIds: noTracks });
  assert.equal(empty.tonight.total, 0);

  reqlog.recordRequest(
    { id: "b", name: "Song B", artist: "Bee", requestedBy: "Sam" },
    now + 10
  );
  assert.equal(stats.partyStatsCacheInfoForTests().hasCache, false);

  const next = await stats.getPartyStatsPayload({ getTracksByIds: noTracks });
  assert.equal(next.tonight.total, 1);
  assert.equal(next.tonight.topSongs[0].id, "b");
});

test("setReaction invalidates liked list cache", async () => {
  await stats.getPartyStatsPayload({ getTracksByIds: noTracks });
  assert.equal(stats.partyStatsCacheInfoForTests().hasCache, true);

  reactions.setReaction("t1", "up", "guest-alex-01", {
    by: "Alex",
    name: "Liked",
    artist: "Band",
  });
  assert.equal(stats.partyStatsCacheInfoForTests().hasCache, false);

  const next = await stats.getPartyStatsPayload({ getTracksByIds: noTracks });
  assert.ok(next.topLiked.some((r) => r.id === "t1"));
});

test("clearRequests invalidates cache", async () => {
  reqlog.recordRequest({ id: "x", name: "X", artist: "Y" }, now);
  await stats.getPartyStatsPayload({ getTracksByIds: noTracks });
  reqlog.clearRequests();
  assert.equal(stats.partyStatsCacheInfoForTests().hasCache, false);
  const next = await stats.getPartyStatsPayload({ getTracksByIds: noTracks });
  assert.equal(next.tonight.total, 0);
  assert.equal(next.allTime.total, 0);
});

test("fills missing reaction titles via getTracksByIds", async () => {
  reactions.setReaction("missing-meta", "fire", "guest-jo-001", { by: "Jo" });
  let called = false;
  const payload = await stats.getPartyStatsPayload({
    getTracksByIds: async (ids) => {
      called = true;
      assert.ok(ids.includes("missing-meta"));
      return new Map([
        ["missing-meta", { title: "Filled", artist: "From Spotify" }],
      ]);
    },
  });
  assert.equal(called, true);
  const row = payload.topLiked.find((r) => r.id === "missing-meta");
  assert.equal(row?.name, "Filled");
  assert.equal(row?.artist, "From Spotify");
});
