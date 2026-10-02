import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  didlDuration,
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

test("URL-only HTTP audio is a DIDL MPEG resource", () => {
  const meta = httpAudioMeta("http://x/pad.mp3");
  assert.equal(meta.trackUri, "http://x/pad.mp3");
  assert.match(meta.metadata, /^<DIDL-Lite /);
  assert.match(meta.metadata, /<\/DIDL-Lite>$/);
  assert.match(meta.metadata, /protocolInfo="http-get:\*:audio\/mpeg:\*"/);
  assert.match(meta.metadata, /<res [^>]*>http:\/\/x\/pad\.mp3<\/res>/);
  assert.doesNotMatch(meta.metadata, /duration=/);
  assert.doesNotMatch(meta.metadata, /<dc:title>/);
  assert.doesNotMatch(meta.metadata, /<dc:creator>/);
});

test("title and artist are included when present", () => {
  const meta = httpAudioMeta(CLIP, {
    title: "DJ Holy Roller",
    artist: "PartyQueue",
    durationSec: 31.21,
  });
  assert.match(meta.metadata, /<dc:title>DJ Holy Roller<\/dc:title>/);
  assert.match(meta.metadata, /<dc:creator>PartyQueue<\/dc:creator>/);
  assert.match(meta.metadata, /duration="0:00:31"/);
});

test("XML characters in title, artist, and URL are escaped", () => {
  const url = 'http://x/a.mp3?x=1&y=2&note="hi"';
  const meta = httpAudioMeta(url, {
    title: 'Tom & Jerry <live>',
    artist: `O'Brien "DJ"`,
  });
  assert.equal(meta.trackUri, url);
  assert.match(meta.metadata, /<dc:title>Tom &amp; Jerry &lt;live&gt;<\/dc:title>/);
  assert.match(
    meta.metadata,
    /<dc:creator>O&apos;Brien &quot;DJ&quot;<\/dc:creator>/
  );
  assert.match(
    meta.metadata,
    /<res [^>]*>http:\/\/x\/a\.mp3\?x=1&amp;y=2&amp;note=&quot;hi&quot;<\/res>/
  );
  assert.doesNotMatch(meta.metadata, /&y=2/);
});

test("known durations use Sonos H:MM:SS", () => {
  assert.equal(didlDuration(31.21), "0:00:31");
  assert.equal(didlDuration(27.07), "0:00:27");
  assert.equal(didlDuration(90.4), "0:01:30");
  assert.equal(didlDuration(125), "0:02:05");
  assert.match(httpAudioMeta(CLIP, { durationSec: 27.07 }).metadata, /duration="0:00:27"/);
  assert.match(httpAudioMeta(CLIP, { durationSec: 125 }).metadata, /duration="0:02:05"/);
});

test("missing or invalid duration omits the attribute", () => {
  for (const durationSec of [undefined, null, Number.NaN, 0, -4, "nope"]) {
    const meta = httpAudioMeta(CLIP, { durationSec });
    assert.doesNotMatch(meta.metadata, /duration=/, String(durationSec));
  }
});

test("enqueue payload keeps the original URL and the generated DIDL", () => {
  const opts = {
    title: "DJ Holy Roller",
    artist: "PartyQueue",
    durationSec: 31.21,
    position: 1,
  };
  const meta = httpAudioMeta(CLIP, opts);
  const body = httpAudioEnqueueBody(CLIP, opts);
  assert.equal(body.EnqueuedURI, CLIP);
  assert.equal(body.EnqueuedURI, meta.trackUri);
  assert.equal(body.EnqueuedURIMetaData, meta.metadata);
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
