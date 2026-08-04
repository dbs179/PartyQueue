import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pq-pool-swr-"));
const cacheFile = path.join(tmpDir, "spotify-cache.json");
const tokensFile = path.join(tmpDir, "spotify-tokens.json");

// Expired pool on disk — SWR must return it without waiting on Spotify.
fs.writeFileSync(
  cacheFile,
  JSON.stringify({
    playlists: [{ id: "pl1", name: "Hits" }],
    playlistsBuiltAt: Date.now() - 48 * 60 * 60_000,
    pool: [
      {
        id: "pl1",
        name: "Hits",
        tracks: [
          {
            uri: "spotify:track:aaa111",
            name: "Song A",
            artist: "Artist A",
            explicit: false,
            year: 1999,
          },
        ],
      },
    ],
    poolBuiltAt: Date.now() - 48 * 60 * 60_000,
    poolVersion: 2,
    rateLimitedUntil: 0,
  })
);
// No refresh token → isUserConnected() is false → no background Spotify sweep.
fs.writeFileSync(tokensFile, JSON.stringify({}));

test("buildPlaylistPool serves a stale disk pool immediately (SWR)", async (t) => {
  t.after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    delete process.env.PARTYQUEUE_SPOTIFY_CACHE_FILE;
    delete process.env.PARTYQUEUE_SPOTIFY_TOKENS_FILE;
  });

  const prevRefresh = process.env.SPOTIFY_REFRESH_TOKEN;
  delete process.env.SPOTIFY_REFRESH_TOKEN;
  process.env.PARTYQUEUE_SPOTIFY_CACHE_FILE = cacheFile;
  process.env.PARTYQUEUE_SPOTIFY_TOKENS_FILE = tokensFile;

  const modUrl =
    pathToFileURL(path.resolve("src/spotify.js")).href +
    `?swr=${Date.now()}`;
  const spotify = await import(modUrl);

  const started = Date.now();
  const pool = await spotify.buildPlaylistPool();
  const elapsed = Date.now() - started;

  assert.equal(pool.length, 1);
  assert.equal(pool[0].id, "pl1");
  assert.equal(pool[0].tracks[0].uri, "spotify:track:aaa111");
  assert.ok(elapsed < 500, `SWR took too long: ${elapsed}ms`);

  spotify.stopPoolRewarmLoopForTests();
  if (prevRefresh != null) process.env.SPOTIFY_REFRESH_TOKEN = prevRefresh;
});

test("startPoolRewarmLoop is idempotent", async () => {
  process.env.PARTYQUEUE_SPOTIFY_CACHE_FILE = cacheFile;
  process.env.PARTYQUEUE_SPOTIFY_TOKENS_FILE = tokensFile;
  delete process.env.SPOTIFY_REFRESH_TOKEN;
  const modUrl =
    pathToFileURL(path.resolve("src/spotify.js")).href +
    `?loop=${Date.now()}`;
  const spotify = await import(modUrl);
  spotify.startPoolRewarmLoop();
  spotify.startPoolRewarmLoop();
  spotify.stopPoolRewarmLoopForTests();
  delete process.env.PARTYQUEUE_SPOTIFY_CACHE_FILE;
  delete process.env.PARTYQUEUE_SPOTIFY_TOKENS_FILE;
});
