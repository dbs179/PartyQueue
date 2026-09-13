import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  announceHoldIsLive,
  announceHoldShouldYieldTo,
  announceNowPlayingHoldForTests,
  getNowPlaying,
  holdAnnounceNowPlaying,
  invalidateSonosSnapshots,
  resetAnnounceNowPlayingHoldForTests,
  shouldPreserveAnnounceHoldOnPlay,
} from "../src/sonos.js";

afterEach(() => {
  resetAnnounceNowPlayingHoldForTests();
});

const CLIP = "http://pq.local:8088/media/tts/dj-announce-ss.mp3";

test("announce hold serves the DJ without waiting on Sonos", async () => {
  const seeded = holdAnnounceNowPlaying({
    uri: CLIP,
    durationSec: 24,
    queueTrack: 1,
  });
  assert.equal(seeded.djVoice, true);
  assert.equal(seeded.uri, CLIP);

  getNowPlaying.bust();
  const np = await getNowPlaying();
  assert.equal(np.djVoice, true);
  assert.equal(np.uri, CLIP);
  assert.ok(np.title, "DJ name must be present");
});

test("a later snapshot invalidation drops the announce hold", () => {
  holdAnnounceNowPlaying({ uri: CLIP, durationSec: 24 });
  assert.equal(announceNowPlayingHoldForTests()?.uri, CLIP);
  invalidateSonosSnapshots();
  assert.equal(announceNowPlayingHoldForTests(), null);
});

test("Play of the announce keeps the hold so a stale song SOAP cannot win", () => {
  holdAnnounceNowPlaying({ uri: CLIP, durationSec: 24, queueTrack: 3 });
  assert.equal(shouldPreserveAnnounceHoldOnPlay(3), true);
  assert.equal(shouldPreserveAnnounceHoldOnPlay(), true);
  assert.equal(
    shouldPreserveAnnounceHoldOnPlay(5),
    false,
    "skip-to-request Play must drop the DJ hold"
  );
});

test("Play-style invalidation keeps a live announce on screen", async () => {
  holdAnnounceNowPlaying({ uri: CLIP, durationSec: 24, queueTrack: 2 });
  invalidateSonosSnapshots({
    preserveAnnounceHold: shouldPreserveAnnounceHoldOnPlay(2),
  });
  assert.equal(announceHoldIsLive(), true);
  const np = await getNowPlaying();
  assert.equal(np.djVoice, true);
  assert.equal(np.uri, CLIP);
});

test("hold yields once Sonos is past the announce row on a song", () => {
  holdAnnounceNowPlaying({ uri: CLIP, durationSec: 47, queueTrack: 2 });
  assert.equal(
    announceHoldShouldYieldTo({
      uri: "x-sonos-spotify:spotify:track:thunderstruck",
      queueTrack: 3,
      title: "Thunderstruck",
      artist: "AC/DC",
    }),
    true,
    "Thunderstruck past the DJ row must knock the hold down"
  );
});

test("hold keeps the DJ when SOAP is still the previous song", () => {
  holdAnnounceNowPlaying({ uri: CLIP, durationSec: 47, queueTrack: 2 });
  assert.equal(
    announceHoldShouldYieldTo({
      uri: "x-sonos-spotify:spotify:track:previous",
      queueTrack: 1,
      title: "Home Team",
      artist: "Whoever",
    }),
    false
  );
});

test("hold keeps the DJ when SOAP is still on the announce index", () => {
  holdAnnounceNowPlaying({ uri: CLIP, durationSec: 47, queueTrack: 2 });
  assert.equal(
    announceHoldShouldYieldTo({
      uri: "x-sonos-spotify:spotify:track:previous",
      queueTrack: 2,
      title: "Home Team",
    }),
    false,
    "stale last-song metadata at the announce index must not win"
  );
});

test("hold keeps the DJ when SOAP is the announce URI", () => {
  holdAnnounceNowPlaying({ uri: CLIP, durationSec: 47, queueTrack: 2 });
  assert.equal(
    announceHoldShouldYieldTo({
      uri: CLIP,
      queueTrack: 2,
      djVoice: true,
    }),
    false
  );
});

test("volume snapshot busts keep the announce hold", async () => {
  holdAnnounceNowPlaying({ uri: CLIP, durationSec: 24 });
  invalidateSonosSnapshots({ preserveAnnounceHold: true });
  assert.equal(announceNowPlayingHoldForTests()?.uri, CLIP);
  const np = await getNowPlaying();
  assert.equal(np.djVoice, true);
  assert.equal(np.uri, CLIP);
});
