import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("enrichNowPlaying stays track-scoped (party flags live on /api/party)", async () => {
  const { enrichNowPlaying } = await import("../src/now-playing-http.js");
  const enriched = await enrichNowPlaying({
    title: "Test",
    artist: "Artist",
    uri: "spotify:track:abc",
  });
  assert.equal(enriched.title, "Test");
  assert.ok("reactions" in enriched);
  assert.ok(enriched.reactionPlayId);
  assert.match(String(enriched.reactionPlayId), /^abc:/);
  assert.ok("mixGenreLane" in enriched);
  assert.ok("mixGenreLabel" in enriched);
  assert.equal("neverEnding" in enriched, false);
  assert.equal("discoverEnabled" in enriched, false);
  assert.equal("kidsLock" in enriched, false);
  assert.equal("partyOver" in enriched, false);
  assert.equal("closingTimeAt" in enriched, false);
  assert.equal("mixGenres" in enriched, false);
});

test("resolveDisplayGenre maps untracked origin from artist buckets", async () => {
  const { resolveDisplayGenre } = await import("../src/now-playing-http.js");
  assert.deepEqual(
    resolveDisplayGenre(
      { title: "X", artist: "Y", uri: "spotify:track:1", origin: null },
      { setLane: "folk", bucketsFor: () => ["metal"] }
    ),
    { mixGenreLane: "metal", mixGenreLabel: "Metal" }
  );
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
});

test("resolveDisplayGenre uses artist genre for Discover, not off-lane set label", async () => {
  const { resolveDisplayGenre } = await import("../src/now-playing-http.js");
  // Bieber-style: pop strongest, junk metal also mapped — show pop, not set metal.
  assert.deepEqual(
    resolveDisplayGenre(
      {
        title: "Intentions",
        artist: "Justin Bieber",
        uri: "spotify:track:bieber",
        origin: "discovered",
        genreLane: "metal",
      },
      {
        setLane: "metal",
        bucketsFor: () => ["pop", "metal"],
      }
    ),
    { mixGenreLane: "pop", mixGenreLabel: "Pop" }
  );
  // Untagged Discover still falls back to enqueue set lane.
  assert.deepEqual(
    resolveDisplayGenre(
      {
        title: "Unknown Discover",
        artist: "Mystery",
        uri: "spotify:track:x",
        origin: "discovered",
        genreLane: "rock",
      },
      {
        setLane: "electronic",
        bucketsFor: () => [],
      }
    ),
    { mixGenreLane: "rock", mixGenreLabel: "Rock" }
  );
});

test("resolveDisplayGenre during DJ uses the upcoming song's set lane", async () => {
  const { resolveDisplayGenre } = await import("../src/now-playing-http.js");
  assert.deepEqual(
    resolveDisplayGenre(
      {
        title: "DJ Test Voice",
        artist: "Live from the Booth",
        uri: "http://ha/tts_proxy/clip.mp3",
        djVoice: true,
      },
      {
        setLane: "folk",
        upcomingForGenre: {
          title: "Neon",
          artist: "DJ Artist",
          uri: "spotify:track:neo",
          origin: "filler",
          genreLane: "electronic",
        },
      }
    ),
    { mixGenreLane: "electronic", mixGenreLabel: "Electronic" }
  );
  // No upcoming row yet — keep the latest set lane so a just-queued batch
  // does not blank the header while the announce is current.
  assert.deepEqual(
    resolveDisplayGenre(
      {
        title: "DJ Test Voice",
        artist: "Live from the Booth",
        uri: "http://ha/tts_proxy/clip.mp3",
        djVoice: true,
      },
      { setLane: "electronic" }
    ),
    { mixGenreLane: "electronic", mixGenreLabel: "Electronic" }
  );
});

test("enrichNowPlaying reuses attached upcomingForGenre and strips it", async () => {
  const { enrichNowPlaying } = await import("../src/now-playing-http.js");
  const enriched = await enrichNowPlaying({
    title: "DJ Test Voice",
    artist: "Live from the Booth",
    uri: "http://10.10.1.30:8088/media/tts/silence-2s.mp3",
    djVoice: true,
    djSilence: true,
    upcomingForGenre: {
      title: "Neon",
      artist: "DJ Artist",
      uri: "spotify:track:neo",
      origin: "filler",
      genreLane: "electronic",
    },
  });
  assert.equal(enriched.mixGenreLane, "electronic");
  assert.equal(enriched.mixGenreLabel, "Electronic");
  assert.equal("upcomingForGenre" in enriched, false);
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
