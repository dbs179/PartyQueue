import { test } from "node:test";
import assert from "node:assert/strict";
import {
  wasPlayingFromQueue,
  shouldResumeAfterTopology,
} from "../src/sonos-topology-resume.js";

test("wasPlayingFromQueue requires playing from the queue", () => {
  assert.equal(wasPlayingFromQueue({ isPlaying: true, playingFromQueue: true }), true);
  assert.equal(wasPlayingFromQueue({ isPlaying: true, playingFromQueue: false }), false);
  assert.equal(wasPlayingFromQueue({ isPlaying: false, playingFromQueue: true }), false);
  assert.equal(wasPlayingFromQueue(null), false);
});

test("shouldResumeAfterTopology skips when already playing or handoff active", () => {
  assert.equal(
    shouldResumeAfterTopology({
      wasPlaying: true,
      after: { isPlaying: false, playingFromQueue: true },
    }),
    true
  );
  assert.equal(
    shouldResumeAfterTopology({
      wasPlaying: true,
      after: { isPlaying: true, playingFromQueue: true },
    }),
    false
  );
  assert.equal(
    shouldResumeAfterTopology({
      wasPlaying: true,
      handoffActive: true,
      after: { isPlaying: false, playingFromQueue: true },
    }),
    false
  );
  assert.equal(
    shouldResumeAfterTopology({
      wasPlaying: false,
      after: { isPlaying: false, playingFromQueue: true },
    }),
    false
  );
  assert.equal(
    shouldResumeAfterTopology({
      wasPlaying: true,
      after: { isPlaying: false, playingFromQueue: false },
    }),
    false
  );
});
