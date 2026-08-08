import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createStreamCursor,
  resetStreamCursor,
  advanceStreamCursor,
} from "../public/js/stream-cursor.js";

test("createStreamCursor starts empty", () => {
  assert.deepEqual(createStreamCursor(), { session: "", sequence: 0 });
  assert.deepEqual(resetStreamCursor(), { session: "", sequence: 0 });
});

test("advanceStreamCursor accepts first snapshot and tracks sequence", () => {
  let cursor = createStreamCursor();
  let next = advanceStreamCursor(cursor, {
    streamSession: "abc",
    streamSequence: 1,
  });
  assert.equal(next.accept, true);
  assert.deepEqual(next.cursor, { session: "abc", sequence: 1 });

  next = advanceStreamCursor(next.cursor, {
    streamSession: "abc",
    streamSequence: 2,
  });
  assert.equal(next.accept, true);
  assert.deepEqual(next.cursor, { session: "abc", sequence: 2 });
});

test("advanceStreamCursor rejects stale same-session sequences", () => {
  const cursor = { session: "abc", sequence: 5 };
  const next = advanceStreamCursor(cursor, {
    streamSession: "abc",
    streamSequence: 5,
  });
  assert.equal(next.accept, false);
  assert.deepEqual(next.cursor, cursor);

  const older = advanceStreamCursor(cursor, {
    streamSession: "abc",
    streamSequence: 3,
  });
  assert.equal(older.accept, false);
});

test("advanceStreamCursor resets on new session", () => {
  const cursor = { session: "old", sequence: 12 };
  const next = advanceStreamCursor(cursor, {
    streamSession: "new",
    streamSequence: 1,
  });
  assert.equal(next.accept, true);
  assert.deepEqual(next.cursor, { session: "new", sequence: 1 });
});

test("advanceStreamCursor accepts snapshots without session metadata", () => {
  const cursor = { session: "abc", sequence: 2 };
  const next = advanceStreamCursor(cursor, { title: "Song" });
  assert.equal(next.accept, true);
  assert.deepEqual(next.cursor, cursor);
});
