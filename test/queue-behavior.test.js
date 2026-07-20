import { test } from "node:test";
import assert from "node:assert/strict";

import {
  removeRangeFor,
  autoStartDecision,
  findInsertPosition,
  findUpcomingAnnouncePadIndices,
  shouldClearQueueForRandomDj,
  randomDjAnnouncePlan,
  songMatchKey,
} from "../src/sonos.js";

// Build Sonos-style queue items from a list of track IDs.
const items = (...ids) => ids.map((id) => ({ TrackUri: `spotify:track:${id}` }));

// removeRangeFor: which already-played tracks to trim given the current pointer.

test("removeRangeFor returns null when the current track is the first", () => {
  assert.equal(removeRangeFor(1), null);
});

test("removeRangeFor returns null for a zero/empty pointer", () => {
  assert.equal(removeRangeFor(0), null);
  assert.equal(removeRangeFor(undefined), null);
});

test("removeRangeFor trims everything before the current track", () => {
  assert.deepEqual(removeRangeFor(2), { StartingIndex: 1, NumberOfTracks: 1 });
  assert.deepEqual(removeRangeFor(5), { StartingIndex: 1, NumberOfTracks: 4 });
});

// autoStartDecision: whether an add should kick off playback.

test("autoStartDecision skips while the system is playing (queue or external)", () => {
  assert.equal(autoStartDecision("PLAYING"), "skip");
});

test("autoStartDecision respects a deliberate pause", () => {
  assert.equal(autoStartDecision("PAUSED_PLAYBACK"), "skip");
  assert.equal(autoStartDecision("PAUSED"), "skip");
});

test("autoStartDecision skips mid-transition", () => {
  assert.equal(autoStartDecision("TRANSITIONING"), "skip");
});

test("autoStartDecision starts when stopped or idle", () => {
  assert.equal(autoStartDecision("STOPPED"), "start");
  assert.equal(autoStartDecision("NO_MEDIA_PRESENT"), "start");
  assert.equal(autoStartDecision(""), "start");
  assert.equal(autoStartDecision(undefined), "start");
});

test("autoStartDecision is case-insensitive", () => {
  assert.equal(autoStartDecision("playing"), "skip");
  assert.equal(autoStartDecision("stopped"), "start");
});

// shouldClearQueueForRandomDj: Random+DJ may only wipe an empty queue.

test("shouldClearQueueForRandomDj clears only when the queue is empty", () => {
  assert.equal(shouldClearQueueForRandomDj({ total: 0 }), true);
  assert.equal(shouldClearQueueForRandomDj({ total: 0, isPlaying: false }), true);
});

test("shouldClearQueueForRandomDj never clears when tracks are waiting", () => {
  // Regression: guest requests were wiped when Random ran during a DJ pause
  // (!isPlaying) or while not on the queue URI (!playingFromQueue).
  assert.equal(
    shouldClearQueueForRandomDj({
      total: 3,
      isPlaying: false,
      playingFromQueue: true,
      upcoming: 3,
    }),
    false
  );
  assert.equal(
    shouldClearQueueForRandomDj({
      total: 5,
      isPlaying: true,
      playingFromQueue: false,
      upcoming: 5,
    }),
    false
  );
  assert.equal(
    shouldClearQueueForRandomDj({
      total: 2,
      isPlaying: true,
      playingFromQueue: true,
      upcoming: 1,
    }),
    false
  );
});

test("shouldClearQueueForRandomDj treats missing/invalid total as empty", () => {
  assert.equal(shouldClearQueueForRandomDj({}), true);
  assert.equal(shouldClearQueueForRandomDj(null), true);
  assert.equal(shouldClearQueueForRandomDj({ total: "x" }), true);
});

// randomDjAnnouncePlan: fresh set vs set-announce before appended Random batch.

test("randomDjAnnouncePlan fresh-set when queue was empty and idle", () => {
  assert.deepEqual(
    randomDjAnnouncePlan({
      djReady: true,
      added: 5,
      queueTotalBefore: 0,
      clearForDj: true,
      deferredStart: true,
      firstAppendPosition: 1,
    }),
    {
      action: "fresh_set",
      queuePosition: 1,
      startPlayback: true,
      resumePlay: false,
    }
  );
});

test("randomDjAnnouncePlan before-batch when queue already has requests (playing)", () => {
  // Regression: old code only announced when deferredStart, so mid-party
  // Add Random skipped the set announce entirely.
  assert.deepEqual(
    randomDjAnnouncePlan({
      djReady: true,
      added: 5,
      queueTotalBefore: 3,
      clearForDj: false,
      deferredStart: false,
      firstAppendPosition: 4,
    }),
    {
      action: "before_batch",
      queuePosition: 4,
      startPlayback: false,
      resumePlay: false,
    }
  );
});

