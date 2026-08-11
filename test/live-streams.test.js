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
  QUEUE_STALE_MESSAGE,
} from "../public/js/live-streams.js";

function makeStatusEl() {
  return {
    hidden: true,
    textContent: "",
    classList: {
      _set: new Set(),
      toggle(name, on) {
        if (on) this._set.add(name);
        else this._set.delete(name);
      },
      contains(name) {
        return this._set.has(name);
      },
    },
  };
}

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

test("queue-status disconnected shows stale Up Next + Party Display banners", async () => {
  assert.match(QUEUE_STALE_MESSAGE, /last known/i);

  const queueSection = makeStatusEl();
  const queueConnectionStatus = makeStatusEl();
  const displayQueueSection = makeStatusEl();
  const displayQueueStatus = makeStatusEl();

  /** @type {null | { fire: (name: string, data: object) => void, onerror?: () => void }} */
  let sourceApi = null;

  const live = createLiveStreams(
    {
      queueSection,
      queueConnectionStatus,
      displayQueueSection,
      displayQueueStatus,
    },
    {
      fetch: async () => ({ ok: true, async json() { return { tracks: [] }; } }),
      EventSource: class {
        constructor() {
          const listeners = new Map();
          sourceApi = {
            fire(name, data) {
              const fn = listeners.get(name);
              fn?.({ data: JSON.stringify(data) });
            },
          };
          queueMicrotask(() => this.onopen?.());
          this.addEventListener = (name, fn) => listeners.set(name, fn);
          this.close = () => {};
        }
      },
      getVisibilityState: () => "visible",
      getCurrentView: () => "main",
      renderNowPlaying: () => {},
      applyQueueTracks: () => {},
      applyPartySettings: () => {},
      freezePlayhead: () => {},
      isQueueEditMode: () => false,
      setPendingStreamTracks: () => {},
      clearPendingStreamTracks: () => {},
      loadGroups: () => {},
    }
  );

  live.openQueueStream();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(queueConnectionStatus.hidden, true);

  sourceApi.fire("queue-status", { status: "disconnected" });
  assert.equal(queueConnectionStatus.hidden, false);
  assert.equal(queueConnectionStatus.textContent, QUEUE_STALE_MESSAGE);
  assert.equal(displayQueueStatus.hidden, false);
  assert.equal(displayQueueStatus.textContent, QUEUE_STALE_MESSAGE);
  assert.ok(queueSection.classList.contains("is-stale"));
  assert.ok(displayQueueSection.classList.contains("is-stale"));

  sourceApi.fire("queue-status", { status: "connected" });
  assert.equal(queueConnectionStatus.hidden, true);
  assert.equal(displayQueueStatus.hidden, true);
  assert.equal(queueSection.classList.contains("is-stale"), false);

  live.closeQueueStream();
});

test("queue EventSource error marks Up Next stale", async () => {
  const queueConnectionStatus = makeStatusEl();
  /** @type {null | { onerror?: () => void }} */
  let instance = null;

  const live = createLiveStreams(
    { queueConnectionStatus },
    {
      fetch: async () => ({ ok: true, async json() { return { tracks: [] }; } }),
      EventSource: class {
        constructor() {
          instance = this;
          this.addEventListener = () => {};
          this.close = () => {};
          queueMicrotask(() => this.onopen?.());
        }
      },
      getVisibilityState: () => "visible",
      getCurrentView: () => "main",
      renderNowPlaying: () => {},
      applyQueueTracks: () => {},
      applyPartySettings: () => {},
      freezePlayhead: () => {},
      isQueueEditMode: () => false,
      setPendingStreamTracks: () => {},
      clearPendingStreamTracks: () => {},
      loadGroups: () => {},
    }
  );

  live.openQueueStream();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(queueConnectionStatus.hidden, true);
  instance.onerror();
  assert.equal(queueConnectionStatus.hidden, false);
  assert.equal(queueConnectionStatus.textContent, QUEUE_STALE_MESSAGE);
  live.closeQueueStream();
});
