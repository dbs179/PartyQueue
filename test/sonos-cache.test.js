import { test } from "node:test";
import assert from "node:assert/strict";

import { makeCachedReader } from "../src/sonos.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("cache bust prevents an in-flight stale read from repopulating cache", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const read = makeCachedReader(() => {
    calls += 1;
    return calls === 1 ? first.promise : second.promise;
  }, 60_000);

  const staleRequest = read();
  assert.equal(calls, 1);

  read.bust();
  const freshRequest = read();
  assert.equal(calls, 2, "post-bust caller must not join the stale request");

  first.resolve({ total: 1 });
  assert.deepEqual(await staleRequest, { total: 1 });

  second.resolve({ total: 0 });
  assert.deepEqual(await freshRequest, { total: 0 });
  assert.deepEqual(
    await read(),
    { total: 0 },
    "stale request must not overwrite the fresh cached value"
  );
  assert.equal(calls, 2);
});
