import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_ORIGIN = path.join(
  os.tmpdir(),
  `pq-origin-${process.pid}-${Date.now()}.json`
);
const TMP_REQUESTS = path.join(
  os.tmpdir(),
  `pq-requests-${process.pid}-${Date.now()}.json`
);
process.env.PARTYQUEUE_ORIGIN_FILE = TMP_ORIGIN;
process.env.PARTYQUEUE_REQUESTS_FILE = TMP_REQUESTS;

const origin = await import("../src/queue-origin.js");
const reqlog = await import("../src/request-log.js");
const { memoryRequesterOf, memoryRequesterIdentityOf } = await import(
  "../src/memory-requester.js"
);

beforeEach(() => {
  origin.reconcileOriginsWithQueue([]);
  reqlog.clearRequests();
});

after(() => {
  try {
    fs.rmSync(TMP_ORIGIN, { force: true });
    fs.rmSync(TMP_REQUESTS, { force: true });
  } catch {
    /* ok */
  }
});

test("memoryRequesterOf prefers a stored history name", () => {
  origin.markOrigin(["t1"], "searched", {
    requestedBy: "Mia",
    requestedByUser: "Maria",
  });
  assert.equal(memoryRequesterOf("t1", "Dave"), "Dave");
});

test("memoryRequesterOf prefers live User over queue alias", () => {
  origin.markOrigin(["t1"], "searched", {
    requestedBy: "Mia",
    requestedByUser: "Maria",
  });
  assert.equal(memoryRequesterOf("t1"), "Maria");
});

test("memoryRequesterOf falls back to the request log", () => {
  reqlog.recordRequest({
    id: "t1",
    name: "Friday I'm in Love",
    artist: "The Cure",
    requestedBy: "Maria",
  });
  assert.equal(memoryRequesterOf("t1"), "Maria");
});

test("memoryRequesterOf returns null when nobody requested it", () => {
  assert.equal(memoryRequesterOf("missing"), null);
  assert.equal(memoryRequesterOf(""), null);
});

test("memoryRequesterIdentityOf returns User plus distinct alias", () => {
  origin.markOrigin(["t1"], "searched", {
    requestedBy: "Mia",
    requestedByUser: "Maria",
  });
  assert.deepEqual(memoryRequesterIdentityOf("t1"), {
    requestedBy: "Maria",
    alias: "Mia",
  });
});

test("memoryRequesterIdentityOf omits alias when it matches the User", () => {
  origin.markOrigin(["t1"], "searched", {
    requestedBy: "Dave",
    requestedByUser: "Dave",
  });
  assert.deepEqual(memoryRequesterIdentityOf("t1"), {
    requestedBy: "Dave",
    alias: null,
  });
});

test("memoryRequesterIdentityOf promotes a stored alias to User + alias", () => {
  reqlog.recordRequest({
    id: "t1",
    name: "Friday I'm in Love",
    artist: "The Cure",
    requestedBy: "Maria",
    alias: "Mia",
  });
  assert.deepEqual(memoryRequesterIdentityOf("t1", { requestedBy: "Mia" }), {
    requestedBy: "Maria",
    alias: "Mia",
  });
});
