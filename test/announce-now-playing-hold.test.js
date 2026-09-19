import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  announceHoldIsLive,
  announceHoldShouldYieldTo,
  announceNowPlayingHoldForTests,
  getNowPlaying,
  holdAnnounceNowPlaying,
  holdIdleNowPlaying,
  idleHoldShouldYieldTo,
  idleNowPlayingHoldForTests,
  invalidateSonosSnapshots,
  rememberLastMusicNowPlayingForTests,
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

test("hold keeps the previous song at a lower index when previous is stored", () => {
  holdAnnounceNowPlaying({
    uri: CLIP,
    durationSec: 47,
    queueTrack: 2,
    previous: {
      uri: "x-sonos-spotify:spotify:track:previous",
      title: "Home Team",
      artist: "Whoever",
    },
  });
  assert.equal(
    announceHoldShouldYieldTo({
      uri: "x-sonos-spotify:spotify:track:previous",
      queueTrack: 1,
      title: "Home Team",
      artist: "Whoever",
    }),
    false,
    "Seek leftover last-song SOAP must not flash over the DJ"
  );
});

test("hold keeps the DJ when SOAP is still on the announce index", () => {
  holdAnnounceNowPlaying({
    uri: CLIP,
    durationSec: 47,
    queueTrack: 2,
    previous: {
      uri: "x-sonos-spotify:spotify:track:previous",
      title: "Home Team",
      artist: "Whoever",
    },
  });
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

test("hold yields when the next song is at the compacted announce index", () => {
  holdAnnounceNowPlaying({
    uri: CLIP,
    durationSec: 47,
    queueTrack: 2,
    previous: {
      uri: "x-sonos-spotify:spotify:track:previous",
      title: "Home Team",
      artist: "Whoever",
    },
  });
  assert.equal(
    announceHoldShouldYieldTo({
      uri: "x-sonos-spotify:spotify:track:thunderstruck",
      queueTrack: 2,
      title: "Thunderstruck",
      artist: "AC/DC",
    }),
    true,
    "Thunderstruck at the trimmed announce index must knock the hold down"
  );
});

test("hold yields when the next song compacted below the announce index", () => {
  holdAnnounceNowPlaying({
    uri: CLIP,
    durationSec: 47,
    queueTrack: 2,
    previous: {
      uri: "x-sonos-spotify:spotify:track:previous",
      title: "Home Team",
      artist: "Whoever",
    },
  });
  assert.equal(
    announceHoldShouldYieldTo({
      uri: "x-sonos-spotify:spotify:track:drown",
      queueTrack: 1,
      title: "Drown",
      artist: "Bring Me The Horizon",
    }),
    true,
    "Drown at track 1 after the DJ row is stripped must knock the hold down"
  );
});

test("remembered last music fills previous when the seed raced onto the DJ", () => {
  rememberLastMusicNowPlayingForTests({
    uri: "x-sonos-spotify:spotify:track:previous",
    title: "Home Team",
    artist: "Whoever",
  });
  holdAnnounceNowPlaying({ uri: CLIP, durationSec: 47, queueTrack: 2 });
  assert.equal(
    announceNowPlayingHoldForTests()?.previousUri,
    "x-sonos-spotify:spotify:track:previous"
  );
  assert.equal(
    announceHoldShouldYieldTo({
      uri: "x-sonos-spotify:spotify:track:drown",
      queueTrack: 1,
      title: "Drown",
      artist: "Bring Me The Horizon",
    }),
    true,
    "missing explicit previous must not keep Holy Roller over compacted Drown"
  );
  assert.equal(
    announceHoldShouldYieldTo({
      uri: "x-sonos-spotify:spotify:track:previous",
      queueTrack: 1,
      title: "Home Team",
      artist: "Whoever",
    }),
    false,
    "Seek leftover last-song SOAP must still lose to the DJ"
  );
});

test("re-seed without queueTrack keeps the held index so yield still works", () => {
  holdAnnounceNowPlaying({ uri: CLIP, durationSec: 47, queueTrack: 3 });
  holdAnnounceNowPlaying({ uri: CLIP, durationSec: 47 });
  assert.equal(announceNowPlayingHoldForTests()?.queueTrack, 3);
  assert.equal(
    announceHoldShouldYieldTo({
      uri: "x-sonos-spotify:spotify:track:thunderstruck",
      queueTrack: 4,
      title: "Thunderstruck",
    }),
    true
  );
});

test("Clear seeds idle Now Playing and drops the announce hold", async () => {
  holdAnnounceNowPlaying({ uri: CLIP, durationSec: 24, queueTrack: 1 });
  invalidateSonosSnapshots({ seedIdle: true });
  assert.equal(announceNowPlayingHoldForTests(), null);
  assert.ok(idleNowPlayingHoldForTests()?.until > Date.now());
  const np = await getNowPlaying();
  assert.equal(np.title, null);
  assert.equal(np.uri, null);
  assert.equal(np.isPlaying, false);
  assert.equal(np.state, "STOPPED");
});

test("holdIdleNowPlaying paints an empty snapshot immediately", async () => {
  const seeded = holdIdleNowPlaying({ room: "Living Room" });
  assert.equal(seeded.title, null);
  assert.equal(seeded.isPlaying, false);
  const np = await getNowPlaying();
  assert.equal(np.room, "Living Room");
  assert.equal(np.uri, null);
});

test("idle hold keeps leftover PLAYING SOAP of the last song", () => {
  rememberLastMusicNowPlayingForTests({
    uri: "x-sonos-spotify:spotify:track:left-behind",
    title: "Left Behind",
    artist: "The Plot In You",
  });
  holdIdleNowPlaying();
  assert.equal(
    idleHoldShouldYieldTo(
      {
        uri: "x-sonos-spotify:spotify:track:left-behind",
        title: "Left Behind",
        artist: "The Plot In You",
        state: "PLAYING",
        isPlaying: true,
      },
      4
    ),
    false,
    "GetMediaInfo still counting tracks must not restore the last title"
  );
  assert.equal(
    idleHoldShouldYieldTo(
      {
        uri: "x-sonos-spotify:spotify:track:left-behind",
        title: "Left Behind",
        artist: "The Plot In You",
        state: "PLAYING",
        isPlaying: true,
      },
      0
    ),
    false,
    "empty-queue PLAYING leftover must stay idle"
  );
});

test("idle hold yields once a different song is actually playing", () => {
  rememberLastMusicNowPlayingForTests({
    uri: "x-sonos-spotify:spotify:track:left-behind",
    title: "Left Behind",
    artist: "The Plot In You",
  });
  holdIdleNowPlaying();
  assert.equal(
    idleHoldShouldYieldTo(
      {
        uri: "x-sonos-spotify:spotify:track:drown",
        title: "Drown",
        artist: "Bring Me The Horizon",
        state: "PLAYING",
        isPlaying: true,
      },
      3
    ),
    true
  );
});

test("idle Now Playing survives a snapshot bust without Sonos", async () => {
  holdIdleNowPlaying({ room: "Living Room" });
  getNowPlaying.bust();
  const np = await getNowPlaying();
  assert.equal(np.title, null);
  assert.equal(np.uri, null);
  assert.equal(np.isPlaying, false);
  assert.equal(np.state, "STOPPED");
  assert.equal(np.room, "Living Room");
});
