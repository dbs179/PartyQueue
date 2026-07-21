import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createNowPlayingTransitionTracker,
  sameTrackMetadata,
  TRANSITION_TIMEOUT_MS,
} from "../src/now-playing-transition.js";

function track(overrides = {}) {
  return {
    queueTrack: 1,
    uri: "spotify:track:aaa",
    title: "Song A",
    artist: "Artist A",
    album: "Album A",
    albumArt: "/art-a.jpg",
    positionSec: 10,
    isPlaying: true,
    ...overrides,
  };
}

test("sameTrackMetadata compares media fields only", () => {
  assert.equal(
    sameTrackMetadata(track(), track({ positionSec: 99, isPlaying: false })),
    true
  );
  assert.equal(sameTrackMetadata(track(), track({ title: "Other" })), false);
});

test("nudge without Sonos advance does not mark metadataPending", () => {
  let now = 1_000;
  const tracker = createNowPlayingTransitionTracker({ now: () => now });
  const current = track();
  tracker.nudge(current);
  const resolved = tracker.resolve(current, current);
  assert.equal(resolved.metadataPending, false);
  assert.equal(resolved.title, "Song A");
});

test("pending only when queue index advanced with stale metadata", () => {
  let now = 1_000;
  const tracker = createNowPlayingTransitionTracker({ now: () => now });
  const previous = track({ queueTrack: 1 });
  const staleNext = track({ queueTrack: 2, positionSec: 0 });
  const resolved = tracker.resolve(previous, staleNext);
  assert.equal(resolved.metadataPending, true);
  assert.equal(resolved.queueTrack, 2);
  assert.equal(resolved.title, "Song A");
});

test("host nudge then index advance with stale meta marks pending", () => {
  let now = 1_000;
  const tracker = createNowPlayingTransitionTracker({ now: () => now });
  const previous = track({ queueTrack: 1 });
  tracker.nudge(previous);
  const stillOld = tracker.resolve(previous, previous);
  assert.equal(stillOld.metadataPending, false);

  const staleNext = track({ queueTrack: 2, positionSec: 0 });
  const pending = tracker.resolve(previous, staleNext);
  assert.equal(pending.metadataPending, true);
});

test("metadata change clears pending immediately", () => {
  let now = 1_000;
  const tracker = createNowPlayingTransitionTracker({ now: () => now });
  const previous = track({ queueTrack: 1 });
  const staleNext = track({ queueTrack: 2 });
  assert.equal(tracker.resolve(previous, staleNext).metadataPending, true);

  const fresh = track({
    queueTrack: 2,
    uri: "spotify:track:bbb",
    title: "Song B",
    artist: "Artist B",
    album: "Album B",
    albumArt: "/art-b.jpg",
    positionSec: 1,
  });
  const resolved = tracker.resolve(staleNext, fresh);
  assert.equal(resolved.metadataPending, false);
  assert.equal(resolved.title, "Song B");
  assert.equal(tracker.diagnostics().lastClearReason, "metadata-changed");
});

test("pending auto-clears after deadline", () => {
  let now = 1_000;
  const tracker = createNowPlayingTransitionTracker({
    now: () => now,
    timeoutMs: TRANSITION_TIMEOUT_MS,
  });
  const previous = track({ queueTrack: 1 });
  const staleNext = track({ queueTrack: 2 });
  assert.equal(tracker.resolve(previous, staleNext).metadataPending, true);

  now += TRANSITION_TIMEOUT_MS + 1;
  const resolved = tracker.resolve(staleNext, staleNext);
  assert.equal(resolved.metadataPending, false);
  assert.equal(tracker.diagnostics().lastClearReason, "timeout");
});
