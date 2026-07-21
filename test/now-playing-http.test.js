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
