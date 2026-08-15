import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  LYRICS_LEAD_SEC,
  DISPLAY_LYRIC_WINDOW,
  activeSyncedLineIndex,
  createLyricsUi,
  displayLyricWindowSlots,
  formatDjAnnounceScript,
  lyricsMissMessage,
} from "../public/js/lyrics-ui.js";

function makeLyricsEl() {
  let html = "";
  const classes = new Set();
  return {
    hidden: false,
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
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
    appendChild(node) {
      if (!node) return;
      if (typeof node.outerHTML === "string") html += node.outerHTML;
      else if (node.className) {
        html += `<${node.tagName || "div"} class="${node.className}">${
          node.textContent || ""
        }</${node.tagName || "div"}>`;
      }
    },
    prepend() {},
  };
}

test("LYRICS_LEAD_SEC is a small positive offset", () => {
  assert.equal(LYRICS_LEAD_SEC, 0.75);
});

test("Party Display karaoke window is 3 lines around the active line", () => {
  assert.equal(DISPLAY_LYRIC_WINDOW, 3);
  assert.deepEqual(displayLyricWindowSlots(4), [
    { i: 3, cls: "is-past" },
    { i: 4, cls: "is-active" },
    { i: 5, cls: "is-next" },
  ]);
  assert.deepEqual(displayLyricWindowSlots(0), [
    { i: -1, cls: "is-past" },
    { i: 0, cls: "is-active" },
    { i: 1, cls: "is-next" },
  ]);
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
        append() {},
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
    assert.equal(
      displayLyrics.hidden,
      true,
      "Party Display hides lyrics until timed karaoke is ready"
    );
    assert.doesNotMatch(displayLyrics.innerHTML, /np-fs-lyrics-synced/);
    assert.match(npFsLyrics.innerHTML, /Loading lyrics/);

    resolveMiss();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(displayLyrics.hidden, true);
    assert.match(npFsLyrics.innerHTML, /No lyrics found/);
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    if (prevMatchMedia === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = prevMatchMedia;
  }
});

test("Party Display stays hidden for plain lyrics and shows timed karaoke", async () => {
  const displayLyrics = makeLyricsEl();
  displayLyrics.hidden = true;
  const npFsLyrics = makeLyricsEl();
  let nowPlaying = {
    title: "Plain Song",
    artist: "Artist",
    uri: "spotify:track:cccccccccccccccccccccc",
    queueTrack: 1,
    isPlaying: true,
    durationSec: 120,
    positionSec: 0,
  };

  const prevDocument = globalThis.document;
  const prevWindow = globalThis.window;
  const prevMatchMedia = globalThis.matchMedia;
  globalThis.document = {
    body: { classList: { add() {}, remove() {} } },
    createElement(tag) {
      const el = {
        tagName: tag,
        className: "",
        textContent: "",
        innerHTML: "",
        classList: { add() {}, contains() { return false; } },
        appendChild() {},
        append() {},
        prepend() {},
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

  let ui;
  try {
    ui = createLyricsUi(
      { displayLyrics, npFsLyrics },
      {
        fetch: async (url) => {
          const u = String(url);
          if (u.includes("Plain")) {
            return {
              ok: true,
              json: async () => ({
                found: true,
                plainLyrics: "Verse one\nVerse two\nVerse three\n".repeat(40),
              }),
            };
          }
          return {
            ok: true,
            json: async () => ({
              found: true,
              syncedLyrics: "[00:00.00] Line A1\n[00:05.00] Line A2\n",
            }),
          };
        },
        getLastNowPlaying: () => nowPlaying,
        getCurrentView: () => "display",
        isModalOpen: () => false,
        bindArtwork: () => {},
      }
    );

    ui.sync(nowPlaying);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(displayLyrics.hidden, true);

    nowPlaying = {
      title: "Timed Song",
      artist: "Artist",
      uri: "spotify:track:dddddddddddddddddddddd",
      queueTrack: 2,
      isPlaying: true,
      durationSec: 120,
      positionSec: 0,
    };
    ui.sync(nowPlaying);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(displayLyrics.hidden, false);
    assert.match(
      displayLyrics.innerHTML,
      /party-display-lyrics-window|np-fs-lyrics-synced/
    );
  } finally {
    ui?.onViewChange({ target: "main", previous: "display" });
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    if (prevMatchMedia === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = prevMatchMedia;
  }
});

test("Party Display shows DJ announce script and hides untimed song lyrics", async () => {
  const displayLyrics = makeLyricsEl();
  displayLyrics.hidden = true;
  const npFsLyrics = makeLyricsEl();
  let nowPlaying = {
    title: "DJ Voice",
    artist: "PartyQueue",
    djVoice: true,
    announceScript: "Hello party. Here comes the set!",
    uri: "spotify:track:djpad0000000000000000",
    queueTrack: 1,
    isPlaying: true,
  };

  const prevDocument = globalThis.document;
  const prevWindow = globalThis.window;
  const prevMatchMedia = globalThis.matchMedia;
  globalThis.document = {
    body: { classList: { add() {}, remove() {} } },
    createElement(tag) {
      return {
        tagName: tag,
        className: "",
        textContent: "",
        innerHTML: "",
        classList: { add() {}, contains() { return false; } },
        appendChild() {},
        get outerHTML() {
          return `<${tag} class="${this.className}">${this.textContent}</${tag}>`;
        },
      };
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

  let ui;
  try {
    ui = createLyricsUi(
      { displayLyrics, npFsLyrics },
      {
        fetch: async () => ({
          ok: true,
          json: async () => ({
            found: true,
            plainLyrics: "Should not appear on the TV",
          }),
        }),
        getLastNowPlaying: () => nowPlaying,
        getCurrentView: () => "display",
        isModalOpen: () => false,
        bindArtwork: () => {},
      }
    );

    ui.sync(nowPlaying);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(displayLyrics.hidden, false);
    assert.match(displayLyrics.innerHTML, /Hello party/);
    assert.match(displayLyrics.innerHTML, /np-fs-lyrics-plain/);
    assert.equal(displayLyrics.classList.contains("is-dj"), true);

    nowPlaying = {
      title: "Plain Song",
      artist: "Artist",
      uri: "spotify:track:eeeeeeeeeeeeeeeeeeeeee",
      queueTrack: 2,
      isPlaying: true,
      durationSec: 120,
      positionSec: 0,
    };
    ui.sync(nowPlaying);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(displayLyrics.hidden, true);
    assert.doesNotMatch(displayLyrics.innerHTML, /Should not appear/);
  } finally {
    ui?.onViewChange({ target: "main", previous: "display" });
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    if (prevMatchMedia === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = prevMatchMedia;
  }
});
