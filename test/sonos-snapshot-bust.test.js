import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getNowPlaying,
  getQueueList,
  getQueueStatus,
  listGroups,
  invalidateSonosSnapshots,
} from "../src/sonos.js";

test("invalidateSonosSnapshots busts getQueueStatus (Never-Ending guard)", () => {
  const readers = [getNowPlaying, getQueueList, getQueueStatus, listGroups];
  const hits = new Map();
  const originals = new Map();

  for (const reader of readers) {
    assert.equal(typeof reader.bust, "function");
    hits.set(reader, 0);
    originals.set(reader, reader.bust);
    reader.bust = () => {
      hits.set(reader, hits.get(reader) + 1);
      originals.get(reader)();
    };
  }

  try {
    invalidateSonosSnapshots();
    assert.equal(hits.get(getNowPlaying), 1);
    assert.equal(hits.get(getQueueList), 1);
    assert.equal(
      hits.get(getQueueStatus),
      1,
      "Clear must drop queue-status cache or Never-Ending can refill from a stale non-empty snapshot"
    );
    assert.equal(hits.get(listGroups), 1);
  } finally {
    for (const reader of readers) {
      reader.bust = originals.get(reader);
    }
  }
});
