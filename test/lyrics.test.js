import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lookupLyrics, warmLyrics } from "../src/lyrics.js";

describe("lookupLyrics", () => {
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

  it("warmLyrics is a no-op for empty queries", () => {
    assert.doesNotThrow(() => warmLyrics({ title: "", artist: "" }));
  });
});
