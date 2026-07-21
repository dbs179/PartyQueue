import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mediaIdentity,
  parseSyncedLyrics,
  playbackIdentity,
  serverPlaybackPosition,
} from "../public/js/now-playing-utils.js";

test("playback identity distinguishes duplicate queue entries", () => {
  const track = {
    uri: "spotify:track:same",
    durationSec: 180,
    title: "Same",
    artist: "Artist",
  };
  assert.equal(mediaIdentity({ ...track, queueTrack: 1 }), mediaIdentity({ ...track, queueTrack: 2 }));
  assert.notEqual(
    playbackIdentity({ ...track, queueTrack: 1 }),
    playbackIdentity({ ...track, queueTrack: 2 })
  );
});

test("server position applies bounded age only while actively playing", () => {
  assert.equal(
    serverPlaybackPosition({
      positionSec: 10,
      positionAgeSec: 2.5,
      isPlaying: true,
    }),
    12.5
  );
  assert.equal(
    serverPlaybackPosition({
      positionSec: 10,
      positionAgeSec: 20,
      isPlaying: true,
    }),
    20
  );
  assert.equal(
    serverPlaybackPosition({
      positionSec: 10,
      positionAgeSec: 2,
      isPlaying: false,
    }),
    10
  );
});

test("LRC parser accepts multiple timestamps, colon fractions, and word tags", () => {
  assert.deepEqual(
    parseSyncedLyrics("[00:01:50][00:03.25]<00:01.50>Hello"),
    [
      { t: 1.5, text: "Hello" },
      { t: 3.25, text: "Hello" },
    ]
  );
});
