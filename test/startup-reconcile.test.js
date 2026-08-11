import { test } from "node:test";
import assert from "node:assert/strict";
import {
  musicTrackIdsFromQueueItems,
  shouldStripOrphanAnnouncePads,
} from "../src/startup-reconcile.js";

const RAMP = "http://partyqueue/media/tts/silence-ramp-3s.mp3";
const RESTORE = "http://partyqueue/media/tts/silence-3s.mp3";
const TTS = "http://partyqueue/media/tts/tts-announce.mp3";
const SONG_A = "x-sonos-spotify:spotify%3atrack%3a1111111111111111111111";
const SONG_B = "x-sonos-spotify:spotify%3atrack%3a2222222222222222222222";

test("musicTrackIdsFromQueueItems skips announce pads and keeps order", () => {
  const ids = musicTrackIdsFromQueueItems([
    { TrackUri: RAMP, Title: "PartyQueue Volume Ramp" },
    { TrackUri: TTS, Title: "DJ" },
    { TrackUri: RESTORE, Title: "PartyQueue Silence Bridge" },
    { TrackUri: SONG_A, Title: "A" },
    { TrackUri: SONG_B, Title: "B" },
    { TrackUri: SONG_A, Title: "A again" },
  ]);
  assert.deepEqual(ids, [
    "1111111111111111111111",
    "2222222222222222222222",
    "1111111111111111111111",
  ]);
});

test("shouldStripOrphanAnnouncePads is false for a complete handoff plan", () => {
  const items = [
    { TrackUri: SONG_A, Title: "Playing" },
    { TrackUri: RAMP, Title: "PartyQueue Volume Ramp" },
    { TrackUri: TTS, Title: "DJ" },
    { TrackUri: RESTORE, Title: "PartyQueue Silence Bridge" },
    { TrackUri: SONG_B, Title: "Next" },
  ];
  assert.equal(shouldStripOrphanAnnouncePads(items, 1, true), false);
});

test("shouldStripOrphanAnnouncePads is true for a lone orphan pad", () => {
  const items = [
    { TrackUri: SONG_A, Title: "Playing" },
    { TrackUri: RAMP, Title: "PartyQueue Volume Ramp" },
    { TrackUri: SONG_B, Title: "Next" },
  ];
  assert.equal(shouldStripOrphanAnnouncePads(items, 1, true), true);
});

test("shouldStripOrphanAnnouncePads is false when there are no pads", () => {
  const items = [
    { TrackUri: SONG_A, Title: "Playing" },
    { TrackUri: SONG_B, Title: "Next" },
  ];
  assert.equal(shouldStripOrphanAnnouncePads(items, 1, true), false);
});
