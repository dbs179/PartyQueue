import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_FILE = path.join(
  os.tmpdir(),
  `pq-origin-${process.pid}-${Date.now()}.json`
);

let origin;

beforeEach(async () => {
  process.env.PARTYQUEUE_ORIGIN_FILE = TMP_FILE;
  try {
    fs.unlinkSync(TMP_FILE);
  } catch {
    /* ignore */
  }
  origin = await import(
    `../src/queue-origin.js?t=${Date.now()}-${Math.random()}`
  );
});

afterEach(() => {
  try {
    fs.unlinkSync(TMP_FILE);
  } catch {
    /* ignore */
  }
  delete process.env.PARTYQUEUE_ORIGIN_FILE;
});

test("records and reports a song's source", () => {
  origin.markOrigin(["a"], "searched");
  assert.equal(origin.originOf("a"), "searched");
  assert.equal(origin.isSearched("a"), true);
  assert.equal(origin.isFiller("a"), false);
});

test("filler covers both 'filler' and 'discovered'", () => {
  origin.markOrigin(["f"], "filler");
  origin.markOrigin(["d"], "discovered");
  assert.equal(origin.isFiller("f"), true);
  assert.equal(origin.isFiller("d"), true);
  assert.equal(origin.isDiscovered("d"), true);
});

test("most-recent source wins when re-marked", () => {
  origin.markOrigin(["x"], "filler");
  origin.markOrigin(["x"], "searched");
  assert.equal(origin.originOf("x"), "searched");
});

test("persists to disk so it survives a restart", async () => {
  origin.markOrigin(["p"], "searched");
  origin.flushOriginPersist();
  const raw = JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
  assert.ok(raw.some((e) => e.id === "p" && e.source === "searched"));
});

test("debounces disk writes until flush", () => {
  origin.markOrigin(["a"], "searched");
  origin.markOrigin(["b"], "filler");
  assert.equal(fs.existsSync(TMP_FILE), false);
  assert.equal(origin.flushOriginPersist(), true);
  const raw = JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
  assert.equal(raw.length, 2);
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
});

test("stores requestedBy on searched origins and preserves it", () => {
  origin.markOrigin(["rb1"], "searched", { requestedBy: "  Alex  " });
  assert.equal(origin.requestedByOf("rb1"), "Alex");
  origin.markOrigin(["rb1"], "searched");
  assert.equal(origin.requestedByOf("rb1"), "Alex");
  origin.markOrigin(["rb1"], "filler");
  assert.equal(origin.requestedByOf("rb1"), null);
});

test("stores dedication on searched origins", () => {
  origin.markOrigin(["d1"], "searched", {
    requestedBy: "Sam",
    dedication: "  This one's for Jen  ",
  });
  assert.equal(origin.dedicationOf("d1"), "This one's for Jen");
  // Re-mark without a dedication key keeps the live note (internal updates).
  origin.markOrigin(["d1"], "searched", { requestedBy: "Sam" });
  assert.equal(origin.dedicationOf("d1"), "This one's for Jen");
  // A new queue instance that passes dedication: null must not inherit.
  origin.markOrigin(["d1"], "searched", {
    requestedBy: "Sam",
    dedication: null,
  });
  assert.equal(origin.dedicationOf("d1"), null);
});

test("appendInstance keeps multiple dedications for the same track", () => {
  origin.markOrigin(["nine"], "searched", {
    requestedBy: "A",
    dedication: "Maria",
  });
  origin.markOrigin(["nine"], "searched", {
    requestedBy: "B",
    dedication: "Dave",
    appendInstance: true,
  });
  origin.markOrigin(["nine"], "searched", {
    requestedBy: "C",
    dedication: "Owen",
    appendInstance: true,
  });
  const inst = origin.searchedInstancesOf("nine");
  assert.equal(inst.length, 3);
  assert.deepEqual(
    inst.map((x) => x.dedication),
    ["Maria", "Dave", "Owen"]
  );
  assert.equal(origin.originMetaForOccurrence("nine", 0).dedication, "Maria");
  assert.equal(origin.originMetaForOccurrence("nine", 1).dedication, "Dave");
  assert.equal(origin.originMetaForOccurrence("nine", 2).dedication, "Owen");
  // Fourth add with no dedication.
  origin.markOrigin(["nine"], "searched", {
    requestedBy: "D",
    dedication: null,
    appendInstance: true,
  });
  assert.equal(origin.originMetaForOccurrence("nine", 3).dedication, null);
});

test("clearConsumedDedication removes the oldest instance only", () => {
  origin.markOrigin(["d3"], "searched", {
    requestedBy: "Alex",
    dedication: "Maria",
  });
  origin.markOrigin(["d3"], "searched", {
    requestedBy: "Alex",
    dedication: "Dave",
    appendInstance: true,
  });
  origin.clearConsumedDedication("d3");
  assert.equal(origin.searchedInstancesOf("d3").length, 1);
  assert.equal(origin.dedicationOf("d3"), "Dave");
  origin.clearConsumedDedication("d3");
  assert.equal(origin.searchedInstancesOf("d3").length, 0);
  origin.clearConsumedDedication("missing");
});

test("clearSearchedOccurrence removes a middle host-deleted copy", () => {
  origin.markOrigin(["nine"], "searched", {
    requestedBy: "A",
    dedication: "Maria",
  });
  origin.markOrigin(["nine"], "searched", {
    requestedBy: "B",
    dedication: "Dave",
    appendInstance: true,
  });
  origin.markOrigin(["nine"], "searched", {
    requestedBy: "C",
    dedication: "Owen",
    appendInstance: true,
  });
  origin.clearSearchedOccurrence("nine", 1);
  assert.deepEqual(
    origin.searchedInstancesOf("nine").map((x) => x.dedication),
    ["Maria", "Owen"]
  );
  assert.equal(origin.originMetaForOccurrence("nine", 1).dedication, "Owen");
});

