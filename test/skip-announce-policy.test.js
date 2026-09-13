import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideSkipAnnounceAction,
  findNextMusicTrackNumber,
  findUpcomingAnnounceHandoffPlan,
  formatSonosRelTime,
  locateAnnounceBlockByClipUrl,
  parseSilencePadSec,
  resolveAnnouncePlayTarget,
} from "../src/skip-announce-policy.js";

const RAMP = "http://partyqueue/media/tts/silence-ramp-3s.mp3";
const RESTORE = "http://partyqueue/media/tts/silence-3s.mp3";
const TTS = "http://partyqueue/media/tts/tts-announce.mp3";
const BAKED =
  "http://partyqueue/media/tts/dj-announce-0123456789abcdef.mp3";
const MUSIC = "x-sonos-http:track%3aid%3aspotify%3atrack%3anext";
const SONG = "x-sonos-http:track%3aid%3aspotify%3atrack%3acurrent";

test("formatSonosRelTime pads minutes and seconds", () => {
  assert.equal(formatSonosRelTime(0), "0:00:00");
  assert.equal(formatSonosRelTime(65), "0:01:05");
  assert.equal(formatSonosRelTime(3723), "1:02:03");
});

test("decideSkipAnnounceAction goes to the next track when it is an announce", () => {
  const d = decideSkipAnnounceAction({
    currentUri: SONG,
    currentTitle: "Song",
    nextUri: RAMP,
    nextTitle: "PartyQueue Volume Ramp",
    durationSec: 180,
    positionSec: 40,
  });
  assert.equal(d.action, "normalNext");
});

