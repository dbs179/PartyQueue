import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the store at a throwaway file BEFORE importing the module.
const TMP_FILE = path.join(os.tmpdir(), `pq-requests-${process.pid}-${Date.now()}.json`);
process.env.PARTYQUEUE_REQUESTS_FILE = TMP_FILE;

const reqlog = await import("../src/request-log.js");

beforeEach(() => {
  reqlog.clearRequests();
});

test("records and returns requests oldest-first", () => {
  reqlog.recordRequest({ id: "a", name: "Song A", artist: "Artist 1" }, 1000);
  reqlog.recordRequest({ id: "b", name: "Song B", artist: "Artist 2" }, 2000);
  const all = reqlog.getRequests();
  assert.equal(all.length, 2);
  assert.equal(all[0].id, "a");
  assert.equal(all[1].id, "b");
  assert.equal(all[0].ts, 1000);
});

test("ignores requests without a valid id", () => {
  reqlog.recordRequest({ name: "no id" });
  reqlog.recordRequest({ id: "", name: "blank" });
  assert.equal(reqlog.getRequests().length, 0);
});

test("persists to disk so stats survive a restart", () => {
  reqlog.recordRequest({ id: "x", name: "X", artist: "Y" }, 1234);
  reqlog.flushRequestsPersist();
  const raw = JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
  assert.ok(raw.some((e) => e.id === "x" && e.ts === 1234));
});

test("debounces disk writes until flush", () => {
  reqlog.recordRequest({ id: "a", name: "A", artist: "X" }, 1);
  reqlog.recordRequest({ id: "b", name: "B", artist: "Y" }, 2);
  assert.equal(fs.existsSync(TMP_FILE), false);
  assert.equal(reqlog.flushRequestsPersist(), true);
  const raw = JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
  assert.equal(raw.length, 2);
});

test("stores requestedBy on request events", () => {
  reqlog.recordRequest(
    { id: "r1", name: "Song", artist: "Art", requestedBy: "  Pat  " },
    50
  );
  const all = reqlog.getRequests();
  assert.equal(all[0].requestedBy, "Pat");
  reqlog.flushRequestsPersist();
  const raw = JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
  assert.equal(raw[0].requestedBy, "Pat");
});

// summarizeRequests is pure; exercise it directly.
const sample = [
  { id: "s1", name: "Hit", artist: "Alpha", ts: 100 },
  { id: "s1", name: "Hit", artist: "Alpha", ts: 200 },
  { id: "s1", name: "Hit", artist: "Alpha", ts: 9000 },
  { id: "s2", name: "Bop", artist: "Beta, Gamma", ts: 9000 },
  { id: "s3", name: "Jam", artist: "Alpha", ts: 50 },
];

test("summarizeRequests ranks top songs and artists by count", () => {
  const out = reqlog.summarizeRequests(sample, 0);
  assert.equal(out.total, 5);
  assert.equal(out.topSongs[0].id, "s1");
  assert.equal(out.topSongs[0].count, 3);
  // Alpha appears 4x (3 on s1 + 1 on s3), so it's the top artist.
  assert.equal(out.topArtists[0].artist, "Alpha");
  assert.equal(out.topArtists[0].count, 4);
});

test("summarizeRequests uses only the primary (first) artist", () => {
  const out = reqlog.summarizeRequests([sample[3]], 0);
  assert.equal(out.topArtists[0].artist, "Beta");
});

test("summarizeRequests filters by sinceTs (the 'tonight' window)", () => {
  const out = reqlog.summarizeRequests(sample, 1000); // only ts >= 1000
  assert.equal(out.total, 2); // the two ts:9000 events
  assert.equal(out.topSongs.length, 2);
});

test("summarizeRequests honors the limit", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    id: `id${i}`,
    name: `n${i}`,
    artist: `Art${i}`,
    ts: 1,
  }));
  const out = reqlog.summarizeRequests(many, 0, 3);
  assert.equal(out.topSongs.length, 3);
  assert.equal(out.topArtists.length, 3);
});

test("topRequesters ranks by count and skips blank names", () => {
  const events = [
    { id: "1", ts: 1, requestedBy: "Alex" },
    { id: "2", ts: 2, requestedBy: "Sam" },
    { id: "3", ts: 3, requestedBy: "Alex" },
    { id: "4", ts: 4 },
  ];
  const top = reqlog.topRequesters(events, 0, 5);
  assert.deepEqual(top, [
    { name: "Alex", count: 2 },
    { name: "Sam", count: 1 },
  ]);
});

test("topRequesters aggregates by User when aliases differ", () => {
  // Server stamps requestedBy=User; alias is audit-only and must not split stats.
  reqlog.recordRequest(
    { id: "a", name: "A", artist: "X", requestedBy: "Mark", alias: "Party Alex" },
    100
  );
  reqlog.recordRequest(
    { id: "b", name: "B", artist: "Y", requestedBy: "Mark", alias: "Alias Mark" },
    200
  );
  reqlog.recordRequest(
    { id: "c", name: "C", artist: "Z", requestedBy: "Alex", alias: "Disco Alex" },
    300
  );
  const top = reqlog.topRequesters(reqlog.getRequests(), 0, 5);
  assert.deepEqual(top, [
    { name: "Mark", count: 2 },
    { name: "Alex", count: 1 },
  ]);
  reqlog.flushRequestsPersist();
  const raw = JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
  assert.equal(raw[0].requestedBy, "Mark");
  assert.equal(raw[0].alias, "Party Alex");
});

test("recentRequests returns newest first", () => {
  reqlog.recordRequest({ id: "a", name: "A", artist: "X", requestedBy: "Alex" }, 100);
  reqlog.recordRequest({ id: "b", name: "B", artist: "Y", requestedBy: "Sam" }, 200);
  const recent = reqlog.recentRequests(2);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].id, "b");
  assert.equal(recent[1].id, "a");
});

test("stores dedication on record and listDedications", () => {
  reqlog.recordRequest(
    {
      id: "d1",
      name: "Song",
      artist: "Art",
      requestedBy: "Mark",
      dedication: "  Sarah  ",
    },
    100
  );
  reqlog.recordRequest(
    { id: "d2", name: "Other", artist: "Art", requestedBy: "Alex" },
    200
  );
  const all = reqlog.getRequests();
  assert.equal(all[0].dedication, "Sarah");
  assert.equal(all[1].dedication, undefined);
  const wall = reqlog.listDedications(0, 10);
  assert.equal(wall.length, 1);
  assert.equal(wall[0].dedication, "Sarah");
  assert.equal(wall[0].requestedBy, "Mark");
});

test("setRequestDedication updates the newest matching request", () => {
  reqlog.recordRequest({ id: "x", name: "A", artist: "Y", requestedBy: "Pat" }, 10);
  assert.equal(reqlog.setRequestDedication("x", "Jess"), true);
  assert.equal(reqlog.getRequests()[0].dedication, "Jess");
  const wall = reqlog.listDedications(0, 5);
  assert.equal(wall[0].dedication, "Jess");
});
