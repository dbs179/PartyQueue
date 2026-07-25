import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findCompanionDjTtsUri,
  visibleUpcomingQueueItems,
} from "../src/sonos.js";

const ramp = {
  TrackUri: "http://10.10.1.30:8088/media/tts/silence-ramp-3s.mp3",
  Title: "PartyQueue Volume Ramp",
};
const tts = {
  TrackUri: "http://ha.local:8123/api/tts_proxy/abc123.mp3",
  Title: "tts",
};
const restore = {
  TrackUri: "http://10.10.1.30:8088/media/tts/silence-3s.mp3",
  Title: "PartyQueue Silence Bridge",
};
const song = {
  TrackUri: "spotify:track:abc",
  Title: "Hurt",
};

test("ramp silence resolves forward to the TTS companion", () => {
  const items = [song, ramp, tts, restore, song];
  assert.equal(findCompanionDjTtsUri(items, 1), tts.TrackUri);
});

test("restore silence resolves backward to the TTS companion", () => {
  const items = [ramp, tts, restore, song];
  assert.equal(findCompanionDjTtsUri(items, 2), tts.TrackUri);
});

test("returns null when no TTS sits next to the pad", () => {
  assert.equal(findCompanionDjTtsUri([ramp, song], 0), null);
  assert.equal(findCompanionDjTtsUri([], 0), null);
});

const song2 = {
  TrackUri: "spotify:track:def",
  Title: "Closer",
};

test("upcoming list shows the DJ TTS row while a song is playing", () => {
  // Current track = song (offset 1); the whole announce is still ahead.
  const items = [song, ramp, tts, restore, song2];
  const upcoming = visibleUpcomingQueueItems(items, 1);
  assert.deepEqual(
    upcoming.map((u) => u.t.TrackUri),
    [tts.TrackUri, song2.TrackUri]
  );
  // Absolute positions must survive the silence-pad filtering.
  assert.deepEqual(
    upcoming.map((u) => u.absoluteIndex),
    [3, 5]
  );
});

test("upcoming list hides the rest of the announce block once the ramp pad plays", () => {
  // Current track = ramp (offset 2); Now Playing already shows the DJ, so
  // the TTS row must not appear a second time in Up Next.
  const items = [song, ramp, tts, restore, song2];
  const upcoming = visibleUpcomingQueueItems(items, 2);
  assert.deepEqual(
    upcoming.map((u) => u.t.TrackUri),
    [song2.TrackUri]
  );
});

test("upcoming list stays collapsed through the TTS and restore segments", () => {
  const items = [song, ramp, tts, restore, song2];
  // Current = TTS clip.
  assert.deepEqual(
    visibleUpcomingQueueItems(items, 3).map((u) => u.t.TrackUri),
    [song2.TrackUri]
  );
  // Current = restore pad.
  assert.deepEqual(
    visibleUpcomingQueueItems(items, 4).map((u) => u.t.TrackUri),
    [song2.TrackUri]
  );
});

test("a later announce block is still visible while an earlier one plays", () => {
  // Only the contiguous block around the current track collapses; the next
  // set's announce further down the queue keeps its Up Next row.
  const tts2 = {
    TrackUri: "http://ha.local:8123/api/tts_proxy/next-set.mp3",
    Title: "tts",
  };
  const items = [ramp, tts, restore, song, ramp, tts2, restore, song2];
  const upcoming = visibleUpcomingQueueItems(items, 1);
  assert.deepEqual(
    upcoming.map((u) => u.t.TrackUri),
    [song.TrackUri, tts2.TrackUri, song2.TrackUri]
  );
});
