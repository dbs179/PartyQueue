import test from "node:test";
import assert from "node:assert/strict";
import {
  parkAnnounceRamp,
  completeParkedAnnounce,
  releaseParkedRamp,
} from "../src/sonos-queue-mutations.js";
import {
  beginAnnounceRampPark,
  endAnnounceRampPark,
  forceEndAnnounceRampPark,
  isAnnounceRampParkActive,
  onAnnounceRampParkEnd,
  resetAnnounceRampParkForTests,
  announceRampToken,
} from "../src/announce-ramp-park.js";
import { queueWorkGeneration } from "../src/queue-preempt.js";

test.afterEach(() => {
  resetAnnounceRampParkForTests();
});

const RAMP = "http://x/silence-ramp-3s.mp3?a=aaaa";
const OTHER_RAMP = "http://x/silence-ramp-3s.mp3?a=bbbb";

function media(url) {
  return {
    url,
    title: url,
    artist: "PartyQueue",
    durationSec: 3,
  };
}

test("parkAnnounceRamp inserts the ramp before the live request and freezes", async () => {
  const enqueued = [];
  const result = await parkAnnounceRamp({
    queuePosition: 2,
    requestUri: "spotify:track:tnt",
    preemptGeneration: queueWorkGeneration(),
    ramp: media(RAMP),
    ops: {
      enqueue: async (url, opts) => {
        enqueued.push({ url, position: opts.position });
        return { url };
      },
      pauseTrim: () => {},
      readItems: async () => [
        { TrackUri: "spotify:track:cur" },
        { TrackUri: "spotify:track:tnt" },
        { TrackUri: "spotify:track:filler" },
      ],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.rampPos, 2);
  assert.equal(result.requestPos, 3);
  assert.deepEqual(enqueued, [{ url: RAMP, position: 2 }]);
  assert.equal(isAnnounceRampParkActive(), true);
});

test("parkAnnounceRamp ignores a played copy of the same request", async () => {
  // Repeat song: an earlier copy sits behind the playhead. The ramp belongs
  // with the upcoming copy, never the one already heard.
  const enqueued = [];
  const result = await parkAnnounceRamp({
    queuePosition: 5,
    requestUri: "spotify:track:tnt",
    preemptGeneration: queueWorkGeneration(),
    ramp: media(RAMP),
    ops: {
      enqueue: async (url, opts) => {
        enqueued.push({ url, position: opts.position });
        return { url };
      },
      pauseTrim: () => {},
      readItems: async () => ({
        currentTrack: 4,
        playingFromQueue: true,
        items: [
          { TrackUri: "spotify:track:tnt" },
          { TrackUri: "spotify:track:a" },
          { TrackUri: "spotify:track:b" },
          { TrackUri: "spotify:track:cur" },
          { TrackUri: "spotify:track:tnt" },
        ],
      }),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.rampPos, 5);
  assert.deepEqual(enqueued, [{ url: RAMP, position: 5 }]);
});

test("completeParkedAnnounce glues TTS + restore after the parked ramp", async () => {
  beginAnnounceRampPark({ rampUrl: RAMP, requestUri: "spotify:track:tnt" });
  const enqueued = [];
  const result = await completeParkedAnnounce({
    rampUrl: RAMP,
    expectedRampPos: 2,
    tts: media("http://x/tts.mp3"),
    restore: media("http://x/silence-3s.mp3"),
    preemptGeneration: queueWorkGeneration(),
    ops: {
      enqueue: async (url, opts) => {
        enqueued.push({ url, position: opts.position });
        return { url };
      },
      readItems: async () => [
        { TrackUri: "spotify:track:cur" },
        { TrackUri: RAMP },
        { TrackUri: "spotify:track:tnt" },
      ],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.rampPos, 2);
  assert.equal(result.ttsPos, 3);
  assert.equal(result.restorePos, 4);
  assert.deepEqual(
    enqueued.map((e) => e.url),
    ["http://x/tts.mp3", "http://x/silence-3s.mp3"]
  );
  assert.equal(isAnnounceRampParkActive(), false);
});

test("completeParkedAnnounce never anchors on a ramp behind the playhead", async () => {
  // The bug: trim is paused during a park, so the pad from the announce that
  // just played is still at #2. Anchoring there inserted a silent DJ clip
  // behind the playhead and shifted every request by two.
  beginAnnounceRampPark({ rampUrl: RAMP, requestUri: "spotify:track:tnt" });
  const enqueued = [];
  const result = await completeParkedAnnounce({
    rampUrl: RAMP,
    expectedRampPos: 6,
    tts: media("http://x/tts.mp3"),
    restore: media("http://x/silence-3s.mp3"),
    preemptGeneration: queueWorkGeneration(),
    ops: {
      enqueue: async (url, opts) => {
        enqueued.push({ url, position: opts.position });
        return { url };
      },
      readItems: async () => ({
        currentTrack: 5,
        playingFromQueue: true,
        items: [
          { TrackUri: "spotify:track:played" },
          // Same URL as ours: unique tokens are the first defence, but the
          // lookup must hold up even when Sonos hands the URI back mangled.
          { TrackUri: RAMP },
          { TrackUri: "http://x/old-tts.mp3" },
          { TrackUri: "http://x/silence-3s.mp3" },
          { TrackUri: "spotify:track:cur" },
          { TrackUri: RAMP },
          { TrackUri: "spotify:track:tnt" },
        ],
      }),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.rampPos, 6, "must find the live ramp, not the played one");
  assert.deepEqual(
    enqueued.map((e) => e.position),
    [7, 8]
  );
});

test("completeParkedAnnounce picks the ramp nearest its own slot", async () => {
  // Two shouts parked back to back with indistinguishable pads: the second
  // must claim its own ramp, not glue its clip onto the first one's.
  beginAnnounceRampPark({ rampUrl: RAMP });
  const enqueued = [];
  const result = await completeParkedAnnounce({
    rampUrl: RAMP,
    expectedRampPos: 4,
    tts: media("http://x/tts-b.mp3"),
    restore: media("http://x/silence-3s.mp3"),
    preemptGeneration: queueWorkGeneration(),
    ops: {
      enqueue: async (url, opts) => {
        enqueued.push({ url, position: opts.position });
        return { url };
      },
      readItems: async () => ({
        currentTrack: 1,
        playingFromQueue: true,
        items: [
          { TrackUri: "spotify:track:cur" },
          { TrackUri: RAMP },
          { TrackUri: "spotify:track:first" },
          { TrackUri: RAMP },
          { TrackUri: "spotify:track:second" },
        ],
      }),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.rampPos, 4);
  assert.deepEqual(
    enqueued.map((e) => e.position),
    [5, 6]
  );
});

test("completeParkedAnnounce reports a missing ramp instead of guessing", async () => {
  beginAnnounceRampPark({ rampUrl: RAMP });
  let enqueues = 0;
  const result = await completeParkedAnnounce({
    rampUrl: RAMP,
    expectedRampPos: 2,
    tts: media("http://x/tts.mp3"),
    restore: media("http://x/silence-3s.mp3"),
    preemptGeneration: queueWorkGeneration(),
    ops: {
      enqueue: async () => {
        enqueues += 1;
        return {};
      },
      readItems: async () => [
        { TrackUri: "spotify:track:cur" },
        { TrackUri: "spotify:track:tnt" },
      ],
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "parked-ramp-missing");
  assert.equal(enqueues, 0, "must not splice clips into a request block");
});

test("releaseParkedRamp removes an orphaned upcoming ramp", async () => {
  const removed = [];
  const result = await releaseParkedRamp({
    rampUrl: RAMP,
    ops: {
      readItems: async () => ({
        currentTrack: 1,
        playingFromQueue: true,
        items: [
          { TrackUri: "spotify:track:cur" },
          { TrackUri: RAMP },
          { TrackUri: "spotify:track:tnt" },
        ],
      }),
      removeRange: async (range) => removed.push(range),
    },
  });
  assert.equal(result.removed, true);
  assert.deepEqual(removed, [{ StartingIndex: 2, NumberOfTracks: 1 }]);
});

test("releaseParkedRamp leaves the ramp alone while it is playing", async () => {
  const removed = [];
  const result = await releaseParkedRamp({
    rampUrl: RAMP,
    ops: {
      readItems: async () => ({
        currentTrack: 2,
        playingFromQueue: true,
        items: [
          { TrackUri: "spotify:track:prev" },
          { TrackUri: RAMP },
          { TrackUri: "spotify:track:tnt" },
        ],
      }),
      removeRange: async (range) => removed.push(range),
    },
  });
  assert.equal(result.removed, false);
  assert.equal(result.reason, "ramp-is-current");
  assert.deepEqual(removed, []);
});

test("park end notifies listeners so Never-Ending can re-arm", async () => {
  let ends = 0;
  onAnnounceRampParkEnd(() => {
    ends += 1;
  });
  beginAnnounceRampPark({ rampUrl: RAMP });
  assert.equal(ends, 0);
  endAnnounceRampPark();
  assert.equal(isAnnounceRampParkActive(), false);
  assert.equal(ends, 1, "autofill must be told the freeze lifted");
});

test("forceEnd clears a park of any depth and notifies once", () => {
  let ends = 0;
  onAnnounceRampParkEnd(() => {
    ends += 1;
  });
  beginAnnounceRampPark({ rampUrl: RAMP });
  beginAnnounceRampPark({ rampUrl: OTHER_RAMP });
  assert.equal(isAnnounceRampParkActive(), true);

  assert.equal(forceEndAnnounceRampPark(), true);
  assert.equal(isAnnounceRampParkActive(), false);
  assert.equal(ends, 1);
  assert.equal(forceEndAnnounceRampPark(), false);
  assert.equal(ends, 1);
});

test("an extra release cannot drive the park negative", () => {
  beginAnnounceRampPark({ rampUrl: RAMP });
  endAnnounceRampPark();
  endAnnounceRampPark();
  assert.equal(isAnnounceRampParkActive(), false);

  // A later park must still freeze — a negative counter would break that.
  beginAnnounceRampPark({ rampUrl: OTHER_RAMP });
  assert.equal(isAnnounceRampParkActive(), true);
});

test("a park that outlives its deadline self-heals", async () => {
  beginAnnounceRampPark({ rampUrl: RAMP, timeoutMs: 1000 });
  assert.equal(isAnnounceRampParkActive(), true);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  // The watchdog releases the freeze so refills resume even if the shout
  // pipeline never came back.
  assert.equal(isAnnounceRampParkActive(), false);
});

test("the watchdog runs the recovery handler once", async () => {
  let cleanups = 0;
  beginAnnounceRampPark({
    rampUrl: RAMP,
    timeoutMs: 1000,
    onExpire: () => {
      cleanups += 1;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(cleanups, 1);
  assert.equal(isAnnounceRampParkActive(), false);
});

test("ramp tokens are unique per announce", () => {
  const tokens = new Set(
    Array.from({ length: 25 }, () => announceRampToken())
  );
  assert.equal(tokens.size, 25);
});
