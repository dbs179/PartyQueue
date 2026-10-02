import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  httpAudioEnqueueBody,
  httpAudioMeta,
} from "../src/sonos-queue-mutations.js";
import {
  holdAnnounceNowPlaying,
  observePostAnnounceTransport,
  resetAnnounceNowPlayingHoldForTests,
} from "../src/sonos-snapshots.js";

const CLIP =
  "http://10.10.1.30:8088/media/tts/dj-announce-588362fef4b9135a.mp3";

afterEach(() => {
  resetAnnounceNowPlayingHoldForTests();
});

function withInfo(fn) {
  const lines = [];
  const orig = console.info;
  console.info = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.info = orig;
  }
  return lines;
}

test("HTTP audio metadata stays empty so Sonos will accept the row", () => {
  const url = 'http://x/a.mp3?x=1&y=2&note="hi"';
  const meta = httpAudioMeta(url);
  assert.equal(meta.trackUri, url);
  assert.equal(meta.metadata, "");
  assert.equal(
    httpAudioMeta(CLIP, {
      title: "Tom & Jerry <live>",
      artist: `O'Brien "DJ"`,
      durationSec: 31.21,
    }).metadata,
    ""
  );
});

test("enqueue payload keeps the original URL and empty metadata", () => {
  const body = httpAudioEnqueueBody(CLIP, { position: 1 });
  assert.equal(body.EnqueuedURI, CLIP);
  assert.equal(body.EnqueuedURIMetaData, "");
  assert.equal(body.DesiredFirstTrackNumberEnqueued, 1);
  assert.equal(body.EnqueueAsNext, false);
  assert.equal(body.InstanceID, 0);
});

test("post-announce diagnostics log only after the baked row is left", () => {
  const baked = CLIP;
  const next = "x-sonos-spotify:spotify%3atrack%3aabc";
  const quiet = withInfo(() => {
    observePostAnnounceTransport({
      state: "PLAYING",
      queueTrack: 1,
      trackUri: baked,
      relTime: "0:00:20",
      trackDuration: "0:00:31",
      currentUri: "x-rincon-queue:RINCON",
    });
  });
  assert.equal(quiet.length, 0);

  const lines = withInfo(() => {
    observePostAnnounceTransport(
      {
        state: "PLAYING",
        queueTrack: 2,
        trackUri: next,
        relTime: "0:00:01",
        trackDuration: "0:03:12",
        currentUri: "x-rincon-queue:RINCON",
      },
      1_000
    );
    observePostAnnounceTransport(
      {
        state: "PLAYING",
        queueTrack: 2,
        trackUri: next,
        relTime: "0:00:03",
        trackDuration: "0:03:12",
        currentUri: "x-rincon-queue:RINCON",
      },
      2_000
    );
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /state=PLAYING/);
  assert.match(lines[0], /track=2/);
  assert.match(lines[0], /rel=0:00:01/);
  assert.match(lines[0], /dur=0:03:12/);
  assert.match(lines[0], new RegExp(next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(lines[1], /rel=0:00:03/);
});

test("post-announce diagnostics stop after the window", () => {
  observePostAnnounceTransport({
    trackUri: CLIP,
    state: "PLAYING",
    queueTrack: 1,
    relTime: "0:00:30",
    trackDuration: "0:00:31",
  });
  const lines = withInfo(() => {
    observePostAnnounceTransport(
      {
        state: "PLAYING",
        queueTrack: 2,
        trackUri: "x-sonos-spotify:spotify%3atrack%3aabc",
        relTime: "0:00:01",
        trackDuration: "0:03:00",
        currentUri: "x-rincon-queue:RINCON",
      },
      10_000
    );
    observePostAnnounceTransport(
      {
        state: "PLAYING",
        queueTrack: 2,
        trackUri: "x-sonos-spotify:spotify%3atrack%3aabc",
        relTime: "0:00:50",
        trackDuration: "0:03:00",
        currentUri: "x-rincon-queue:RINCON",
      },
      10_000 + 45_001
    );
  });
  assert.equal(lines.length, 1);
});

test("a live announce hold starts the diagnostic when SOAP has already moved on", () => {
  holdAnnounceNowPlaying({
    uri: CLIP,
    durationSec: 31,
    queueTrack: 1,
  });
  const lines = withInfo(() => {
    observePostAnnounceTransport({
      state: "TRANSITIONING",
      queueTrack: 2,
      trackUri: "x-sonos-spotify:spotify%3atrack%3aabc",
      relTime: "0:00:00",
      trackDuration: "0:03:40",
      currentUri: "x-rincon-queue:RINCON",
    });
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /state=TRANSITIONING/);
  assert.match(lines[0], /rel=0:00:00/);
});
