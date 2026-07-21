import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LyricsUnavailableError,
  lookupLyrics,
  resetLyricsStateForTests,
  warmLyrics,
} from "../src/lyrics.js";

describe("lookupLyrics", () => {
  beforeEach(() => {
    resetLyricsStateForTests();
  });

  it("rejects missing title/artist", async () => {
    const out = await lookupLyrics({ title: "", artist: "X" });
    assert.equal(out.found, false);
  });

  it("finds known track via LRClib search", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const isSearch = String(url).includes("/api/search?");
      return {
        ok: true,
        status: 200,
        async json() {
          if (isSearch) {
            return [
              {
                trackName: "I Want to Live",
                artistName: "Borislav Slavov",
                duration: 233,
                syncedLyrics: "[00:01.00]Mock synced lyrics",
              },
            ];
          }
          return {
            trackName: "I Want to Live",
            artistName: "Borislav Slavov",
            duration: 233,
            plainLyrics: "Mock plain lyrics",
          };
        },
      };
    };

    try {
      const out = await lookupLyrics({
        title: "I Want to Live",
        artist: "Borislav Slavov",
        album: "Baldur's Gate 3 (Original Game Soundtrack)",
        duration: 233,
      });
      assert.equal(out.found, true);
      assert.match(out.syncedLyrics, /Mock synced lyrics/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("shares one provider request between concurrent lookups", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let release;
    globalThis.fetch = async () => {
      calls += 1;
      await new Promise((resolve) => {
        release = resolve;
      });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            trackName: "Concurrent Test",
            artistName: "PartyQueue",
            duration: 180,
            syncedLyrics: "[00:01.00]Shared lookup",
          };
        },
      };
    };

    try {
      const query = {
        title: "Concurrent Test",
        artist: "PartyQueue",
        album: "Tests",
        duration: 180,
      };
      const first = lookupLyrics(query);
      const second = lookupLyrics(query);
      await Promise.resolve();
      assert.equal(calls, 1);
      release();
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a.found, true);
      assert.deepEqual(a, b);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses Unison synchronized lyrics when LRClib is unavailable", async () => {
    const originalFetch = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (url) => {
      const value = String(url);
      urls.push(value);
      if (value.includes("lrclib.net")) {
        throw new Error("LRClib unavailable");
      }
      if (value.includes("/lyrics/search?")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              success: true,
              data: [
                {
                  id: 42,
                  song: "Fallback Test",
                  artist: "PartyQueue",
                  duration: 182,
                  format: "lrc",
                },
              ],
            };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              id: 42,
              song: "Fallback Test",
              artist: "PartyQueue",
              format: "lrc",
              lyrics: "[by:Test]\n[00:01.00]<00:01.00>Fallback <00:01.50>lyrics",
            },
          };
        },
      };
    };

    try {
      const out = await lookupLyrics({
        title: "Fallback Test",
        artist: "PartyQueue",
        album: "Tests",
        duration: 182,
      });
      assert.equal(out.found, true);
      assert.equal(out.provider, "unison");
      assert.equal(out.syncKind, "line");
      assert.equal(out.syncedLyrics, "[00:01.00]Fallback lyrics");
      assert.equal(out.attribution.text, "Lyrics from Unison");
      assert.equal(urls.filter((url) => url.includes("unison.boidu.dev")).length, 2);

      const cached = await lookupLyrics({
        title: "Fallback Test",
        artist: "PartyQueue",
        album: "Tests",
        duration: 182,
      });
      assert.equal(cached.cached, true);
      assert.equal(cached.provider, "unison");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("prefers Unison synchronized lyrics over LRClib plain lyrics", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes("lrclib.net")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return value.includes("/api/search?")
              ? []
              : { plainLyrics: "LRClib plain lyrics" };
          },
        };
      }
      if (value.includes("/lyrics/search?")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              success: true,
              data: [
                {
                  id: 7,
                  song: "Quality Test",
                  artist: "PartyQueue",
                  format: "lrc",
                },
              ],
            };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              id: 7,
              song: "Quality Test",
              artist: "PartyQueue",
              format: "lrc",
              lyrics: "[00:02.00]Unison synced lyrics",
            },
          };
        },
      };
    };

    try {
      const out = await lookupLyrics({
        title: "Quality Test",
        artist: "PartyQueue",
        album: "Tests",
        duration: 180,
      });
      assert.equal(out.provider, "unison");
      assert.match(out.syncedLyrics, /Unison synced lyrics/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps LRClib plain lyrics when Unison is unavailable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes("/api/get?")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { plainLyrics: "Usable plain lyrics" };
          },
        };
      }
      if (value.includes("/api/search?")) {
        throw new Error("LRClib search unavailable");
      }
      throw new Error("Unison unavailable");
    };

    try {
      const out = await lookupLyrics({
        title: "Partial Test",
        artist: "PartyQueue",
        album: "Tests",
        duration: 180,
      });
      assert.equal(out.found, true);
      assert.equal(out.provider, "lrclib");
      assert.equal(out.syncKind, "plain");
      assert.equal(out.plainLyrics, "Usable plain lyrics");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("backs off independently after both providers become unavailable", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error("upstream unavailable");
    };

    try {
      const query = {
        title: "Provider Failure Test",
        artist: "PartyQueue",
        album: "Tests",
        duration: 181,
      };
      await assert.rejects(lookupLyrics(query), LyricsUnavailableError);
      assert.equal(calls, 3, "LRClib attempts and Unison fallback each run once");

      await assert.rejects(lookupLyrics(query), LyricsUnavailableError);
      assert.equal(calls, 3, "independent backoffs prevent new provider requests");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("warmLyrics is a no-op for empty queries", () => {
    assert.doesNotThrow(() => warmLyrics({ title: "", artist: "" }));
  });
});
