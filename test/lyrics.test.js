import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lookupLyrics, warmLyrics } from "../src/lyrics.js";

describe("lookupLyrics", () => {
  it("rejects missing title/artist", async () => {
    const out = await lookupLyrics({ title: "", artist: "X" });
    assert.equal(out.found, false);
  });

  it("finds known track via LRClib search", async () => {
    const out = await lookupLyrics({
      title: "I Want to Live",
      artist: "Borislav Slavov",
      album: "Baldur's Gate 3 (Original Game Soundtrack)",
      duration: 233,
    });
    assert.equal(out.found, true);
    assert.ok(out.plainLyrics || out.syncedLyrics);
  });

  it("warmLyrics is a no-op for empty queries", () => {
    assert.doesNotThrow(() => warmLyrics({ title: "", artist: "" }));
  });
});
