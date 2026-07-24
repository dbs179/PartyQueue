import { test } from "node:test";
import assert from "node:assert/strict";

import { DJ_TAGLINES, taglineForClip } from "../src/dj-taglines.js";

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

test("different clips spread across the pack", () => {
  const picks = new Set();
  for (let i = 0; i < 200; i++) {
    picks.add(taglineForClip(`http://ha.local:8123/api/tts_proxy/clip-${i}.mp3`));
  }
  assert.ok(picks.size >= 25, `expected wide spread, got ${picks.size} taglines`);
});

test("null and empty URIs still resolve to a tagline", () => {
  assert.ok(taglineForClip(null));
  assert.ok(taglineForClip(""));
  assert.ok(taglineForClip(undefined));
});
