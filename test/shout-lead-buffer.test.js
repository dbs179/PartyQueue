import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHOUT_LEAD_BUFFER_SEC,
  needsShoutLeadBuffer,
  findShoutBufferTrackNumber,
  requestPosAfterShoutBuffer,
} from "../src/shout-lead-buffer.js";

const RAMP = "http://partyqueue/media/tts/silence-ramp-3s.mp3";

test("needsShoutLeadBuffer only when next-up and short remaining", () => {
  assert.equal(
    needsShoutLeadBuffer({
      requestAbsPos: 2,
      currentTrack: 1,
      remainingSec: 30,
    }),
    true
  );
  assert.equal(
    needsShoutLeadBuffer({
      requestAbsPos: 2,
      currentTrack: 1,
      remainingSec: SHOUT_LEAD_BUFFER_SEC + 1,
    }),
    false
  );
  assert.equal(
    needsShoutLeadBuffer({
      requestAbsPos: 3,
      currentTrack: 1,
      remainingSec: 10,
    }),
    false
  );
  assert.equal(
    needsShoutLeadBuffer({
      requestAbsPos: 2,
      currentTrack: 1,
      remainingSec: null,
    }),
    false
  );
});

test("findShoutBufferTrackNumber skips other requests to reach filler", () => {
  const items = [
    { TrackUri: "spotify:track:cur", Title: "Cur" },
    { TrackUri: "spotify:track:req", Title: "Req" },
    { TrackUri: "spotify:track:otherReq", Title: "Req2" },
    { TrackUri: "spotify:track:filler", Title: "Filler" },
  ];
  assert.equal(
    findShoutBufferTrackNumber(items, {
      requestAbsPos: 2,
      searchedIds: new Set(["req", "otherReq"]),
    }),
    4
  );
});

test("findShoutBufferTrackNumber refuses to demote past announce pads", () => {
  // Pending Random refill announce between the request and filler — demoting
  // would play that intro before the guest request.
  const items = [
    { TrackUri: "spotify:track:cur", Title: "Cur" },
    { TrackUri: "spotify:track:req", Title: "Req" },
    {
      TrackUri: RAMP,
      Title: "PartyQueue Volume Ramp",
    },
    { TrackUri: "spotify:track:filler", Title: "Filler" },
  ];
  assert.equal(
    findShoutBufferTrackNumber(items, {
      requestAbsPos: 2,
      searchedIds: new Set(["req"]),
    }),
    null
  );
});

test("findShoutBufferTrackNumber returns null when no buffer exists", () => {
  const items = [
    { TrackUri: "spotify:track:cur", Title: "Cur" },
    { TrackUri: "spotify:track:req", Title: "Req" },
  ];
  assert.equal(
    findShoutBufferTrackNumber(items, {
      requestAbsPos: 2,
      searchedIds: new Set(["req"]),
    }),
    null
  );
});

test("requestPosAfterShoutBuffer matches Sonos demote landing", () => {
  assert.equal(requestPosAfterShoutBuffer(2, 3), 3);
  assert.equal(requestPosAfterShoutBuffer(2, 4), 4);
  assert.equal(requestPosAfterShoutBuffer(5, 3), 5);
});
