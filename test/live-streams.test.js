import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldPollView,
  NOW_PLAYING_FALLBACK_MS,
  QUEUE_FALLBACK_MS,
  PARTY_FALLBACK_MS,
} from "../public/js/live-streams.js";

test("shouldPollView only on visible main/display/mix", () => {
  assert.equal(shouldPollView("visible", "main"), true);
  assert.equal(shouldPollView("visible", "display"), true);
  assert.equal(shouldPollView("visible", "mix"), true);
  assert.equal(shouldPollView("visible", "booth"), false);
  assert.equal(shouldPollView("hidden", "main"), false);
  assert.equal(shouldPollView("visible", "settings-dj"), false);
});

test("fallback intervals stay in the expected band", () => {
  assert.equal(NOW_PLAYING_FALLBACK_MS, 15000);
  assert.equal(QUEUE_FALLBACK_MS, 15000);
  assert.ok(PARTY_FALLBACK_MS >= QUEUE_FALLBACK_MS);
});
