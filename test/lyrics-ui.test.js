import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LYRICS_LEAD_SEC,
  activeSyncedLineIndex,
  formatDjAnnounceScript,
  lyricsMissMessage,
} from "../public/js/lyrics-ui.js";

test("LYRICS_LEAD_SEC is a small positive offset", () => {
  assert.equal(LYRICS_LEAD_SEC, 0.75);
});

test("activeSyncedLineIndex respects lead and timeline", () => {
  const lines = [
    { t: 0, text: "a" },
    { t: 5, text: "b" },
    { t: 10, text: "c" },
  ];
  assert.equal(activeSyncedLineIndex(lines, 0, 0), 0);
  assert.equal(activeSyncedLineIndex(lines, 4.2, 0), 0);
  assert.equal(activeSyncedLineIndex(lines, 4.3, 0.75), 1);
  assert.equal(activeSyncedLineIndex(lines, 10, 0), 2);
  assert.equal(activeSyncedLineIndex(lines, -1, 0), -1);
  assert.equal(activeSyncedLineIndex([], 1), -1);
});

test("lyricsMissMessage covers degraded providers", () => {
  assert.equal(lyricsMissMessage(null), "No lyrics found");
  assert.equal(lyricsMissMessage({}), "No lyrics found");
  assert.equal(
    lyricsMissMessage({ degraded: true }),
    "No lyrics found — providers are having trouble"
  );
});

test("formatDjAnnounceScript soft-breaks sentences for TV/overlay", () => {
  assert.equal(formatDjAnnounceScript(""), "");
  assert.equal(
    formatDjAnnounceScript("Hello party. Here comes the set! Enjoy."),
    "Hello party.\n\nHere comes the set!\n\nEnjoy."
  );
});
