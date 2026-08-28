import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_MEM = path.join(
  os.tmpdir(),
  `pq-dj-taglines-${process.pid}-${Date.now()}.json`
);
process.env.PARTYQUEUE_DJ_MEMORY_FILE = TMP_MEM;

const { DJ_TAGLINES, taglineForClip, normalizeDjTaglines } = await import(
  "../src/dj-taglines.js"
);
const { clearDjNightMemory, reserveClipTagline } = await import(
  "../src/dj-night-memory.js"
);

beforeEach(() => {
  clearDjNightMemory();
});

after(() => {
  try {
    fs.rmSync(TMP_MEM, { force: true });
  } catch {
    /* ok */
  }
});

test("pack holds 50 short unique taglines", () => {
  assert.equal(DJ_TAGLINES.length, 50);
  const seen = new Set();
  for (const line of DJ_TAGLINES) {
    assert.ok(line && typeof line === "string", "tagline required");
    assert.ok(line.length <= 60, `tagline too long: ${line}`);
    assert.ok(!seen.has(line), `duplicate tagline: ${line}`);
    seen.add(line);
  }
});

test("a clip keeps the same tagline across polls", () => {
  const uri = "http://ha.local:8123/api/tts_proxy/abc123def.mp3";
  const first = taglineForClip(uri);
  for (let i = 0; i < 5; i++) {
    assert.equal(taglineForClip(uri), first);
  }
});

test("new clips avoid repeating taglines until the pack is exhausted", () => {
  const picks = [];
  for (let i = 0; i < DJ_TAGLINES.length; i++) {
    picks.push(taglineForClip(`http://ha.local:8123/api/tts_proxy/clip-${i}.mp3`));
  }
  assert.equal(new Set(picks).size, DJ_TAGLINES.length);

  // After the pack is spent, a new clip can reuse the least-recently used line.
  const next = taglineForClip(
    "http://ha.local:8123/api/tts_proxy/clip-overflow.mp3"
  );
  assert.ok(DJ_TAGLINES.includes(next));
});

test("null and empty URIs still resolve to a tagline", () => {
  assert.ok(taglineForClip(null));
  assert.ok(taglineForClip(""));
  assert.ok(taglineForClip(undefined));
  // Empty keys share one assignment so polls stay stable.
  assert.equal(taglineForClip(""), taglineForClip(null));
});

test("normalizeDjTaglines trims, caps, and falls back", () => {
  assert.deepEqual(normalizeDjTaglines(null), DJ_TAGLINES);
  assert.deepEqual(normalizeDjTaglines([]), DJ_TAGLINES);
  assert.deepEqual(normalizeDjTaglines("  \n  "), DJ_TAGLINES);
  assert.deepEqual(
    normalizeDjTaglines("Rocking from the Pulpit\nRocking from the Pulpit\n\nHeat"),
    ["Rocking from the Pulpit", "Heat"]
  );
  assert.equal(normalizeDjTaglines(["x".repeat(80)])[0].length, 60);
  assert.equal(normalizeDjTaglines(Array.from({ length: 90 }, (_, i) => `Line ${i}`)).length, 80);
});

test("taglineForClip uses a custom pack", () => {
  const pack = ["Custom Booth Line", "Another Custom Line"];
  const first = taglineForClip("http://ha.local:8123/api/tts_proxy/custom.mp3", pack);
  assert.ok(pack.includes(first));
  assert.equal(
    taglineForClip("http://ha.local:8123/api/tts_proxy/custom.mp3", pack),
    first
  );
});

test("reserveClipTagline falls back when the pack is empty", () => {
  assert.equal(reserveClipTagline("http://x/a.mp3", []), "Live from the Booth");
});
