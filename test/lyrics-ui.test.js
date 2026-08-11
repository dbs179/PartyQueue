import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  LYRICS_LEAD_SEC,
  activeSyncedLineIndex,
  createLyricsUi,
  formatDjAnnounceScript,
  lyricsMissMessage,
} from "../public/js/lyrics-ui.js";

function makeLyricsEl() {
  let html = "";
  return {
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = String(value);
    },
    querySelector(sel) {
      const s = String(sel);
      if (s.includes("synced") && html.includes("np-fs-lyrics-synced")) {
        return {
          className: "np-fs-lyrics-synced",
          children: [],
          classList: {
            contains: () => false,
            toggle: () => {},
          },
          scrollIntoView: () => {},
        };
      }
      if (s.includes("plain") && html.includes("np-fs-lyrics-plain")) {
        return { className: "np-fs-lyrics-plain" };
      }
      if (s.includes("status") && html.includes("np-fs-lyrics-status")) {
        return { className: "np-fs-lyrics-status" };
      }
      return null;
    },
    replaceChildren(...nodes) {
      html = nodes
        .map((n) => {
          if (!n) return "";
          if (typeof n.outerHTML === "string") return n.outerHTML;
          if (n.className) {
            return `<${n.tagName || "div"} class="${n.className}"></${
              n.tagName || "div"
            }>`;
          }
          return "";
        })
        .join("");
    },
  };
}

test("LYRICS_LEAD_SEC is a small positive offset", () => {
  assert.equal(LYRICS_LEAD_SEC, 0.75);
});

test("activeSyncedLineIndex respects lead and timeline", () => {
  const lines = [
    { t: 0, text: "a" },
    { t: 5, text: "b" },
    { t: 10, text: "c" },
  ];
  assert.equal(activeSyncedLineIndex(lines, 0, 0), 0);
  assert.equal(activeSyncedLineIndex(lines, 4.2, 0), 0);
  assert.equal(activeSyncedLineIndex(lines, 4.3, 0.75), 1);
  assert.equal(activeSyncedLineIndex(lines, 10, 0), 2);
  assert.equal(activeSyncedLineIndex(lines, -1, 0), -1);
  assert.equal(activeSyncedLineIndex([], 1), -1);
});

test("lyricsMissMessage covers degraded providers", () => {
  assert.equal(lyricsMissMessage(null), "No lyrics found");
  assert.equal(lyricsMissMessage({}), "No lyrics found");
  assert.equal(
    lyricsMissMessage({ degraded: true }),
    "No lyrics found — providers are having trouble"
  );
});

test("formatDjAnnounceScript soft-breaks sentences for TV/overlay", () => {
  assert.equal(formatDjAnnounceScript(""), "");
  assert.equal(
    formatDjAnnounceScript("Hello party. Here comes the set! Enjoy."),
    "Hello party.\n\nHere comes the set!\n\nEnjoy."
  );
});

test("track change clears prior karaoke before a lyrics miss returns", async () => {
  const displayLyrics = makeLyricsEl();
  const npFsLyrics = makeLyricsEl();
  let nowPlaying = null;
  let resolveMiss;
  const missPromise = new Promise((resolve) => {
    resolveMiss = resolve;
  });

  const prevDocument = globalThis.document;
  const prevWindow = globalThis.window;
  const prevMatchMedia = globalThis.matchMedia;
  globalThis.document = {
    body: {
      classList: { add() {}, remove() {} },
    },
    createElement(tag) {
      const kids = [];
      const el = {
        tagName: tag,
        className: "",
        textContent: "",
        innerHTML: "",
        style: {},
        classList: {
          add() {},
          contains() {
            return false;
          },
        },
        appendChild(child) {
          kids.push(child);
        },
        prepend() {},
        querySelector() {
          return null;
        },
        replaceChildren(...nodes) {
          kids.length = 0;
          kids.push(...nodes);
        },
        get outerHTML() {
          return `<${tag} class="${this.className}"></${tag}>`;
        },
      };
      return el;
    },
  };
  globalThis.window = {
    addEventListener() {},
    matchMedia: () => ({ matches: true }),
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
  };
  globalThis.matchMedia = () => ({ matches: true });

  const fetchFn = mock.fn(async (url) => {
    const u = String(url);
    if (u.includes("Track%20A") || u.includes("Track+A") || u.includes("title=Track+A") || u.includes("title=Track%20A")) {
      return {
        ok: true,
        json: async () => ({
          found: true,
          syncedLyrics: "[00:00.00] Line A1\n[00:05.00] Line A2\n",
        }),
      };
    }
    await missPromise;
    return {
      ok: true,
      json: async () => ({ found: false }),
    };
  });

  try {
    const ui = createLyricsUi(
      { displayLyrics, npFsLyrics },
      {
        fetch: fetchFn,
        getLastNowPlaying: () => nowPlaying,
        getCurrentView: () => "display",
        isModalOpen: () => false,
        bindArtwork: () => {},
      }
    );

    nowPlaying = {
      title: "Track A",
      artist: "Artist",
      uri: "spotify:track:aaaaaaaaaaaaaaaaaaaaaa",
      queueTrack: 1,
      isPlaying: true,
      durationSec: 120,
      positionSec: 0,
    };
    ui.sync(nowPlaying);
    await new Promise((r) => setTimeout(r, 0));
    assert.match(
      displayLyrics.innerHTML + npFsLyrics.innerHTML,
      /np-fs-lyrics-synced/
    );

    nowPlaying = {
      title: "Track B",
      artist: "Artist",
      uri: "spotify:track:bbbbbbbbbbbbbbbbbbbbbb",
      queueTrack: 2,
      isPlaying: true,
      durationSec: 120,
      positionSec: 0,
    };
    ui.sync(nowPlaying);
    assert.match(
      displayLyrics.innerHTML,
      /Loading lyrics/,
      "prior karaoke must clear before miss returns"
    );
    assert.doesNotMatch(displayLyrics.innerHTML, /np-fs-lyrics-synced/);

    resolveMiss();
    await new Promise((r) => setTimeout(r, 0));
    assert.match(displayLyrics.innerHTML, /No lyrics found/);
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    if (prevMatchMedia === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = prevMatchMedia;
  }
});
