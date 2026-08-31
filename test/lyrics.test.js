import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LyricsUnavailableError,
  lookupLyrics,
  normalizeLrc,
  pickBestSearchHit,
  fitLyricsToDuration,
  resetLyricsStateForTests,
  warmLyrics,
} from "../src/lyrics.js";
import { lookupUnisonLyrics } from "../src/unison-lyrics.js";
import { lookupOvhLyrics } from "../src/ovh-lyrics.js";
import {
  artistCreditVariants,
  artistLookupVariants,
  titleLookupVariants,
} from "../src/lyrics-variants.js";

it("normalizes common LRC timestamp and enhanced-word variants", () => {
  assert.equal(
    normalizeLrc("[ar:Artist]\n[00:01:50][00:03.25]<00:01.50>Hello"),
    "[00:01.50][00:03.25]Hello"
  );
});

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
  };
}

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
      const value = String(url);
      if (value.includes("unison.boidu.dev") || value.includes("lyrics.ovh")) {
        return jsonResponse({ success: true, data: [] });
      }
      const isSearch = value.includes("/api/search?");
      return jsonResponse(
        isSearch
          ? [
              {
                trackName: "I Want to Live",
                artistName: "Borislav Slavov",
                duration: 233,
                syncedLyrics: "[00:01.00]Mock synced lyrics",
              },
            ]
          : {
              trackName: "I Want to Live",
              artistName: "Borislav Slavov",
              duration: 233,
              plainLyrics: "Mock plain lyrics",
            }
      );
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
    let gate = Promise.resolve();
    let releaseGate;
    gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    globalThis.fetch = async (url) => {
      calls += 1;
      await gate;
      const value = String(url);
      if (value.includes("unison.boidu.dev")) {
        // Direct miss without forcing a second hung search request.
        if (value.includes("/lyrics/search")) {
          return jsonResponse({ success: true, data: [] });
        }
        return jsonResponse({ success: true, data: null });
      }
      if (value.includes("lyrics.ovh")) {
        return jsonResponse({}, 404);
      }
      return jsonResponse({
        trackName: "Concurrent Test",
        artistName: "PartyQueue",
        duration: 180,
        syncedLyrics: "[00:01.00]Shared lookup",
      });
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
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(calls >= 1);
      releaseGate();
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a.found, true);
      assert.deepEqual(a, b);
      const callsAfterShared = calls;
      // A third lookup after settle should hit cache, not providers.
      const cached = await lookupLyrics(query);
      assert.equal(cached.cached, true);
      assert.equal(calls, callsAfterShared);
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
      if (value.includes("lyrics.ovh")) {
        return jsonResponse({}, 404);
      }
      if (value.includes("/lyrics?") && !value.includes("/lyrics/search")) {
        return jsonResponse({
          success: true,
          data: {
            id: 42,
            song: "Fallback Test",
            artist: "PartyQueue",
            format: "lrc",
            lyrics: "[by:Test]\n[00:01.00]<00:01.00>Fallback <00:01.50>lyrics",
          },
        });
      }
      return jsonResponse({ success: true, data: [] });
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
      assert.ok(urls.some((url) => url.includes("unison.boidu.dev/lyrics?")));

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

  it("returns found false when Unison misses and LRClib is down", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes("lrclib.net")) throw new Error("LRClib down");
      if (value.includes("lyrics.ovh")) return jsonResponse({}, 404);
      if (value.includes("unison.boidu.dev")) {
        if (value.includes("/lyrics/search")) {
          return jsonResponse({ success: true, data: [] });
        }
        return jsonResponse({ success: false }, 404);
      }
      throw new Error(`unexpected ${value}`);
    };

    try {
      const out = await lookupLyrics({
        title: "Missing Everywhere",
        artist: "PartyQueue",
        album: "Tests",
        duration: 180,
      });
      assert.equal(out.found, false);
      assert.equal(out.degraded, true);
      assert.equal(out.cached, undefined);
      const again = await lookupLyrics({
        title: "Missing Everywhere",
        artist: "PartyQueue",
        album: "Tests",
        duration: 180,
      });
      assert.equal(again.cached, undefined, "degraded misses must not be cached");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("prefers Unison synchronized lyrics over LRClib plain lyrics", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes("lrclib.net")) {
        return jsonResponse(
          value.includes("/api/search?")
            ? []
            : { plainLyrics: "LRClib plain lyrics" }
        );
      }
      if (value.includes("lyrics.ovh")) return jsonResponse({}, 404);
      if (value.includes("/lyrics?") && !value.includes("/lyrics/search")) {
        return jsonResponse({
          success: true,
          data: {
            id: 7,
            song: "Quality Test",
            artist: "PartyQueue",
            format: "lrc",
            lyrics: "[00:02.00]Unison synced lyrics",
          },
        });
      }
      return jsonResponse({ success: true, data: [] });
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
      if (value.includes("/api/search?")) {
        return jsonResponse([
          {
            trackName: "Partial Test",
            artistName: "PartyQueue",
            plainLyrics: "Usable plain lyrics",
          },
        ]);
      }
      if (value.includes("/api/get?")) {
        return jsonResponse({ plainLyrics: "Usable plain lyrics" });
      }
      if (value.includes("unison.boidu.dev")) {
        throw new Error("Unison unavailable");
      }
      if (value.includes("lyrics.ovh")) return jsonResponse({}, 404);
      throw new Error(`unexpected ${value}`);
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

  it("uses lyrics.ovh plain text when LRClib and Unison miss", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes("lrclib.net")) {
        return jsonResponse(value.includes("/api/search?") ? [] : null, 404);
      }
      if (value.includes("unison.boidu.dev")) {
        return jsonResponse({ success: true, data: [] }, value.includes("/lyrics?") ? 404 : 200);
      }
      if (value.includes("lyrics.ovh")) {
        return jsonResponse({ lyrics: "Plain from ovh\nSecond line" });
      }
      throw new Error(`unexpected ${value}`);
    };

    try {
      const out = await lookupLyrics({
        title: "Ovh Track",
        artist: "PartyQueue",
        album: "Tests",
        duration: 200,
      });
      assert.equal(out.found, true);
      assert.equal(out.provider, "lyrics.ovh");
      assert.equal(out.syncKind, "plain");
      assert.match(out.plainLyrics, /Plain from ovh/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("backs off independently after providers become unavailable", async () => {
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
      const firstPassCalls = calls;
      assert.ok(firstPassCalls >= 3, "LRClib, Unison, and ovh each attempt once");

      await assert.rejects(lookupLyrics(query), LyricsUnavailableError);
      assert.equal(
        calls,
        firstPassCalls,
        "provider backoffs prevent new upstream requests"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("warmLyrics failure does not cache a poison entry for the track", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("warm upstream down");
    };

    try {
      const query = {
        title: "Warm Recover",
        artist: "PartyQueue",
        album: "Tests",
        duration: 190,
      };
      warmLyrics(query);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Warm must not write a cached miss/busy result. After clearing only
      // provider backoffs (via test reset), a healthy lookup can succeed.
      resetLyricsStateForTests();
      globalThis.fetch = async (url) => {
        const value = String(url);
        if (value.includes("lrclib.net") && value.includes("/api/search?")) {
          return jsonResponse([
            {
              trackName: "Warm Recover",
              artistName: "PartyQueue",
              syncedLyrics: "[00:01.00]Recovered",
            },
          ]);
        }
        if (value.includes("unison.boidu.dev") || value.includes("lyrics.ovh")) {
          return jsonResponse({ success: true, data: [] }, 404);
        }
        return jsonResponse({ syncedLyrics: "[00:01.00]Recovered" });
      };
      const out = await lookupLyrics(query);
      assert.equal(out.found, true);
      assert.match(out.syncedLyrics, /Recovered/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("warmLyrics is a no-op for empty queries", () => {
    assert.doesNotThrow(() => warmLyrics({ title: "", artist: "" }));
  });

  it("re-picks lyrics once duration arrives after a duration-blind cache", async () => {
    const originalFetch = globalThis.fetch;
    let searches = 0;
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes("unison.boidu.dev") || value.includes("lyrics.ovh")) {
        return jsonResponse({ success: true, data: [] }, 404);
      }
      if (value.includes("/api/search?")) {
        searches += 1;
        return jsonResponse([
          {
            trackName: "Maps",
            artistName: "Yeah Yeah Yeahs",
            albumName: "Fever To Tell (Deluxe Remastered)",
            duration: 259,
            syncedLyrics: "[00:59.75]Pack up\n[03:24.42]Wait",
            plainLyrics: "Pack up",
          },
          {
            trackName: "Maps",
            artistName: "Yeah Yeah Yeahs",
            albumName: "Fever To Tell (Deluxe Remastered)",
            duration: 220,
            syncedLyrics: "[00:29.48]Pack up\n[02:53.82]Wait",
            plainLyrics: "Pack up",
          },
        ]);
      }
      return jsonResponse(null, 404);
    };

    try {
      const base = {
        title: "Maps",
        artist: "Yeah Yeah Yeahs",
        album: "Fever To Tell (Deluxe Remastered)",
        uri: "spotify:track:maps-test",
      };
      const blind = await lookupLyrics(base);
      assert.equal(blind.found, true);
      assert.match(blind.syncedLyrics, /00:29\.48/);
      const firstSearches = searches;

      const cachedBlind = await lookupLyrics(base);
      assert.equal(cachedBlind.cached, true);
      assert.equal(searches, firstSearches);

      const timed = await lookupLyrics({ ...base, duration: 220 });
      assert.equal(timed.found, true);
      assert.match(timed.syncedLyrics, /00:29\.48/);
      assert.ok(searches > firstSearches, "duration-aware lookup bypasses provisional cache");
      assert.equal(timed.cached, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("upgrades plain lyrics to synced when a featuring artist credit hid the hit", async () => {
    const originalFetch = globalThis.fetch;
    const lrclibSearches = [];
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes("unison.boidu.dev")) {
        if (value.includes("/lyrics/search")) {
          return jsonResponse({ success: true, data: [] });
        }
        return jsonResponse({ success: false }, 404);
      }
      if (value.includes("lyrics.ovh")) return jsonResponse({}, 404);
      if (value.includes("/api/search?")) {
        const decoded = decodeURIComponent(value).replace(/\+/g, " ");
        lrclibSearches.push(decoded);
        if (decoded.includes("artist_name=Dr. Dre feat. Eminem")) {
          return jsonResponse([
            {
              trackName: "Forgot About Dre",
              artistName: "Dr. Dre feat. Eminem",
              duration: 222,
              plainLyrics: "Y'all know me, still the same OG",
            },
          ]);
        }
        if (
          decoded.includes("artist_name=Dr. Dre&") ||
          decoded.endsWith("artist_name=Dr. Dre")
        ) {
          return jsonResponse([
            {
              trackName: "Forgot About Dre",
              artistName: "Dr. Dre",
              duration: 222,
              syncedLyrics: "[00:12.00]Y'all know me, still the same OG",
              plainLyrics: "Y'all know me, still the same OG",
            },
          ]);
        }
        return jsonResponse([]);
      }
      return jsonResponse(null, 404);
    };

    try {
      const out = await lookupLyrics({
        title: "Forgot About Dre",
        artist: "Dr. Dre feat. Eminem",
        duration: 222,
      });
      assert.equal(out.found, true);
      assert.equal(out.provider, "lrclib");
      assert.equal(out.syncKind, "line");
      assert.match(out.syncedLyrics, /Y'all know me/);
      assert.ok(
        lrclibSearches.some((u) => u.includes("Dr. Dre feat. Eminem")),
        "featuring credit is tried first"
      );
      assert.ok(
        lrclibSearches.some(
          (u) =>
            (u.includes("artist_name=Dr. Dre&") ||
              u.endsWith("artist_name=Dr. Dre")) &&
            !u.includes("feat")
        ),
        "primary artist is retried for synced lyrics"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries with a cleaned title when the decorated Spotify title misses", async () => {
    const originalFetch = globalThis.fetch;
    const lrclibSearches = [];
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes("unison.boidu.dev")) {
        if (value.includes("/lyrics/search")) {
          return jsonResponse({ success: true, data: [] });
        }
        return jsonResponse({ success: false }, 404);
      }
      if (value.includes("lyrics.ovh")) return jsonResponse({}, 404);
      if (value.includes("/api/search?")) {
        lrclibSearches.push(decodeURIComponent(value).replace(/\+/g, " "));
        // Providers only index the plain title.
        if (value.includes("Remastered")) return jsonResponse([]);
        return jsonResponse([
          {
            trackName: "Peaches",
            artistName: "The Presidents of the United States of America",
            duration: 172,
            plainLyrics: "Movin' to the country",
          },
        ]);
      }
      return jsonResponse(null, 404);
    };

    try {
      const query = {
        title: "Peaches - Remastered",
        artist: "The Presidents of the United States of America",
        duration: 172,
      };
      const out = await lookupLyrics(query);
      assert.equal(out.found, true);
      assert.equal(out.provider, "lrclib");
      assert.match(out.plainLyrics, /Movin' to the country/);
      assert.ok(
        lrclibSearches.some((u) => u.includes("track_name=Peaches - Remastered")),
        "original title is tried first"
      );
      assert.ok(
        lrclibSearches.some(
          (u) => u.includes("track_name=Peaches&") || u.endsWith("track_name=Peaches")
        ),
        "cleaned title is retried"
      );

      // The decorated query itself is now cached — no extra provider calls.
      const callsBefore = lrclibSearches.length;
      const cached = await lookupLyrics(query);
      assert.equal(cached.cached, true);
      assert.equal(cached.found, true);
      assert.equal(lrclibSearches.length, callsBefore);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("lookupUnisonLyrics", () => {
  it("treats direct 404 then empty search as a miss", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes("/lyrics/search")) {
        return jsonResponse({ success: true, data: [] });
      }
      return jsonResponse({ success: false }, 404);
    };
    try {
      const out = await lookupUnisonLyrics(
        { title: "Gone", artist: "Nobody" },
        { deadline: Date.now() + 5_000, userAgent: "PartyQueue/test" }
      );
      assert.equal(out.found, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts enhanced_lrc payloads via direct get", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      jsonResponse({
        success: true,
        data: {
          song: "Enhanced",
          artist: "PartyQueue",
          format: "enhanced_lrc",
          lyrics: "[00:01.00]<00:01.20>Hello",
        },
      });
    try {
      const out = await lookupUnisonLyrics(
        { title: "Enhanced", artist: "PartyQueue" },
        { deadline: Date.now() + 5_000, userAgent: "PartyQueue/test" }
      );
      assert.equal(out.found, true);
      assert.equal(out.syncedLyrics, "[00:01.00]Hello");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("artistCreditVariants", () => {
  it("strips featuring credits down to the primary artist", () => {
    assert.deepEqual(artistCreditVariants("Dr. Dre feat. Eminem"), [
      "Dr. Dre feat. Eminem",
      "Dr. Dre",
    ]);
    assert.ok(
      artistCreditVariants("Dr. Dre, Eminem").includes("Dr. Dre")
    );
    assert.ok(
      artistCreditVariants("Dr. Dre & Eminem").includes("Dr. Dre")
    );
  });

  it("keeps duo/band names with & as the first attempt", () => {
    const variants = artistCreditVariants("Simon & Garfunkel");
    assert.equal(variants[0], "Simon & Garfunkel");
  });

  it("does not carve up Earth, Wind & Fire", () => {
    const variants = artistCreditVariants("Earth, Wind & Fire");
    assert.equal(variants[0], "Earth, Wind & Fire");
    assert.ok(!variants.includes("Earth"));
  });
});

describe("titleLookupVariants", () => {
  it("strips Spotify dash suffixes as a fallback variant", () => {
    assert.deepEqual(titleLookupVariants("Peaches - Remastered"), [
      "Peaches - Remastered",
      "Peaches",
    ]);
    assert.deepEqual(titleLookupVariants("Peaches - Remastered 2004"), [
      "Peaches - Remastered 2004",
      "Peaches",
    ]);
  });

  it("strips keyword-bearing trailing parentheticals", () => {
    const variants = titleLookupVariants("Peaches (Remastered)");
    assert.equal(variants[0], "Peaches (Remastered)");
    assert.ok(variants.includes("Peaches"));
    assert.ok(
      titleLookupVariants("Umbrella (feat. JAY-Z)").includes("Umbrella")
    );
  });

  it("keeps legit parentheticals and plain titles unchanged", () => {
    assert.deepEqual(titleLookupVariants("Time (Clock of the Heart)"), [
      "Time (Clock of the Heart)",
    ]);
    assert.deepEqual(titleLookupVariants("Peaches"), ["Peaches"]);
  });
});

describe("artistLookupVariants", () => {
  it("expands punctuated band names providers often rewrite", () => {
    const variants = artistLookupVariants("Sixx:A.M.");
    assert.equal(variants[0], "Sixx:A.M.");
    assert.ok(variants.includes("Sixx A.M."));
    assert.ok(variants.includes("Sixx AM"));
    assert.ok(
      variants.indexOf("Sixx AM") < variants.indexOf("SixxAM"),
      "spaced cleanup should be tried before compacted forms"
    );
  });
});

describe("lookupOvhLyrics", () => {
  it("returns plain lyrics", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      jsonResponse({ lyrics: "Line one\r\nLine two" });
    try {
      const out = await lookupOvhLyrics(
        { title: "Song", artist: "Artist" },
        { deadline: Date.now() + 5_000 }
      );
      assert.equal(out.found, true);
      assert.equal(out.plainLyrics, "Line one\nLine two");
      assert.equal(out.provider, "lyrics.ovh");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries artist punctuation variants after a miss", async () => {
    const originalFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      if (String(url).includes("Sixx%20AM")) {
        return jsonResponse({ lyrics: "Then everything went to hell" });
      }
      return jsonResponse({ error: "No lyrics found" });
    };
    try {
      const out = await lookupOvhLyrics(
        { title: "Everything Went To Hell", artist: "Sixx:A.M." },
        { deadline: Date.now() + 5_000 }
      );
      assert.equal(out.found, true);
      assert.match(out.plainLyrics, /everything went to hell/i);
      assert.ok(seen.length >= 2);
      assert.ok(seen.some((url) => url.includes("Sixx%20AM")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

it("prefers synced lyrics that fit the playing duration over a closer duration label", () => {
  const volume1 = {
    trackName: "The Dreamer",
    albumName: "Volume 1",
    duration: 230,
    syncedLyrics: "[00:26.28]I'm so god damn tired of whistling\n[03:59.08]And I'll lay by your side",
  };
  const otherMix = {
    trackName: "The Dreamer",
    albumName: "Diggers",
    duration: 231,
    syncedLyrics: "[00:21.39]I'm so god damn tired of whistling\n[03:43.85]And I'll lay by your side",
  };
  const picked = pickBestSearchHit([volume1, otherMix], 229);
  assert.equal(picked, otherMix);
});

it("picks the on-time Maps mix over a Deluxe search hit that starts 30s late", () => {
  const lateDeluxe = {
    trackName: "Maps",
    artistName: "Yeah Yeah Yeahs",
    albumName: "Fever To Tell (Deluxe Remastered)",
    duration: 259,
    syncedLyrics: "[00:59.75]Pack up\n[03:24.42]Wait, they don't love you like I love you",
    plainLyrics: "Pack up",
  };
  const onTime = {
    trackName: "Maps",
    artistName: "Yeah Yeah Yeahs",
    albumName: "Fever To Tell (Deluxe Remastered)",
    duration: 220,
    syncedLyrics: "[00:29.48]Pack up\n[02:53.82]Wait, they don't love you like I love you",
    plainLyrics: "Pack up",
  };
  const compilation = {
    trackName: "Maps",
    artistName: "Yeah Yeah Yeahs",
    albumName: "00s Mixtape Vol. 1",
    duration: 214,
    syncedLyrics: "[00:29.48]Pack up\n[02:58.16]Wait, they don't love you like I love you",
    plainLyrics: "Pack up",
  };
  const album = "Fever To Tell (Deluxe Remastered)";
  assert.equal(
    pickBestSearchHit([lateDeluxe, onTime, compilation], 220, album),
    onTime
  );
  // Duration-blind overlay used to follow LRClib order (the 0:59 file).
  assert.equal(
    pickBestSearchHit([lateDeluxe, onTime, compilation], null, album),
    onTime
  );
  assert.equal(
    pickBestSearchHit([lateDeluxe, onTime], null, album),
    onTime
  );
});

it("prefers duration-matched plain Folsom lyrics over a 170s studio karaoke file", () => {
  const studioSynced = {
    trackName: "Folsom Prison Blues",
    artistName: "Johnny Cash",
    albumName: "The Essential Johnny Cash",
    duration: 170,
    syncedLyrics:
      "[00:04.80]I hear the train a-coming'\n[02:45.87]On down to San Antone",
    plainLyrics: "I hear the train a-coming'",
  };
  const albumPlain = {
    trackName: "Folsom Prison Blues",
    artistName: "Johnny Cash",
    albumName: "I Walk the Line",
    duration: 156,
    plainLyrics: "I hear the train a comin'",
  };
  const junkDuration = {
    trackName: "Folsom Prison Blues",
    artistName: "Johnny Cash",
    albumName: "I Walk the Line",
    duration: 2,
    syncedLyrics:
      "[00:04.80]I hear the train a-coming'\n[02:36.79]On down to San Antone",
    plainLyrics: "I hear the train a-coming'",
  };
  const picked = pickBestSearchHit(
    [junkDuration, studioSynced, albumPlain],
    156,
    "I Walk the Line"
  );
  assert.equal(picked, albumPlain);

  const stripped = fitLyricsToDuration(
    {
      found: true,
      syncedLyrics: studioSynced.syncedLyrics,
      plainLyrics: studioSynced.plainLyrics,
      duration: 170,
      syncKind: "line",
    },
    156
  );
  assert.equal(stripped.syncKind, "plain");
  assert.equal(stripped.syncedLyrics, "");
  assert.match(stripped.plainLyrics, /train/);
});
