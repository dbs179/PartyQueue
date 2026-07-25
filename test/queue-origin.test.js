import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the store at a throwaway file BEFORE importing the module, so the real
// data/queue-origin.json is never touched.
const TMP_FILE = path.join(
  os.tmpdir(),
  `pq-origin-${process.pid}-${Date.now()}.json`
);
process.env.PARTYQUEUE_ORIGIN_FILE = TMP_FILE;

const origin = await import("../src/queue-origin.js");

beforeEach(() => {
  try {
    fs.rmSync(TMP_FILE, { force: true });
  } catch {
    /* ignore */
  }
});

test("records and reports a song's source", () => {
  origin.markOrigin(["a"], "searched");
  assert.equal(origin.isSearched("a"), true);
  assert.equal(origin.isFiller("a"), false);
});

test("filler covers both 'filler' and 'discovered'", () => {
  origin.markOrigin(["f"], "filler");
  origin.markOrigin(["d"], "discovered");
  assert.equal(origin.isFiller("f"), true);
  assert.equal(origin.isFiller("d"), true);
  assert.equal(origin.isDiscovered("d"), true);
  assert.equal(origin.isDiscovered("f"), false);
});

test("most-recent source wins when re-marked", () => {
  origin.markOrigin(["x"], "filler");
  origin.markOrigin(["x"], "searched");
  assert.equal(origin.isSearched("x"), true);
  assert.equal(origin.isFiller("x"), false);
});

test("persists to disk so it survives a restart", () => {
  origin.markOrigin(["p"], "searched");
  const raw = JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
  assert.ok(raw.some((e) => e.id === "p" && e.source === "searched"));
});

test("ignores blank ids and unknown sources", () => {
  origin.markOrigin(["", null, undefined], "searched");
  origin.markOrigin(["bad"], "nonsense");
  assert.equal(origin.originOf("bad"), null);
});

test("snapshot returns a map of id -> { source, requestedBy }", () => {
  origin.markOrigin(["m1"], "searched", { requestedBy: "Sarah" });
  origin.markOrigin(["m2"], "filler");
  const snap = origin.originSnapshot();
  assert.equal(snap.get("m1").source, "searched");
  assert.equal(snap.get("m1").requestedBy, "Sarah");
  assert.equal(snap.get("m2").source, "filler");
  assert.equal(snap.get("m2").requestedBy, null);
});

test("stores requestedBy on searched origins and preserves it", () => {
  origin.markOrigin(["rb1"], "searched", { requestedBy: "  Alex  " });
  assert.equal(origin.requestedByOf("rb1"), "Alex");
  // Re-mark without a name keeps the previous requester.
  origin.markOrigin(["rb1"], "searched");
  assert.equal(origin.requestedByOf("rb1"), "Alex");
  // Filler clears requester.
  origin.markOrigin(["rb1"], "filler");
  assert.equal(origin.requestedByOf("rb1"), null);
  assert.equal(origin.originOf("rb1"), "filler");
});

test("stores dedication on searched origins", () => {
  origin.markOrigin(["d1"], "searched", {
    requestedBy: "Sam",
    dedication: "  This one's for Jen  ",
  });
  assert.equal(origin.dedicationOf("d1"), "This one's for Jen");
  origin.markOrigin(["d1"], "searched", { requestedBy: "Sam" });
  assert.equal(origin.dedicationOf("d1"), "This one's for Jen");
  origin.markOrigin(["d1"], "filler");
  assert.equal(origin.dedicationOf("d1"), null);
});

test("setDedication updates or clears a searched origin", () => {
  origin.markOrigin(["d2"], "searched", { requestedBy: "Mark" });
  const set = origin.setDedication("d2", "  Sarah  ");
  assert.equal(set.ok, true);
  assert.equal(set.dedication, "Sarah");
  assert.equal(origin.dedicationOf("d2"), "Sarah");
  const cleared = origin.setDedication("d2", "   ");
  assert.equal(cleared.ok, true);
  assert.equal(cleared.dedication, null);
  assert.equal(origin.dedicationOf("d2"), null);
  const bad = origin.setDedication("missing", "Jen");
  assert.equal(bad.ok, false);
});

test("sanitizes blank / oversized requestedBy", () => {
  origin.markOrigin(["rb2"], "searched", { requestedBy: "   " });
  assert.equal(origin.requestedByOf("rb2"), null);
  origin.markOrigin(["rb3"], "searched", {
    requestedBy: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  });
  assert.equal(origin.requestedByOf("rb3"), "ABCDEFGHIJKLMNOPQRSTUVWX");
});

test("stores the decade on mood origins and survives a reload", () => {
  origin.markOrigin(["era1"], "mood", { mood: "80s" });
  const snap = origin.originSnapshot().get("era1");
  assert.equal(snap.source, "mood");
  assert.equal(snap.mood, "80s");
  // Persisted to disk with the decade attached.
  const raw = JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
  assert.ok(raw.some((e) => e.id === "era1" && e.mood === "80s"));
  // A later batch under a different decade doesn't relabel this track...
  origin.markOrigin(["era2"], "mood", { mood: "90s" });
  assert.equal(origin.originSnapshot().get("era1").mood, "80s");
  assert.equal(origin.originSnapshot().get("era2").mood, "90s");
  // ...and non-mood sources never carry a decade.
  origin.markOrigin(["era1"], "filler", { mood: "90s" });
  assert.equal(origin.originSnapshot().get("era1").mood, null);
});

test("stores the set genre lane on filler origins and survives a reload", () => {
  origin.markOrigin(["lane1"], "filler", { genreLane: "pop" });
  assert.equal(origin.genreLaneOf("lane1"), "pop");
  const raw = JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
  assert.ok(raw.some((e) => e.id === "lane1" && e.genreLane === "pop"));
  // Later batch under a different lane does not relabel this track.
  origin.markOrigin(["lane2"], "discovered", { genreLane: "folk" });
  assert.equal(origin.genreLaneOf("lane1"), "pop");
  assert.equal(origin.genreLaneOf("lane2"), "folk");
  // Re-mark without a lane keeps the previous value.
  origin.markOrigin(["lane1"], "filler");
  assert.equal(origin.genreLaneOf("lane1"), "pop");
  // Searched requests never carry a set lane.
  origin.markOrigin(["lane1"], "searched", { genreLane: "rock" });
  assert.equal(origin.genreLaneOf("lane1"), null);
});

test("stores badge alias and requestedByUser separately", () => {
  origin.markOrigin(["alias1"], "searched", {
    requestedBy: "Party Alex",
    requestedByUser: "Mark",
  });
  assert.equal(origin.requestedByOf("alias1"), "Party Alex");
  assert.equal(origin.requestedByUserOf("alias1"), "Mark");
  const snap = origin.originSnapshot().get("alias1");
  assert.equal(snap.requestedBy, "Party Alex");
  assert.equal(snap.requestedByUser, "Mark");
  // Re-mark without identity keeps previous values.
  origin.markOrigin(["alias1"], "searched");
  assert.equal(origin.requestedByOf("alias1"), "Party Alex");
  assert.equal(origin.requestedByUserOf("alias1"), "Mark");
  // Old rows without requestedByUser fall back to badge for user lookup.
  origin.markOrigin(["legacy"], "searched", { requestedBy: "Sam" });
  assert.equal(origin.requestedByUserOf("legacy"), "Sam");
});