test("advanceHeardTrack does not clear origin when entering DJ announce pads", () => {
  // Empty-queue Set Request: first song registers as heard, then shout pads.
  const afterSong = origin.advanceHeardTrack(null, {
    playingFromQueue: true,
    uri: "spotify:track:adventure",
    trackId: "adventure",
  });
  assert.equal(afterSong.heardId, "adventure");
  assert.equal(afterSong.lastHeardTrackId, "adventure");
  assert.equal(afterSong.clearId, null);

  const onRamp = origin.advanceHeardTrack(afterSong.lastHeardTrackId, {
    playingFromQueue: true,
    uri: "http://partyqueue/media/tts/silence-ramp-3s.mp3",
    djClip: false,
    silenceBridge: true,
    trackId: null,
  });
  assert.equal(onRamp.clearId, null, "must keep Set Request origin through DJ");
  assert.equal(onRamp.lastHeardTrackId, "adventure");

  const onTts = origin.advanceHeardTrack(onRamp.lastHeardTrackId, {
    playingFromQueue: true,
    uri: "http://ha/tts_proxy/clip.mp3",
    djClip: true,
    silenceBridge: false,
  });
  assert.equal(onTts.clearId, null);
  assert.equal(onTts.lastHeardTrackId, "adventure");

  // Same song resumes after announce — no clear, no re-record.
  const resume = origin.advanceHeardTrack(onTts.lastHeardTrackId, {
    playingFromQueue: true,
    uri: "spotify:track:adventure",
    trackId: "adventure",
  });
  assert.equal(resume.clearId, null);
  assert.equal(resume.heardId, null);
  assert.equal(resume.lastHeardTrackId, "adventure");

  // Next music track consumes the prior request.
  const next = origin.advanceHeardTrack(resume.lastHeardTrackId, {
    playingFromQueue: true,
    uri: "spotify:track:magic",
    trackId: "magic",
  });
  assert.equal(next.clearId, "adventure");
  assert.equal(next.heardId, "magic");
  assert.equal(next.lastHeardTrackId, "magic");
});

test("advanceHeardTrack clears when leaving the queue or going idle", () => {
  assert.deepEqual(
    origin.advanceHeardTrack("abc", {
      playingFromQueue: false,
      uri: "spotify:track:abc",
      trackId: "abc",
    }),
    { lastHeardTrackId: null, clearId: "abc", heardId: null }
  );
  assert.deepEqual(
    origin.advanceHeardTrack("abc", {
      playingFromQueue: true,
      uri: null,
    }),
    { lastHeardTrackId: null, clearId: "abc", heardId: null }
  );
});

test("setDedication updates or clears the newest searched instance", () => {
  origin.markOrigin(["d2"], "searched", { requestedBy: "Mark" });
  const set = origin.setDedication("d2", "  Sarah  ");
  assert.equal(set.ok, true);
  assert.equal(set.dedication, "Sarah");
  assert.equal(origin.dedicationOf("d2"), "Sarah");
  origin.markOrigin(["d2"], "searched", {
    requestedBy: "Mark",
    dedication: "Owen",
    appendInstance: true,
  });
  // Toast dedicate targets the newest copy.
  origin.setDedication("d2", "Updated Owen");
  assert.equal(origin.originMetaForOccurrence("d2", 0).dedication, "Sarah");
  assert.equal(
    origin.originMetaForOccurrence("d2", 1).dedication,
    "Updated Owen"
  );
  const cleared = origin.setDedication("d2", "   ");
  assert.equal(cleared.ok, true);
  assert.equal(origin.originMetaForOccurrence("d2", 1).dedication, null);
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
  origin.flushOriginPersist();
  const raw = JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
  assert.ok(raw.some((e) => e.id === "era1" && e.mood === "80s"));
  origin.markOrigin(["era2"], "mood", { mood: "90s" });
  assert.equal(origin.originSnapshot().get("era1").mood, "80s");
  assert.equal(origin.originSnapshot().get("era2").mood, "90s");
  origin.markOrigin(["era1"], "filler", { mood: "90s" });
  assert.equal(origin.originSnapshot().get("era1").mood, null);
});

test("stores the set genre lane on filler origins and survives a reload", () => {
  origin.markOrigin(["lane1"], "filler", { genreLane: "pop" });
  assert.equal(origin.genreLaneOf("lane1"), "pop");
  origin.flushOriginPersist();
  const raw = JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
  assert.ok(raw.some((e) => e.id === "lane1" && e.genreLane === "pop"));
  origin.markOrigin(["lane2"], "discovered", { genreLane: "folk" });
  assert.equal(origin.genreLaneOf("lane1"), "pop");
  assert.equal(origin.genreLaneOf("lane2"), "folk");
  origin.markOrigin(["lane1"], "filler");
  assert.equal(origin.genreLaneOf("lane1"), "pop");
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
  origin.markOrigin(["alias1"], "searched");
  assert.equal(origin.requestedByOf("alias1"), "Party Alex");
  assert.equal(origin.requestedByUserOf("alias1"), "Mark");
  origin.markOrigin(["legacy"], "searched", { requestedBy: "Sam" });
  assert.equal(origin.requestedByUserOf("legacy"), "Sam");
});
