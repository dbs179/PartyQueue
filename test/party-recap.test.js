import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPartyRecapHtml,
  shouldAnnounceClosingTime,
} from "../public/js/party-recap.js";

test("buildPartyRecapHtml renders totals and top lists", () => {
  const html = buildPartyRecapHtml({
    total: 1,
    topSongs: [{ name: "A", artist: "B", count: 2 }],
    topRequesters: [{ name: "Sam", count: 1 }],
  });
  assert.match(html, /1<\/span> request/);
  assert.match(html, /A — B/);
  assert.match(html, /Sam/);
});

test("buildPartyRecapHtml returns empty for missing payload", () => {
  assert.equal(buildPartyRecapHtml(null), "");
});

test("shouldAnnounceClosingTime skips stale and repeats", () => {
  const now = 1_000_000;
  assert.deepEqual(shouldAnnounceClosingTime(0, 0, now), {
    announce: false,
    nextLastShown: 0,
  });
  assert.deepEqual(shouldAnnounceClosingTime(500, 500, now), {
    announce: false,
    nextLastShown: 500,
  });
  assert.deepEqual(shouldAnnounceClosingTime(now - 70_000, 0, now), {
    announce: false,
    nextLastShown: now - 70_000,
  });
  assert.deepEqual(shouldAnnounceClosingTime(now - 10_000, 0, now), {
    announce: true,
    nextLastShown: now - 10_000,
  });
});
