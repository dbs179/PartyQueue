import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  announceNowPlayingHoldForTests,
  getNowPlaying,
  holdAnnounceNowPlaying,
  invalidateSonosSnapshots,
  resetAnnounceNowPlayingHoldForTests,
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

test("volume snapshot busts keep the announce hold", async () => {
  holdAnnounceNowPlaying({ uri: CLIP, durationSec: 24 });
  invalidateSonosSnapshots({ preserveAnnounceHold: true });
  assert.equal(announceNowPlayingHoldForTests()?.uri, CLIP);
  const np = await getNowPlaying();
  assert.equal(np.djVoice, true);
  assert.equal(np.uri, CLIP);
});
