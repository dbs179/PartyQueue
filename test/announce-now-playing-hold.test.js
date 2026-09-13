import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  announceHoldIsLive,
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

test("volume snapshot busts keep the announce hold", async () => {
  holdAnnounceNowPlaying({ uri: CLIP, durationSec: 24 });
  invalidateSonosSnapshots({ preserveAnnounceHold: true });
  assert.equal(announceNowPlayingHoldForTests()?.uri, CLIP);
  const np = await getNowPlaying();
  assert.equal(np.djVoice, true);
  assert.equal(np.uri, CLIP);
});
