import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldPollView,
  shouldLoadSonosGroups,
  createLiveStreams,
  bindForegroundResume,
  nowPlayingLooksActive,
  NOW_PLAYING_FALLBACK_MS,
  NOW_PLAYING_FALLBACK_PAUSED_MS,
  QUEUE_FALLBACK_MS,
  PARTY_FALLBACK_MS,
  QUEUE_STALE_MESSAGE,
  NOW_PLAYING_STALE_MESSAGE,
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

test("shouldPollView only on visible main/display/karaoke/mix", () => {
  assert.equal(shouldPollView("visible", "main"), true);
  assert.equal(shouldPollView("visible", "display"), true);
  assert.equal(shouldPollView("visible", "karaoke"), true);
  assert.equal(shouldPollView("visible", "mix"), true);
  assert.equal(shouldPollView("visible", "booth"), false);
  assert.equal(shouldPollView("hidden", "main"), false);
  assert.equal(shouldPollView("hidden", "karaoke"), false);
  assert.equal(shouldPollView("visible", "settings-dj"), false);
  assert.equal(shouldLoadSonosGroups("main"), true);
  assert.equal(shouldLoadSonosGroups("display"), false);
  assert.equal(shouldLoadSonosGroups("karaoke"), false);
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

test("bootstrap HTTP now-playing paints when SSE opens without a snapshot", async () => {
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
            return { title: "http-bootstrap", artist: "X" };
          },
        };
      },
      EventSource: class {
        constructor() {
          queueMicrotask(() => this.onopen?.());
        }
        addEventListener() {}
        close() {}
      },
      getVisibilityState: () => "visible",
      getCurrentView: () => "display",
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
  assert.deepEqual(paints, []);
  resolveFetch();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(paints, ["http-bootstrap"]);
  live.closeNowPlayingStream();
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

test("now-playing EventSource error marks Now Playing stale", async () => {
  assert.match(NOW_PLAYING_STALE_MESSAGE, /last update/i);

  const npCard = makeStatusEl();
  const npConnectionStatus = makeStatusEl();
  const displayConnectionStatus = makeStatusEl();
  /** @type {null | { onerror?: () => void }} */
  let instance = null;

  const live = createLiveStreams(
    { npCard, npConnectionStatus, displayConnectionStatus },
    {
      fetch: async () => ({
        ok: true,
        async json() {
          return { title: "np" };
        },
      }),
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

  live.openNowPlayingStream();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(npConnectionStatus.hidden, true);
  instance.onerror();
  assert.equal(npConnectionStatus.hidden, false);
  assert.equal(npConnectionStatus.textContent, NOW_PLAYING_STALE_MESSAGE);
  assert.equal(displayConnectionStatus.hidden, false);
  assert.equal(displayConnectionStatus.textContent, NOW_PLAYING_STALE_MESSAGE);
  assert.ok(npCard.classList.contains("is-stale"));
  live.closeNowPlayingStream();
});

test("queue-changed pulls Up Next even while the queue SSE is connected", async () => {
  const paints = [];
  /** @type {null | { fire: (name: string, data?: object) => void }} */
  let sourceApi = null;
  const live = createLiveStreams(
    {},
    {
      fetch: async (url) => {
        if (String(url).startsWith("/api/queue/list")) {
          return {
            ok: true,
            async json() {
              return { tracks: [{ uri: "spotify:track:ha", title: "From HA" }] };
            },
          };
        }
        return { ok: true, async json() { return { tracks: [] }; } };
      },
      EventSource: class {
        constructor() {
          const listeners = new Map();
          sourceApi = {
            fire(name, data) {
              listeners.get(name)?.({ data: JSON.stringify(data || {}) });
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
      applyQueueTracks: (tracks) => paints.push(tracks.map((t) => t.title)),
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
  paints.length = 0;
  sourceApi.fire("queue-changed", { at: 1 });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(paints, [["From HA"]]);
  live.closeQueueStream();
});

test("refreshSonos reloads the queue while SSE is connected", async () => {
  const paints = [];
  let queueListFetches = 0;
  const live = createLiveStreams(
    {},
    {
      fetch: async (url) => {
        if (String(url).startsWith("/api/queue/list")) {
          queueListFetches += 1;
          return {
            ok: true,
            async json() {
              return {
                tracks: [{ uri: "spotify:track:n", title: `N${queueListFetches}` }],
              };
            },
          };
        }
        return { ok: true, async json() { return { title: "np" }; } };
      },
      EventSource: class {
        constructor() {
          this.addEventListener = () => {};
          this.close = () => {};
          queueMicrotask(() => this.onopen?.());
        }
      },
      getVisibilityState: () => "visible",
      getCurrentView: () => "main",
      renderNowPlaying: () => {},
      applyQueueTracks: (tracks) => paints.push(tracks[0]?.title),
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
  const fetchesAtOpen = queueListFetches;
  live.refreshSonos();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(queueListFetches > fetchesAtOpen);
  assert.ok(paints.includes(`N${queueListFetches}`));
  live.closeQueueStream();
});

test("nowplaying-changed pulls Now Playing even while SSE is connected", async () => {
  const paints = [];
  /** @type {null | { fire: (name: string, data?: object) => void }} */
  let sourceApi = null;
  const live = createLiveStreams(
    {},
    {
      fetch: async (url) => {
        if (String(url).startsWith("/api/nowplaying")) {
          return {
            ok: true,
            async json() {
              return { title: "HA Random" };
            },
          };
        }
        return { ok: true, async json() { return {}; } };
      },
      EventSource: class {
        constructor() {
          const listeners = new Map();
          sourceApi = {
            fire(name, data) {
              listeners.get(name)?.({ data: JSON.stringify(data || {}) });
            },
          };
          queueMicrotask(() => this.onopen?.());
          this.addEventListener = (name, fn) => listeners.set(name, fn);
          this.close = () => {};
        }
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
  paints.length = 0;
  sourceApi.fire("nowplaying-changed", { at: 1 });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(paints, ["HA Random"]);
  live.closeNowPlayingStream();
});

test("HTTP party fallback does not overwrite an active SSE paint", async () => {
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
            return { mixMood: "stale-http", streamSession: "s0", streamSequence: 1 };
          },
        };
      },
      EventSource: class {
        constructor() {
          queueMicrotask(() => {
            this.onopen?.();
            this.onmessage?.({
              data: JSON.stringify({
                mixMood: "fresh-sse",
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
      renderNowPlaying: () => {},
      applyQueueTracks: () => {},
      applyPartySettings: (snap) => paints.push(snap.mixMood),
      freezePlayhead: () => {},
      isQueueEditMode: () => false,
      setPendingStreamTracks: () => {},
      clearPendingStreamTracks: () => {},
      loadGroups: () => {},
    }
  );

  live.openPartyStream();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(paints, ["fresh-sse"]);
  resolveFetch();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(paints, ["fresh-sse"]);
  live.closePartyStream();
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

test("a resume event while hidden leaves the debounce for the real return", () => {
  const listeners = new Map();
  const target = {
    visibilityState: "hidden",
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
  let now = 1_000;
  let resumes = 0;
  bindForegroundResume({
    onResume: () => {
      resumes += 1;
    },
    target,
    win,
    now: () => now,
  });

  // Background tab load / Back into bfcache / WiFi returning in a pocket.
  listeners.get("win:pageshow")();
  listeners.get("win:online")();
  assert.equal(resumes, 0);

  // The unlock that follows within the debounce window must still reconnect.
  now += 200;
  target.visibilityState = "visible";
  listeners.get("doc:visibilitychange")();
  assert.equal(resumes, 1);
});

test("going hidden clears the debounce so a quick return reconnects", () => {
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
  let now = 1_000;
  let resumes = 0;
  let sleeps = 0;
  bindForegroundResume({
    onResume: () => {
      resumes += 1;
    },
    onSleep: () => {
      sleeps += 1;
    },
    target,
    win,
    now: () => now,
  });

  listeners.get("doc:visibilitychange")();
  assert.equal(resumes, 1);

  // Notification shade / quick app hop: shorter than the debounce window.
  now += 300;
  target.visibilityState = "hidden";
  listeners.get("doc:visibilitychange")();
  assert.equal(sleeps, 1);

  now += 300;
  target.visibilityState = "visible";
  listeners.get("doc:visibilitychange")();
  assert.equal(resumes, 2);
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
