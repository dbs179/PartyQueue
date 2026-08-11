import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { envTimeoutMs, withTimeout } from "../src/with-timeout.js";

describe("withTimeout", () => {
  it("resolves when the work finishes first", async () => {
    const value = await withTimeout(Promise.resolve("ok"), 100, "slow");
    assert.equal(value, "ok");
  });

  it("rejects when the deadline wins", async () => {
    await assert.rejects(
      withTimeout(new Promise(() => {}), 20, "LLM script timed out"),
      /LLM script timed out/
    );
  });

  it("skips racing when ms is non-positive", async () => {
    const value = await withTimeout(Promise.resolve("pass"), 0, "unused");
    assert.equal(value, "pass");
  });
});

describe("envTimeoutMs", () => {
  it("uses fallback when env missing or invalid", () => {
    const prev = process.env.PARTYQUEUE_TEST_TIMEOUT_MS;
    delete process.env.PARTYQUEUE_TEST_TIMEOUT_MS;
    assert.equal(envTimeoutMs("PARTYQUEUE_TEST_TIMEOUT_MS", 1234), 1234);
    process.env.PARTYQUEUE_TEST_TIMEOUT_MS = "nope";
    assert.equal(envTimeoutMs("PARTYQUEUE_TEST_TIMEOUT_MS", 1234), 1234);
    if (prev === undefined) delete process.env.PARTYQUEUE_TEST_TIMEOUT_MS;
    else process.env.PARTYQUEUE_TEST_TIMEOUT_MS = prev;
  });

  it("reads a positive env override", () => {
    const prev = process.env.PARTYQUEUE_TEST_TIMEOUT_MS;
    process.env.PARTYQUEUE_TEST_TIMEOUT_MS = "50";
    assert.equal(envTimeoutMs("PARTYQUEUE_TEST_TIMEOUT_MS", 1234), 50);
    if (prev === undefined) delete process.env.PARTYQUEUE_TEST_TIMEOUT_MS;
    else process.env.PARTYQUEUE_TEST_TIMEOUT_MS = prev;
  });
});
