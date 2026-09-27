// Up Next rendering for outbox rows: songs PartyQueue has accepted but the
// speaker has not confirmed, and songs we gave up on.
//
// The point of showing them at all is that "queued" plus an empty list is
// indistinguishable from the app losing the song.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  queueStatusBadgeHtml,
  isOutboxRow,
  queueTrackSig,
  queueBadgeHtml,
} from "../public/js/queue-ui.js";

test("a pending row is badged as still being added", () => {
  const html = queueStatusBadgeHtml({ pending: true });

  assert.match(html, /is-pending/);
  assert.match(html, /Adding/);
});

test("a failed row carries its reason in the tooltip", () => {
  const html = queueStatusBadgeHtml({
    failed: true,
    failedReason: "Sonos timeout",
  });

  assert.match(html, /is-failed/);
  assert.match(html, /Sonos timeout/);
});

test("a failed row without a reason still explains itself", () => {
  const html = queueStatusBadgeHtml({ failed: true });

  assert.match(html, /is-failed/);
  assert.doesNotMatch(html, /undefined|null/);
});

test("a confirmed row gets no status badge", () => {
  assert.equal(queueStatusBadgeHtml({ searched: true }), "");
  assert.equal(queueStatusBadgeHtml({}), "");
});

test("the failure reason is escaped, not injected", () => {
  const html = queueStatusBadgeHtml({
    failed: true,
    failedReason: '"><img src=x onerror=alert(1)>',
  });

  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("outbox rows are recognisable to the edit controls", () => {
  assert.equal(isOutboxRow({ pending: true }), true);
  assert.equal(isOutboxRow({ failed: true }), true);
  assert.equal(isOutboxRow({ searched: true }), false);
  assert.equal(isOutboxRow(null), false);
});

test("a row repaints when its add lands or gives up", () => {
  const base = { uri: "spotify:track:a", title: "Nine Ball", artist: "Cadence" };

  const pending = queueTrackSig({ ...base, pending: true });
  const placed = queueTrackSig({ ...base });
  const failed = queueTrackSig({ ...base, failed: true });

  assert.notEqual(pending, placed, "pending must not reuse a placed row");
  assert.notEqual(failed, placed);
  assert.notEqual(pending, failed);
});

test("status sits ahead of the Requested badge, not instead of it", () => {
  const html = queueBadgeHtml({
    pending: true,
    searched: true,
    requestedBy: "Dave",
  });

  assert.match(html, /Adding/);
  assert.match(html, /Requested/);
  assert.ok(
    html.indexOf("Adding") < html.indexOf("Requested"),
    "the waiting state reads first"
  );
});
