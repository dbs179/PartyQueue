import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  shouldSuppressRefillAnnounce,
  refillAnnounceGuardTtlMs,
  buildRefillAnnounceGuard,
  clearRefillAnnounceGuard,
  clearRefillAnnounceClipUrl,
  getRefillAnnounceClipUrl,
  getRefillAnnounceGuard,
  setRefillAnnounceClipUrl,
  setRefillAnnounceGuardForTests,
  isRefillAnnounceSuppressed,
  refillSetFlavorChanged,
} from "../src/refill-announce-guard.js";

describe("refill announce guard", () => {
  beforeEach(() => {
    clearRefillAnnounceGuard();
    clearRefillAnnounceClipUrl();
  });

  test("refill clip URL is remembered until cleared", () => {
    assert.equal(getRefillAnnounceClipUrl(), null);
    assert.equal(
      setRefillAnnounceClipUrl("http://partyqueue/media/tts/refill-abc.mp3"),
      "http://partyqueue/media/tts/refill-abc.mp3"
    );
    assert.equal(
      getRefillAnnounceClipUrl(),
      "http://partyqueue/media/tts/refill-abc.mp3"
    );
    clearRefillAnnounceClipUrl();
    assert.equal(getRefillAnnounceClipUrl(), null);
  });

  test("TTL is at least 20 minutes and scales with set size", () => {
    assert.equal(refillAnnounceGuardTtlMs(0), 20 * 60_000);
    assert.equal(refillAnnounceGuardTtlMs(5), 20 * 60_000);
    assert.equal(refillAnnounceGuardTtlMs(6), 24 * 60_000);
  });

  test("buildRefillAnnounceGuard keeps name/artist anchors and set flavor", () => {
    const guard = buildRefillAnnounceGuard(
      {
        added: 5,
        genreLane: "country",
        mood: "80s",
        highlights: [
          { name: "Song A", artist: "Artist A" },
          { name: "", artist: "" },
          { name: "Song B", artist: "Artist B" },
        ],
      },
      1_700_000_000_000
    );
    assert.equal(guard.setSize, 5);
    assert.equal(guard.createdAt, 1_700_000_000_000);
    assert.equal(guard.genreLane, "country");
    assert.equal(guard.mood, "80s");
    assert.deepEqual(guard.highlights, [
      { name: "Song A", artist: "Artist A" },
      { name: "Song B", artist: "Artist B" },
    ]);
  });

  test("refillSetFlavorChanged detects lane or mood changes", () => {
    const guard = buildRefillAnnounceGuard({
      added: 5,
      genreLane: "country",
      mood: "party",
      highlights: [{ name: "A", artist: "B" }],
    });
    assert.equal(refillSetFlavorChanged(guard, "country", "party"), false);
    assert.equal(refillSetFlavorChanged(guard, "hiphop", "party"), true);
    assert.equal(refillSetFlavorChanged(guard, "country", "80s"), true);
    assert.equal(refillSetFlavorChanged(guard, "hiphop", "80s"), true);
    assert.equal(refillSetFlavorChanged(null, "hiphop", "party"), false);
  });

  test("refillSetFlavorChanged treats same-artist as a flavor change", () => {
    const guard = buildRefillAnnounceGuard({
      added: 5,
      genreLane: "rock",
      mood: null,
      sameArtistBatch: { artist: "Foo Fighters", key: "foo fighters" },
      highlights: [{ name: "Run", artist: "Foo Fighters" }],
    });
    assert.equal(guard.sameArtist, "Foo Fighters");
    assert.equal(
      refillSetFlavorChanged(guard, "rock", null, null, "Foo Fighters"),
      false
    );
    assert.equal(refillSetFlavorChanged(guard, "rock", null, null, null), true);
    assert.equal(
      refillSetFlavorChanged(guard, "rock", null, null, "Queen"),
      true
    );
  });

  test("refillSetFlavorChanged treats rotation as a flavor change", () => {
    const guard = buildRefillAnnounceGuard({
      added: 5,
      genreLane: "rock",
      mood: "party",
      rotation: { decade: "80's", mood: null },
      highlights: [{ name: "A", artist: "B" }],
    });
    assert.equal(guard.rotation, "80's");
    assert.equal(
      refillSetFlavorChanged(guard, "rock", "party", null, null, "80's"),
      false
    );
    assert.equal(
      refillSetFlavorChanged(guard, "rock", "party", null, null, null),
      false,
      "same-set top-up after a rotate is not a new flavor"
    );
    assert.equal(
      refillSetFlavorChanged(guard, "rock", "party", null, null, "90's"),
      true
    );
    const plain = buildRefillAnnounceGuard({
      added: 5,
      genreLane: "rock",
      mood: "party",
      highlights: [{ name: "A", artist: "B" }],
    });
    assert.equal(
      refillSetFlavorChanged(plain, "rock", "party", null, null, "80's"),
      true,
      "a new rotate on an unlabeled guard must announce"
    );
  });

  test("refillSetFlavorChanged treats reactionSet as a flavor change", () => {
    const guard = buildRefillAnnounceGuard({
      added: 5,
      genreLane: null,
      mood: null,
      reactionSet: { kind: "loved" },
      highlights: [{ name: "A", artist: "B" }],
    });
    assert.equal(guard.reactionSet, "loved");
    assert.equal(refillSetFlavorChanged(guard, null, null, "loved"), false);
    assert.equal(refillSetFlavorChanged(guard, null, null, "hated"), true);
    assert.equal(refillSetFlavorChanged(guard, null, null, null), true);
  });

  test("shouldSuppress: no guard allows announce", () => {
    assert.equal(
      shouldSuppressRefillAnnounce({
        guard: null,
        anyHighlightQueued: true,
      }),
      false
    );
  });

  test("shouldSuppress: still-queued highlight blocks same-set announce", () => {
    const guard = buildRefillAnnounceGuard(
      {
        added: 5,
        genreLane: "country",
        mood: "party",
        highlights: [{ name: "Song A", artist: "Artist A" }],
      },
      1_000
    );
    assert.equal(
      shouldSuppressRefillAnnounce({
        guard,
        anyHighlightQueued: true,
        now: 1_000 + 60_000,
        nextGenreLane: "country",
        nextMood: "party",
      }),
      true
    );
  });

  test("shouldSuppress: lane change allows announce even if highlight queued", () => {
    const guard = buildRefillAnnounceGuard(
      {
        added: 5,
        genreLane: "country",
        mood: "party",
        highlights: [{ name: "Song A", artist: "Artist A" }],
      },
      1_000
    );
    assert.equal(
      shouldSuppressRefillAnnounce({
        guard,
        anyHighlightQueued: true,
        now: 1_000 + 60_000,
        nextGenreLane: "hiphop",
        nextMood: "party",
      }),
      false
    );
  });

  test("shouldSuppress: same-set top-up after a rotate stays silent", () => {
    const guard = buildRefillAnnounceGuard(
      {
        added: 5,
        genreLane: "rock",
        mood: "80s",
        rotation: { decade: "80's", mood: null },
        highlights: [{ name: "Song A", artist: "Artist A" }],
      },
      1_000
    );
    assert.equal(
      shouldSuppressRefillAnnounce({
        guard,
        anyHighlightQueued: true,
        now: 1_000 + 60_000,
        nextGenreLane: "rock",
        nextMood: "80s",
        nextRotation: null,
      }),
      true
    );
    assert.equal(
      shouldSuppressRefillAnnounce({
        guard,
        anyHighlightQueued: true,
        now: 1_000 + 60_000,
        nextGenreLane: "rock",
        nextMood: "80s",
        nextRotation: "90's",
      }),
      false
    );
  });

  test("shouldSuppress: mood change allows announce even if highlight queued", () => {
    const guard = buildRefillAnnounceGuard(
      {
        added: 5,
        genreLane: "rock",
        mood: "80s",
        highlights: [{ name: "Song A", artist: "Artist A" }],
      },
      1_000
    );
    assert.equal(
      shouldSuppressRefillAnnounce({
        guard,
        anyHighlightQueued: true,
        now: 1_000 + 60_000,
        nextGenreLane: "rock",
        nextMood: "90s",
      }),
      false
    );
  });

  test("shouldSuppress: consumed set allows announce", () => {
    const guard = buildRefillAnnounceGuard(
      {
        added: 5,
        highlights: [{ name: "Song A", artist: "Artist A" }],
      },
      1_000
    );
    assert.equal(
      shouldSuppressRefillAnnounce({
        guard,
        anyHighlightQueued: false,
        now: 1_000 + 60_000,
      }),
      false
    );
  });

  test("shouldSuppress: expired TTL allows announce", () => {
    const guard = buildRefillAnnounceGuard(
      {
        added: 5,
        highlights: [{ name: "Song A", artist: "Artist A" }],
      },
      1_000
    );
    const ttl = refillAnnounceGuardTtlMs(5);
    assert.equal(
      shouldSuppressRefillAnnounce({
        guard,
        anyHighlightQueued: true,
        now: 1_000 + ttl,
      }),
      false
    );
  });

  test("shouldSuppress: highlight-less guard uses TTL window only", () => {
    const guard = buildRefillAnnounceGuard({ added: 5, highlights: [] }, 1_000);
    assert.equal(
      shouldSuppressRefillAnnounce({
        guard,
        anyHighlightQueued: false,
        now: 1_000 + 60_000,
      }),
      true
    );
    assert.equal(
      shouldSuppressRefillAnnounce({
        guard,
        anyHighlightQueued: false,
        now: 1_000 + refillAnnounceGuardTtlMs(5),
      }),
      false
    );
  });

  test("isRefillAnnounceSuppressed: still upcoming → suppress", async () => {
    setRefillAnnounceGuardForTests(
      buildRefillAnnounceGuard(
        {
          added: 5,
          genreLane: "country",
          mood: "party",
          highlights: [
            { name: "Keep Me", artist: "Band" },
            { name: "Gone", artist: "Band" },
          ],
        },
        Date.now()
      )
    );
    const suppressed = await isRefillAnnounceSuppressed({
      findUpcoming: async ({ name }) => (name === "Keep Me" ? 3 : null),
      nextSummary: { genreLane: "country", mood: "party" },
    });
    assert.equal(suppressed, true);
    assert.ok(getRefillAnnounceGuard());
  });

  test("isRefillAnnounceSuppressed: lane change allows and clears", async () => {
    setRefillAnnounceGuardForTests(
      buildRefillAnnounceGuard(
        {
          added: 5,
          genreLane: "country",
          mood: "party",
          highlights: [{ name: "Keep Me", artist: "Band" }],
        },
        Date.now()
      )
    );
    const suppressed = await isRefillAnnounceSuppressed({
      findUpcoming: async () => 2,
      nextSummary: { genreLane: "hiphop", mood: "party" },
    });
    assert.equal(suppressed, false);
    assert.equal(getRefillAnnounceGuard(), null);
  });

  test("isRefillAnnounceSuppressed: none upcoming → allow and clear", async () => {
    setRefillAnnounceGuardForTests(
      buildRefillAnnounceGuard(
        {
          added: 5,
          highlights: [{ name: "Gone", artist: "Band" }],
        },
        Date.now()
      )
    );
    const suppressed = await isRefillAnnounceSuppressed({
      findUpcoming: async () => null,
    });
    assert.equal(suppressed, false);
    assert.equal(getRefillAnnounceGuard(), null);
  });

  test("isRefillAnnounceSuppressed: TTL expiry clears guard", async () => {
    const createdAt = 1_000;
    setRefillAnnounceGuardForTests(
      buildRefillAnnounceGuard(
        {
          added: 5,
          highlights: [{ name: "Keep Me", artist: "Band" }],
        },
        createdAt
      )
    );
    const suppressed = await isRefillAnnounceSuppressed({
      findUpcoming: async () => 2,
      now: createdAt + refillAnnounceGuardTtlMs(5),
    });
    assert.equal(suppressed, false);
    assert.equal(getRefillAnnounceGuard(), null);
  });

  test("building a guard snapshot does not install module state", () => {
    // scheduleRefillAnnounce only installs after result.ok; failed enqueue
    // must leave the module guard unset.
    clearRefillAnnounceGuard();
    buildRefillAnnounceGuard({
      added: 5,
      highlights: [{ name: "Song A", artist: "Artist A" }],
    });
    assert.equal(getRefillAnnounceGuard(), null);
  });
});
