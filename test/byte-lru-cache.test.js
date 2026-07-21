import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createByteLruCache,
  createInFlightCoalescer,
} from "../src/byte-lru-cache.js";

test("byte LRU evicts least-recently used artwork within its memory budget", () => {
  const cache = createByteLruCache(6);
  cache.set("a", { body: Buffer.alloc(3) });
  cache.set("b", { body: Buffer.alloc(3) });
  assert.ok(cache.get("a"));
  cache.set("c", { body: Buffer.alloc(3) });
  assert.equal(cache.get("b"), null);
  assert.ok(cache.get("a"));
  assert.ok(cache.get("c"));
  assert.equal(cache.bytes, 6);
});

test("byte LRU does not retain one oversized artwork response", () => {
  const cache = createByteLruCache(4);
  assert.equal(cache.set("large", { body: Buffer.alloc(5) }), false);
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
});

test("in-flight coalescer shares one upstream request and clears failures", async () => {
  const coalescer = createInFlightCoalescer();
  let calls = 0;
  let release;
  const load = async () => {
    calls += 1;
    await new Promise((resolve) => {
      release = resolve;
    });
    return "art";
  };
  const first = coalescer.run("cover", load);
  const second = coalescer.run("cover", load);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["art", "art"]);
  await Promise.resolve();
  assert.equal(coalescer.size, 0);
});
