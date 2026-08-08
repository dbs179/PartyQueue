import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  formatTimeAgo,
  formatSuggestionWhen,
  escapeHtml,
  formatTrackTime,
} from "../public/js/format.js";

test("formatDuration renders hours, minutes, and seconds", () => {
  assert.equal(formatDuration(5), "5s");
  assert.equal(formatDuration(65), "1m 5s");
  assert.equal(formatDuration(3661), "1h 1m");
});

test("formatTimeAgo uses relative buckets", () => {
  const now = 1_700_000_000_000;
  assert.equal(formatTimeAgo(null, now), "never warmed");
  assert.equal(formatTimeAgo(now - 10_000, now), "just now");
  assert.equal(formatTimeAgo(now - 5 * 60_000, now), "5m ago");
  assert.equal(formatTimeAgo(now - 2 * 3600_000 - 15 * 60_000, now), "2h 15m ago");
});

test("formatSuggestionWhen covers short and longer spans", () => {
  const now = 1_700_000_000_000;
  assert.equal(formatSuggestionWhen(0, now), "");
  assert.equal(formatSuggestionWhen(now - 30_000, now), "just now");
  assert.equal(formatSuggestionWhen(now - 10 * 60_000, now), "10m ago");
  assert.equal(formatSuggestionWhen(now - 3 * 3600_000, now), "3h ago");
});

test("escapeHtml encodes markup characters", () => {
  assert.equal(
    escapeHtml(`<b a="x">&</b>`),
    "&lt;b a=&quot;x&quot;&gt;&amp;&lt;/b&gt;"
  );
});

test("formatTrackTime renders mm:ss and h:mm:ss", () => {
  assert.equal(formatTrackTime(0), "0:00");
  assert.equal(formatTrackTime(65), "1:05");
  assert.equal(formatTrackTime(3661), "1:01:01");
  assert.equal(formatTrackTime("nope"), "0:00");
});

