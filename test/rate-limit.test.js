import { test } from "node:test";
import assert from "node:assert/strict";
import { softRateLimit } from "../src/rate-limit.js";

function responseStub() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function invoke(limit, ip) {
  const res = responseStub();
  let nextCalls = 0;
  limit({ ip }, res, () => {
    nextCalls += 1;
  });
  return { res, nextCalls };
}

test("softRateLimit allows requests through the configured maximum", () => {
  const limit = softRateLimit({ windowMs: 1000, max: 2, now: () => 10 });

  assert.equal(invoke(limit, "10.0.0.2").nextCalls, 1);
  assert.equal(invoke(limit, "10.0.0.2").nextCalls, 1);
});

test("softRateLimit returns 429 with retry metadata over the limit", () => {
  const limit = softRateLimit({
    windowMs: 2500,
    max: 1,
    message: "Wait your turn.",
    now: () => 100,
  });

  invoke(limit, "10.0.0.3");
  const blocked = invoke(limit, "10.0.0.3");

  assert.equal(blocked.nextCalls, 0);
  assert.equal(blocked.res.statusCode, 429);
  assert.equal(blocked.res.headers["Retry-After"], "3");
  assert.deepEqual(blocked.res.body, {
    error: "Wait your turn.",
    retryMs: 2500,
  });
});

test("softRateLimit keeps independent buckets per client IP", () => {
  const limit = softRateLimit({ windowMs: 1000, max: 1, now: () => 0 });

  assert.equal(invoke(limit, "10.0.0.4").nextCalls, 1);
  assert.equal(invoke(limit, "10.0.0.5").nextCalls, 1);
  assert.equal(invoke(limit, "10.0.0.4").res.statusCode, 429);
});

test("softRateLimit resets a bucket at the window boundary", () => {
  let currentTime = 0;
  const limit = softRateLimit({
    windowMs: 1000,
    max: 1,
    now: () => currentTime,
  });

  invoke(limit, "10.0.0.6");
  assert.equal(invoke(limit, "10.0.0.6").res.statusCode, 429);

  currentTime = 1000;
  assert.equal(invoke(limit, "10.0.0.6").nextCalls, 1);
});

test("softRateLimit falls back to the socket address", () => {
  const limit = softRateLimit({ windowMs: 1000, max: 1, now: () => 0 });
  const res = responseStub();

  limit({ socket: { remoteAddress: "10.0.0.7" } }, res, () => {});
  limit({ socket: { remoteAddress: "10.0.0.7" } }, res, () => {});

  assert.equal(res.statusCode, 429);
});
