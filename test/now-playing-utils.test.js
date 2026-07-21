import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mediaIdentity,
  parseSyncedLyrics,
  playbackIdentity,
  queueTrackAsNowPlaying,
  resolveNowPlayingDisplay,
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

test("server position applies bounded age while playing", () => {
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
  // Display models own transition UX; age still advances when playing.
  assert.equal(
    serverPlaybackPosition({
      positionSec: 10,
      positionAgeSec: 2,
      isPlaying: true,
      metadataPending: true,
    }),
    12
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

test("resolveNowPlayingDisplay keeps confirmed paint while transport is pending", () => {
  const confirmed = {
    title: "Old",
    artist: "A",
    albumArt: "/old.jpg",
    uri: "spotify:track:old",
    queueTrack: 1,
    positionSec: 40,
    durationSec: 200,
    isPlaying: true,
  };
  const transport = {
    ...confirmed,
    queueTrack: 2,
    metadataPending: true,
  };
  const resolved = resolveNowPlayingDisplay({
    transport,
    lastConfirmed: confirmed,
  });
  assert.equal(resolved.mode, "converging");
  assert.equal(resolved.display.title, "Old");
  assert.equal(resolved.display.albumArt, "/old.jpg");
  assert.equal(resolved.display.metadataPending, false);
  assert.equal(resolved.display.updating, true);
  assert.equal(resolved.display.positionSec, 40);
});

test("resolveNowPlayingDisplay prefers optimistic next until transport catches up", () => {
  const confirmed = {
    title: "Old",
    artist: "A",
    albumArt: "/old.jpg",
    uri: "spotify:track:old",
    durationSec: 180,
  };
  const optimistic = queueTrackAsNowPlaying({
    title: "Next",
    artist: "B",
    albumArt: "/next.jpg",
    uri: "spotify:track:next",
    position: 2,
  });
  const stillOld = resolveNowPlayingDisplay({
    transport: { ...confirmed, metadataPending: false, isPlaying: true },
    lastConfirmed: confirmed,
    optimistic,
  });
  assert.equal(stillOld.mode, "optimistic");
  assert.equal(stillOld.display.title, "Next");
  assert.equal(stillOld.display.albumArt, "/next.jpg");

  const caughtUp = resolveNowPlayingDisplay({
    transport: {
      title: "Next",
      artist: "B",
      albumArt: "/next.jpg",
      uri: "spotify:track:next",
      durationSec: 200,
      metadataPending: false,
      isPlaying: true,
      positionSec: 1,
    },
    lastConfirmed: confirmed,
    optimistic,
  });
  assert.equal(caughtUp.mode, "confirmed");
  assert.equal(caughtUp.display.title, "Next");
  assert.equal(caughtUp.display.updating, false);
});