test("randomDjAnnouncePlan before-batch + resume when leftover queue is STOPPED", () => {
  // Must NOT fresh_set at #1 (that would land ahead of guest requests).
  assert.deepEqual(
    randomDjAnnouncePlan({
      djReady: true,
      added: 5,
      queueTotalBefore: 2,
      clearForDj: false,
      deferredStart: true,
      firstAppendPosition: 3,
    }),
    {
      action: "before_batch",
      queuePosition: 3,
      startPlayback: false,
      resumePlay: true,
    }
  );
});

test("randomDjAnnouncePlan is none when DJ off or nothing added", () => {
  assert.equal(
    randomDjAnnouncePlan({
      djReady: false,
      added: 5,
      queueTotalBefore: 0,
      deferredStart: true,
    }).action,
    "none"
  );
  assert.equal(
    randomDjAnnouncePlan({
      djReady: true,
      added: 0,
      queueTotalBefore: 0,
      deferredStart: true,
    }).action,
    "none"
  );
});

// findUpcomingAnnouncePadIndices: unplayed DJ ramp/TTS pads to strip on supersede.

test("findUpcomingAnnouncePadIndices lists unplayed ramp/TTS pads only", () => {
  const list = [
    { TrackUri: "spotify:track:cur", Title: "Cur" },
    {
      TrackUri: "http://10.10.10.10:8088/media/tts/silence-ramp-2s.mp3",
      Title: "PartyQueue Volume Ramp",
    },
    {
      TrackUri: "http://10.10.20.35:8123/api/tts_proxy/abc.mp3",
      Title: "Party DJ",
    },
    { TrackUri: "spotify:track:s1", Title: "Req" },
    {
      TrackUri: "http://10.10.10.10:8088/media/tts/silence-ramp-2s.mp3",
      Title: "PartyQueue Volume Ramp",
    },
    {
      TrackUri: "http://10.10.20.35:8123/api/tts_proxy/def.mp3",
      Title: "Party DJ",
    },
  ];
  assert.deepEqual(
    findUpcomingAnnouncePadIndices(list, {
      currentTrack: 1,
      playingFromQueue: true,
    }),
    [2, 3, 5, 6]
  );
});

test("findUpcomingAnnouncePadIndices skips the current track even if it is a pad", () => {
  const list = [
    {
      TrackUri: "http://10.10.20.35:8123/api/tts_proxy/abc.mp3",
      Title: "Party DJ",
    },
    { TrackUri: "spotify:track:s1", Title: "Req" },
  ];
  assert.deepEqual(
    findUpcomingAnnouncePadIndices(list, {
      currentTrack: 1,
      playingFromQueue: true,
    }),
    []
  );
});

// findInsertPosition: where a searched song slots in (ahead of filler, after
// any waiting searched songs). 0 means "append to the end".

test("findInsertPosition appends when everything upcoming is already searched", () => {
  const pos = findInsertPosition(items("cur", "s1", "s2"), {
    currentTrack: 1,
    playingFromQueue: true,
    searchedIds: new Set(["s1", "s2"]),
  });
  assert.equal(pos, 0);
});

test("findInsertPosition inserts right after the current song when all upcoming is filler", () => {
  // [1:cur, 2:f1, 3:f2], playing track 1 -> first non-searched is at position 2.
  const pos = findInsertPosition(items("cur", "f1", "f2"), {
    currentTrack: 1,
    playingFromQueue: true,
    searchedIds: new Set(),
  });
  assert.equal(pos, 2);
});

test("findInsertPosition lands after waiting searched songs, before filler (FIFO)", () => {
  // [1:cur, 2:s1, 3:s2, 4:f1, 5:f2] -> insert before f1 at position 4.
  const pos = findInsertPosition(items("cur", "s1", "s2", "f1", "f2"), {
    currentTrack: 1,
    playingFromQueue: true,
    searchedIds: new Set(["s1", "s2"]),
  });
  assert.equal(pos, 4);
});

test("findInsertPosition treats untracked filler as a boundary (jumps ahead of it)", () => {
  // No songs are tracked as searched (e.g. queue from a prior session) -> a new
  // request still lands up next, not at the bottom.
  const pos = findInsertPosition(items("cur", "u1", "u2", "u3"), {
    currentTrack: 1,
    playingFromQueue: true,
    searchedIds: new Set(),
  });
  assert.equal(pos, 2);
});

