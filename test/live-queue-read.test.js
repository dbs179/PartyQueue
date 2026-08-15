import { test } from "node:test";
import assert from "node:assert/strict";
import { readLiveQueueForInsert } from "../src/sonos-queue-mutations.js";

function fakeCoordinator({ getQueue, position = { Track: 2 } } = {}) {
  return {
    GetQueue: getQueue,
    AVTransportService: {
      async GetPositionInfo() {
        return position;
      },
      async GetMediaInfo() {
        return { CurrentURI: "x-rincon-queue:RINCON_1#0" };
      },
      async GetTransportInfo() {
        return { CurrentTransportState: "PLAYING" };
      },
    },
  };
}

test("readLiveQueueForInsert returns the live queue on success", async () => {
  const items = [{ Title: "A" }];
  const live = await readLiveQueueForInsert(
    fakeCoordinator({
      getQueue: async () => ({ Result: items, UpdateID: 9 }),
    }),
    { attempts: 1 }
  );
  assert.equal(live.items, items);
  assert.equal(live.updateId, 9);
  assert.equal(live.currentTrack, 2);
  assert.equal(live.playingFromQueue, true);
  assert.equal(live.transportState, "PLAYING");
});

test("readLiveQueueForInsert retries once then succeeds", async () => {
  let n = 0;
  const live = await readLiveQueueForInsert(
    fakeCoordinator({
      getQueue: async () => {
        n += 1;
        if (n === 1) throw new Error("Sonos timeout");
        return { Result: [{ Title: "B" }], UpdateID: 3 };
      },
    })
  );
  assert.equal(n, 2);
  assert.equal(live.items[0].Title, "B");
});

test("readLiveQueueForInsert fails closed after retry — no empty fallback", async () => {
  let n = 0;
  await assert.rejects(
    () =>
      readLiveQueueForInsert(
        fakeCoordinator({
          getQueue: async () => {
            n += 1;
            throw new Error("Sonos timeout");
          },
        })
      ),
    /Sonos timeout/
  );
  assert.equal(n, 2);
});
