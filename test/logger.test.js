import test from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/logger.js";

function captureSink() {
  const lines = [];
  return {
    lines,
    log(...args) {
      lines.push({ level: "info", args });
    },
    warn(...args) {
      lines.push({ level: "warn", args });
    },
    error(...args) {
      lines.push({ level: "error", args });
    },
    debug(...args) {
      lines.push({ level: "debug", args });
    },
  };
}

test("human logger keeps tagged console output", () => {
  const sink = captureSink();
  const log = createLogger("http", { sink, json: false });
  log.info("ready", { port: 8080 });
  assert.equal(sink.lines.length, 1);
  assert.equal(sink.lines[0].level, "info");
  assert.deepEqual(sink.lines[0].args.slice(0, 2), ["[http]", "ready"]);
  assert.equal(sink.lines[0].args[2].port, 8080);
});

test("json logger emits one structured object per line", () => {
  const sink = captureSink();
  const log = createLogger("shutdown", {
    sink,
    json: true,
    now: () => Date.parse("2026-07-20T12:00:00.000Z"),
  });
  log.warn("closing", { reason: "SIGTERM", err: new Error("boom") });
  assert.equal(sink.lines.length, 1);
  assert.equal(sink.lines[0].level, "warn");
  const payload = JSON.parse(sink.lines[0].args[0]);
  assert.equal(payload.ts, "2026-07-20T12:00:00.000Z");
  assert.equal(payload.level, "warn");
  assert.equal(payload.scope, "shutdown");
  assert.equal(payload.msg, "closing");
  assert.equal(payload.reason, "SIGTERM");
  assert.equal(payload.err.message, "boom");
});

test("child loggers nest scopes", () => {
  const sink = captureSink();
  const log = createLogger("server", { sink, json: false }).child("http");
  log.error("failed");
  assert.deepEqual(sink.lines[0].args.slice(0, 2), ["[server/http]", "failed"]);
});
