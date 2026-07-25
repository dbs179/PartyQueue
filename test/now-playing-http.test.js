import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("enrichNowPlaying adds shared party flags without throwing", async () => {
  const { enrichNowPlaying } = await import("../src/now-playing-http.js");
  const enriched = enrichNowPlaying({
    title: "Test",
    artist: "Artist",
    uri: "spotify:track:abc",
  });
  assert.equal(enriched.title, "Test");
  assert.equal(typeof enriched.neverEnding, "boolean");
  assert.equal(typeof enriched.requestsPaused, "boolean");
  assert.equal(typeof enriched.hostControlsOnly, "boolean");
  assert.ok("reactions" in enriched);
  assert.ok("mixGenreLane" in enriched);
  assert.ok("mixGenreLabel" in enriched);
});

test("resolveDisplayGenre hides stale set lane when idle", async () => {
  const { resolveDisplayGenre } = await import("../src/now-playing-http.js");
  assert.deepEqual(resolveDisplayGenre({}, { setLane: "folk" }), {
    mixGenreLane: null,
    mixGenreLabel: null,
  });
  assert.deepEqual(
    resolveDisplayGenre(
      { title: "X", artist: "Y", uri: "spotify:track:1", origin: null },
      { setLane: "folk" }
    ),
    { mixGenreLane: null, mixGenreLabel: null }
  );
});

test("resolveDisplayGenre uses set lane for filler and artist genre for requests", async () => {
  const { resolveDisplayGenre } = await import("../src/now-playing-http.js");
  assert.deepEqual(
    resolveDisplayGenre(
      {
        title: "Random Song",
        artist: "Band",
        uri: "spotify:track:1",
        origin: "filler",
      },
      { setLane: "folk" }
    ),
    { mixGenreLane: "folk", mixGenreLabel: "Folk" }
  );
  assert.deepEqual(
    resolveDisplayGenre(
      {
        title: "Guest Pick",
        artist: "Rapper",
        uri: "spotify:track:2",
        origin: "searched",
      },
      {
        setLane: "folk",
        bucketsFor: () => ["hiphop"],
      }
    ),
    { mixGenreLane: "hiphop", mixGenreLabel: "Hip-Hop/Rap" }
  );
});

test("resolveDisplayGenre prefers the track's enqueue lane over the latest set lane", async () => {
  const { resolveDisplayGenre } = await import("../src/now-playing-http.js");
  assert.deepEqual(
    resolveDisplayGenre(
      {
        title: "Pop Filler",
        artist: "Band",
        uri: "spotify:track:1",
        origin: "filler",
        genreLane: "pop",
      },
      { setLane: "folk" }
    ),
    { mixGenreLane: "pop", mixGenreLabel: "Pop" }
  );
  assert.deepEqual(
    resolveDisplayGenre(
      {
        title: "Discover Hit",
        artist: "Band",
        uri: "spotify:track:2",
        origin: "discovered",
        genreLane: "rock",
      },
      { setLane: "electronic" }
    ),
    { mixGenreLane: "rock", mixGenreLabel: "Rock" }
  );
});

test("position age is calculated using the server clock", async () => {
  const { addPositionAge } = await import("../src/now-playing-http.js");
  const payload = addPositionAge(
    { positionSec: 12, positionObservedAt: 10_000 },
    10_750
  );
  assert.equal(payload.positionAgeSec, 0.75);
});

test("/api/state compatibility route is explicitly deprecated in source", () => {
  const src = fs.readFileSync(
    path.join(here, "..", "src", "now-playing-http.js"),
    "utf8"
  );
  assert.match(src, /app\.get\("\/api\/state"/);
  assert.match(src, /Deprecation/);
  assert.match(src, /\/api\/nowplaying and \/api\/queue\/list/);
});

test("transport fresh reads are private, bounded, and shared through SSE", () => {
  const src = fs.readFileSync(
    path.join(here, "..", "src", "now-playing-http.js"),
    "utf8"
  );
  assert.match(src, /getNowPlayingFresh/);
  assert.match(src, /nudgeNowPlayingTransition/);
  assert.match(src, /monitorFreshReadsPending/);
  assert.match(src, /readNowPlayingWithTransition/);
  assert.doesNotMatch(src, /req\.query\.fresh/);
  assert.match(src, /Cache-Control", "no-store"/);
});

test("HTTP nowplaying route uses transition-aware reader for SSE parity", () => {
  const src = fs.readFileSync(
    path.join(here, "..", "src", "now-playing-http.js"),
    "utf8"
  );
  assert.match(
    src,
    /app\.get\("\/api\/nowplaying"[\s\S]*?readNowPlayingWithTransition\(\)/
  );
});

test("transport convergence uses the snapshot captured before the Sonos command", () => {
  const src = fs.readFileSync(
    path.join(here, "..", "src", "routes", "transport.js"),
    "utf8"
  );
  assert.match(
    src,
    /const transitionFrom = nowPlayingMonitor\.latest;\s*try \{\s*const result = await next\(\);[\s\S]*?nudgeNowPlayingTransition\(transitionFrom\)/
  );
  assert.match(
    src,
    /const transitionFrom = nowPlayingMonitor\.latest;\s*try \{\s*const result = await previous\(\);\s*nudgeNowPlayingTransition\(transitionFrom\)/
  );
});
