import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHOUT_LEAD_BUFFER_SEC,
  IMMINENT_ANNOUNCE_PAUSE_SEC,
  TRACK_END_ANNOUNCE_HOLD_SEC,
  ANNOUNCE_RAMP_PARK_SEC,
  ANNOUNCE_RAMP_RESTART_MAX_SEC,
  needsShoutLeadBuffer,
  shouldPauseForImminentAnnounce,
  shouldHoldAtTrackEndForAnnounce,
  shouldParkOnRampForAnnounce,
  shouldSeekRampNow,
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
  // Unused by product path: demoting past other requests (#2 behind #7)
  // split set-requests and broke FIFO. ensureShoutLeadBuffer is a no-op.
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

test("shouldPauseForImminentAnnounce uses a narrower window than lead buffer", () => {
  assert.ok(IMMINENT_ANNOUNCE_PAUSE_SEC < SHOUT_LEAD_BUFFER_SEC);
  const base = {
    queuePosition: 2,
    currentTrack: 1,
    isPlaying: true,
    playingFromQueue: true,
  };
  assert.equal(
    shouldPauseForImminentAnnounce({
      ...base,
      remainingSec: IMMINENT_ANNOUNCE_PAUSE_SEC,
    }),
    true
  );
  assert.equal(
    shouldPauseForImminentAnnounce({
      ...base,
      remainingSec: IMMINENT_ANNOUNCE_PAUSE_SEC + 1,
    }),
    false
  );
  // Mid lead-buffer window: demote preferred; do not hard-pause.
  assert.equal(
    shouldPauseForImminentAnnounce({
      ...base,
      remainingSec: 30,
    }),
    false
  );
  assert.equal(
    needsShoutLeadBuffer({
      requestAbsPos: 2,
      currentTrack: 1,
      remainingSec: 30,
    }),
    true
  );
  assert.equal(
    shouldPauseForImminentAnnounce({
      ...base,
      remainingSec: 5,
      isPlaying: false,
    }),
    false
  );
});

test("shouldParkOnRampForAnnounce is next-up or already-current when time is short", () => {
  const nextUp = {
    requestAbsPos: 2,
    currentTrack: 1,
    isPlaying: true,
    playingFromQueue: true,
  };
  assert.equal(ANNOUNCE_RAMP_PARK_SEC, 20);
  assert.equal(
    shouldParkOnRampForAnnounce({ ...nextUp, remainingSec: 12 }),
    true
  );
  assert.equal(
    shouldParkOnRampForAnnounce({
      ...nextUp,
      remainingSec: ANNOUNCE_RAMP_PARK_SEC + 1,
    }),
    false
  );
  assert.equal(
    shouldParkOnRampForAnnounce({
      ...nextUp,
      requestAbsPos: 4,
      remainingSec: 5,
    }),
    false
  );
  assert.equal(
    shouldParkOnRampForAnnounce({
      requestAbsPos: 1,
      currentTrack: 1,
      isPlaying: true,
      playingFromQueue: true,
      remainingSec: 180,
    }),
    true
  );
  assert.equal(
    shouldParkOnRampForAnnounce({
      ...nextUp,
      remainingSec: 8,
      startPlayback: true,
    }),
    false
  );
  assert.equal(
    shouldParkOnRampForAnnounce({
      ...nextUp,
      remainingSec: 8,
      isPlaying: false,
    }),
    true
  );
});

test("an already-current request is only restarted while it is still a tease", () => {
  const current = {
    requestAbsPos: 1,
    currentTrack: 1,
    isPlaying: true,
    playingFromQueue: true,
    remainingSec: 180,
  };
  assert.equal(ANNOUNCE_RAMP_RESTART_MAX_SEC, 12);
  assert.equal(
    shouldParkOnRampForAnnounce({ ...current, elapsedSec: 3 }),
    true,
    "a few seconds in is the tease we want to undo"
  );
  assert.equal(
    shouldParkOnRampForAnnounce({
      ...current,
      elapsedSec: ANNOUNCE_RAMP_RESTART_MAX_SEC + 1,
    }),
    false,
    "well into the song, a late shout beats yanking it back"
  );
  // Unknown elapsed keeps the old behavior rather than dropping the shout.
  assert.equal(shouldParkOnRampForAnnounce({ ...current }), true);
  assert.equal(
    shouldParkOnRampForAnnounce({ ...current, elapsedSec: null }),
    true
  );
});

test("shouldSeekRampNow only when the request is already current or the song is dying", () => {
  assert.equal(
    shouldSeekRampNow({
      requestAbsPos: 2,
      currentTrack: 1,
      isPlaying: true,
      remainingSec: 12,
    }),
    false
  );
  assert.equal(
    shouldSeekRampNow({
      requestAbsPos: 2,
      currentTrack: 1,
      isPlaying: true,
      remainingSec: 1,
    }),
    true
  );
  assert.equal(
    shouldSeekRampNow({
      requestAbsPos: 1,
      currentTrack: 1,
      isPlaying: true,
      remainingSec: 180,
    }),
    true
  );
});

test("shouldHoldAtTrackEndForAnnounce only at the tail or after playhead moves", () => {
  const base = {
    nextUp: true,
    playingFromQueue: true,
    currentTrack: 4,
    startedOnTrack: 4,
  };
  assert.equal(TRACK_END_ANNOUNCE_HOLD_SEC, 2);
  assert.equal(
    shouldHoldAtTrackEndForAnnounce({ ...base, remainingSec: 20 }),
    false
  );
  assert.equal(
    shouldHoldAtTrackEndForAnnounce({ ...base, remainingSec: 2 }),
    true
  );
  assert.equal(
    shouldHoldAtTrackEndForAnnounce({
      ...base,
      remainingSec: 20,
      currentTrack: 5,
    }),
    true
  );
  assert.equal(
    shouldHoldAtTrackEndForAnnounce({
      ...base,
      nextUp: false,
      remainingSec: 1,
    }),
    false
  );
});
