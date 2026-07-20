import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_PIN = path.join(
  os.tmpdir(),
  `pq-host-pin-${process.pid}-${Date.now()}.json`
);
process.env.PARTYQUEUE_HOST_PIN_FILE = TMP_PIN;

const auth = await import("../src/host-auth.js");

beforeEach(() => {
  auth._resetHostSessionsForTests();
  auth._bustHostPinCacheForTests();
  delete process.env.SETTINGS_PIN;
  try {
    fs.rmSync(TMP_PIN, { force: true });
  } catch {
    /* ignore */
  }
  auth._bustHostPinCacheForTests();
});

afterEach(() => {
  try {
    fs.rmSync(TMP_PIN, { force: true });
  } catch {
    /* ignore */
  }
});

test("isHostPinConfigured follows SETTINGS_PIN env", () => {
  assert.equal(auth.isHostPinConfigured(), false);
  process.env.SETTINGS_PIN = "1234";
  assert.equal(auth.isHostPinConfigured(), true);
  assert.equal(auth.hostPinSource(), "env");
});

test("setHostPin stores a hash and verifies", () => {
  const set = auth.setHostPin("party42");
  assert.equal(set.ok, true);
  assert.equal(auth.isHostPinConfigured(), true);
  assert.equal(auth.hostPinSource(), "file");
  assert.equal(auth.verifyHostPin("party42"), true);
  assert.equal(auth.verifyHostPin("wrong"), false);
  const raw = JSON.parse(fs.readFileSync(TMP_PIN, "utf8"));
  assert.ok(raw.salt);
  assert.ok(raw.hash);
  assert.notEqual(raw.hash, "party42");
});

test("file PIN takes precedence over env", () => {
  process.env.SETTINGS_PIN = "envpin1";
  auth.setHostPin("filepin1");
  assert.equal(auth.verifyHostPin("filepin1"), true);
  assert.equal(auth.verifyHostPin("envpin1"), false);
});

test("clearHostPin removes file PIN", () => {
  auth.setHostPin("party42");
  const cleared = auth.clearHostPin();
  assert.equal(cleared.ok, true);
  assert.equal(auth.isHostPinConfigured(), false);
});

test("clearHostPin reports env-only PIN", () => {
  process.env.SETTINGS_PIN = "1234";
  const cleared = auth.clearHostPin();
  assert.equal(cleared.ok, false);
  assert.equal(auth.isHostPinConfigured(), true);
});

test("createHostSession tokens validate until reset", () => {
  process.env.SETTINGS_PIN = "1234";
  const token = auth.createHostSession();
  assert.equal(typeof token, "string");
  assert.ok(token.length >= 32);
  assert.equal(auth.isValidHostToken(token), true);
  assert.equal(auth.isValidHostToken("nope"), false);
});

test("extractHostToken reads header, bearer, and cookie", () => {
  assert.equal(
    auth.extractHostToken({
      get: (n) => (n === "x-partyqueue-host" ? " hdr-token " : ""),
      headers: {},
    }),
    "hdr-token"
  );
  assert.equal(
    auth.extractHostToken({
      get: (n) => (n === "authorization" ? "Bearer abc.def" : ""),
      headers: {},
    }),
    "abc.def"
  );
  assert.equal(
    auth.extractHostToken({
      get: () => "",
      headers: { cookie: "a=1; pq_host=cookie%2Dtoken; b=2" },
    }),
    "cookie-token"
  );
});

test("requireHost is a no-op when PIN is unset", () => {
  let nextCalled = false;
  auth.requireHost({}, {}, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test("requireHost rejects missing session when PIN is set", () => {
  process.env.SETTINGS_PIN = "9999";
  let status = 0;
  let body = null;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  let nextCalled = false;
  auth.requireHost(
    { get: () => "", headers: {} },
    res,
    () => {
      nextCalled = true;
    }
  );
  assert.equal(nextCalled, false);
  assert.equal(status, 401);
  assert.equal(body.pinRequired, true);

  const token = auth.createHostSession();
  status = 0;
  nextCalled = false;
  auth.requireHost(
    {
      get: (n) => (n === "x-partyqueue-host" ? token : ""),
      headers: {},
    },
    res,
    () => {
      nextCalled = true;
    }
  );
  assert.equal(nextCalled, true);
});

test("setHostPin revokes existing sessions", () => {
  auth.setHostPin("first1");
  const token = auth.createHostSession();
  assert.equal(auth.isValidHostToken(token), true);
  auth.setHostPin("second1");
  assert.equal(auth.isValidHostToken(token), false);
});
