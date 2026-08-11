import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Mock fetch that never resolves unless AbortSignal fires (real fetch behavior). */
function hungFetch(_url, opts = {}) {
  return new Promise((_resolve, reject) => {
    const signal = opts.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        reject(new DOMException("The operation was aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

describe("Spotify fetch timeouts", () => {
  /** @type {typeof fetch} */
  let originalFetch;
  /** @type {typeof import("../src/spotify.js")} */
  let spotify;

  before(async () => {
    originalFetch = globalThis.fetch;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pq-spotify-timeout-"));
    process.env.PARTYQUEUE_SPOTIFY_TOKENS_FILE = path.join(dir, "tokens.json");
    process.env.PARTYQUEUE_SPOTIFY_CACHE_FILE = path.join(dir, "cache.json");
    process.env.PARTYQUEUE_SPOTIFY_FETCH_TIMEOUT_MS = "40";
    process.env.SPOTIFY_CLIENT_ID = "test-client-id";
    process.env.SPOTIFY_CLIENT_SECRET = "test-client-secret";
    // Fresh module so SPOTIFY_FETCH_TIMEOUT_MS is picked up at load.
    spotify = await import(`../src/spotify.js?timeout-test=${Date.now()}`);
    assert.equal(spotify.SPOTIFY_FETCH_TIMEOUT_MS, 40);
  });

  after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.PARTYQUEUE_SPOTIFY_FETCH_TIMEOUT_MS;
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
  });

  beforeEach(() => {
    spotify.resetSpotifyNetworkStateForTests();
  });

  it("client-credentials path rejects when fetch never settles", async () => {
    globalThis.fetch = hungFetch;
    const started = Date.now();
    await assert.rejects(
      spotify.searchTracks("never settles"),
      /Spotify request timed out/
    );
    assert.ok(Date.now() - started < 500);
  });

  it("clears single-flight so a later call can succeed", async () => {
    globalThis.fetch = hungFetch;
    await assert.rejects(spotify.searchTracks("hang"), /timed out/);

    spotify.resetSpotifyNetworkStateForTests();

    globalThis.fetch = async (url) => {
      if (String(url).includes("/api/token")) {
        return new Response(
          JSON.stringify({
            access_token: "tok-after-hang",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ tracks: { items: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const tracks = await spotify.searchTracks("ok after hang");
    assert.deepEqual(tracks, []);
  });
});