test("findInsertPosition walks past DJ ramp/TTS pads to the request block", () => {
  // After a mid-queue shout: [cur, ramp, DJ, s1, filler] — new request must
  // land after s1 (bottom of request block), not before the ramp ("up next").
  const list = [
    { TrackUri: "spotify:track:cur", Title: "Cur", Artist: "A" },
    {
      TrackUri: "http://10.10.10.10:8088/media/tts/silence-ramp-2s.mp3",
      Title: "PartyQueue Volume Ramp",
      Artist: "PartyQueue",
    },
    {
      TrackUri: "http://10.10.20.35:8123/api/tts_proxy/abc.mp3",
      Title: "Party DJ",
      Artist: "PartyQueue",
    },
    { TrackUri: "spotify:track:s1", Title: "Req", Artist: "B" },
    { TrackUri: "spotify:track:f1", Title: "Filler", Artist: "C" },
  ];
  const pos = findInsertPosition(list, {
    currentTrack: 1,
    playingFromQueue: true,
    searchedIds: new Set(["s1"]),
  });
  assert.equal(pos, 5);
});

test("findInsertPosition ignores leading announce pads when only filler follows", () => {
  // [cur, ramp, DJ, filler] → insert before filler (pos 4), not before ramp.
  const list = [
    { TrackUri: "spotify:track:cur", Title: "Cur", Artist: "A" },
    {
      TrackUri: "http://10.10.10.10:8088/media/tts/silence-ramp-2s.mp3",
      Title: "PartyQueue Volume Ramp",
      Artist: "PartyQueue",
    },
    {
      TrackUri: "http://10.10.20.35:8123/api/tts_proxy/abc.mp3",
      Title: "Party DJ",
      Artist: "PartyQueue",
    },
    { TrackUri: "spotify:track:f1", Title: "Filler", Artist: "C" },
  ];
  const pos = findInsertPosition(list, {
    currentTrack: 1,
    playingFromQueue: true,
    searchedIds: new Set(),
  });
  assert.equal(pos, 4);
});

test("findInsertPosition skips announce pads between searched songs", () => {
  // [cur, s1, ramp, DJ, s2, filler] → new request after s2 (pos 6).
  const list = [
    { TrackUri: "spotify:track:cur", Title: "Cur", Artist: "A" },
    { TrackUri: "spotify:track:s1", Title: "Req1", Artist: "B" },
    {
      TrackUri: "http://10.10.10.10:8088/media/tts/silence-ramp-2s.mp3",
      Title: "PartyQueue Volume Ramp",
      Artist: "PartyQueue",
    },
    {
      TrackUri: "http://10.10.20.35:8123/api/tts_proxy/abc.mp3",
      Title: "Party DJ",
      Artist: "PartyQueue",
    },
    { TrackUri: "spotify:track:s2", Title: "Req2", Artist: "C" },
    { TrackUri: "spotify:track:f1", Title: "Filler", Artist: "D" },
  ];
  const pos = findInsertPosition(list, {
    currentTrack: 1,
    playingFromQueue: true,
    searchedIds: new Set(["s1", "s2"]),
  });
  assert.equal(pos, 6);
});

test("findInsertPosition considers the whole queue when not playing from it", () => {
  const pos = findInsertPosition(items("f1", "f2"), {
    currentTrack: 0,
    playingFromQueue: false,
    searchedIds: new Set(),
  });
  assert.equal(pos, 1);
});

test("findInsertPosition appends on an empty queue", () => {
  const pos = findInsertPosition([], {
    currentTrack: 0,
    playingFromQueue: false,
    searchedIds: new Set(["x"]),
  });
  assert.equal(pos, 0);
});

// songMatchKey: collapse different releases of the same song to one key.

test("songMatchKey matches across case and release differences", () => {
  assert.equal(
    songMatchKey("If It Means a Lot to You", "A Day to Remember"),
    songMatchKey("If It Means A Lot To You", "A Day To Remember"),
  );
});

test("songMatchKey ignores remaster/live and feat suffixes", () => {
  const base = songMatchKey("Comfortably Numb", "Pink Floyd");
  assert.equal(songMatchKey("Comfortably Numb - Live", "Pink Floyd"), base);
  assert.equal(songMatchKey("Comfortably Numb (Remastered 2011)", "Pink Floyd"), base);
});

test("songMatchKey uses only the primary artist", () => {
  assert.equal(
    songMatchKey("Outlaw Shit", "Mojo Nixon"),
    songMatchKey("Outlaw Shit (feat. Waylon Jennings & Yelawolf)", "Mojo Nixon, Waylon Jennings"),
  );
});

test("songMatchKey distinguishes different songs", () => {
  assert.notEqual(
    songMatchKey("Hello", "Adele"),
    songMatchKey("Hello", "Lionel Richie"),
  );
});

test("songMatchKey returns empty when title or artist is missing", () => {
  assert.equal(songMatchKey("", "Adele"), "");
  assert.equal(songMatchKey("Hello", ""), "");
});
