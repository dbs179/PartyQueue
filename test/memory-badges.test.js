import { test } from "node:test";
import assert from "node:assert/strict";
import { memorySourceBadge } from "../public/js/memory-badges.js";

test("memorySourceBadge renders searched with requester", () => {
  const html = memorySourceBadge("searched", false, "Dave");
  assert.match(html, /searched-badge/);
  assert.match(html, /Requested/);
  assert.match(html, /Dave/);
});

test("memorySourceBadge renders Discover and Random", () => {
  assert.match(memorySourceBadge("discovered"), /Discover/);
  assert.match(memorySourceBadge("filler"), /Random/);
});

test("memorySourceBadge renders era hit from mood id", () => {
  const html = memorySourceBadge("mood", false, "", "80s");
  assert.match(html, /mood-badge/);
  assert.match(html, /80's Hit/);
});

test("memorySourceBadge appends Skipped", () => {
  const html = memorySourceBadge("filler", true);
  assert.match(html, /Random/);
  assert.match(html, /Skipped/);
});

test("memorySourceBadge escapes requester HTML", () => {
  const html = memorySourceBadge("searched", false, `<img src=x>`);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});
