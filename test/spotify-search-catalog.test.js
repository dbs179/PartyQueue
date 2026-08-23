import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

describe("Spotify searchCatalog", () => {
  /** @type {typeof fetch} */
  let originalFetch;
  /** @type {typeof import("../src/spotify.js")} */
  let spotify;
  let searchUrls;

  before(async () => {
    originalFetch = globalThis.fetch;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pq-spotify-catalog-"));
    process.env.PARTYQUEUE_SPOTIFY_TOKENS_FILE = path.join(dir, "tokens.json");
    process.env.PARTYQUEUE_SPOTIFY_CACHE_FILE = path.join(dir, "cache.json");
    process.env.SPOTIFY_CLIENT_ID = "test-client-id";
    process.env.SPOTIFY_CLIENT_SECRET = "test-client-secret";
    process.env.SPOTIFY_MARKET = "US";
    spotify = await import(`../src/spotify.js?catalog-test=${Date.now()}`);
  });

  after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
    delete process.env.SPOTIFY_MARKET;
  });

  beforeEach(() => {
    searchUrls = [];
    spotify.resetSpotifyNetworkStateForTests();
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("accounts.spotify.com/api/token")) {
        return jsonRes({
          access_token: "tok",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (u.includes("api.spotify.com/v1/search")) {
        searchUrls.push(u);
        return jsonRes({
          tracks: {
            items: [
              {
                uri: "spotify:track:1",
                name: "Song",
                artists: [{ name: "A" }],
                album: {
                  name: "Al",
                  images: [
                    { url: "http://i/640.jpg", width: 640 },
                    { url: "http://i/300.jpg", width: 300 },
                    { url: "http://i/64.jpg", width: 64 },
                  ],
                },
                duration_ms: 1000,
                explicit: false,
              },
            ],
          },
          artists: {
            items: [
              {
                id: "art1",
                name: "Artist",
                images: [{ url: "http://a/64.jpg", width: 64 }],
                popularity: 70,
              },
            ],
          },
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    };
  });

  it("uses one Spotify search for tracks and artists", async () => {
    const { tracks, artists } = await spotify.searchCatalog("neon");
    assert.equal(searchUrls.length, 1);
    assert.match(searchUrls[0], /type=track%2Cartist|type=track,artist/);
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].name, "Song");
    assert.equal(tracks[0].image, "http://i/64.jpg");
    assert.equal(artists.length, 1);
    assert.equal(artists[0].id, "art1");
  });

  it("serves a repeat query from cache without another Spotify search", async () => {
    await spotify.searchCatalog("neon");
    const again = await spotify.searchCatalog("neon");
    assert.equal(searchUrls.length, 1);
    assert.equal(again.tracks[0].name, "Song");
    assert.equal(again.artists[0].name, "Artist");
  });
});
