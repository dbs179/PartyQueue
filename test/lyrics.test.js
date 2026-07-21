import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LyricsUnavailableError,
  lookupLyrics,
  warmLyrics,
} from "../src/lyrics.js";

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

  it("backs off quickly after the provider becomes unavailable", async () => {
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
      assert.equal(calls, 2, "exact and search attempts share one lookup budget");

      await assert.rejects(lookupLyrics(query), LyricsUnavailableError);
      assert.equal(calls, 2, "backoff prevents another provider request");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("warmLyrics is a no-op for empty queries", () => {
    assert.doesNotThrow(() => warmLyrics({ title: "", artist: "" }));
  });
});
