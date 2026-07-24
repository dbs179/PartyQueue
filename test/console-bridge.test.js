import { test } from "node:test";
import assert from "node:assert/strict";
import { installConsoleBridge } from "../src/console-bridge.js";
import { createLogger } from "../src/logger.js";

function captureSink() {
  const lines = { log: [], info: [], warn: [], error: [], debug: [] };
  const sink = {};
  for (const method of Object.keys(lines)) {
    sink[method] = (...args) => lines[method].push(args.join(" "));
  }
  return { lines, sink };
}

test("human mode redacts strings and inspects objects", () => {
  const { lines, sink } = captureSink();
  const restore = installConsoleBridge({ json: false, sink });
  try {
    console.error(
      "[spotify] refresh failed:",
      "Bearer abc123token and SPOTIFY_CLIENT_SECRET=supersecret"
    );
    console.warn("[queue] state", { retries: 2, apiKey: "hunter2" });
  } finally {
    restore();
  }
  assert.equal(lines.error.length, 1);
  assert.match(lines.error[0], /^\[spotify\] refresh failed:/);
  assert.match(lines.error[0], /Bearer \[REDACTED\]/);
  assert.match(lines.error[0], /SPOTIFY_CLIENT_SECRET=\[REDACTED\]/);
  assert.doesNotMatch(lines.error[0], /supersecret/);

  // Object args are deep-redacted by key before rendering.
  assert.match(lines.warn[0], /retries: 2/);
  assert.match(lines.warn[0], /\[REDACTED\]/);
  assert.doesNotMatch(lines.warn[0], /hunter2/);
});

test("json mode emits one JSON line and lifts the [scope] tag", () => {
  const { lines, sink } = captureSink();
  const restore = installConsoleBridge({ json: true, sink });
  try {
    console.error("[queue/remove] could not remove:", "boom");
    console.log("no scope tag here");
  } finally {
    restore();
  }
  const err = JSON.parse(lines.error[0]);
  assert.equal(err.level, "error");
  assert.equal(err.scope, "queue/remove");
  assert.equal(err.msg, "could not remove: boom");
  assert.ok(err.ts);

  const info = JSON.parse(lines.log[0]);
  assert.equal(info.scope, "console");
  assert.equal(info.msg, "no scope tag here");
});

test("json mode passes structured-logger JSON lines through untouched", () => {
  const { lines, sink } = captureSink();
  const restore = installConsoleBridge({ json: true, sink });
  try {
    // The structured logger writes to the (bridged) global console.
    createLogger("harness", { json: true, now: () => 0 }).info("hello", {
      n: 1,
    });
  } finally {
    restore();
  }
  const parsed = JSON.parse(lines.log[0]);
  assert.equal(parsed.scope, "harness");
  assert.equal(parsed.msg, "hello");
  assert.equal(parsed.n, 1);
  // Not double-wrapped: the payload keys sit at the top level.
  assert.equal(parsed.scope === "console", false);
});

test("restore puts the original console methods back", () => {
  const before = console.log;
  const restore = installConsoleBridge({ json: false, sink: captureSink().sink });
  assert.notEqual(console.log, before);
  restore();
  assert.equal(console.log, before);
});
