import { test } from "node:test";
import assert from "node:assert/strict";
import {
  refreshQueueUpdateId,
  searchedOccurrenceIndexForPosition,
} from "../src/sonos-queue-mutations.js";

const spotify = (id) =>
  `x-sonos-http:track%3aid%3aspotify%3atrack%3a${id}?sid=1`;

test("refreshQueueUpdateId prefers NewUpdateID from the remove result", async () => {
  assert.equal(await refreshQueueUpdateId({ NewUpdateID: 42 }, 7), 42);
  assert.equal(await refreshQueueUpdateId({ NewUpdateID: "99" }, 7), 99);
});

test("refreshQueueUpdateId falls back to a live GetQueue UpdateID", async () => {
  const coordinator = {
    async GetQueue() {
      return { UpdateID: 55 };
    },
  };
  assert.equal(await refreshQueueUpdateId({}, 7, coordinator), 55);
  assert.equal(await refreshQueueUpdateId(null, 7, coordinator), 55);
});

test("refreshQueueUpdateId keeps the previous id when nothing fresher is available", async () => {
  assert.equal(await refreshQueueUpdateId({}, 12, null), 12);
  assert.equal(
    await refreshQueueUpdateId(
      {},
      12,
      {
        async GetQueue() {
          throw new Error("offline");
        },
      }
    ),
    12
  );
});

test("searchedOccurrenceIndexForPosition matches queue-list occurrence mapping", () => {
  const items = [
    { TrackUri: spotify("playing") },
    { TrackUri: spotify("nine") },
    { TrackUri: spotify("other") },
    { TrackUri: spotify("nine") },
    { TrackUri: spotify("nine") },
  ];
  assert.equal(
    searchedOccurrenceIndexForPosition(items, {
      trackId: "nine",
      absolutePos: 2,
      currentTrack: 1,
      playingFromQueue: true,
    }),
    0
  );
  assert.equal(
    searchedOccurrenceIndexForPosition(items, {
      trackId: "nine",
      absolutePos: 4,
      currentTrack: 1,
      playingFromQueue: true,
    }),
    1
  );
  assert.equal(
    searchedOccurrenceIndexForPosition(items, {
      trackId: "nine",
      absolutePos: 5,
      currentTrack: 1,
      playingFromQueue: true,
    }),
    2
  );
  assert.equal(
    searchedOccurrenceIndexForPosition(items, {
      trackId: "nine",
      absolutePos: 3,
      currentTrack: 1,
      playingFromQueue: true,
    }),
    null
  );
});
