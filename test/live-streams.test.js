import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldPollView,
  createLiveStreams,
  bindForegroundResume,
  nowPlayingLooksActive,
  NOW_PLAYING_FALLBACK_MS,
  NOW_PLAYING_FALLBACK_PAUSED_MS,
  QUEUE_FALLBACK_MS,
  PARTY_FALLBACK_MS,
  QUEUE_STALE_MESSAGE,
  FOREGROUND_RESUME_DEBOUNCE_MS,
  FOCUS_RESUME_FRESH_MS,
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

test("bindForegroundResume debounces stacked unlock events", () => {
  const listeners = new Map();
  const target = {
    visibilityState: "visible",
    addEventListener(name, fn) {
      listeners.set(`doc:${name}`, fn);
    },
    removeEventListener(name) {
      listeners.delete(`doc:${name}`);
    },
  };
  const win = {
    addEventListener(name, fn) {
      listeners.set(`win:${name}`, fn);
    },
    removeEventListener(name) {
      listeners.delete(`win:${name}`);
    },
  };
  let now = 1_000;
  let resumes = 0;
  let sleeps = 0;
  const unbind = bindForegroundResume({
    onResume: () => {
      resumes += 1;
    },
    onSleep: () => {
      sleeps += 1;
    },
    target,
    win,
    now: () => now,
    debounceMs: FOREGROUND_RESUME_DEBOUNCE_MS,
  });

  listeners.get("win:pageshow")();
  listeners.get("doc:visibilitychange")();
  listeners.get("win:focus")();
  assert.equal(resumes, 1);

  now += FOREGROUND_RESUME_DEBOUNCE_MS + 1;
  listeners.get("win:pageshow")();
  assert.equal(resumes, 2);

  listeners.get("win:pagehide")();
  assert.equal(sleeps, 1);
  unbind();
});

test("bindForegroundResume skips a fresh focus hop", () => {
  const listeners = new Map();
  const target = {
    visibilityState: "visible",
    addEventListener(name, fn) {
      listeners.set(`doc:${name}`, fn);
    },
    removeEventListener() {},
  };
  const win = {
    addEventListener(name, fn) {
      listeners.set(`win:${name}`, fn);
    },
    removeEventListener() {},
  };
  let resumes = 0;
  bindForegroundResume({
    onResume: () => {
      resumes += 1;
    },
    shouldResumeOnFocus: () => false,
    target,
    win,
    now: () => 5_000,
  });
  listeners.get("win:focus")();
  assert.equal(resumes, 0);
  listeners.get("win:pageshow")();
  assert.equal(resumes, 1);
  assert.ok(FOCUS_RESUME_FRESH_MS > 0);
});

test("force reconnect closes a zombie EventSource and fetches without cache", async () => {
  const fetches = [];
  let sources = 0;
  let closes = 0;
  const live = createLiveStreams(
    {},
    {
      fetch: async (url, opts) => {
        fetches.push({ url, cache: opts?.cache });
        return { ok: true, async json() { return { title: "np", tracks: [] }; } };
      },
      EventSource: class {
        constructor() {
          sources += 1;
          this.addEventListener = () => {};
          this.close = () => {
            closes += 1;
          };
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

  live.syncPolling();
  await new Promise((r) => setTimeout(r, 10));
  const opened = sources;
  assert.ok(opened >= 3);
  assert.ok(fetches.every((item) => item.cache === "no-store"));

  live.syncPolling({ forceReconnect: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(closes >= 3);
  assert.ok(sources >= opened + 3);
  live.closeNowPlayingStream();
  live.closeQueueStream();
  live.closePartyStream();
});
