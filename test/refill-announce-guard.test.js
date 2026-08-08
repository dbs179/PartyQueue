import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  shouldSuppressRefillAnnounce,
  refillAnnounceGuardTtlMs,
  buildRefillAnnounceGuard,
  clearRefillAnnounceGuard,
  getRefillAnnounceGuard,
  setRefillAnnounceGuardForTests,
  isRefillAnnounceSuppressed,
} from "../src/refill-announce-guard.js";

describe("refill announce guard", () => {
  beforeEach(() => {
    clearRefillAnnounceGuard();
  });

  test("TTL is at least 20 minutes and scales with set size", () => {
    assert.equal(refillAnnounceGuardTtlMs(0), 20 * 60_000);
    assert.equal(refillAnnounceGuardTtlMs(5), 20 * 60_000);
    assert.equal(refillAnnounceGuardTtlMs(6), 24 * 60_000);
  });

  test("buildRefillAnnounceGuard keeps name/artist anchors", () => {
    const guard = buildRefillAnnounceGuard(
      {
        added: 5,
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
    assert.deepEqual(guard.highlights, [
      { name: "Song A", artist: "Artist A" },
      { name: "Song B", artist: "Artist B" },
    ]);
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

  test("shouldSuppress: still-queued highlight blocks announce", () => {
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
        anyHighlightQueued: true,
        now: 1_000 + 60_000,
      }),
      true
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
    });
    assert.equal(suppressed, true);
    assert.ok(getRefillAnnounceGuard());
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
