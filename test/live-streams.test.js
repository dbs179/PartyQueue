import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldPollView,
  createLiveStreams,
  nowPlayingLooksActive,
  NOW_PLAYING_FALLBACK_MS,
  NOW_PLAYING_FALLBACK_PAUSED_MS,
  QUEUE_FALLBACK_MS,
  PARTY_FALLBACK_MS,
} from "../public/js/live-streams.js";

test("shouldPollView only on visible main/display/mix", () => {
  assert.equal(shouldPollView("visible", "main"), true);
  assert.equal(shouldPollView("visible", "display"), true);
  assert.equal(shouldPollView("visible", "mix"), true);
  assert.equal(shouldPollView("visible", "booth"), false);
  assert.equal(shouldPollView("hidden", "main"), false);
  assert.equal(shouldPollView("visible", "settings-dj"), false);
});

test("fallback intervals stay in the expected band", () => {
  assert.equal(NOW_PLAYING_FALLBACK_MS, 15000);
  assert.equal(NOW_PLAYING_FALLBACK_PAUSED_MS, 45000);
  assert.ok(NOW_PLAYING_FALLBACK_PAUSED_MS > NOW_PLAYING_FALLBACK_MS);
  assert.equal(QUEUE_FALLBACK_MS, 15000);
  assert.ok(PARTY_FALLBACK_MS >= QUEUE_FALLBACK_MS);
});

test("nowPlayingLooksActive treats playing and transitioning as active", () => {
  assert.equal(nowPlayingLooksActive({ isPlaying: true }), true);
  assert.equal(nowPlayingLooksActive({ state: "TRANSITIONING" }), true);
  assert.equal(nowPlayingLooksActive({ isPlaying: false, state: "PAUSED_PLAYBACK" }), false);
  assert.equal(nowPlayingLooksActive(null), false);
});

test("HTTP now-playing fallback does not overwrite an active SSE paint", async () => {
  const paints = [];
  let resolveFetch;
  const fetchPromise = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const live = createLiveStreams(
    {},
    {
      fetch: async () => {
        await fetchPromise;
        return {
          ok: true,
          async json() {
            return { title: "stale-http", artist: "X" };
          },
        };
      },
      EventSource: class {
        constructor() {
          queueMicrotask(() => {
            this.onopen?.();
            this.onmessage?.({
              data: JSON.stringify({
                title: "fresh-sse",
                artist: "Y",
                streamSession: "s1",
                streamSequence: 2,
              }),
            });
          });
        }
        addEventListener() {}
        close() {}
      },
      getVisibilityState: () => "visible",
      getCurrentView: () => "main",
      renderNowPlaying: (snap) => paints.push(snap.title),
      applyQueueTracks: () => {},
      applyPartySettings: () => {},
      freezePlayhead: () => {},
      isQueueEditMode: () => false,
      setPendingStreamTracks: () => {},
      clearPendingStreamTracks: () => {},
      loadGroups: () => {},
    }
  );

  live.openNowPlayingStream();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(paints, ["fresh-sse"]);
  resolveFetch();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(paints, ["fresh-sse"]);
  live.closeNowPlayingStream?.();
  live.stopAll?.();
});