test("decideSkipAnnounceAction still Nexts onto a baked announce near the song end", () => {
  const d = decideSkipAnnounceAction({
    currentUri: SONG,
    nextUri: TTS,
    durationSec: 100,
    positionSec: 99.9,
  });
  assert.equal(d.action, "normalNext");
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

test("decideSkipAnnounceAction does not jump a waiting announce when duration is missing", () => {
  assert.equal(
    decideSkipAnnounceAction({
      currentUri: SONG,
      nextUri: RAMP,
      durationSec: null,
      positionSec: 10,
    }).action,
    "normalNext"
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

test("parseSilencePadSec reads ramp and restore lengths", () => {
  assert.equal(parseSilencePadSec(RAMP), 3);
  assert.equal(parseSilencePadSec(RESTORE), 3);
  assert.equal(parseSilencePadSec("http://x/media/tts/silence-ramp-2.5s.mp3"), 2.5);
  assert.equal(parseSilencePadSec(TTS), null);
});

test("findUpcomingAnnounceHandoffPlan maps ramp→TTS→restore→music", () => {
  const items = [
    { TrackUri: SONG, Title: "A" },
    { TrackUri: RAMP, Title: "PartyQueue Volume Ramp" },
    { TrackUri: TTS, Title: "DJ", Duration: "0:00:09" },
    { TrackUri: RESTORE, Title: "PartyQueue Silence Bridge" },
    { TrackUri: MUSIC, Title: "B" },
  ];
  const plan = findUpcomingAnnounceHandoffPlan(items, 1);
  assert.deepEqual(plan, {
    rampPosition: 2,
    ttsPosition: 3,
    tts2Position: null,
    restorePosition: 4,
    musicPosition: 5,
    ttsUri: TTS,
    silenceSec: 3,
    approxDurationSec: 9,
  });
});

test("findUpcomingAnnounceHandoffPlan works when already on the ramp", () => {
  const items = [
    { TrackUri: RAMP, Title: "PartyQueue Volume Ramp" },
    { TrackUri: TTS, Title: "DJ" },
    { TrackUri: RESTORE, Title: "PartyQueue Silence Bridge" },
    { TrackUri: MUSIC, Title: "B" },
  ];
  const plan = findUpcomingAnnounceHandoffPlan(items, 1);
  assert.equal(plan?.rampPosition, 1);
  assert.equal(plan?.ttsPosition, 2);
  assert.equal(plan?.tts2Position, null);
  assert.equal(plan?.musicPosition, 4);
  assert.equal(plan?.approxDurationSec, 12);
});

test("findUpcomingAnnounceHandoffPlan keeps music after a banter punch TTS", () => {
  const punch = "http://partyqueue/media/tts/tts-punch.mp3";
  const items = [
    { TrackUri: SONG, Title: "A" },
    { TrackUri: RAMP, Title: "PartyQueue Volume Ramp" },
    { TrackUri: TTS, Title: "Holy Roller", Duration: "0:00:09" },
    { TrackUri: punch, Title: "Sister Static", Duration: "0:00:07" },
    { TrackUri: RESTORE, Title: "PartyQueue Silence Bridge" },
    { TrackUri: MUSIC, Title: "B" },
    { TrackUri: "x-sonos-http:track%3aid%3aspotify%3atrack%3ac", Title: "C" },
    { TrackUri: "x-sonos-http:track%3aid%3aspotify%3atrack%3ad", Title: "D" },
    { TrackUri: "x-sonos-http:track%3aid%3aspotify%3atrack%3ae", Title: "E" },
    { TrackUri: "x-sonos-http:track%3aid%3aspotify%3atrack%3af", Title: "F" },
  ];
  const plan = findUpcomingAnnounceHandoffPlan(items, 1);
  assert.equal(plan?.rampPosition, 2);
  assert.equal(plan?.ttsPosition, 3);
  assert.equal(plan?.tts2Position, 4);
  assert.equal(plan?.restorePosition, 5);
  assert.equal(plan?.musicPosition, 6);
  assert.equal(plan?.approxDurationSec, 16);
});

test("findUpcomingAnnounceHandoffPlan returns null without a DJ clip", () => {
  assert.equal(
    findUpcomingAnnounceHandoffPlan(
      [
        { TrackUri: SONG },
        { TrackUri: RAMP, Title: "PartyQueue Volume Ramp" },
        { TrackUri: MUSIC },
      ],
      1
    ),
    null
  );
  assert.equal(findUpcomingAnnounceHandoffPlan([{ TrackUri: MUSIC }], 1), null);
});

test("findUpcomingAnnounceHandoffPlan treats a baked row as the whole announce", () => {
  const items = [
    { TrackUri: SONG, Title: "A" },
    { TrackUri: BAKED, Title: "DJ Holy Roller", Duration: "0:00:24" },
    { TrackUri: MUSIC, Title: "B" },
  ];
  const plan = findUpcomingAnnounceHandoffPlan(items, 1);
  assert.equal(plan?.ttsPosition, 2);
  assert.equal(plan?.tts2Position, null);
  assert.equal(plan?.restorePosition, null);
  assert.equal(plan?.musicPosition, 3);
  assert.equal(plan?.ttsUri, BAKED);
});

test("findUpcomingAnnounceHandoffPlan keeps a stall pad in front of a baked row", () => {
  const items = [
    { TrackUri: RAMP, Title: "PartyQueue Volume Ramp" },
    { TrackUri: BAKED, Title: "DJ", Duration: "0:00:20" },
    { TrackUri: MUSIC, Title: "B" },
  ];
  const plan = findUpcomingAnnounceHandoffPlan(items, 1);
  assert.equal(plan?.rampPosition, 1);
  assert.equal(plan?.ttsPosition, 2);
  assert.equal(plan?.restorePosition, null);
  assert.equal(plan?.musicPosition, 3);
});

test("Skip on a baked row jumps to the next music track, not row + 3", () => {
  const items = [
    { TrackUri: SONG, Title: "A" },
    { TrackUri: BAKED, Title: "DJ" },
    { TrackUri: MUSIC, Title: "B" },
    { TrackUri: "x-sonos-http:track%3aid%3aspotify%3atrack%3ac", Title: "C" },
  ];
  assert.equal(findNextMusicTrackNumber(items, 2), 3);
  assert.equal(
    decideSkipAnnounceAction({
      currentUri: BAKED,
      currentTitle: "DJ Holy Roller",
      nextUri: MUSIC,
    }).action,
    "jumpAnnounce"
  );
});

test("locateAnnounceBlockByClipUrl treats a baked clip as one row", () => {
  const items = [
    { TrackUri: SONG, Title: "A" },
    { TrackUri: BAKED, Title: "DJ" },
    { TrackUri: MUSIC, Title: "B" },
  ];
  const found = locateAnnounceBlockByClipUrl(items, BAKED, {
    currentTrack: 1,
    playingFromQueue: true,
  });
  assert.equal(found?.ttsPosition, 2);
  assert.equal(found?.tts2Position, null);
  assert.equal(found?.restorePosition, null);
  assert.equal(found?.musicPosition, 3);
  assert.equal(found?.blockStart, 2);
  assert.equal(found?.blockEnd, 2);
});

test("resolveAnnouncePlayTarget prefers the live baked row and refuses a missing clip", () => {
  const items = [
    { TrackUri: MUSIC, Title: "Played" },
    { TrackUri: BAKED, Title: "DJ" },
    { TrackUri: SONG, Title: "Request" },
  ];
  const live = resolveAnnouncePlayTarget({
    items,
    clipUrl: BAKED,
    currentTrack: 1,
    currentUri: MUSIC,
    playingFromQueue: true,
  });
  assert.equal(live.found, true);
  assert.equal(live.alreadyOnTarget, false);
  assert.equal(live.trackNumber, 2);
  assert.equal(live.musicPosition, 3);

  const onClip = resolveAnnouncePlayTarget({
    items,
    clipUrl: BAKED,
    currentTrack: 2,
    currentUri: BAKED,
    playingFromQueue: true,
  });
  assert.equal(onClip.alreadyOnTarget, true);
  assert.equal(onClip.found, true);

  const gone = resolveAnnouncePlayTarget({
    items: [{ TrackUri: SONG, Title: "A" }],
    clipUrl: BAKED,
    currentTrack: 1,
    currentUri: SONG,
    playingFromQueue: true,
  });
  assert.equal(gone.found, false);
  assert.equal(gone.trackNumber, null);
});
