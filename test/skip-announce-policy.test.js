import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEEK_END_LEAD_SEC,
  decideSkipAnnounceAction,
  findNextMusicTrackNumber,
  formatSonosRelTime,
} from "../src/skip-announce-policy.js";

const RAMP = "http://partyqueue/media/tts/silence-ramp-3s.mp3";
const TTS = "http://partyqueue/media/tts/tts-announce.mp3";
const MUSIC = "x-sonos-http:track%3aid%3aspotify%3atrack%3anext";
const SONG = "x-sonos-http:track%3aid%3aspotify%3atrack%3acurrent";

test("formatSonosRelTime pads minutes and seconds", () => {
  assert.equal(formatSonosRelTime(0), "0:00:00");
  assert.equal(formatSonosRelTime(65), "0:01:05");
  assert.equal(formatSonosRelTime(3723), "1:02:03");
});

test("decideSkipAnnounceAction seeks near end when next is announce pad", () => {
  const d = decideSkipAnnounceAction({
    currentUri: SONG,
    currentTitle: "Song",
    nextUri: RAMP,
    nextTitle: "PartyQueue Volume Ramp",
    durationSec: 180,
    positionSec: 40,
  });
  assert.equal(d.action, "seekNearEnd");
  assert.equal(d.targetSec, 180 - SEEK_END_LEAD_SEC);
  assert.equal(d.alreadyNearEnd, false);
});

test("decideSkipAnnounceAction marks alreadyNearEnd near the target", () => {
  const d = decideSkipAnnounceAction({
    currentUri: SONG,
    nextUri: TTS,
    durationSec: 100,
    positionSec: 99.9,
  });
  assert.equal(d.action, "seekNearEnd");
  assert.equal(d.alreadyNearEnd, true);
});

test("decideSkipAnnounceAction jumps when already on a pad", () => {
  assert.equal(
    decideSkipAnnounceAction({
      currentUri: RAMP,
      currentTitle: "PartyQueue Volume Ramp",
      nextUri: TTS,
      durationSec: 3,
      positionSec: 1,
    }).action,
    "jumpAnnounce"
  );
  assert.equal(
    decideSkipAnnounceAction({
      currentUri: TTS,
      currentTitle: "DJ",
      nextUri: MUSIC,
      volumeLocked: false,
    }).action,
    "jumpAnnounce"
  );
});

test("decideSkipAnnounceAction jumps when volume handoff is locked", () => {
  assert.equal(
    decideSkipAnnounceAction({
      currentUri: SONG,
      nextUri: MUSIC,
      volumeLocked: true,
      durationSec: 120,
      positionSec: 10,
    }).action,
    "jumpAnnounce"
  );
});

test("decideSkipAnnounceAction jumps when duration is missing before announce", () => {
  assert.equal(
    decideSkipAnnounceAction({
      currentUri: SONG,
      nextUri: RAMP,
      durationSec: null,
      positionSec: 10,
    }).action,
    "jumpAnnounce"
  );
});

test("decideSkipAnnounceAction uses normal Next for music→music", () => {
  assert.equal(
    decideSkipAnnounceAction({
      currentUri: SONG,
      nextUri: MUSIC,
      durationSec: 200,
      positionSec: 20,
    }).action,
    "normalNext"
  );
});

test("findNextMusicTrackNumber skips the announce block", () => {
  const items = [
    { TrackUri: SONG, Title: "A" },
    { TrackUri: RAMP, Title: "PartyQueue Volume Ramp" },
    { TrackUri: TTS, Title: "DJ" },
    { TrackUri: MUSIC, Title: "B" },
  ];
  // Current track 1 (SONG) → next music is track 4.
  assert.equal(findNextMusicTrackNumber(items, 1), 4);
  // Current on ramp (track 2) → next music is track 4.
  assert.equal(findNextMusicTrackNumber(items, 2), 4);
  // Current on TTS (track 3) → next music is track 4.
  assert.equal(findNextMusicTrackNumber(items, 3), 4);
  // Current on last music → none.
  assert.equal(findNextMusicTrackNumber(items, 4), null);
});
